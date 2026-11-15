/**
 * Markdown → plain-text normalization for strings that are about to be handed
 * to something that has no idea what markdown is (a model's text encoder, a
 * slug builder, a TTS engine).
 *
 * `stripMarkdownEmphasis(text)` — unwrap `**bold**` / `~~struck~~` / `` `code` `` / `[text](url)` and
 * drop HTML comments, keeping the words. For strings handed to something that can't read markdown (a
 * model's text encoder, a slug builder, TTS); leftover lone `*_~` become spaces so an unbalanced
 * marker can't fuse two words. Does not collapse whitespace — callers that need that normalize
 * themselves.
 *
 * The motivating case: prompts authored in a markdown-ish textarea reach a
 * text-to-audio sidecar with their `**emphasis**` intact, and the encoder
 * tokenizes the asterisks as literal content — conditioning noise the author
 * never intended to write.
 */

/**
 * Strip common markdown wrappers, keeping the words inside them.
 * - `**bold**`     → `bold`
 * - `~~struck~~`   → `struck`
 * - `` `code` ``   → `code`
 * - `[text](url)`  → `text`
 * - HTML comments  → removed
 *
 * Leftover lone `*`/`_`/`~` become spaces rather than being deleted, so an
 * unbalanced marker can't fuse two words together. Whitespace is NOT collapsed
 * here — callers that care (slug builders) normalize it themselves, and
 * callers that don't (prompt text) keep their line structure intact.
 */
export function stripMarkdownEmphasis(text) {
  return String(text ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/[*_~]/g, ' ');
}
