import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadEnvFile(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const equalsIndex = line.indexOf('=');
      if (equalsIndex <= 0) continue;
      const key = line.slice(0, equalsIndex).trim();
      let envValue = line.slice(equalsIndex + 1).trim();
      if (
        (envValue.startsWith('"') && envValue.endsWith('"')) ||
        (envValue.startsWith("'") && envValue.endsWith("'"))
      ) {
        envValue = envValue.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = envValue;
      }
    }
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
}

function nested(source, keyPath) {
  return keyPath.split('.').reduce((value, key) => {
    if (value && typeof value === 'object' && key in value) return value[key];
    return undefined;
  }, source);
}

function value(source, keyPath, envName, fallback) {
  const fromEnv = process.env[envName];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const fromFile = nested(source, keyPath);
  return fromFile === undefined || fromFile === null ? fallback : fromFile;
}

function list(input) {
  if (Array.isArray(input)) {
    return input.map((item) => String(item).trim()).filter(Boolean);
  }
  return String(input ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function numberValue(input, fallback) {
  const parsed = Number(input);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return {};
    throw error;
  }
}

export async function loadConfig() {
  await loadEnvFile(path.join(ROOT_DIR, '.env'));

  const configPath = process.env.ASENIX_WATCHER_CONFIG
    ? path.resolve(process.env.ASENIX_WATCHER_CONFIG)
    : path.join(ROOT_DIR, 'watcher.config.json');
  const fileConfig = await readJsonIfExists(configPath);

  const thresholds = {
    diskCriticalPercent: numberValue(
      value(fileConfig, 'thresholds.diskCriticalPercent', 'ASENIX_DISK_CRITICAL_PERCENT', 93),
      93,
    ),
    diskWarnPercent: numberValue(
      value(fileConfig, 'thresholds.diskWarnPercent', 'ASENIX_DISK_WARN_PERCENT', 85),
      85,
    ),
    localHeightLagBlocks: numberValue(
      value(fileConfig, 'thresholds.localHeightLagBlocks', 'ASENIX_LOCAL_HEIGHT_LAG_BLOCKS', 3),
      3,
    ),
    memoryWarnPercent: numberValue(
      value(fileConfig, 'thresholds.memoryWarnPercent', 'ASENIX_MEMORY_WARN_PERCENT', 92),
      92,
    ),
    pollSeconds: numberValue(
      value(fileConfig, 'thresholds.pollSeconds', 'ASENIX_POLL_SECONDS', 60),
      60,
    ),
    proposalMaxMissedBlocks: numberValue(
      value(fileConfig, 'thresholds.proposalMaxMissedBlocks', 'ASENIX_PROPOSAL_MAX_MISSED_BLOCKS', 0),
      0,
    ),
    publicBlockCriticalSeconds: numberValue(
      value(fileConfig, 'thresholds.publicBlockCriticalSeconds', 'ASENIX_PUBLIC_BLOCK_CRITICAL_SECONDS', 3600),
      3600,
    ),
    publicBlockStaleSeconds: numberValue(
      value(fileConfig, 'thresholds.publicBlockStaleSeconds', 'ASENIX_PUBLIC_BLOCK_STALE_SECONDS', 600),
      600,
    ),
    reminderMinutes: numberValue(
      value(fileConfig, 'thresholds.reminderMinutes', 'ASENIX_REMINDER_MINUTES', 60),
      60,
    ),
    requestTimeoutMs: numberValue(
      value(fileConfig, 'thresholds.requestTimeoutMs', 'ASENIX_REQUEST_TIMEOUT_MS', 8000),
      8000,
    ),
  };

  const statePath = process.env.ASENIX_WATCHER_STATE
    ? path.resolve(process.env.ASENIX_WATCHER_STATE)
    : path.join(ROOT_DIR, 'watcher-state.json');

  return {
    configPath,
    local: {
      diskPaths: list(value(fileConfig, 'local.diskPaths', 'ASENIX_DISK_PATHS', process.platform === 'win32' ? '' : '/')),
      dockerContainers: list(value(fileConfig, 'local.dockerContainers', 'ASENIX_DOCKER_CONTAINERS', '')),
      logFiles: list(value(fileConfig, 'local.logFiles', 'ASENIX_LOG_FILES', '')),
      nodeRpcUrl: String(value(fileConfig, 'local.nodeRpcUrl', 'ASENIX_NODE_RPC_URL', '')).replace(/\/$/, ''),
      processNames: list(value(fileConfig, 'local.processNames', 'ASENIX_NODE_PROCESS_NAMES', '')),
      systemdServices: list(value(fileConfig, 'local.systemdServices', 'ASENIX_SYSTEMD_SERVICES', '')),
    },
    operatorAddress: String(value(fileConfig, 'operatorAddress', 'ASENIX_OPERATOR_ADDRESS', '')).trim().toLowerCase(),
    publicRpcUrl: String(value(fileConfig, 'publicRpcUrl', 'ASENIX_PUBLIC_RPC_URL', 'https://testnet.asentum.com')).replace(/\/$/, ''),
    scanWindowBlocks: Math.max(
      1,
      numberValue(value(fileConfig, 'scanWindowBlocks', 'ASENIX_SCAN_WINDOW_BLOCKS', 256), 256),
    ),
    statePath,
    telegram: {
      chatIds: list(value(fileConfig, 'telegram.chatIds', 'ASENIX_TELEGRAM_CHAT_IDS', '')),
      token: String(value(fileConfig, 'telegram.token', 'TELEGRAM_BOT_TOKEN', '')).trim(),
    },
    thresholds,
  };
}

export function describeEnabledChecks(config) {
  const enabled = [];
  if (config.local.nodeRpcUrl) enabled.push(`local RPC ${config.local.nodeRpcUrl}`);
  if (config.local.systemdServices.length) enabled.push(`systemd ${config.local.systemdServices.join(', ')}`);
  if (config.local.dockerContainers.length) enabled.push(`docker ${config.local.dockerContainers.join(', ')}`);
  if (config.local.processNames.length) enabled.push(`process ${config.local.processNames.join(', ')}`);
  if (config.local.diskPaths.length) enabled.push(`disk ${config.local.diskPaths.join(', ')}`);
  if (config.local.logFiles.length) enabled.push(`logs ${config.local.logFiles.join(', ')}`);
  return enabled;
}
