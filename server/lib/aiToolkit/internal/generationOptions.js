/**
 * Default generation controls, rendered into an OpenAI `/chat/completions` body.
 *
 * Same provider-level defaults the OpenCode wrappers render
 * (`server/lib/opencodeConfig.js` `buildAgentGeneration`). Scoped to LOCAL
 * OpenAI-compatible backends on purpose: a cloud provider's body carries no
 * sampling fields unless the user pins them.
 *
 * Lives beside `ollamaBacked.js` so `runner.js` avoids a cycle through `providers.js`.
 */
import { isOllamaBackedProvider } from './ollamaBacked.js';

const finiteNumber = (value, min, max) => {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
};

/**
 * Every local backend marker belongs in the guard below: a missing one returns
 * `{}` and drops temperature and top_p too.
 *
 * @param {{temperature?:unknown, topP?:unknown, thinking?:unknown, lmstudioBacked?:boolean, llamaBacked?:boolean, mtplxBacked?:boolean, vllmBacked?:boolean, sglangBacked?:boolean}|null|undefined} provider
 * @returns {{temperature?:number, top_p?:number, think?:boolean, chat_template_kwargs?:{enable_thinking:boolean}}}
 */
export function apiGenerationOptions(provider) {
  const ollama = isOllamaBackedProvider(provider);
  const lmstudio = provider?.lmstudioBacked === true;
  if (!ollama
    && !lmstudio
    && provider?.llamaBacked !== true
    && provider?.mtplxBacked !== true
    && provider?.vllmBacked !== true
    && provider?.sglangBacked !== true) return {};
  // Only Ollama defaults to 0.6; other backends keep their own until pinned.
  const temperature = finiteNumber(provider.temperature, 0, 2) ?? (ollama ? 0.6 : undefined);
  const topP = finiteNumber(provider.topP, 0, 1);
  return {
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { top_p: topP }),
    // Ollama takes a native `think` boolean; llama.cpp / MTPLX / vLLM / SGLang
    // use the chat template. LM Studio takes neither (reasoning is a property of
    // the loaded model instance).
    ...(typeof provider.thinking !== 'boolean' || lmstudio
      ? {}
      : ollama
        ? { think: provider.thinking }
        : { chat_template_kwargs: { enable_thinking: provider.thinking } }),
  };
}
