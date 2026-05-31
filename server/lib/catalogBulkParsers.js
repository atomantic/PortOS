/**
 * Pure parsers for the catalog bulk-import path. Dependency-free —
 * markdown / CSV / JSON each normalize to a list of
 * `{ type, name, payload, tags }` entries that the route then validates
 * one-by-one against `catalogIngredientCreateSchema` before insert.
 *
 * The parsers are intentionally lenient (best-effort); the Zod gate after
 * parse is what guarantees DB-safe shape. Each parser throws on structural
 * failure (not on per-row content errors) — those bubble up as the
 * `BULK_IMPORT_PARSE_FAILED` error.
 *
 * `INGREDIENT_TYPES` + `PRIMARY_CONTENT_KEY_BY_TYPE` derive from the shared
 * type registry (`catalogTypes.js`, a pure no-side-effect module) so a new
 * type flows through bulk import/export automatically. A bulk-import row's
 * body paragraph / CSV `description` column lands in each type's
 * `primaryContentKey`.
 *
 * Also exports a minimal `toYamlString()` serializer used by the export
 * route — handwritten so we don't pull js-yaml just for the catalog bundle.
 */

import { CATALOG_TYPES, INGREDIENT_TYPE_IDS } from './catalogTypes.js';

export const INGREDIENT_TYPES = INGREDIENT_TYPE_IDS;

export const PRIMARY_CONTENT_KEY_BY_TYPE = Object.freeze(
  Object.fromEntries(CATALOG_TYPES.map((t) => [t.id, t.primaryContentKey])),
);

const TYPE_LOWER = new Set(INGREDIENT_TYPES);

function normalizeType(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().toLowerCase();
  return TYPE_LOWER.has(t) ? t : null;
}

function normalizeTags(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((t) => (typeof t === 'string' ? t.trim() : ''))
      .filter(Boolean);
  }
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Normalize one freeform entry into the import shape.
 * Returns `{ type, name, payload, tags }` or throws.
 */
function normalizeEntry(input, index) {
  if (!input || typeof input !== 'object') {
    throw new Error(`entry[${index}]: not an object`);
  }
  const type = normalizeType(input.type);
  if (!type) {
    throw new Error(`entry[${index}]: invalid or missing type (got ${JSON.stringify(input.type)})`);
  }
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) {
    throw new Error(`entry[${index}]: name is required`);
  }
  // Caller may supply payload directly OR a top-level `description` /
  // `summary` shortcut that flows into the type's primary content key.
  const explicitPayload = input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload)
    ? { ...input.payload }
    : {};
  if (typeof input.description === 'string' && input.description.trim()) {
    const key = PRIMARY_CONTENT_KEY_BY_TYPE[type];
    // Don't overwrite an explicit payload key — the explicit one wins.
    if (!(key in explicitPayload)) explicitPayload[key] = input.description.trim();
  }
  return {
    type,
    name,
    payload: explicitPayload,
    tags: normalizeTags(input.tags),
  };
}

/**
 * JSON: accepts either a bare array of entries OR a full export bundle
 * (`{ version, ref, ingredients: [...] }`) so the export → edit → re-import
 * round trip works without the user having to strip the wrapper.
 */
export function parseJsonBulk(payload) {
  if (typeof payload !== 'string') {
    throw new Error('json payload must be a string');
  }
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch (err) {
    throw new Error(`invalid JSON: ${err.message}`);
  }
  const isBundle = !Array.isArray(parsed) && parsed && Array.isArray(parsed.ingredients);
  const rawEntries = Array.isArray(parsed)
    ? parsed
    : (isBundle ? parsed.ingredients : null);
  if (!rawEntries) {
    throw new Error('json payload must be an array of entries or an export bundle with an `ingredients` array');
  }
  const entries = rawEntries.map((entry, i) => {
    const normalized = normalizeEntry(entry, i);
    // Preserve the per-row role the export bundle stamped so the bulk-import
    // route can re-create each ingredient's ref link with its original role,
    // instead of collapsing every row onto the batch-level default. Rides as
    // a non-enumerable field so deep-equal tests on the entry shape still pass.
    if (entry && typeof entry.roleForExportedRef === 'string' && entry.roleForExportedRef.trim()) {
      attachNonEnumerable(normalized, 'roleForExportedRef', entry.roleForExportedRef.trim());
    }
    return normalized;
  });
  // When the input is a full export bundle, surface its `ref` so the route can
  // fall back to it for ref-links (re-import recreates the bundle's slice
  // membership). Non-enumerable, like markdown's `warnings`, so array-indexing
  // callers are unaffected.
  if (isBundle && parsed.ref && typeof parsed.ref === 'object'
      && typeof parsed.ref.kind === 'string' && parsed.ref.id != null) {
    attachNonEnumerable(entries, 'bundleRef', { kind: parsed.ref.kind, id: String(parsed.ref.id) });
  }
  return entries;
}

