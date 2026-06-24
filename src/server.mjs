import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectChainSnapshot } from './asentum-rpc.mjs';
import { loadConfig } from './config.mjs';
import { loadJson, saveJson } from './store.mjs';
import { TelegramClient } from './telegram.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLER_SCRIPT = await fs.readFile(
  path.join(ROOT_DIR, 'install-machine-alerts.sh'),
  'utf8',
);
const POWERSHELL_INSTALLER_SCRIPT = await fs.readFile(
  path.join(ROOT_DIR, 'install-machine-alerts.ps1'),
  'utf8',
);
const config = await loadConfig();
const serverPort = Number(process.env.PORT || process.env.ASENIX_WATCHER_PORT || 8787);
const publicBaseUrl = String(process.env.ASENIX_WATCHER_PUBLIC_URL || 'https://watch.asenix.net').replace(/\/$/, '');
const machineInstallerUrl = String(
  process.env.ASENIX_MACHINE_INSTALLER_URL ||
    `${publicBaseUrl}/install-machine-alerts.sh`,
).trim();
const statePath = process.env.ASENIX_WATCHER_SERVER_STATE
  ? path.resolve(process.env.ASENIX_WATCHER_SERVER_STATE)
  : path.join(ROOT_DIR, 'watcher-server-state.json');

if (!config.telegram.token) {
  throw new Error('TELEGRAM_BOT_TOKEN or telegram.token is required for server mode');
}

const telegram = new TelegramClient(config.telegram.token);
const state = await loadJson(statePath, {
  chats: {},
  telegramOffset: 0,
});
state.chats ??= {};
state.telegramOffset ??= 0;

try {
  await setupBotCommands();
} catch (error) {
  console.error('Failed to set Telegram bot command menu:', error);
}

function nowIso() {
  return new Date().toISOString();
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function makeToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function getChat(chatId) {
  const key = String(chatId);
  state.chats[key] ??= {
    agent: null,
    createdAt: nowIso(),
    lastAlertAt: 0,
    lastStatus: null,
    pairing: null,
  };
  return state.chats[key];
}

async function persist() {
  await saveJson(statePath, state);
}

function isAddress(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(value ?? '').trim());
}

function shortAddress(address) {
  if (!address) return 'not set';
  return `${address.slice(0, 8)}...${address.slice(-6)}`;
}

function addressCode(address) {
  return `<code>${escapeHtml(address || 'not set')}</code>`;
}

function formatAge(iso) {
  if (!iso) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return `${formatDuration(seconds)} ago`;
}

