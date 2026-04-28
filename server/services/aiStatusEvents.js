/**
 * AI operation status events.
 *
 * Any AI call (LLM chat, model load, embedding, etc.) emits phase-tagged
 * status events here. socket.js bridges them onto the `ai:status` Socket.IO
 * channel so client UIs can show live toasts ("Loading gpt-oss-20b…",
 * "Calling LM Studio…", "Done").
 *
 * Phases:
 *   start         — request kicked off
 *   model:loading — provider reported no model loaded; auto-loading
 *   model:loaded  — model is in memory and ready
 *   complete      — call finished successfully
 *   error         — call failed (with reason)
 *
 * Single-user system: events broadcast to all connected clients.
 */
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';

export const aiStatusEvents = new EventEmitter();
aiStatusEvents.setMaxListeners(50);

const ICONS = {
  start: '🤖',
  'model:loading': '📦',
  'model:loaded': '✅',
  complete: '🎉',
  error: '❌'
};

/**
 * Begin tracking an AI operation. Returns a handle with phase helpers.
 *
 * @param {object} init
 * @param {string} init.op           — short slug, e.g. 'taste-summary'
 * @param {string} init.label        — human description, e.g. 'Generating taste summary'
 * @param {string} [init.providerId]
 * @param {string} [init.providerName]
 * @param {string} [init.model]
 */
export function startAIOp(init) {
  const id = randomUUID();
  const base = {
    id,
    op: init.op,
    label: init.label,
    providerId: init.providerId,
    providerName: init.providerName,
    model: init.model,
    silent: !!init.silent
  };

  emit('start', base, init.label || `Calling ${init.providerName || init.providerId || 'AI'}…`);

  return {
    id,
    update(phase, message, extra = {}) {
      emit(phase, { ...base, ...extra }, message);
    },
    complete(message = 'Done', extra = {}) {
      emit('complete', { ...base, ...extra }, message);
    },
    error(message, extra = {}) {
      emit('error', { ...base, ...extra }, message);
    }
  };
}

function emit(phase, payload, message) {
  const event = { ...payload, phase, message, ts: Date.now() };
  aiStatusEvents.emit('status', event);
  const provider = payload.providerName || payload.providerId || '';
  const model = payload.model ? ` (${payload.model})` : '';
  console.log(`${ICONS[phase] || '🤖'} AI[${payload.op}] ${phase}: ${message}${provider ? ` — ${provider}${model}` : ''}`);
}