/**
 * CSV: dependency-free parser. Header row required; supports basic
 * double-quoted fields ("" = literal quote, embedded commas allowed).
 * Recognized headers: `type`, `name`, `description`, `tags`. Unknown
 * columns are folded into `payload[colName]`.
 */
export function parseCsvBulk(payload) {
  if (typeof payload !== 'string') {
    throw new Error('csv payload must be a string');
  }
  const rows = tokenizeCsv(payload);
  if (rows.length < 2) {
    throw new Error('csv requires a header row and at least one data row');
  }
  const headers = rows[0].map((h) => h.trim());
  const typeIdx = headers.indexOf('type');
  const nameIdx = headers.indexOf('name');
  if (typeIdx < 0 || nameIdx < 0) {
    throw new Error('csv headers must include `type` and `name`');
  }
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    // Skip blank lines (tokenizer leaves a single empty string per blank).
    if (row.length === 1 && row[0] === '') continue;
    const entry = { type: row[typeIdx], name: row[nameIdx], payload: {}, tags: [] };
    for (let c = 0; c < headers.length; c++) {
      const h = headers[c];
      const v = row[c] ?? '';
      if (h === 'type' || h === 'name') continue;
      if (h === 'tags') {
        entry.tags = normalizeTags(v);
      } else if (h === 'description') {
        entry.description = v;
      } else if (h) {
        // Unknown column → stash in payload so users can pre-populate
        // canon-shape keys (e.g. `personality,role,significance,…`) without
        // a custom format.
        if (v !== '') entry.payload[h] = v;
      }
    }
    out.push(normalizeEntry(entry, r - 1));
  }
  if (out.length === 0) {
    throw new Error('csv produced zero data rows');
  }
  return out;
}

function tokenizeCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(cur); cur = ''; i++; continue; }
    if (ch === '\r') {
      // Swallow lone \r; handle \r\n via the \n branch
      if (text[i + 1] === '\n') { i++; continue; }
      // Treat bare \r as line terminator
      row.push(cur); cur = ''; rows.push(row); row = []; i++;
      continue;
    }
    if (ch === '\n') {
      row.push(cur); cur = ''; rows.push(row); row = []; i++;
      continue;
    }
    cur += ch;
    i++;
  }
  // Final cell + row (no trailing newline case).
  row.push(cur);
  // If the only thing in the final row is an empty cell AND there were prior
  // rows, drop it (trailing newline artifact).
  if (!(row.length === 1 && row[0] === '' && rows.length > 0)) {
    rows.push(row);
  }
  return rows;
}

/**
 * Markdown convention:
 *   ## <Type>: <Name>
 *   <body paragraph(s) — primary content for the type>
 *   tags: <comma, separated, tags>
 *
 * The `tags:` line is optional and case-insensitive; everything else above
 * it (until the next `## ` heading) becomes the body. Body lands in the
 * type's primary content key per PRIMARY_CONTENT_KEY_BY_TYPE.
 *
 * This mirrors `ingredientToMarkdown` for everything that format emits, so it
 * also recognizes the two structured sections that exporter writes inside a
 * `## ` block:
 *   - a ` ```json … ``` ` fence carrying the non-primary payload keys, which
 *     is parsed back into `payload.*` (merged under the body's primary key);
 *   - a `### Scraps` subsection of `- (kind) text` bullets, preserved as a
 *     sibling `scraps[]` array for a lossless round-trip.
 * (Per-row export role rides only the JSON bundle's `roleForExportedRef`; the
 * markdown format does not carry it, so markdown re-import falls back to the
 * route's default role — lossy on role by design.)
 * Both terminate the body so re-importing an export doesn't pollute the
 * primary content key with fence text or scrap bullets.
 */
