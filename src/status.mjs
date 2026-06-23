import { collectChainSnapshot } from './asentum-rpc.mjs';
import { describeEnabledChecks } from './config.mjs';
import { checkLocalNode } from './local-node.mjs';

function formatAge(seconds) {
  if (seconds === null || seconds === undefined) return 'unknown';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown';
  const gb = bytes / 1024 / 1024 / 1024;
  return `${gb.toFixed(gb >= 10 ? 1 : 2)} GB`;
}

function formatAse(balance) {
  const value = balance?.balance ?? balance?.value;
  if (value === undefined || value === null) return 'unknown';
  try {
    const ase = Number(BigInt(value)) / 1e18;
    if (!Number.isFinite(ase)) return String(value);
    return `${ase.toLocaleString(undefined, { maximumFractionDigits: 4 })} ASE`;
  } catch {
    return String(value);
  }
}

function pushPublicIssues(config, publicSnapshot, issues) {
  if (!publicSnapshot.ok) {
    issues.push({ message: `Public RPC failed: ${publicSnapshot.error}`, severity: 'warning' });
    return;
  }
  const latestAge = publicSnapshot.data.window.latestBlockAgeSec;
  if (
    typeof latestAge === 'number' &&
    latestAge > config.thresholds.publicBlockStaleSeconds
  ) {
    issues.push({
      message: `Public chain latest scanned block is stale: ${formatAge(latestAge)}`,
      severity: 'warning',
    });
  }

  if (
    config.operatorAddress &&
    config.thresholds.proposalMaxMissedBlocks > 0 &&
    publicSnapshot.data.window.proposedByAddress === 0 &&
    publicSnapshot.data.window.blocksScanned >= config.thresholds.proposalMaxMissedBlocks
  ) {
    issues.push({
      message: `No proposed block by operator address in the last ${publicSnapshot.data.window.blocksScanned} scanned blocks`,
      severity: 'warning',
    });
  }
}

export async function collectStatus(config) {
  const publicSnapshot = await collectChainSnapshot({
    address: config.operatorAddress,
    rpcUrl: config.publicRpcUrl,
    timeoutMs: config.thresholds.requestTimeoutMs,
    windowSize: config.scanWindowBlocks,
  })
    .then((data) => ({ data, ok: true }))
    .catch((error) => ({
      error: error instanceof Error ? error.message : 'public RPC failed',
      ok: false,
    }));

  const publicHeight = publicSnapshot.ok ? publicSnapshot.data.chain.height : null;
  const local = await checkLocalNode(config, publicHeight);
  const issues = [...local.issues];
  pushPublicIssues(config, publicSnapshot, issues);

  const rank = { critical: 2, warning: 1 };
  const highest = issues.reduce((value, issue) => Math.max(value, rank[issue.severity] ?? 0), 0);

  return {
    checkedAt: new Date().toISOString(),
    config: {
      enabledChecks: describeEnabledChecks(config),
      operatorAddress: config.operatorAddress || null,
      publicRpcUrl: config.publicRpcUrl,
      scanWindowBlocks: config.scanWindowBlocks,
    },
    issues,
    local,
    public: publicSnapshot,
    status: highest === 2 ? 'critical' : highest === 1 ? 'warning' : 'ok',
  };
}

export function formatStatusMessage(snapshot, { compact = false } = {}) {
  const lines = [];
  lines.push(`Asenix Watcher: ${snapshot.status.toUpperCase()}`);
  lines.push(`Checked: ${new Date(snapshot.checkedAt).toLocaleString()}`);
  lines.push('');

  if (snapshot.local.localRpc) {
    const localRpc = snapshot.local.localRpc;
    if (localRpc.ok) {
      lines.push(`Node RPC: height ${localRpc.chain.height}, lag ${localRpc.lagBlocks ?? 'unknown'} blocks`);
    } else {
      lines.push(`Node RPC: failed (${localRpc.error})`);
    }
  } else {
    lines.push('Node RPC: not configured');
  }

  if (snapshot.local.systemd.length) {
    lines.push(`Systemd: ${snapshot.local.systemd.map((item) => `${item.service}=${item.state}`).join(', ')}`);
  }
  if (snapshot.local.docker.length) {
    lines.push(`Docker: ${snapshot.local.docker.map((item) => `${item.container}=${item.status}`).join(', ')}`);
  }
  if (snapshot.local.processes.length) {
    lines.push(`Process: ${snapshot.local.processes.map((item) => `${item.name}=${item.ok ? 'running' : 'missing'}`).join(', ')}`);
  }
  if (snapshot.local.disks.length) {
    lines.push(`Disk: ${snapshot.local.disks.map((item) => `${item.path} ${item.usedPercent ?? '?'}%`).join(', ')}`);
  }
  lines.push(`Memory: ${snapshot.local.memory.usedPercent}% used, ${formatBytes(snapshot.local.memory.freeBytes)} free`);

  if (snapshot.public.ok) {
    const data = snapshot.public.data;
    lines.push('');
    lines.push(`Chain: height ${data.chain.height}, mempool ${data.chain.mempoolSize}, ready ${data.ready ? 'yes' : 'no'}`);
    lines.push(`Latest scanned block: ${formatAge(data.window.latestBlockAgeSec)}`);
    lines.push(`Operator balance: ${formatAse(data.balance)}`);
    lines.push(`Validator set match: ${data.isValidator ? 'yes' : 'not found'}`);
    if (data.window.lastProposedBlock) {
      const ageSec = data.window.lastProposedBlock.timestampMs
        ? Math.max(0, Math.round((Date.now() - data.window.lastProposedBlock.timestampMs) / 1000))
        : null;
      lines.push(`Last proposed block: #${data.window.lastProposedBlock.height} (${formatAge(ageSec)})`);
    } else {
      lines.push(`Last proposed block: none in last ${data.window.blocksScanned} scanned blocks`);
    }
  } else {
    lines.push('');
    lines.push(`Chain: public RPC failed (${snapshot.public.error})`);
  }

  if (snapshot.issues.length) {
    lines.push('');
    lines.push('Issues:');
    for (const issue of snapshot.issues.slice(0, compact ? 6 : 12)) {
      lines.push(`- ${issue.severity.toUpperCase()}: ${issue.message}`);
    }
  }

  if (!compact && snapshot.local.logs.some((item) => item.matches?.length)) {
    lines.push('');
    lines.push('Recent log warnings:');
    for (const log of snapshot.local.logs) {
      if (log.matches?.length) lines.push(`- ${log.filePath}: ${log.matches.length} recent error-like lines`);
    }
  }

  return lines.join('\n');
}

