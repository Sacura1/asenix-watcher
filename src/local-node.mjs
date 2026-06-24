import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';

import { collectChainSnapshot } from './asentum-rpc.mjs';

const execFileAsync = promisify(execFile);

async function run(command, args, timeoutMs = 6000) {
  try {
    const result = await execFileAsync(command, args, {
      timeout: timeoutMs,
      windowsHide: true,
    });
    return { ok: true, stderr: result.stderr ?? '', stdout: result.stdout ?? '' };
  } catch (error) {
    return {
      code: error.code ?? null,
      ok: false,
      stderr: error.stderr ?? error.message ?? '',
      stdout: error.stdout ?? '',
    };
  }
}

async function checkProcesses(names) {
  if (!names.length) return [];

  const command = process.platform === 'win32' ? 'tasklist.exe' : 'ps';
  const args = process.platform === 'win32'
    ? ['/FO', 'CSV', '/NH']
    : ['-eo', 'pid,comm,args'];
  const result = await run(command, args);
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();

  return names.map((name) => {
    const query = name.toLowerCase();
    const matches = text
      .split(/\r?\n/)
      .filter((line) => line.includes(query) && !line.includes('asenix-watcher'));
    return {
      matches: matches.slice(0, 5),
      name,
      ok: result.ok && matches.length > 0,
      skipped: false,
    };
  });
}

function parseSystemdProperties(text) {
  const properties = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    properties[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return properties;
}

async function checkSystemd(services) {
  if (!services.length || process.platform === 'win32') return [];
  return Promise.all(
    services.map(async (service) => {
      const active = await run('systemctl', ['is-active', service]);
      const detail = await run('systemctl', [
        'show',
        service,
        '--property=ActiveState,SubState,MainPID,NRestarts',
        '--no-pager',
      ]);
      const properties = parseSystemdProperties(detail.stdout);
      const state = active.stdout.trim() || properties.ActiveState || active.stderr.trim();
      const mainPid = Number(properties.MainPID ?? 0);
      return {
        detail: detail.stdout.trim(),
        mainPid: Number.isFinite(mainPid) ? mainPid : 0,
        ok: active.stdout.trim() === 'active' || properties.ActiveState === 'active',
        restartCount: properties.NRestarts ?? null,
        service,
        state,
        subState: properties.SubState ?? null,
      };
    }),
  );
}

function comparableUnitName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/\.service$/, '')
    .trim();
}

function systemdServiceForProcess(processName, systemd) {
  const normalizedProcess = comparableUnitName(processName);
  return systemd.find((item) =>
    item.ok &&
    comparableUnitName(item.service) === normalizedProcess &&
    (!item.mainPid || item.mainPid > 0)
  );
}

function reconcileProcessesWithSystemd(processes, systemd) {
  if (!processes.length || !systemd.length) return processes;
  return processes.map((item) => {
    if (item.ok) return item;
    const service = systemdServiceForProcess(item.name, systemd);
    if (!service) return item;
    const pidText = service.mainPid ? `, main pid ${service.mainPid}` : '';
    return {
      ...item,
      coveredBy: 'systemd',
      matches: [`systemd ${service.service} is ${service.state}${pidText}`],
      ok: true,
      skipped: true,
      systemdService: service.service,
    };
  });
}

async function checkDocker(containers) {
  if (!containers.length) return [];
  return Promise.all(
    containers.map(async (container) => {
      const result = await run('docker', [
        'inspect',
        '--format',
        '{{.State.Running}}|{{.State.Status}}|{{.State.RestartCount}}',
        container,
      ]);
      const [running, status, restartCount] = result.stdout.trim().split('|');
      return {
        container,
        ok: result.ok && running === 'true',
        restartCount: restartCount ?? null,
        status: status || result.stderr.trim() || 'unknown',
      };
    }),
  );
}

async function checkDisks(paths, thresholds) {
  if (!paths.length || process.platform === 'win32') return [];
  const result = await run('df', ['-Pk', ...paths]);
  if (!result.ok) {
    return paths.map((diskPath) => ({
      error: result.stderr.trim() || 'df failed',
      ok: false,
      path: diskPath,
    }));
  }

  return result.stdout
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((columns) => columns.length >= 6)
    .map((columns) => {
      const usedPercent = Number(columns[4].replace('%', ''));
      return {
        availableKb: Number(columns[3]),
        filesystem: columns[0],
        ok: usedPercent < thresholds.diskCriticalPercent,
        path: columns.slice(5).join(' '),
        status: usedPercent >= thresholds.diskCriticalPercent
          ? 'critical'
          : usedPercent >= thresholds.diskWarnPercent
            ? 'warning'
            : 'ok',
        usedPercent,
      };
    });
}

function checkMemory(thresholds) {
  const total = os.totalmem();
  const free = os.freemem();
  const usedPercent = total ? Math.round(((total - free) / total) * 100) : 0;
  return {
    freeBytes: free,
    ok: usedPercent < thresholds.memoryWarnPercent,
    status: usedPercent >= thresholds.memoryWarnPercent ? 'warning' : 'ok',
    totalBytes: total,
    usedPercent,
  };
}

