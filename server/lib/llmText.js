/**
 * Pure text helpers for LLM responses.
 *
 * These sit below the provider layer so a lib module can clean up model output
 * without importing the provider orchestration that produced it (issue #4901).
 * They were exported from `aiProvider.js` while it lived in lib; that module
 * calls providers and moved to services, but nothing about unfencing a string
 * needs a provider. `services/aiProvider.js` re-exports both, so existing
 * imports keep working.
 */

/**
 * Strip markdown code fences from LLM output before JSON.parse.
 *
 * Trims surrounding whitespace BEFORE the fence regex so common LLM shapes
 * with trailing newlines/spaces around the closing fence (e.g. "```json\n{}\n```\n")
 * still get the closing ``` stripped — the regex anchors on end-of-string.
 */
export function stripCodeFences(raw) {
  return raw.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
}

/**
 * Parse JSON from LLM output, stripping code fences first.
 * Throws a descriptive error on parse failure.
 */
export function parseLLMJSON(raw) {
  const cleaned = stripCodeFences(raw);
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Invalid JSON from AI: ${e.message}`);
  }
}
