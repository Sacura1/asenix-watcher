import { collectStatus, formatStatusMessage } from './status.mjs';
import { loadConfig } from './config.mjs';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

const config = await loadConfig();
config.publicRpcUrl = String(arg('rpc', config.publicRpcUrl)).replace(/\/$/, '');
config.operatorAddress = String(arg('address', config.operatorAddress)).toLowerCase();
config.scanWindowBlocks = Math.max(1, Number(arg('window', config.scanWindowBlocks)));

const json = process.argv.includes('--json');
const snapshot = await collectStatus(config);

console.log(json ? JSON.stringify(snapshot, null, 2) : formatStatusMessage(snapshot));