async function tailFile(filePath, maxBytes = 256 * 1024) {
  const stat = await fs.stat(filePath);
  const length = Math.min(stat.size, maxBytes);
  const file = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, stat.size - length);
    return buffer.toString('utf8');
  } finally {
    await file.close();
  }
}

async function checkLogs(files) {
  if (!files.length) return [];
  return Promise.all(
    files.map(async (filePath) => {
      try {
        const text = await tailFile(filePath);
        const matches = text
          .split(/\r?\n/)
          .filter((line) => /\b(error|fatal|panic|crash|failed|uncaught)\b/i.test(line))
          .slice(-5);
        return {
          filePath,
          matches,
          ok: matches.length === 0,
          status: matches.length ? 'warning' : 'ok',
        };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : 'log read failed',
          filePath,
          ok: false,
          status: 'warning',
        };
      }
    }),
  );
}

async function checkLocalRpc(config, publicHeight) {
  if (!config.local.nodeRpcUrl) return null;
  try {
    const snapshot = await collectChainSnapshot({
      address: config.operatorAddress,
      rpcUrl: config.local.nodeRpcUrl,
      timeoutMs: config.thresholds.requestTimeoutMs,
      windowSize: 1,
    });
    const lagBlocks = typeof publicHeight === 'number'
      ? Math.max(0, publicHeight - snapshot.chain.height)
      : null;
    return {
      ...snapshot,
      lagBlocks,
      ok: lagBlocks === null || lagBlocks <= config.thresholds.localHeightLagBlocks,
      status: lagBlocks !== null && lagBlocks > config.thresholds.localHeightLagBlocks
        ? 'critical'
        : 'ok',
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'local RPC failed',
      ok: false,
      rpcUrl: config.local.nodeRpcUrl,
      status: 'critical',
    };
  }
}

function addIssue(issues, severity, message) {
  issues.push({ message, severity });
}

export async function checkLocalNode(config, publicHeight = null) {
  const [rawProcesses, systemd, docker, disks, logs, localRpc] = await Promise.all([
    checkProcesses(config.local.processNames),
    checkSystemd(config.local.systemdServices),
    checkDocker(config.local.dockerContainers),
    checkDisks(config.local.diskPaths, config.thresholds),
    checkLogs(config.local.logFiles),
    checkLocalRpc(config, publicHeight),
  ]);
  const processes = reconcileProcessesWithSystemd(rawProcesses, systemd);
  const memory = checkMemory(config.thresholds);
  const issues = [];

  for (const item of processes) {
    if (!item.ok && localRpc?.ok) {
      addIssue(issues, 'warning', `Process name not matched: ${item.name}, but local node RPC is healthy`);
    } else if (!item.ok) {
      addIssue(issues, 'critical', `Process not found: ${item.name}`);
    }
  }
  for (const item of systemd) {
    if (!item.ok) addIssue(issues, 'critical', `Systemd service is not active: ${item.service} (${item.state || 'unknown'})`);
  }
  for (const item of docker) {
    if (!item.ok) addIssue(issues, 'critical', `Docker container is not running: ${item.container} (${item.status})`);
  }
  if (localRpc && !localRpc.ok) {
    addIssue(
      issues,
      localRpc.status === 'critical' ? 'critical' : 'warning',
      localRpc.lagBlocks === null || localRpc.lagBlocks === undefined
        ? `Local node RPC failed: ${localRpc.error}`
        : `Local node is ${localRpc.lagBlocks} blocks behind public RPC`,
    );
  }
  for (const disk of disks) {
    if (disk.status === 'critical') addIssue(issues, 'critical', `Disk is nearly full: ${disk.path} ${disk.usedPercent}%`);
    if (disk.status === 'warning') addIssue(issues, 'warning', `Disk usage is high: ${disk.path} ${disk.usedPercent}%`);
    if (disk.error) addIssue(issues, 'warning', `Disk check failed for ${disk.path}: ${disk.error}`);
  }
  if (!memory.ok) addIssue(issues, 'warning', `Memory usage is high: ${memory.usedPercent}%`);
  for (const log of logs) {
    if (!log.ok) addIssue(issues, 'warning', `Recent error-like log lines in ${log.filePath}`);
  }

  const configuredChecks = [
    config.local.nodeRpcUrl,
    config.local.processNames.length,
    config.local.systemdServices.length,
    config.local.dockerContainers.length,
  ].filter(Boolean).length;
  if (!configuredChecks) {
    addIssue(issues, 'warning', 'No local node checks configured yet');
  }

  const severityRank = { critical: 2, warning: 1 };
  const highest = issues.reduce((rank, issue) => Math.max(rank, severityRank[issue.severity] ?? 0), 0);
  return {
    disks,
    docker,
    issues,
    localRpc,
    memory,
    processes,
    status: highest === 2 ? 'critical' : highest === 1 ? 'warning' : 'ok',
    systemd,
    logs,
  };
}
