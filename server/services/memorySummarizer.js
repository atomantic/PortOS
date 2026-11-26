/**
 * Memory Summarizer
 *
 * Compresses an over-long memory into a short, embedding-sized summary so the
 * resulting vector represents the WHOLE record rather than just its first N
 * chars (plain truncation drops everything past the embedding model's context
 * window — for a 2048-token embedder that's ~1/3 of imported ChatGPT chats).
 *
 * Used only when a record exceeds the embedding budget (see memoryEmbeddings.js);
 * short records embed directly with no LLM call. For a ChatGPT-import record we
 * summarize the FULL archived transcript (via `sourceRef`), not the truncated
 * memory preview, so the embedding captures the entire conversation.
 *
 * Self-contained provider plumbing: resolves the Brain default provider/model
 * (gpt-oss:20b on a typical install) and runs one chat completion. Any failure
 * returns null so the caller falls back to truncation — summarization is a
 * quality boost, never a hard dependency of embedding.
 */

import { getProviderById } from './provider/providers.js';
import { loadMeta } from './brainStorage.js';
import { readArchivedConversation } from './chatgptImport.js';
import { runPromptThroughProvider } from './promptRunner.js';
import { isPrivateNetworkEndpoint } from '../lib/localEndpoint.js';

// Preferred summarizer model when the Brain default doesn't resolve. gpt-oss:20b
// is the typical Brain default and has ample context for a full transcript.
const PREFERRED_MODEL = 'gpt-oss:20b';

// Cap how much source text we hand the summarizer — large-context local models
// still slow down (and can wander) on enormous inputs. 60k chars (~15k tokens)
// comfortably covers a full ChatGPT conversation while bounding latency.
const MAX_SUMMARY_INPUT_CHARS = 60000;

const SUMMARY_SYSTEM_PROMPT =
  'You compress a conversation or note into a dense, factual summary for semantic search. '
  + 'Capture every distinct topic, question, decision, entity, and conclusion. '
  + 'Prefer keywords and concrete nouns over prose. No preamble, no headings, no markdown — '
  + 'just the summary text. Aim for under 250 words.';

const truncateText = (s, n) => (s.length > n ? s.slice(0, n) : s);

// Embedding can read entire private archives, so provider capability alone
// does not authorize the destination.
const isLocalEnabledApiProvider = (provider) =>
  provider?.type === 'api' && provider.enabled !== false && isPrivateNetworkEndpoint(provider.endpoint);

/**
 * Prefer Brain's default when eligible, then try private-network Ollama.
 * Returns null when the embedder should truncate locally.
 */
async function resolveSummarizer() {
  const meta = await loadMeta().catch(() => null);
  const providerId = meta?.defaultProvider || 'ollama';
  const provider = await getProviderById(providerId).catch(() => null);
  if (isLocalEnabledApiProvider(provider)) {
    const model = meta?.defaultModel || provider.defaultModel || PREFERRED_MODEL;
    return { provider, model };
  }

  if (providerId === 'ollama') return null;
  // The Brain model belongs to the rejected provider. Use Ollama's own model.
  const ollama = await getProviderById('ollama').catch(() => null);
  if (!isLocalEnabledApiProvider(ollama)) return null;
  return { provider: ollama, model: ollama.defaultModel || PREFERRED_MODEL };
}

/**
 * Pull the richest available source text for a memory:
 *  - a ChatGPT-import record → the FULL archived transcript (sourceRef), so we
 *    summarize the whole conversation, not the import's truncated preview;
 *  - anything else → the memory's own combined text (passed in as `fallbackText`).
 */
async function resolveSourceText(memory, fallbackText) {
  if (memory?.source === 'chatgpt-import' && memory.sourceRef) {
    const archived = await readArchivedConversation(memory.sourceRef).catch(() => null);
    if (archived?.transcript?.trim()) return archived.transcript;
  }
  return fallbackText;
}

/**
 * Produce an embedding-sized summary of `memory`, or null on any failure (the
 * caller then falls back to truncation). `fallbackText` is the combined
 * type/category/tags/summary/content string the embedder would otherwise embed.
 */
export async function summarizeForEmbedding(memory, fallbackText) {
  const summarizer = await resolveSummarizer();
  if (!summarizer) return null;

  const sourceText = await resolveSourceText(memory, fallbackText);
  if (!sourceText?.trim()) return null;

  const prompt = `${SUMMARY_SYSTEM_PROMPT}\n\n--- CONTENT ---\n${truncateText(sourceText, MAX_SUMMARY_INPUT_CHARS)}`;

  const result = await runPromptThroughProvider({
    provider: summarizer.provider,
    model: summarizer.model,
    prompt,
    // Keep the admitted provider pinned so recovery cannot send private text
    // to another provider.
    toolFree: true,
    allowFallback: false,
    source: 'memory-embedding-summary'
  }).catch((err) => {
    console.warn(`⚠️ Embedding summarization failed (${summarizer.model}): ${err.message}`);
    return null;
  });

  const text = result?.text?.trim();
  if (!text) return null;
  return text;
}

export const __test = { resolveSummarizer, resolveSourceText, SUMMARY_SYSTEM_PROMPT };