function formatDuration(secondsInput) {
  if (secondsInput === null || secondsInput === undefined) return 'unknown';
  const seconds = Math.max(0, Math.round(Number(secondsInput)));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatAse(balance) {
  const value = balance?.balance ?? balance?.value;
  if (value === undefined || value === null) return 'unknown';
  try {
    const ase = Number(BigInt(value)) / 1e18;
    return `${ase.toLocaleString(undefined, { maximumFractionDigits: 4 })} ASE`;
  } catch {
    return String(value);
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function statusIcon(status) {
  if (status === 'critical' || status === 'bad') return '\u274c';
  if (status === 'warning' || status === 'stale') return '\u26a0\ufe0f';
  if (status === 'info' || status === 'not-connected') return '\u2139\ufe0f';
  return '\u2705';
}

function machineHeartbeatAgeSeconds(agent) {
  if (!agent?.lastSeenAt) return null;
  return Math.max(0, Math.round((Date.now() - Date.parse(agent.lastSeenAt)) / 1000));
}

function machineStaleSeconds() {
  return Math.max(
    config.thresholds.machineHeartbeatStaleSeconds,
    config.thresholds.pollSeconds * 3,
  );
}

function machineStatusFromAgent(agent) {
  if (!agent?.lastSeenAt) return 'not-connected';
  const seconds = machineHeartbeatAgeSeconds(agent);
  if (seconds !== null && seconds > machineStaleSeconds()) return 'stale';
  return agent.snapshot?.local?.status ?? 'unknown';
}

function machineStatusText(status) {
  if (status === 'ok') return 'Healthy';
  if (status === 'warning') return 'Needs attention';
  if (status === 'critical') return 'Action needed';
  if (status === 'stale') return 'Heartbeat delayed';
  if (status === 'not-connected') return 'Not connected';
  return 'Unknown';
}

function processStateText(item) {
  if (item.ok && item.coveredBy === 'systemd') return `verified by systemd (${item.systemdService})`;
  if (item.ok) return 'running';
  return 'not matched';
}

function dashboardKeyboard() {
  return {
    inline_keyboard: [
      [
        { callback_data: 'status', text: '\ud83d\udcca Status' },
        { callback_data: 'chain', text: '\ud83d\udd17 Chain status' },
      ],
      [
        { callback_data: 'node', text: '\ud83d\udda5\ufe0f Machine status' },
        { callback_data: 'connect_machine', text: '\u2795 Setup alerts' },
      ],
      [{ callback_data: 'help', text: '\u2754 Help' }],
    ],
  };
}

function persistentMenuKeyboard() {
  return {
    is_persistent: true,
    keyboard: [
      [{ text: 'Status' }, { text: 'Chain status' }],
      [{ text: 'Machine status' }, { text: 'Setup alerts' }],
      [{ text: 'Help' }],
    ],
    resize_keyboard: true,
  };
}

function normalizeCommandText(text) {
  const normalized = String(text ?? '').trim().toLowerCase();
  const map = new Map([
    ['status', '/status'],
    ['dashboard', '/status'],
    ['chain', '/chain'],
    ['chain status', '/chain'],
    ['validator status', '/chain'],
    ['machine', '/node'],
    ['machine status', '/node'],
    ['node', '/node'],
    ['node status', '/node'],
    ['setup alerts', '/connect_machine'],
    ['machine alerts', '/connect_machine'],
    ['connect machine', '/connect_machine'],
    ['help', '/help'],
  ]);
  return map.get(normalized) ?? text;
}

async function setupBotCommands() {
  await telegram.setMyCommands([
    { command: 'status', description: 'Open validator status dashboard' },
    { command: 'chain', description: 'Check public chain health' },
    { command: 'node', description: 'Check machine alert status' },
    { command: 'connect_machine', description: 'Set up machine alerts' },
    { command: 'add', description: 'Add validator wallet' },
    { command: 'remove', description: 'Remove this chat data' },
    { command: 'help', description: 'Show help' },
  ]);
}

function validatorSetText(isValidator) {
  return isValidator
    ? 'found'
    : 'not found - this usually means the wallet is not currently in the active validator set, but it does not by itself prove the machine is offline';
}

function validatorCountText(chain) {
  return chain?.validatorCount === null || chain?.validatorCount === undefined
    ? 'unknown'
    : chain.validatorCount.toLocaleString();
}

function explainProposalWindow(chain) {
  const count = chain.window.proposedByAddress;
  const scanned = chain.window.blocksScanned;
  if (count === 0) {
    return `No proposed block found in the last ${scanned} checked blocks. This can be normal for small validators, but if it stays this way for long, check node health.`;
  }
  return `This validator produced ${count} of the last ${scanned} checked blocks.`;
}

function latestBlockAgeText(chain) {
  const age = chain?.window?.latestBlockAgeSec;
  return age === null || age === undefined ? 'unknown' : `${formatDuration(age)} ago`;
}

function appendChainStats(lines, chain) {
  const chainHealth = analyzeChainHealth(chain);
  lines.push(`\ud83d\udd17 <b>Current block:</b> #${chain.chain.height.toLocaleString()}`);
  lines.push(`\ud83d\udcca <b>Total blocks:</b> ${chain.chain.height.toLocaleString()}`);
  lines.push(`${statusIcon(chainHealth.issues.find((issue) => issue.label === 'Last block')?.status ?? 'ok')} <b>Last block age:</b> ${escapeHtml(latestBlockAgeText(chain))}`);
  lines.push(`${statusIcon(chainHealth.issues.find((issue) => issue.label === 'Validator set')?.status ?? 'ok')} <b>Total validators:</b> ${escapeHtml(validatorCountText(chain))}`);
  lines.push(`\ud83d\udce6 <b>Mempool:</b> ${chain.chain.mempoolSize.toLocaleString()}`);
  if (chain.chain.latestProposer) {
    lines.push(`\ud83e\uddf1 <b>Latest proposer:</b> <code>${escapeHtml(shortAddress(chain.chain.latestProposer))}</code>`);
  }
}

function analyzeChainHealth(chain) {
  const issues = [];
  if (!chain) {
    return {
      issues: [{ label: 'Public chain check', status: 'warning', text: 'Could not read chain data' }],
      status: 'warning',
    };
  }

  if (chain.validatorCount === 0) {
    issues.push({
      label: 'Validator set',
      status: 'critical',
      text: 'No validators returned by public RPC',
    });
  } else if (chain.validatorCount === null || chain.validatorCount === undefined) {
    issues.push({
      label: 'Validator set',
      status: 'info',
      text: 'Validator count unavailable from public RPC',
    });
  }

  if (chain.window.latestBlockAgeSec === null || chain.window.latestBlockAgeSec === undefined) {
    issues.push({
      label: 'Last block',
      status: 'warning',
      text: 'Could not read the latest block timestamp',
    });
  } else if (chain.window.latestBlockAgeSec >= config.thresholds.publicBlockCriticalSeconds) {
    issues.push({
      label: 'Last block',
      status: 'critical',
      text: `Latest scanned block is ${formatDuration(chain.window.latestBlockAgeSec)} old`,
    });
  } else if (chain.window.latestBlockAgeSec >= config.thresholds.publicBlockStaleSeconds) {
    issues.push({
      label: 'Last block',
      status: 'warning',
      text: `Latest scanned block is ${formatDuration(chain.window.latestBlockAgeSec)} old`,
    });
  }

  const highest = issues.some((issue) => issue.status === 'critical')
    ? 'critical'
    : issues.some((issue) => issue.status === 'warning')
      ? 'warning'
      : issues.some((issue) => issue.status === 'info')
        ? 'info'
        : 'ok';

  return { issues, status: highest };
}

function scoreFromChecks({ chain = null, machineStatus = 'not-connected' }) {
  let score = 100;
  const checks = [];

  const chainHealth = analyzeChainHealth(chain);
  if (chainHealth.status === 'critical') score -= 35;
  else if (chainHealth.status === 'warning') score -= 20;
  else if (chainHealth.status === 'info') score -= 5;

  if (!chain) {
    score -= 25;
  } else {
    checks.push({ label: 'Public chain check', status: 'ok', text: `Height ${chain.chain.height}` });
    checks.push({
      label: 'Last block',
      status: chainHealth.issues.find((issue) => issue.label === 'Last block')?.status ?? 'ok',
      text: chain.window.latestBlockAgeSec === null || chain.window.latestBlockAgeSec === undefined
        ? 'Timestamp unavailable'
        : `${formatDuration(chain.window.latestBlockAgeSec)} old`,
    });
    checks.push({
      label: 'Total validators',
      status: chainHealth.issues.find((issue) => issue.label === 'Validator set')?.status ?? 'ok',
      text: validatorCountText(chain),
    });
    if (chain.isValidator) {
      checks.push({ label: 'Validator set', status: 'ok', text: 'Wallet is active in validator data' });
    } else {
      score -= 35;
      checks.push({ label: 'Validator set', status: 'warning', text: 'Wallet not found in validator data' });
    }
    if (chain.window.proposedByAddress > 0) {
      checks.push({ label: 'Recent proposals', status: 'ok', text: explainProposalWindow(chain) });
    } else {
      score -= 10;
      checks.push({ label: 'Recent proposals', status: 'info', text: explainProposalWindow(chain) });
    }
  }

  for (const issue of chainHealth.issues) {
    if (!checks.some((check) => check.label === issue.label)) checks.push(issue);
  }

  if (machineStatus === 'not-connected') {
    score -= 10;
    checks.push({ label: 'Machine alerts', status: 'info', text: 'Not connected. Public checks are still active.' });
  } else if (machineStatus === 'ok') {
    checks.push({ label: 'Machine alerts', status: 'ok', text: 'Connected and healthy' });
  } else if (machineStatus === 'warning') {
    score -= 20;
    checks.push({ label: 'Machine alerts', status: 'warning', text: 'Connected, but warnings were found' });
  } else if (machineStatus === 'stale') {
    score -= 20;
    checks.push({ label: 'Machine alerts', status: 'warning', text: 'Heartbeat is delayed; waiting for the next machine report' });
  } else {
    score -= 40;
    checks.push({ label: 'Machine alerts', status: 'critical', text: `Machine status is ${machineStatus}` });
  }

  return {
    checks,
    label: score >= 90 ? 'Everything looks good' : score >= 70 ? 'Needs attention' : 'Action needed',
    score: Math.max(0, Math.min(100, score)),
  };
}

async function collectChain(address) {
  return collectChainSnapshot({
    address,
    rpcUrl: config.publicRpcUrl,
    timeoutMs: config.thresholds.requestTimeoutMs,
    windowSize: config.scanWindowBlocks,
  });
}

function summarizeAgent(agent) {
  const status = machineStatusFromAgent(agent);
  const lines = ['<b>Machine Status</b>', ''];
  if (!agent?.lastSeenAt) {
    lines.push(`${statusIcon('not-connected')} <b>Status:</b> ${machineStatusText('not-connected')}`);
    lines.push('\u2139\ufe0f <b>Machine alerts:</b> Run Setup alerts on the node machine to enable local checks.');
    return lines;
  }

  const snapshot = agent.snapshot;
  const local = snapshot?.local;
  lines.push(`${statusIcon(status)} <b>Status:</b> ${machineStatusText(status)}`);
  lines.push(`\ud83d\udd52 <b>Heartbeat:</b> ${escapeHtml(formatAge(agent.lastSeenAt))}`);
  lines.push(`\ud83d\udda5\ufe0f <b>Machine:</b> ${escapeHtml(agent.hostname || 'unknown')}`);

  if (!local) return lines;
  if (local.localRpc?.ok) {
    lines.push(`\ud83d\udd17 <b>Local node:</b> height ${local.localRpc.chain.height.toLocaleString()}, ready ${local.localRpc.ready ? 'yes' : 'no'}`);
  } else if (local.localRpc) {
    lines.push(`\u274c <b>Local node:</b> failed (${escapeHtml(local.localRpc.error)})`);
  }
  if (local.systemd?.length) {
    lines.push(`${statusIcon(local.systemd.every((item) => item.ok) ? 'ok' : 'critical')} <b>Systemd:</b> ${escapeHtml(local.systemd.map((item) => `${item.service}=${item.state}`).join(', '))}`);
  }
  if (local.processes?.length) {
    lines.push(`${statusIcon(local.processes.every((item) => item.ok) ? 'ok' : 'warning')} <b>Process:</b> ${escapeHtml(local.processes.map((item) => `${item.name}=${processStateText(item)}`).join(', '))}`);
  }
  if (local.disks?.length) {
    lines.push(`${statusIcon(local.disks.every((item) => item.ok) ? 'ok' : 'warning')} <b>Disk:</b> ${escapeHtml(local.disks.map((item) => `${item.path} ${item.usedPercent ?? '?'}%`).join(', '))}`);
  }
  if (local.memory) {
    lines.push(`${statusIcon(local.memory.status)} <b>Memory:</b> ${local.memory.usedPercent}% used`);
  }
  if (local.issues?.length) {
    lines.push('');
    lines.push('<b>Needs attention</b>');
    for (const issue of local.issues.slice(0, 6)) {
      lines.push(`${statusIcon(issue.severity)} ${escapeHtml(issue.message)}`);
    }
  } else {
    lines.push('');
    lines.push('\u2705 <b>Checks:</b> No machine issues found.');
  }
  return lines;
}

async function formatStatus(chat) {
  if (!chat.address) {
    return 'No validator wallet added yet. Send /add 0xYourValidatorWallet.';
  }

  let chain = null;
  let chainError = '';
  try {
    chain = await collectChain(chat.address);
  } catch (error) {
    chainError = error instanceof Error ? error.message : 'unknown error';
  }

  const machineStatus = chatNodeStatus(chat);
  const health = scoreFromChecks({ chain, machineStatus });
  const lines = [
    `<b>Asenix Watcher Dashboard</b>`,
    addressCode(chat.address),
    '',
    `${statusIcon(health.score >= 70 ? 'ok' : 'warning')} <b>${health.label}</b> - <b>${health.score}/100</b>`,
    '',
  ];

  if (chain) {
    appendChainStats(lines, chain);
    lines.push(`${chain.isValidator ? '\u2705' : '\u26a0\ufe0f'} <b>Validator:</b> ${chain.isValidator ? 'active in validator data' : 'not found in validator data'}`);
    lines.push(`\ud83d\udcb0 <b>Balance:</b> ${escapeHtml(formatAse(chain.balance))}`);
    lines.push(`\ud83c\udfd7\ufe0f <b>Recent block production:</b> ${escapeHtml(explainProposalWindow(chain))}`);
    if (chain.window.lastProposedBlock) {
      lines.push(`\ud83e\uddf1 <b>Last proposed block:</b> #${chain.window.lastProposedBlock.height.toLocaleString()}`);
    } else {
      lines.push(`\ud83e\uddf1 <b>Last proposed block:</b> none in checked window`);
    }
  } else {
    lines.push(`\u26a0\ufe0f <b>Chain check failed:</b> ${escapeHtml(chainError)}`);
  }

  lines.push('');
  lines.push(`<b>Checks</b>`);
  for (const check of health.checks) {
    lines.push(`${statusIcon(check.status)} <b>${escapeHtml(check.label)}:</b> ${escapeHtml(check.text)}`);
  }
  lines.push('');
  lines.push(`<i>Use the buttons below instead of typing commands.</i>`);
  return lines.join('\n');
}

function connectCommand(token) {
  const watcherRepo = String(process.env.ASENIX_WATCHER_REPO || '').trim();
  const linuxRepoEnv = watcherRepo ? ` ASENIX_WATCHER_REPO="${watcherRepo}"` : '';
  const windowsRepoEnv = watcherRepo ? `; $env:ASENIX_WATCHER_REPO="${watcherRepo}"` : '';
  const linuxOneLiner = `ASENIX_WATCHER_SERVER="${publicBaseUrl}" ASENIX_WATCHER_TOKEN="${token}"${linuxRepoEnv} sh -c "$(curl -fsSL ${machineInstallerUrl})"`;
  const windowsOneLiner = `$env:ASENIX_WATCHER_SERVER="${publicBaseUrl}"; $env:ASENIX_WATCHER_TOKEN="${token}"${windowsRepoEnv}; iex (irm ${publicBaseUrl}/install-machine-alerts.ps1)`;
  return [
    '<b>Enable Machine alerts</b>',
    '',
    'Run one of these on the machine running the Asentum node/operator.',
    '',
    '<b>Linux VPS</b>',
    '<code>' + escapeHtml(linuxOneLiner) + '</code>',
    '',
    '<b>Windows Operator app</b>',
    '<code>' + escapeHtml(windowsOneLiner) + '</code>',
    '',
    'Machine alerts are outbound-only and read-only.',
  ].join('\n');
}

function chatNodeStatus(chat) {
  return machineStatusFromAgent(chat.agent);
}

async function assessChat(chat) {
  if (!chat.address) {
    return { issues: [], status: 'empty', text: 'No validator wallet configured.' };
  }

  const issues = [];
  let chain = null;
  let chainError = '';
  try {
    chain = await collectChain(chat.address);
    for (const issue of analyzeChainHealth(chain).issues) {
      if (issue.status === 'critical' || issue.status === 'warning') {
        issues.push({
          severity: issue.status,
          text: issue.text,
        });
      }
    }
    if (!chain.isValidator) {
      issues.push({
        severity: 'warning',
        text: 'Wallet is not currently found in the active validator set',
      });
    }
    if (chain.window.proposedByAddress === 0 && chain.window.blocksScanned > 0) {
      issues.push({
        severity: 'info',
        text: `No proposed block found in the last ${chain.window.blocksScanned} scanned blocks`,
      });
    }
  } catch (error) {
    chainError = error instanceof Error ? error.message : 'unknown error';
    issues.push({
      severity: 'warning',
      text: `Public chain check failed: ${chainError}`,
    });
  }

  const nodeStatus = chatNodeStatus(chat);
  if (nodeStatus === 'stale') {
    issues.push({ severity: 'warning', text: 'Machine alerts heartbeat is delayed' });
  } else if (nodeStatus === 'critical') {
    issues.push({ severity: 'critical', text: 'Machine node checks are critical' });
  } else if (nodeStatus === 'warning') {
    issues.push({ severity: 'warning', text: 'Machine node checks have warnings' });
  }

  const rank = { critical: 3, warning: 2, info: 1 };
  const highest = issues.reduce((value, issue) => Math.max(value, rank[issue.severity] ?? 0), 0);
  const status = highest === 3 ? 'critical' : highest === 2 ? 'warning' : 'ok';
  const health = scoreFromChecks({ chain, machineStatus: nodeStatus });
  const lines = [
    `${statusIcon(status)} <b>Asenix Watcher Alert</b>`,
    addressCode(chat.address),
    '',
    `${statusIcon(health.score >= 70 ? 'ok' : 'warning')} <b>${health.label}</b> - <b>${health.score}/100</b>`,
  ];

  if (chain) {
    lines.push('');
    appendChainStats(lines, chain);
    lines.push(`${chain.isValidator ? '\u2705' : '\u26a0\ufe0f'} <b>Validator:</b> ${chain.isValidator ? 'active in validator data' : 'not found in validator data'}`);
    lines.push(`\ud83d\udcb0 <b>Balance:</b> ${escapeHtml(formatAse(chain.balance))}`);
    lines.push(`\ud83c\udfd7\ufe0f <b>Recent block production:</b> ${escapeHtml(explainProposalWindow(chain))}`);
    if (chain.window.lastProposedBlock) {
      lines.push(`\ud83e\uddf1 <b>Last proposed block:</b> #${chain.window.lastProposedBlock.height.toLocaleString()}`);
    } else {
      lines.push(`\ud83e\uddf1 <b>Last proposed block:</b> none in checked window`);
    }
  } else {
    lines.push('');
    lines.push(`\u26a0\ufe0f <b>Chain check failed:</b> ${escapeHtml(chainError)}`);
  }

  lines.push('');
  lines.push(`${statusIcon(nodeStatus)} <b>Machine alerts:</b> ${escapeHtml(machineStatusText(nodeStatus))}`);

  if (issues.length) {
    lines.push('');
    lines.push('<b>Needs attention</b>');
    for (const issue of issues.slice(0, 6)) {
      lines.push(`${statusIcon(issue.severity)} ${escapeHtml(issue.text)}`);
    }
  } else {
    lines.push('');
    lines.push('\u2705 Everything is in check right now.');
  }
  return { issues, status, text: lines.join('\n') };
}

async function handleTelegramMessage(message) {
  const chatId = String(message.chat.id);
  const chat = getChat(chatId);
  const text = String(normalizeCommandText(message.text ?? '')).trim();
  const [rawCommand, ...args] = text.split(/\s+/);
  const command = rawCommand.toLowerCase().split('@')[0];

  if (command) {
    try {
      await telegram.sendChatAction(chatId, 'typing');
    } catch {
      // Non-critical; responses should still be sent if chat actions fail.
    }
  }

  if (command === '/start' || command === '/help') {
    if (chat.address) {
      await telegram.sendMessage(
        chatId,
        [
          '<b>Asenix Watcher</b>',
          addressCode(chat.address),
          '',
          'Use the menu buttons below to check your validator.',
        ].join('\n'),
        { parseMode: 'HTML', replyMarkup: persistentMenuKeyboard() },
      );
    } else {
      await telegram.sendMessage(
        chatId,
        [
          '<b>Asenix Watcher</b>',
          'Track your Asentum validator from Telegram.',
          '',
          '<b>Start:</b>',
          '<code>/add 0xYourValidatorWallet</code>',
          '',
          'After adding a wallet, use the menu buttons below.',
        ].join('\n'),
        { parseMode: 'HTML', replyMarkup: persistentMenuKeyboard() },
      );
    }
    return;
  }

  if (command === '/add') {
    const address = args[0];
    if (!isAddress(address)) {
      await telegram.sendMessage(chatId, 'Send it like: /add 0xYourValidatorWallet');
      return;
    }
    chat.address = address.toLowerCase();
    chat.updatedAt = nowIso();
    await persist();
    await telegram.sendMessage(
      chatId,
      [
        `\u2705 <b>Wallet added</b>`,
        addressCode(chat.address),
        '',
        'Public chain checks are now active.',
        '',
        'If validator status shows <b>not found</b>, the wallet is probably not active in validator data. That can be setup, stake, sync, node-health, or wrong-wallet related.',
        '',
        'Machine alerts are optional and add peers, sync, service, disk, memory, and log checks.',
      ].join('\n'),
      { parseMode: 'HTML', replyMarkup: persistentMenuKeyboard() },
    );
    return;
  }

  if (command === '/status') {
    await telegram.sendMessage(chatId, await formatStatus(chat), {
      parseMode: 'HTML',
      replyMarkup: dashboardKeyboard(),
    });
    return;
  }

  if (command === '/chain') {
    if (!chat.address) {
      await telegram.sendMessage(chatId, 'No wallet added. Send /add 0xYourValidatorWallet.');
      return;
    }
    const chain = await collectChain(chat.address);
    await telegram.sendMessage(
      chatId,
      [
        `<b>Chain Status</b>`,
        addressCode(chat.address),
        '',
        ...(() => {
          const stats = [];
          appendChainStats(stats, chain);
          return stats;
        })(),
        `\ud83d\udcb0 <b>Balance:</b> ${escapeHtml(formatAse(chain.balance))}`,
        `${chain.isValidator ? '\u2705' : '\u26a0\ufe0f'} <b>Validator:</b> ${chain.isValidator ? 'active in validator data' : escapeHtml(validatorSetText(false))}`,
        `\ud83c\udfd7\ufe0f <b>Block production:</b> ${escapeHtml(explainProposalWindow(chain))}`,
        chain.window.lastProposedBlock
          ? `\ud83e\uddf1 <b>Last proposed block:</b> #${chain.window.lastProposedBlock.height.toLocaleString()}`
          : '\ud83e\uddf1 <b>Last proposed block:</b> none in checked window',
      ].join('\n'),
      { parseMode: 'HTML', replyMarkup: dashboardKeyboard() },
    );
    return;
  }

  if (command === '/node') {
    await telegram.sendMessage(chatId, summarizeAgent(chat.agent).join('\n'), {
      parseMode: 'HTML',
      replyMarkup: dashboardKeyboard(),
    });
    return;
  }

  if (command === '/connect_machine' || command === '/connect_vps' || command === '/connect_node') {
    if (!chat.address) {
      await telegram.sendMessage(chatId, 'Add the validator wallet first: /add 0xYourValidatorWallet');
      return;
    }
    const token = makeToken();
    chat.pairing = {
      createdAt: nowIso(),
      tokenHash: hashToken(token),
    };
    await persist();
    await telegram.sendMessage(chatId, connectCommand(token), {
      parseMode: 'HTML',
      replyMarkup: dashboardKeyboard(),
    });
    return;
  }

  if (command === '/remove') {
    delete state.chats[chatId];
    await persist();
    await telegram.sendMessage(chatId, 'Removed your watcher data from this bot.');
    return;
  }

  await telegram.sendMessage(chatId, 'Unknown command. Send /help.');
}

async function handleCallback(callbackQuery) {
  await telegram.answerCallbackQuery(callbackQuery.id);
  const chatId = String(callbackQuery.message.chat.id);
  try {
    await telegram.sendChatAction(chatId, 'typing');
  } catch {
    // Non-critical; callbacks should still continue if chat actions fail.
  }
  const data = String(callbackQuery.data ?? '');
  const synthetic = {
    chat: { id: chatId },
    text:
      data === 'status'
        ? '/status'
        : data === 'chain'
          ? '/chain'
          : data === 'node'
            ? '/node'
            : data === 'connect_machine'
              ? '/connect_machine'
              : '/help',
  };
  await handleTelegramMessage(synthetic);
}

async function pollTelegram() {
  const updates = await telegram.getUpdates(state.telegramOffset || 0);
  for (const update of updates) {
    state.telegramOffset = update.update_id + 1;
    if (update.message?.text) {
      await handleTelegramMessage(update.message);
    } else if (update.callback_query) {
      await handleCallback(update.callback_query);
    }
  }
  await persist();
}

async function monitorChats() {
  const now = Date.now();
  const reminderMs = config.thresholds.reminderMinutes * 60 * 1000;
  for (const [chatId, chat] of Object.entries(state.chats)) {
    if (!chat.address) continue;
    try {
      const assessment = await assessChat(chat);
      const changed = assessment.status !== chat.lastStatus;
      const reminderDue =
        assessment.status !== 'ok' && now - (chat.lastAlertAt || 0) > reminderMs;
      chat.lastStatus = assessment.status;
      const shouldSendRecovery = changed && assessment.status === 'ok' && chat.lastAlertAt;
      const shouldSendProblem = assessment.status !== 'ok' && (changed || reminderDue);
      if (shouldSendRecovery || shouldSendProblem) {
        await telegram.sendMessage(chatId, assessment.text, { parseMode: 'HTML' });
        chat.lastAlertAt = now;
      }
    } catch (error) {
      console.error(error);
    }
  }
  await persist();
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function findChatByToken(token) {
  const tokenHash = hashToken(token);
  return Object.entries(state.chats).find(([, chat]) => chat.pairing?.tokenHash === tokenHash);
}

async function handleHeartbeat(request, response) {
  try {
    const body = await readBody(request);
    const auth = request.headers.authorization || '';
    const token = auth.toLowerCase().startsWith('bearer ')
      ? auth.slice(7).trim()
      : String(body.token ?? '').trim();
    const match = token ? findChatByToken(token) : null;
    if (!match) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: 'invalid pairing token' }));
      return;
    }
    const [, chat] = match;
    chat.agent = {
      hostname: String(body.hostname || 'unknown'),
      lastSeenAt: nowIso(),
      platform: body.platform ?? null,
      snapshot: body.snapshot ?? null,
      version: body.version ?? null,
    };
    await persist();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  } catch (error) {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'bad request' }));
  }
}

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ hostname: os.hostname(), ok: true }));
    return;
  }
  if (request.method === 'GET' && request.url === '/install-machine-alerts.sh') {
    response.writeHead(200, {
      'content-type': 'text/x-shellscript; charset=utf-8',
    });
    response.end(INSTALLER_SCRIPT);
    return;
  }
  if (request.method === 'GET' && request.url === '/install-machine-alerts.ps1') {
    response.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
    });
    response.end(POWERSHELL_INSTALLER_SCRIPT);
    return;
  }
  if (request.method === 'POST' && request.url === '/api/agent/heartbeat') {
    void handleHeartbeat(request, response);
    return;
  }
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ ok: false, error: 'not found' }));
});

server.listen(serverPort, () => {
  console.log(`Asenix Watcher server listening on ${serverPort}`);
  console.log(`State: ${statePath}`);
  console.log(`Public URL shown to users: ${publicBaseUrl}`);
});

let lastMonitorAt = 0;
while (true) {
  try {
    await pollTelegram();
    const now = Date.now();
    if (now - lastMonitorAt >= config.thresholds.pollSeconds * 1000) {
      lastMonitorAt = now;
      await monitorChats();
    }
  } catch (error) {
    console.error(error);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}
