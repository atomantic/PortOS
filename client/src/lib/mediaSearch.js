// Shared client-side search over normalized media items (images + videos).
// Extracted from MediaHistory's inline haystack/token logic so the Image Gen
// gallery picker (GalleryImagePicker) and any future media browser share one
// definition of "what's searchable" and the AND-token matching semantics.
//
// Items are the normalized shape from `components/media/normalize.js`
// (normalizeImage / normalizeVideo) — prompt, modelId, seed, loraNames,
// universe/entry tags, etc.

// Build the lowercased searchable string for one normalized item. Keep this in
// sync with the fields users expect to match on (prompt text, model id, seed,
// resolution, LoRA names, Universe Builder entity/universe tags, lineage tags).
export function buildMediaHaystack(item) {
  if (!item) return '';
  return [
    item.prompt,
    item.negativePrompt,
    item.modelId,
    item.filename,
    item.kind,
    item.seed != null ? `seed ${item.seed}` : '',
    item.width && item.height ? `${item.width}x${item.height}` : '',
    ...(Array.isArray(item.loraNames) ? item.loraNames : []),
    // Universe Builder tags — searchable by entity name (e.g. "Ash"), universe
    // name, kind, or category even when those tokens aren't in the prompt.
    item.universeName,
    item.entryName,
    item.entryLabel,
    item.entryCategory,
    item.entryKind,
    item.extractedFromVideoId ? 'extracted frame' : '',
    item.stitchedFrom ? 'stitched' : '',
    item.upscaledFrom ? 'upscaled 2x' : '',
  ].filter(Boolean).join(' ').toLowerCase();
}

// Split a query into lowercased whitespace tokens (AND semantics across them).
export function tokenizeQuery(query) {
  return String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
}

// True when the haystack contains every token (substring, any order).
export function matchHaystack(haystack, tokens) {
  return tokens.every((t) => haystack.includes(t));
}

// Convenience: filter a list of normalized items by a raw query string. Builds
// haystacks inline — fine for one-shot filtering (the picker). For hot keystroke
// paths over a large list, cache `buildMediaHaystack` per item and reuse
// `tokenizeQuery` + `matchHaystack` (see MediaHistory).
export function filterByQuery(items, query) {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return items;
  return items.filter((item) => matchHaystack(buildMediaHaystack(item), tokens));
}
