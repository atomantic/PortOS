/**
 * Telegram Bot Client
 * fetch-based polling loop replacing node-telegram-bot-api
 */

import { EventEmitter } from 'events';

const BASE_URL = 'https://api.telegram.org/bot';
const POLL_TIMEOUT_SEC = 30;
const API_TIMEOUT_MS = 10_000; // regular calls: sendMessage, editMessageText, etc.
const RETRY_DELAY_API_ERROR_MS = 5_000;
const RETRY_DELAY_NETWORK_ERROR_MS = 2_000;

function buildUrl(token, method) {
  return `${BASE_URL}${token}/${method}`;
}

async function apiCall(token, method, body = {}) {
  // Telegram JSON API expects reply_markup as an object, not a pre-serialized string
  const payload = { ...body };
  if (typeof payload.reply_markup === 'string') {
    payload.reply_markup = JSON.parse(payload.reply_markup);
  }

  const res = await fetch(buildUrl(token, method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(API_TIMEOUT_MS)
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.description || `Telegram API error: ${method}`);
  return json.result;
}

/**
 * Create a Telegram bot client.
 * @param {string} token - Bot token from BotFather
 * @param {{ polling?: boolean }} opts
 */
export function createTelegramBot(token, opts = {}) {
  const emitter = new EventEmitter();
  const textHandlers = []; // { regex, fn }
  let offset = 0;
  let polling = false;
  let activePollController = null;

  async function pollLoop() {
    while (polling) {
      activePollController = new AbortController();
      let updates;
      try {
        const res = await fetch(buildUrl(token, 'getUpdates'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ offset, timeout: POLL_TIMEOUT_SEC, allowed_updates: ['message', 'callback_query'] }),
          signal: activePollController.signal
        });
        const json = await res.json();
        if (!json.ok) {
          // Retry after a delay on API errors
          await new Promise(r => setTimeout(r, RETRY_DELAY_API_ERROR_MS));
          continue;
        }
        updates = json.result;
      } catch {
        // Aborted (stopPolling called) or network error
        if (!polling) break;
        await new Promise(r => setTimeout(r, RETRY_DELAY_NETWORK_ERROR_MS));
        continue;
      }

      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) {
          const msg = update.message;
          if (msg.text) {
            for (const { regex, fn } of textHandlers) {
              const match = msg.text.match(regex);
              if (match) fn(msg, match);
            }
          }
          emitter.emit('message', msg);
        }
        if (update.callback_query) {
          emitter.emit('callback_query', update.callback_query);
        }
      }
    }
  }

  if (opts.polling) {
    polling = true;
    pollLoop().catch(() => {});
  }

  return {
    getMe() {
      return apiCall(token, 'getMe');
    },
    sendMessage(chatId, text, extra = {}) {
      return apiCall(token, 'sendMessage', { chat_id: chatId, text, ...extra });
    },
    answerCallbackQuery(callbackQueryId, extra = {}) {
      return apiCall(token, 'answerCallbackQuery', { callback_query_id: callbackQueryId, ...extra });
    },
    editMessageText(text, extra = {}) {
      return apiCall(token, 'editMessageText', { text, ...extra });
    },
    onText(regex, fn) {
      textHandlers.push({ regex, fn });
    },
    on(event, fn) {
      emitter.on(event, fn);
    },
    async stopPolling() {
      polling = false;
      activePollController?.abort();
      activePollController = null;
    }
  };
}
