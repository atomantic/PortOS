/**
 * Deterministic Markdown serializer for a Universe Builder world bible.
 *
 * This module is intentionally pure: it reads a universe-shaped record and
 * returns text without touching storage, the filesystem, or the network.
 * Filename normalization mirrors client/src/lib/universeMarkdownFilename.js;
 * change both helpers in the same commit and run their shared contract cases.
 */

const CANON_ENTRY_FIELD_ORDER = Object.freeze({
  characters: Object.freeze([
    'aliases', 'role', 'pronouns', 'age', 'coreTheme', 'speechAccent',
    'speechPattern', 'visualNotes', 'physicalDescription', 'personality',
    'background', 'silhouetteNotes', 'postureNotes', 'specialTraits',
    'visualIdentity', 'motivations', 'ghost', 'wound', 'lie', 'want', 'need',
    'psychology', 'arcType', 'sliders', 'secrets', 'likes', 'dislikes', 'mannerisms',
    'relationships', 'skills', 'stats', 'colorPalette', 'props',
    'expressions', 'handGestures', 'voiceId', 'wardrobes', 'tags', 'prompt',
    'notes', 'evidence', 'firstAppearance', 'imageRefs', 'primaryImageRef',
    'referenceSheetImageRef', 'referenceSheets',
  ]),
  places: Object.freeze([
    'slugline', 'description', 'palette', 'era', 'weather', 'intExt',
    'timeOfDay', 'recurringDetails', 'tags', 'prompt', 'notes', 'evidence',
    'firstAppearance', 'imageRefs', 'primaryImageRef',
  ]),
  objects: Object.freeze([
    'aliases', 'description', 'significance', 'attachments', 'tags', 'prompt',
    'notes', 'evidence', 'firstAppearance', 'imageRefs', 'primaryImageRef',
  ]),
});

const ENTRY_METADATA_FIELDS = new Set([
  'id', 'createdAt', 'updatedAt', 'source', 'sourceSeriesId', 'ingredientId',
  'deleted', 'deletedAt', 'schemaVersion', 'locked', 'missingFromProse',
]);

const CANON_SECTIONS = Object.freeze([
  ['characters', 'Characters'],
  ['places', 'Places'],
  ['objects', 'Objects'],
]);

const compareNames = (left, right) => {
  const a = String(left).toLowerCase();
  const b = String(right).toLowerCase();
  if (a < b) return -1;
  if (a > b) return 1;
  const rawA = String(left);
  const rawB = String(right);
  return rawA < rawB ? -1 : rawA > rawB ? 1 : 0;
};

const hasContent = (value) => {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return Boolean(value.trim());
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.some(hasContent);
  if (typeof value === 'object') return Object.values(value).some(hasContent);
  return false;
};

const formatFieldLabel = (key) => String(key)
  .replace(/([a-z])([A-Z])/g, '$1 $2')
  .replace(/[_-]+/g, ' ')
  .replace(/^./, (char) => char.toUpperCase());

const formatInlineValue = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim().replace(/\s*[\r\n]+\s*/g, ' ');
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value
      .map(formatInlineValue)
      .filter(Boolean)
      .map((rendered) => rendered.replace(/\\/g, '\\\\').replace(/,/g, '\\,'))
      .join(', ');
  }
  if (typeof value === 'object') {
    return Object.entries(value)
      .filter(([key]) => !ENTRY_METADATA_FIELDS.has(key))
      .sort(([a], [b]) => compareNames(a, b))
      .map(([key, nested]) => {
        const rendered = formatInlineValue(nested);
        return rendered ? `${formatFieldLabel(key)}: ${rendered}` : '';
      })
      .filter(Boolean)
      .join('; ');
  }
  return '';
};

const formatBlockValue = (value) => {
  if (typeof value !== 'string') return formatInlineValue(value);
  return value
    .trim()
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      const leading = line.match(/^\s*/u)?.[0] || '';
      const content = line.slice(leading.length);
      return /^(?:#{1,6}\s|>\s?|[-*_]{3,}\s*$|=+\s*$|-+\s*$|`{3,}|\*\*[^*]+:\*\*)/u.test(content)
        ? `${leading}\\${content}`
        : line;
    })
    .join('\n');
};

const headingText = (value, fallback) => String(value || fallback)
  .trim()
  .replace(/[\r\n]+/g, ' ')
  .replace(/\s+/g, ' ');

const entryName = (entry, fallback) => headingText(entry?.name || entry?.slugline, fallback);

const entryHeadingKey = (entry) => (typeof entry?.name === 'string' && entry.name.trim()
  ? 'name'
  : typeof entry?.slugline === 'string' && entry.slugline.trim() ? 'slugline' : null);

