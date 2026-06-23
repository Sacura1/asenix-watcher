import os from 'node:os';

import { loadConfig } from './config.mjs';
import { checkLocalNode } from './local-node.mjs';

const config = await loadConfig();
const serverUrl = String(process.env.ASENIX_WATCHER_SERVER || '').replace(/\/$/, '');
const token = String(process.env.ASENIX_WATCHER_TOKEN || '').trim();
const intervalSeconds = Math.max(15, Number(process.env.ASENIX_AGENT_INTERVAL_SECONDS || 60));

if (!serverUrl) throw new Error('ASENIX_WATCHER_SERVER is required');
if (!token) throw new Error('ASENIX_WATCHER_TOKEN is required');

async function sendHeartbeat(snapshot) {
  const response = await fetch(`${serverUrl}/api/agent/heartbeat`, {
    body: JSON.stringify({
      hostname: os.hostname(),
      platform: {
        arch: os.arch(),
        platform: os.platform(),
        release: os.release(),
        uptimeSec: Math.round(os.uptime()),
      },
      snapshot,
      version: '0.1.0',
    }),
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(`heartbeat failed with ${response.status}: ${await response.text()}`);
  }
}

console.log('Asenix Watcher Machine alerts started');
console.log(`Server: ${serverUrl}`);
console.log('Mode: outbound-only, read-only');

while (true) {
  try {
    const local = await checkLocalNode(config, null);
    await sendHeartbeat({
      checkedAt: new Date().toISOString(),
      local,
    });
    console.log(`${new Date().toISOString()} heartbeat sent (${local.status})`);
  } catch (error) {
    console.error(error);
  }
  await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
}
