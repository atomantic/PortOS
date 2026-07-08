/**
 * Marker-delimited section replacement (pure, no I/O).
 *
 * Lets an automated writer own a clearly-delimited region inside a larger
 * user-authored document (e.g. the auto-generated activity-digest section inside
 * a Brain daily-log entry, #2155) without ever touching the surrounding
 * hand-written content. Re-runs replace ONLY the region between the stable
 * start/end markers; everything else is preserved byte-for-byte.
 *
 * Consumers: `server/services/activityDigest.js` builds the section body,
 * `brainJournal.upsertAutoSection()` splices it in.
 */

// Build a matched start/end marker pair for a stable section id. HTML-comment
// syntax so the markers render invisibly in Markdown / Obsidian previews and
// never collide with user prose.
export function buildMarkers(id) {
  const safe = String(id || 'section').trim() || 'section';
  return {
    start: `<!-- portos:${safe}:start -->`,
    end: `<!-- portos:${safe}:end -->`,
  };
}

// Escape a literal string for embedding inside a RegExp.
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Match the full marker region plus any leading blank line(s) the writer added
// so a replace/remove doesn't accumulate (or leave) widening gaps. Non-greedy
// body so two regions can't be swallowed as one.
function regionRegExp({ start, end }) {
  return new RegExp(`(?:\\n{1,2})?${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`);
}

// True when `content` already carries a well-formed (start … end) region.
export function hasMarkedSection(content, { start, end }) {
  if (typeof content !== 'string' || !content) return false;
  const si = content.indexOf(start);
  if (si === -1) return false;
  return content.indexOf(end, si + start.length) !== -1;
}

// Extract the trimmed body BETWEEN the markers, or null when absent. Markers
// themselves are stripped.
export function extractMarkedSection(content, { start, end }) {
  if (typeof content !== 'string') return null;
  const si = content.indexOf(start);
  if (si === -1) return null;
  const bodyStart = si + start.length;
  const ei = content.indexOf(end, bodyStart);
  if (ei === -1) return null;
  return content.slice(bodyStart, ei).trim();
}

/**
 * Replace (or insert, or remove) the marker-delimited section in `content`.
 *
 * - `body` non-empty → the region is (re)written to `${start}\n${body}\n${end}`.
 *   An existing region is replaced in place (surrounding content + position
 *   preserved); otherwise the block is appended after the existing content,
 *   separated by a blank line.
 * - `body` empty/null → any existing region (and its leading blank line) is
 *   removed; content with no region is returned untouched.
 *
 * Idempotent: replacing a region with the same body yields byte-identical
 * output, and markers never nest or duplicate.
 */
export function replaceMarkedSection(content, body, markers) {
  const base = typeof content === 'string' ? content : '';
  const trimmedBody = typeof body === 'string' ? body.trim() : '';
  const regionRe = regionRegExp(markers);

  if (!trimmedBody) {
    // Remove an existing region; collapse the resulting trailing whitespace so
    // the document doesn't end on a growing run of blank lines.
    return base.replace(regionRe, '').replace(/\s+$/, '');
  }

  const block = `${markers.start}\n${trimmedBody}\n${markers.end}`;

  if (regionRe.test(base)) {
    // Replace in place. Re-attach the blank-line separator the regex consumed so
    // the block stays visually detached from the content above; strip any
    // leading newlines left when the region was at the very top of the document.
    return base.replace(regionRe, `\n\n${block}`).replace(/^\n+/, '');
  }

  const head = base.replace(/\s+$/, '');
  return head ? `${head}\n\n${block}` : block;
}
