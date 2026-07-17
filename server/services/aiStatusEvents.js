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
 * @param {string} [init.appId]         — managed-app id this call works on behalf of
 * @param {string} [init.workspacePath] — CoS-agent workspace this call works on behalf of
 * @param {boolean} [init.background]    — this call is part of an UNATTENDED job (a
 *   scheduled/autopilot task the user isn't watching), NOT merely display-silent.
 *   Distinct from `silent` (which only suppresses the start toast — user-triggered
 *   op-less actions are silent too). The client coalesces per-provider error toasts
 *   for background ops so a systematically-failing provider in a fan-out job (e.g.
 *   the multi-goal check-in) yields one notification instead of N stacked toasts.
 *
 * `appId`/`workspacePath` let the CyberCity AI Core aim its activity beam at the
 * originating building; ops with neither get the generic radial beam. Token counts
 * (`tokens` / `tokensPerSec`) arrive later via the `complete` phase's `extra`.
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
    appId: init.appId,
    workspacePath: init.workspacePath,
    silent: !!init.silent,
    background: !!init.background
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