const orderedEntryKeys = (kind, entry) => {
  const preferred = CANON_ENTRY_FIELD_ORDER[kind] || [];
  const headingKey = entryHeadingKey(entry);
  const preferredKeys = preferred.filter((key) => Object.prototype.hasOwnProperty.call(entry, key));
  const remainingKeys = Object.keys(entry)
    .filter((key) => key !== 'name' && key !== headingKey
      && !preferred.includes(key) && !ENTRY_METADATA_FIELDS.has(key))
    .sort(compareNames);
  return [...preferredKeys.filter((key) => key !== headingKey), ...remainingKeys];
};

const renderEntry = (kind, entry, fallback) => {
  if (!entry || typeof entry !== 'object') return '';
  const lines = [`### ${entryName(entry, fallback)}`];
  for (const key of orderedEntryKeys(kind, entry)) {
    const value = entry[key];
    if (!hasContent(value)) continue;
    const rendered = formatBlockValue(value);
    if (!rendered) continue;
    lines.push(`**${formatFieldLabel(key)}:** ${rendered}`);
  }
  return lines.join('\n\n');
};

const renderCanonSection = (key, title, record) => {
  const entries = Array.isArray(record?.[key]) ? record[key] : [];
  if (entries.length === 0) return '';
  const renderedEntries = entries
    .map((entry, index) => renderEntry(key, entry, `${title.slice(0, -1)} ${index + 1}`))
    .filter(Boolean);
  return renderedEntries.length ? `## ${title}\n\n${renderedEntries.join('\n\n')}` : '';
};

const renderCategory = (name, category) => {
  const variations = Array.isArray(category) ? category : category?.variations;
  if (!Array.isArray(variations) || variations.length === 0) return '';
  const lines = [`### ${headingText(name, 'Unnamed Category')}`];
  if (category?.kind) lines.push(`**Kind:** ${formatInlineValue(category.kind)}`);
  for (const variation of variations) {
    if (typeof variation === 'string') {
      const rendered = formatInlineValue(variation);
      if (rendered) lines.push(`- ${rendered}`);
      continue;
    }
    if (!variation || typeof variation !== 'object') continue;
    const label = formatInlineValue(variation.label || variation.name);
    const prompt = formatInlineValue(variation.prompt || variation.description);
    if (!label && !prompt) continue;
    if (label && prompt) lines.push(`- **${label}** — ${prompt}`);
    else lines.push(`- ${label || prompt}`);
  }
  return lines.length > 1 ? lines.join('\n') : '';
};

const renderCategories = (record) => {
  if (!record?.categories || typeof record.categories !== 'object' || Array.isArray(record.categories)) return '';
  const categories = Object.entries(record.categories)
    .sort(([a], [b]) => compareNames(a, b))
    .map(([name, category]) => renderCategory(name, category))
    .filter(Boolean);
  return categories.length ? `## Categories\n\n${categories.join('\n\n')}` : '';
};

const listValues = (value) => (Array.isArray(value) ? value : [])
  .map((item) => formatInlineValue(item))
  .filter(Boolean);

const renderInfluences = (record) => {
  const embrace = listValues(record?.influences?.embrace);
  const avoid = listValues(record?.influences?.avoid);
  const lines = [
    ...embrace.map((value) => `- Embrace: ${value}`),
    ...avoid.map((value) => `- Avoid: ${value}`),
  ];
  return lines.length ? `## Influences\n\n${lines.join('\n')}` : '';
};

const filenamesFor = (item) => [
  ...(Array.isArray(item?.imageRefs) ? item.imageRefs : []),
  ...(typeof item?.filename === 'string' ? [item.filename] : []),
].map((filename) => formatInlineValue(filename)).filter(Boolean);

const renderNamedFileList = (title, values, nameKeys) => {
  if (!Array.isArray(values) || values.length === 0) return '';
  const lines = values.map((item) => {
    if (typeof item === 'string') return formatInlineValue(item);
    if (!item || typeof item !== 'object') return '';
    const name = nameKeys.map((key) => formatInlineValue(item[key])).find(Boolean) || '';
    const filenames = filenamesFor(item);
    return [name, ...filenames].filter(Boolean).join(' — ');
  }).filter(Boolean);
  return lines.length ? `## ${title}\n\n${lines.map((line) => `- ${line}`).join('\n')}` : '';
};

/**
 * Convert a universe name to a filesystem-safe, human-readable slug.
 *
 * The fallback keeps the download filename useful even for a missing or
 * non-ASCII-only name while the character whitelist prevents path traversal.
 */
