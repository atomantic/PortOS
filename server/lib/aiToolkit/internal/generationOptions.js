/**
 * Default generation controls, rendered into an OpenAI `/chat/completions` body.
 *
 * These are the same provider-level defaults the OpenCode wrappers turn into an
 * `agent.build` block (`server/lib/opencodeConfig.js` — `buildAgentGeneration`),
 * so one local model keeps its temperature / top_p / thinking posture whether it
 * is reached through this HTTP runner, a CLI, or a TUI.
 *
 * Scoped to the LOCAL OpenAI-compatible backends on purpose. A cloud provider is
 * left exactly as it was: its request body carries no sampling fields at all
 * unless the user pins them, so a stored default can never quietly re-shape a
 * hosted model's output.
 *
 * Lives in `internal/` beside `ollamaBacked.js` so `runner.js` can build the
 * body without importing `providers.js` and forming a module cycle.
 */
import { isOllamaBackedProvider } from './ollamaBacked.js';

const finiteNumber = (value, min, max) => {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
};

/**
 * Every local backend marker belongs in the guard below. A missing one does not
 * degrade to "no thinking toggle" — it returns `{}` and drops temperature and
 * top_p with it, which is how the vLLM providers shipped with every generation
 * control silently discarded on the OpenCode side (#4765).
 *
 * @param {{temperature?:unknown, topP?:unknown, thinking?:unknown, llamaBacked?:boolean, mtplxBacked?:boolean, vllmBacked?:boolean}|null|undefined} provider
 * @returns {{temperature?:number, top_p?:number, think?:boolean, chat_template_kwargs?:{enable_thinking:boolean}}}
 */
export function apiGenerationOptions(provider) {
  const ollama = isOllamaBackedProvider(provider);
  if (!ollama
    && provider?.llamaBacked !== true
    && provider?.mtplxBacked !== true
    && provider?.vllmBacked !== true) return {};
  // Ollama API runs have defaulted to 0.6 since this control shipped; the other
  // local backends keep their own default until the user pins one.
  const temperature = finiteNumber(provider.temperature, 0, 2) ?? (ollama ? 0.6 : undefined);
  const topP = finiteNumber(provider.topP, 0, 1);
  return {
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { top_p: topP }),
    // Ollama takes its own native `think` boolean; llama.cpp / MTPLX / vLLM
    // route the toggle through the chat template instead.
    ...(typeof provider.thinking !== 'boolean'
      ? {}
      : ollama
        ? { think: provider.thinking }
        : { chat_template_kwargs: { enable_thinking: provider.thinking } }),
  };
}