export function parseMarkdownBulk(payload) {
  if (typeof payload !== 'string') {
    throw new Error('markdown payload must be a string');
  }
  const lines = payload.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  // Heading regex: `## <Type>: <Name>` — case-insensitive on the type, name
  // is everything to the right of the first `:`. Heading must start the line.
  const headingRe = /^##\s+([A-Za-z][A-Za-z-]*)\s*:\s*(.+?)\s*$/;
  // `### Scraps` subsection header (case-insensitive).
  const scrapsHeadingRe = /^###\s+scraps\s*$/i;
  // `- (sourceKind) raw text…` scrap bullet emitted by ingredientToMarkdown.
  const scrapBulletRe = /^-\s+\(([^)]*)\)\s*(.*)$/;
  const out = [];
  const warnings = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    const bodyText = current.bodyLines.join('\n').trim();
    if (bodyText) {
      const key = PRIMARY_CONTENT_KEY_BY_TYPE[current.type];
      // Don't clobber a fence-supplied key with the body, and vice-versa: the
      // fence holds the non-primary keys, so the body's primary key wins here.
      current.payload[key] = bodyText;
    }
    out.push({
      type: current.type,
      name: current.name,
      payload: current.payload,
      tags: current.tags,
      scraps: current.scraps,
    });
  };
  for (const line of lines) {
    const m = headingRe.exec(line);
    if (m) {
      flush();
      const type = normalizeType(m[1]);
      const name = m[2].trim();
      if (!type) {
        // Skip unrecognized headings (e.g. `## Notes:`, typos like `## Plce:`);
        // they'd otherwise open a malformed section. Surface as a warning so
        // the user notices typos; the body until the next valid heading is
        // dropped.
        warnings.push(`Unknown type "${m[1]}" in heading "${line.trim()}" — section skipped`);
        current = null;
        continue;
      }
      current = { type, name, bodyLines: [], tags: [], payload: {}, scraps: [], section: 'body', fence: null };
      continue;
    }
    if (!current) continue;
    // Inside a ```json fence: accumulate raw lines until the closing ```.
    if (current.fence) {
      if (/^```\s*$/.test(line)) {
        const raw = current.fence.lines.join('\n');
        let parsedFence = null;
        try { parsedFence = JSON.parse(raw); } catch { parsedFence = null; }
        if (parsedFence && typeof parsedFence === 'object' && !Array.isArray(parsedFence)) {
          // Merge the non-primary payload keys back in. The body's primary
          // key is applied in flush() and wins on collision.
          for (const [k, v] of Object.entries(parsedFence)) current.payload[k] = v;
        } else {
          warnings.push(`Malformed JSON fence in "## ${capitalize(current.type)}: ${current.name}" — skipped`);
        }
        current.fence = null;
      } else {
        current.fence.lines.push(line);
      }
      continue;
    }
    // Open a ```json fence — the ONLY fence `ingredientToMarkdown` emits,
    // carrying the non-primary payload keys. Other fences (```js, ```text,
    // bare ```) are intentionally left in the body so a hand-authored markdown
    // import doesn't silently lose fenced content. Fence state is driven by
    // `current.fence`; `section` only gates scraps, so the body resumes after
    // the closing ```.
    const fenceOpen = /^```(\w*)\s*$/.exec(line);
    if (fenceOpen && fenceOpen[1].toLowerCase() === 'json') {
      current.fence = { lines: [] };
      continue;
    }
    // `### Scraps` switches us into the scraps subsection — body is done.
    if (scrapsHeadingRe.test(line)) {
      current.section = 'scraps';
      continue;
    }
    if (current.section === 'scraps') {
      const bullet = scrapBulletRe.exec(line);
      if (bullet) {
        const sourceKind = bullet[1].trim() || 'unknown';
        const rawText = bullet[2].trim();
        current.scraps.push({ sourceKind, rawText });
      }
      // Non-bullet lines inside the scraps subsection (blanks) are ignored.
      continue;
    }
    // `tags: a, b, c` (case-insensitive, anywhere in the body section).
    const tagMatch = /^\s*tags\s*:\s*(.*)$/i.exec(line);
    if (tagMatch) {
      current.tags = normalizeTags(tagMatch[1]);
      continue;
    }
    current.bodyLines.push(line);
  }
  flush();
  if (out.length === 0) {
    throw new Error('markdown produced zero `## <Type>: <Name>` sections');
  }
  const entries = out.map((entry, i) => {
    const normalized = normalizeEntry(entry, i);
    // Parse scraps into a NON-enumerable sibling so the markdown re-import is
    // lossy-but-not-corrupt (per PLAN [catalog-markdown-roundtrip-fences-scraps]):
    // the bulk-import route does NOT persist scraps today — it spreads each
    // entry into the `.strict()` catalogIngredientCreateSchema, which has no
    // `scraps` field, so an enumerable key would reject the whole import. The
    // data is preserved on `entry.scraps` for any consumer; persisting it into
    // catalog_scraps/catalog_ingredient_sources is a tracked follow-up.
    if (Array.isArray(entry.scraps) && entry.scraps.length > 0) {
      attachNonEnumerable(normalized, 'scraps', entry.scraps);
    }
    return normalized;
  });
  // Warnings ride as a non-enumerable property on the returned array so
  // existing callers that array-index `result[i]` (or deep-equal it in
  // tests) keep working; the bulk-import handler reads `result.warnings`
  // to surface typos back to the user.
  attachNonEnumerable(entries, 'warnings', warnings);
  return entries;
}

/**
 * Top-level dispatch — `format` is the trusted enum (already Zod-validated
 * at the route boundary).
 */
export function parseBulkPayload(format, payload) {
  if (format === 'json') return parseJsonBulk(payload);
  if (format === 'csv') return parseCsvBulk(payload);
  if (format === 'markdown') return parseMarkdownBulk(payload);
  throw new Error(`unknown bulk-import format: ${format}`);
}

// === Export serializers ===================================================

/**
 * Render a single ingredient as a `## <Type>: <Name>` block with body +
 * tags + scraps. Inverse of parseMarkdownBulk (lossy on payload keys that
 * aren't the primary content key — they're still dumped as a JSON code
 * fence so round-tripping power users don't lose data).
 */
export function ingredientToMarkdown(ing) {
  const lines = [];
  lines.push(`## ${capitalize(ing.type)}: ${ing.name}`);
  lines.push('');
  const primaryKey = PRIMARY_CONTENT_KEY_BY_TYPE[ing.type];
  const payload = ing.payload || {};
  const primaryBody = typeof payload[primaryKey] === 'string' ? payload[primaryKey].trim() : '';
  if (primaryBody) {
    lines.push(primaryBody);
    lines.push('');
  }
  if (Array.isArray(ing.tags) && ing.tags.length > 0) {
    lines.push(`tags: ${ing.tags.join(', ')}`);
    lines.push('');
  }
  // Dump remaining payload keys as a JSON fence so power users keep the
  // full canon shape on round-trip. Empty {} is suppressed.
  const remainder = { ...payload };
  delete remainder[primaryKey];
  if (Object.keys(remainder).length > 0) {
    lines.push('```json');
    lines.push(JSON.stringify(remainder, null, 2));
    lines.push('```');
    lines.push('');
  }
  if (Array.isArray(ing.scraps) && ing.scraps.length > 0) {
    lines.push('### Scraps');
    lines.push('');
    for (const s of ing.scraps) {
      lines.push(`- (${s.sourceKind || 'unknown'}) ${truncate(s.rawText || '', 500)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// Attach metadata (warnings, bundleRef, roleForExportedRef) that rides
// alongside the parsed shape without affecting array-indexing callers or
// deep-equal tests on the entry/array shape.
function attachNonEnumerable(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: false });
}

function capitalize(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n).trimEnd()}…` : s;
}

/**
 * Bundle the export envelope as markdown — top heading + per-ingredient
 * blocks via ingredientToMarkdown.
 */
export function bundleToMarkdown(bundle) {
  const out = [];
  out.push(`# Catalog Export — ${bundle.ref.kind}/${bundle.ref.id}`);
  out.push('');
  out.push(`Exported at ${bundle.exportedAt} (${bundle.ingredients.length} ingredient${bundle.ingredients.length === 1 ? '' : 's'})`);
  out.push('');
  for (const ing of bundle.ingredients) {
    out.push(ingredientToMarkdown(ing));
  }
  return out.join('\n');
}

/**
 * Minimal YAML serializer for the export bundle's JSON shape. Supports the
 * value types we actually emit (strings, numbers, booleans, null, arrays,
 * objects). Strings always quote with double-quotes to sidestep YAML's
 * special-token landmines (`yes`, `no`, `null`, leading-`-`, etc.).
 *
 * Power users who need a richer YAML round-trip can convert from the JSON
 * format instead; we don't pull js-yaml just for this.
 */
export function toYamlString(value) {
  // Top-level shape: emit as a mapping if it's a plain object, else fall
  // back to a list/scalar at depth 0.
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return emitMapping(value, 0).join('\n') + '\n';
  }
  if (Array.isArray(value)) {
    return emitSequence(value, 0).join('\n') + '\n';
  }
  return emitScalar(value) + '\n';
}

function isScalar(v) {
  return v === null || v === undefined || typeof v !== 'object';
}

function emitScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'string') return yamlQuote(value);
  return yamlQuote(String(value));
}

function emitMapping(obj, depth) {
  const pad = '  '.repeat(depth);
  const keys = Object.keys(obj);
  if (keys.length === 0) return [`${pad}{}`];
  const out = [];
  for (const k of keys) {
    const v = obj[k];
    const keyStr = yamlKey(k);
    if (isScalar(v)) {
      out.push(`${pad}${keyStr}: ${emitScalar(v)}`);
      continue;
    }
    if (Array.isArray(v)) {
      if (v.length === 0) {
        out.push(`${pad}${keyStr}: []`);
      } else {
        out.push(`${pad}${keyStr}:`);
        out.push(...emitSequence(v, depth));
      }
      continue;
    }
    // Object (non-null, non-array)
    if (Object.keys(v).length === 0) {
      out.push(`${pad}${keyStr}: {}`);
    } else {
      out.push(`${pad}${keyStr}:`);
      out.push(...emitMapping(v, depth + 1));
    }
  }
  return out;
}

function emitSequence(arr, depth) {
  const pad = '  '.repeat(depth);
  const out = [];
  for (const v of arr) {
    if (isScalar(v)) {
      out.push(`${pad}- ${emitScalar(v)}`);
      continue;
    }
    if (Array.isArray(v)) {
      if (v.length === 0) {
        out.push(`${pad}- []`);
      } else {
        out.push(`${pad}-`);
        out.push(...emitSequence(v, depth + 1));
      }
      continue;
    }
    // Object: inline first key after the `- ` then indent the rest.
    const keys = Object.keys(v);
    if (keys.length === 0) {
      out.push(`${pad}- {}`);
      continue;
    }
    const mapLines = emitMapping(v, depth + 1);
    // The first mapping line already carries depth+1 indentation; rewrite
    // it to use `- ` at depth instead so the list item is properly aligned.
    const firstPad = '  '.repeat(depth + 1);
    const first = mapLines[0].startsWith(firstPad) ? mapLines[0].slice(firstPad.length) : mapLines[0];
    out.push(`${pad}- ${first}`);
    for (let i = 1; i < mapLines.length; i++) out.push(mapLines[i]);
  }
  return out;
}

function yamlKey(k) {
  // Quote keys that aren't safe bare identifiers; covers spaces, colons,
  // special tokens. Cheap and correct for our shape.
  if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(k) && !['null', 'true', 'false', 'yes', 'no'].includes(k.toLowerCase())) {
    return k;
  }
  return yamlQuote(k);
}

function yamlQuote(s) {
  // JSON.stringify already gives us a YAML-compatible double-quoted form
  // for the subset of strings we'll see (escapes \, ", \n, control chars).
  return JSON.stringify(s);
}