export const slugifyUniverseName = (name) => {
  const value = String(name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return value || 'universe';
};

export const universeMarkdownFilename = (name) => `${slugifyUniverseName(name)}.md`;

/**
 * Serialize one Universe Builder record as a deterministic Markdown world
 * bible. Canon arrays retain stored order; category names sort alphabetically.
 *
 * @param {Record<string, unknown>} record - A sanitized or universe-shaped record.
 * @returns {string} Markdown text ending in one newline.
 */
export function universeToMarkdown(record) {
  const source = record && typeof record === 'object' ? record : {};
  const sections = [`# ${headingText(source.name, 'Untitled Universe')}`];
  const prose = ['logline', 'premise', 'styleNotes']
    .map((key) => {
      const value = formatBlockValue(source[key]);
      return value ? `**${formatFieldLabel(key)}:** ${value}` : '';
    })
    .filter(Boolean);
  if (prose.length) sections.push(prose.join('\n\n'));

  for (const [key, title] of CANON_SECTIONS) {
    const section = renderCanonSection(key, title, source);
    if (section) sections.push(section);
  }

  for (const section of [
    renderCategories(source),
    renderInfluences(source),
    renderNamedFileList('Composite Sheets', source.compositeSheets, ['label', 'name']),
    renderNamedFileList('Style References', source.styleReferences, ['title', 'label', 'name']),
  ]) {
    if (section) sections.push(section);
  }

  return `${sections.join('\n\n').trimEnd()}\n`;
}

const STRING_FIELDS = Object.freeze({
  characters: new Set([
    'role', 'pronouns', 'age', 'coreTheme', 'speechAccent', 'speechPattern',
    'visualNotes', 'physicalDescription', 'personality', 'background',
    'silhouetteNotes', 'postureNotes', 'specialTraits', 'visualIdentity',
    'motivations', 'ghost', 'wound', 'lie', 'want', 'need', 'arcType',
    'likes', 'dislikes', 'mannerisms', 'relationships', 'skills', 'voiceId',
    'prompt', 'notes', 'firstAppearance',
  ]),
  places: new Set([
    'slugline', 'description', 'palette', 'era', 'weather', 'intExt',
    'timeOfDay', 'recurringDetails', 'prompt', 'notes', 'firstAppearance',
  ]),
  objects: new Set([
    'description', 'significance', 'prompt', 'notes', 'firstAppearance',
  ]),
});

const ARRAY_FIELDS = Object.freeze({
  characters: new Set(['aliases', 'tags', 'secrets', 'evidence', 'missingFromProse']),
  places: new Set(['tags', 'evidence', 'missingFromProse']),
  objects: new Set(['aliases', 'tags', 'evidence', 'missingFromProse']),
});
const UNIVERSE_FIELDS = new Map([
  ['logline', 'logline'],
  ['premise', 'premise'],
  ['styleNotes', 'styleNotes'],
]);
const SECTION_NAMES = new Map([
  ['characters', 'characters'],
  ['places', 'places'],
  ['objects', 'objects'],
  ['categories', 'categories'],
  ['influences', 'influences'],
]);

const unescapeMarkdownLine = (line) => line.replace(
  /^(\s*)\\(?=(?:#{1,6}\s|>\s?|[-*_]{3,}\s*$|`{3,}|\*\*[^*]+:\*\*))/u,
  '$1',
);

const fieldKey = (label) => label
  .trim()
  .toLowerCase()
  .split(/[^a-z0-9]+/u)
  .filter(Boolean)
  .map((part, index) => (index === 0 ? part : `${part[0].toUpperCase()}${part.slice(1)}`))
  .join('');

const FIELD_LINE = /^\*\*([^*]+):\*\*(?:\s+(.*))?$/u;

const readFieldBlocks = (lines, isKnownField) => {
  const fields = {};
  const free = [];
  let activeKey = null;
  let activeLines = [];
  let ignoringField = false;
  const flush = () => {
    if (activeKey) fields[activeKey] = activeLines.join('\n').trim();
    activeKey = null;
    activeLines = [];
  };

  for (const rawLine of lines) {
    const line = unescapeMarkdownLine(rawLine);
    const escapedFieldLine = /^\s*\\\*\*[^*]+:\*\*/u.test(rawLine);
    const match = escapedFieldLine ? null : line.match(FIELD_LINE);
    if (match) {
      flush();
      activeKey = fieldKey(match[1]);
      ignoringField = !isKnownField(activeKey);
      if (ignoringField) activeKey = null;
      else activeLines = [match[2] || ''];
    } else if (activeKey) {
      activeLines.push(line);
    } else if (!ignoringField) {
      free.push(line);
    }
  }
  flush();
  return { fields, freeText: free.join('\n').trim() };
};

const splitArrayValue = (value) => {
  const items = [];
  let item = '';
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === '\\' && (value[i + 1] === ',' || value[i + 1] === '\\')) {
      item += value[i + 1];
      i += 1;
    } else if (value[i] === ',') {
      if (item.trim()) items.push(item.trim());
      item = '';
      while (value[i + 1] === ' ') i += 1;
    } else {
      item += value[i];
    }
  }
  if (item.trim()) items.push(item.trim());
  return items;
};

const readSections = (lines) => {
  const sections = [];
  let current = null;
  const preamble = [];
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*#*\s*$/u);
    if (!heading) {
      if (current) current.lines.push(line);
      else preamble.push(line);
      continue;
    }
    current = { title: heading[1].trim().toLowerCase(), lines: [] };
    sections.push(current);
  }
  return { preamble, sections };
};

