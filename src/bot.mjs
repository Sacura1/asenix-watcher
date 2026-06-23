import { loadConfig } from './config.mjs';
import { loadState, saveState } from './state.mjs';
import {
  collectStatus,
  formatChainMessage,
  formatNodeMessage,
  formatStatusMessage,
} from './status.mjs';
import { TelegramClient } from './telegram.mjs';

const config = await loadConfig();
if (!config.telegram.token) {
  throw new Error('TELEGRAM_BOT_TOKEN or telegram.token is required');
}

const telegram = new TelegramClient(config.telegram.token);
const state = await loadState(config.statePath);
state.registeredChats ??= [];
state.telegramOffset ??= 0;

function chats() {
  const configured = config.telegram.chatIds.map(String);
  return configured.length ? configured : (state.registeredChats ?? []);
}

function isAuthorized(chatId) {
  const configured = config.telegram.chatIds.map(String);
  if (!configured.length) {
    return state.registeredChats.length === 0 || state.registeredChats.includes(String(chatId));
  }
  return configured.includes(String(chatId));
}

async function persist() {
  await saveState(config.statePath, state);
}

async function sendToChats(text) {
  for (const chatId of chats()) {
    await telegram.sendMessage(chatId, text);
  }
}

async function collectAndFormat(options = {}) {
  const snapshot = await collectStatus(config);
  return {
    snapshot,
    text: formatStatusMessage(snapshot, options),
  };
}

async function handleCommand(message) {
  const chatId = String(message.chat.id);
  const text = String(message.text ?? '').trim();
  const command = text.split(/\s+/)[0].toLowerCase().split('@')[0];

  if (!isAuthorized(chatId)) {
    await telegram.sendMessage(chatId, 'This chat is not authorized for this watcher.');
    return;
  }

  if (command === '/start') {
    if (!config.telegram.chatIds.length && state.registeredChats.length === 0) {
      state.registeredChats.push(chatId);
      await persist();
    }
    await telegram.sendMessage(
      chatId,
      [
        'Asenix Watcher connected.',
        '',
        'Commands:',
        '/status - full node and chain status',
        '/node - local VPS/node status',
        '/chain - public chain and validator status',
        '/config - enabled checks',
        '/help - command list',
      ].join('\n'),
    );
    return;
  }

  if (command === '/help') {
    await telegram.sendMessage(
      chatId,
      [
        'Asenix Watcher commands:',
        '/status - full node and chain status',
        '/node - local VPS/node status',
        '/chain - public chain and validator status',
        '/config - enabled checks',
      ].join('\n'),
    );
    return;
  }

  if (command === '/config') {
    await telegram.sendMessage(
      chatId,
      [
        `Public RPC: ${config.publicRpcUrl}`,
        `Operator address: ${config.operatorAddress || 'not set'}`,
        `Scan window: ${config.scanWindowBlocks} blocks`,
        `Local RPC: ${config.local.nodeRpcUrl || 'not configured'}`,
        `Systemd: ${config.local.systemdServices.join(', ') || 'not configured'}`,
        `Docker: ${config.local.dockerContainers.join(', ') || 'not configured'}`,
        `Processes: ${config.local.processNames.join(', ') || 'not configured'}`,
        `Disks: ${config.local.diskPaths.join(', ') || 'not configured'}`,
        `Logs: ${config.local.logFiles.join(', ') || 'not configured'}`,
      ].join('\n'),
    );
    return;
  }

  if (command === '/status' || command === '/node' || command === '/chain') {
    const { snapshot } = await collectAndFormat();
    if (command === '/node') {
      await telegram.sendMessage(chatId, formatNodeMessage(snapshot));
      return;
    }
    if (command === '/chain') {
      await telegram.sendMessage(chatId, formatChainMessage(snapshot));
      return;
    }
    await telegram.sendMessage(chatId, formatStatusMessage(snapshot));
    return;
  }

  await telegram.sendMessage(chatId, 'Unknown command. Send /help.');
}

async function pollTelegram() {
  const updates = await telegram.getUpdates(state.telegramOffset || 0);
  for (const update of updates) {
    state.telegramOffset = update.update_id + 1;
    const message = update.message;
    if (message?.text) {
      await handleCommand(message);
    }
  }
  await persist();
}

async function monitorOnce() {
  const now = Date.now();
  const { snapshot, text } = await collectAndFormat({ compact: true });
  const reminderMs = config.thresholds.reminderMinutes * 60 * 1000;
  const changed = snapshot.status !== state.lastStatus;
  const reminderDue =
    snapshot.status !== 'ok' && now - (state.lastAlertAt || 0) > reminderMs;
  const shouldAlert =
    chats().length > 0 &&
    (changed || reminderDue);

  state.lastStatus = snapshot.status;
  if (shouldAlert) {
    await sendToChats(text);
    state.lastAlertAt = now;
  }
  await persist();
}

console.log('Asenix Watcher bot started');
console.log(`Config: ${config.configPath}`);
console.log(`State: ${config.statePath}`);
console.log(`Public RPC: ${config.publicRpcUrl}`);

let lastMonitorAt = 0;
while (true) {
  try {
    await pollTelegram();
    const now = Date.now();
    if (now - lastMonitorAt >= config.thresholds.pollSeconds * 1000) {
      lastMonitorAt = now;
      await monitorOnce();
    }
  } catch (error) {
    console.error(error);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}
