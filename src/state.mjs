import fs from 'node:fs/promises';
import path from 'node:path';

export async function loadState(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return {
        lastAlertAt: 0,
        lastStatus: null,
        registeredChats: [],
        telegramOffset: 0,
      };
    }
    throw error;
  }
}

export async function saveState(filePath, state) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`);
}
