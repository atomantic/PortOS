/**
 * The persistent mind's local-window prompt budget, shared by the adapter and the maintainer gate.
 *
 * The adapter FITS each round's prompt to it and the gate ADMITS against it, so the gate can never
 * refuse a prompt the adapter already fitted.
 */
import { CHARS_PER_TOKEN, localOutputReserveTokens } from '../contextBudget.js';

// Every mind call declares this much answer room. On a local window the
// prompt runner shrinks it to fit (localOutputReserveTokens) and caps
// generation at the shrunk number.
export const PERSISTENT_MIND_OUTPUT_RESERVE_TOKENS = 8_192;
// chars/4 undercounts real tokenizers (qwen3 packed a 54K-char wake into
// 14,990 tokens, ~10% over the estimate), so the fitted prompt targets 90% of
// the room the dispatch gate allows.
export const LOCAL_PROMPT_TOKENIZER_MARGIN = 0.9;

/** Largest prompt (chars) for `maxPromptTokens` of room on a local window. */
export const localPromptCharsForTokens = (maxPromptTokens) =>
  Math.floor(Math.max(0, maxPromptTokens) * LOCAL_PROMPT_TOKENIZER_MARGIN) * CHARS_PER_TOKEN;

/** Largest prompt (chars) a `contextTokens` local window admits after the mind's output reserve, or null if unknown. */
export function localPromptCharLimit(contextTokens) {
  const reserve = localOutputReserveTokens(PERSISTENT_MIND_OUTPUT_RESERVE_TOKENS, contextTokens);
  if (!reserve) return null;
  return localPromptCharsForTokens(contextTokens - reserve);
}
