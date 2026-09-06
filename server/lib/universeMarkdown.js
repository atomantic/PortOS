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
    return value.map(formatInlineValue).filter(Boolean).join(', ');
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
      return /^(?:#{1,6}\s|>\s?|[-*_]{3,}\s*$|=+\s*$|-+\s*$|`{3,})/u.test(content)
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
    .map((key) => formatBlockValue(source[key]))
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