export function formatNodeMessage(snapshot) {
  const lines = [];
  lines.push(`Asenix Watcher node status: ${snapshot.local.status.toUpperCase()}`);
  lines.push(`Checked: ${new Date(snapshot.checkedAt).toLocaleString()}`);
  lines.push('');

  if (snapshot.local.localRpc) {
    const localRpc = snapshot.local.localRpc;
    if (localRpc.ok) {
      lines.push(`Node RPC: height ${localRpc.chain.height}, lag ${localRpc.lagBlocks ?? 'unknown'} blocks`);
      lines.push(`Node RPC ready: ${localRpc.ready ? 'yes' : 'no'}`);
    } else {
      lines.push(`Node RPC: failed (${localRpc.error})`);
    }
  } else {
    lines.push('Node RPC: not configured');
  }

  if (snapshot.local.systemd.length) {
    lines.push(`Systemd: ${snapshot.local.systemd.map((item) => `${item.service}=${item.state}`).join(', ')}`);
  }
  if (snapshot.local.docker.length) {
    lines.push(`Docker: ${snapshot.local.docker.map((item) => `${item.container}=${item.status}`).join(', ')}`);
  }
  if (snapshot.local.processes.length) {
    lines.push(`Process: ${snapshot.local.processes.map((item) => `${item.name}=${item.ok ? 'running' : 'missing'}`).join(', ')}`);
  }
  if (snapshot.local.disks.length) {
    lines.push(`Disk: ${snapshot.local.disks.map((item) => `${item.path} ${item.usedPercent ?? '?'}%`).join(', ')}`);
  }
  lines.push(`Memory: ${snapshot.local.memory.usedPercent}% used, ${formatBytes(snapshot.local.memory.freeBytes)} free`);

  const localIssues = snapshot.issues.filter((issue) =>
    !issue.message.startsWith('Public RPC') &&
    !issue.message.startsWith('Public chain') &&
    !issue.message.startsWith('No proposed block'),
  );
  if (localIssues.length) {
    lines.push('');
    lines.push('Issues:');
    for (const issue of localIssues.slice(0, 10)) {
      lines.push(`- ${issue.severity.toUpperCase()}: ${issue.message}`);
    }
  }

  return lines.join('\n');
}

export function formatChainMessage(snapshot) {
  const lines = [];
  lines.push(`Asenix Watcher chain status: ${snapshot.public.ok ? 'OK' : 'WARNING'}`);
  lines.push(`Checked: ${new Date(snapshot.checkedAt).toLocaleString()}`);
  lines.push('');

  if (!snapshot.public.ok) {
    lines.push(`Public RPC failed: ${snapshot.public.error}`);
    return lines.join('\n');
  }

  const data = snapshot.public.data;
  lines.push(`RPC: ${data.rpcUrl}`);
  lines.push(`Height: ${data.chain.height}`);
  lines.push(`Mempool: ${data.chain.mempoolSize}`);
  lines.push(`Ready: ${data.ready ? 'yes' : 'no'}`);
  lines.push(`Latest scanned block: ${formatAge(data.window.latestBlockAgeSec)}`);
  lines.push(`Operator balance: ${formatAse(data.balance)}`);
  lines.push(`Validator set match: ${data.isValidator ? 'yes' : 'not found'}`);
  if (data.window.lastProposedBlock) {
    const ageSec = data.window.lastProposedBlock.timestampMs
      ? Math.max(0, Math.round((Date.now() - data.window.lastProposedBlock.timestampMs) / 1000))
      : null;
    lines.push(`Last proposed block: #${data.window.lastProposedBlock.height} (${formatAge(ageSec)})`);
  } else {
    lines.push(`Last proposed block: none in last ${data.window.blocksScanned} scanned blocks`);
  }

  return lines.join('\n');
}
