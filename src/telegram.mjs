export class TelegramClient {
  constructor(token) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async call(method, body) {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.description || `${method} failed`);
    }
    return payload.result;
  }

  async answerCallbackQuery(callbackQueryId) {
    return this.call('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
    });
  }

  async getUpdates(offset) {
    return this.call('getUpdates', {
      allowed_updates: ['message', 'callback_query'],
      offset,
      timeout: 35,
    });
  }

  async setMyCommands(commands) {
    return this.call('setMyCommands', { commands });
  }

  async sendChatAction(chatId, action = 'typing') {
    return this.call('sendChatAction', {
      action,
      chat_id: chatId,
    });
  }

  async sendMessage(chatId, text, options = {}) {
    const chunks = [];
    for (let index = 0; index < text.length; index += 3600) {
      chunks.push(text.slice(index, index + 3600));
    }
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      await this.call('sendMessage', {
        chat_id: chatId,
        disable_web_page_preview: true,
        parse_mode: options.parseMode,
        reply_markup: index === chunks.length - 1 ? options.replyMarkup : undefined,
        text: chunk,
      });
    }
  }
}
