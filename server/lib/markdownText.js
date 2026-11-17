/**
 * `stripMarkdownEmphasis(text)` unwraps markdown and drops HTML comments, keeping the words.
 *
 * For strings handed to something that can't read markdown (a model's text encoder, slug builder, TTS).
 */

/**
 * Leftover lone `*`/`_`/`~` become spaces so an unbalanced marker can't fuse two words.
 * Whitespace is NOT collapsed; callers that need that normalize it themselves.
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