const splitSubsections = (lines) => {
  const subsections = [];
  let current = null;
  for (const line of lines) {
    const heading = line.match(/^###\s+(.+?)\s*#*\s*$/u);
    if (!heading) {
      if (current) current.lines.push(line);
      continue;
    }
    current = { title: unescapeMarkdownLine(heading[1]).trim(), lines: [] };
    subsections.push(current);
  }
  return subsections;
};

const parseCanonEntries = (kind, lines) => splitSubsections(lines).map(({ title, lines: entryLines }) => {
  const { fields, freeText } = readFieldBlocks(
    entryLines,
    (key) => STRING_FIELDS[kind].has(key) || ARRAY_FIELDS[kind].has(key),
  );
  const entry = { ...(kind === 'places' && /^(?:int\.?\s*\/\s*ext\.?|ext\.?|int\.?)(?:\s|\.)/iu.test(title)
    ? { slugline: title }
    : { name: title }) };
  for (const [key, value] of Object.entries(fields)) {
    if (STRING_FIELDS[kind].has(key)) entry[key] = value;
    else if (ARRAY_FIELDS[kind].has(key)) entry[key] = splitArrayValue(value);
  }
  if (freeText && !entry.notes) entry.notes = freeText;
  return entry;
});

const parseCategories = (lines) => Object.fromEntries(splitSubsections(lines).map(({ title, lines: categoryLines }) => {
  let kind;
  const variations = [];
  for (const rawLine of categoryLines) {
    const line = unescapeMarkdownLine(rawLine).trim();
    const kindMatch = line.match(/^\*\*kind:\*\*\s*(.+)$/iu);
    if (kindMatch) {
      kind = kindMatch[1].trim();
      continue;
    }
    const labeled = line.match(/^-\s+\*\*(.+?)\*\*\s+—\s+(.*)$/u);
    if (labeled) {
      variations.push({ label: labeled[1].trim(), prompt: labeled[2].trim() });
      continue;
    }
    const bullet = line.match(/^-\s+(.+)$/u);
    if (bullet) {
      const value = bullet[1].trim();
      if (value) variations.push({ label: value, prompt: value });
    }
  }
  return [title, { ...(kind ? { kind } : {}), variations }];
}));

const parseInfluences = (lines) => {
  const influences = { embrace: [], avoid: [] };
  for (const rawLine of lines) {
    const match = unescapeMarkdownLine(rawLine).trim().match(/^-\s+(embrace|avoid):\s*(.+)$/iu);
    if (!match) continue;
    const value = match[2].trim();
    if (value) influences[match[1].toLowerCase()].push(value);
  }
  return influences;
};

/**
 * Parse the editable world-bible fields represented by Universe Markdown.
 * Exported sections are treated as replacements; omitted sections are absent
 * from the patch. The parser intentionally skips local image pointers and
 * inventory-only Composite Sheets / Style References rows.
 *
 * @param {string} markdown - A Markdown document with a top-level universe title.
 * @returns {Record<string, unknown>} A partial universe patch.
 */
export function parseUniverseMarkdown(markdown) {
  if (typeof markdown !== 'string') throw new Error('Choose a Markdown file to import.');
  const lines = markdown.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').split('\n');
  const titleIndex = lines.findIndex((line) => line.trim());
  const title = titleIndex >= 0 ? lines[titleIndex].match(/^#\s+(.+?)\s*#*\s*$/u) : null;
  if (!title?.[1]?.trim()) throw new Error('Markdown must start with a top-level # universe title.');

  const { preamble, sections } = readSections(lines.slice(titleIndex + 1));
  const { fields: topFields, freeText } = readFieldBlocks(
    preamble,
    (key) => UNIVERSE_FIELDS.has(key),
  );
  const patch = { name: title[1].trim() };
  for (const [key, value] of Object.entries(topFields)) patch[UNIVERSE_FIELDS.get(key)] = value;
  if (freeText && !('premise' in patch)) patch.premise = freeText;

  for (const section of sections) {
    const key = SECTION_NAMES.get(section.title);
    if (key === 'characters' || key === 'places' || key === 'objects') {
      patch[key] = parseCanonEntries(key, section.lines);
    } else if (key === 'categories') {
      patch.categories = parseCategories(section.lines);
    } else if (key === 'influences') {
      patch.influences = parseInfluences(section.lines);
    }
  }
  return patch;
}
