/**
 * Chop a product-requirements document into addressable clauses.
 *
 * `PRD.md` and `GOALS.md` state what the product is supposed to be. Nothing
 * reads them. This module turns that prose into the premise corpus the local
 * entailment scorer needs: a flat list of short, self-contained statements,
 * each one carrying the heading path it came from so a verdict can name the
 * clause a human can go and argue with.
 *
 * THE CORPUS IS NOT A TRAINING SET. 373 lines of product prose is nowhere near
 * one. Its only job is to be split into premises.
 *
 * Pure: no I/O, no module state. `services/scopeAdherence.js` reads the files.
 *
 * ## Clause identity
 *
 * An id is `<sourceFile>#<heading-path-slug>:<content-hash>`, with `~<n>`
 * appended for the second and later identical clauses under one heading. It
 * deliberately carries NO line number and NO document-wide ordinal: a clause
 * has to keep its id when an unrelated paragraph is inserted above it, or an
 * adherence verdict recorded last week would address a different clause today.
 * The hash covers the clause's own normalized text before any truncation, so
 * shortening the display cap does not re-key the corpus.
 */

import { createHash } from 'crypto';

/** The documents PortOS scores its own changes against. */
export const PRD_CLAUSE_SOURCES = Object.freeze(['PRD.md', 'GOALS.md']);

/**
 * Per-clause character cap.
 *
 * Far below the scorer's premise bound (`JEV_MAX_PREMISE_CHARS`), because the
 * premise is the clause PLUS the change being scored against it — the clause
 * is the small half. A single requirement that needs more than this to state
 * itself is a requirement nobody can check either.
 */
export const PRD_MAX_CLAUSE_CHARS = 2_000;

/** Below this a "clause" is a stray fragment, not a statement of intent. */
const MIN_CLAUSE_CHARS = 24;

const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^\s*(```|~~~)/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const LIST_ITEM = /^\s{0,3}(?:[-*+]|\d{1,3}[.)])\s+/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_DIVIDER = /^\s*\|[\s:|-]+\|\s*$/;
const BLOCKQUOTE = /^\s*>+\s?/;

const slug = (text) => text
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 60);

/** Strip the markdown that carries no meaning for an entailment scorer. */
function flatten(text) {
  return text
    .replace(/^\s*>+\s?/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A table row rendered as one sentence: `FR-1 — The system MUST … — Must — …`. */
function flattenTableRow(line) {
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|')
    .map((cell) => flatten(cell))
    .filter(Boolean);
  return cells.join(' — ');
}

const contentHash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 8);

/** H1 count outside fenced code, so a `# comment` in a shell example doesn't vote. */
function countTopLevelHeadings(lines) {
  let fenced = false;
  let count = 0;
  for (const line of lines) {
    if (FENCE.test(line)) { fenced = !fenced; continue; }
    if (!fenced && /^#\s/.test(line)) count += 1;
  }
  return count;
}

/**
 * Split one markdown document into clauses.
 *
 * A clause is a paragraph, a top-level list item (with its nested lines
 * folded in), a blockquote, or a table data row. Headings build the path;
 * fenced code, table headers, and horizontal rules are dropped — they are
 * syntax or examples, not statements about the product.
 *
 * @param {string} markdown Raw file contents.
 * @param {{ sourceFile?: string }} options `sourceFile` is part of every id.
 * @returns {Array<{ id, heading, headingPath, text, sourceFile, line }>}
 */
export function parsePrdClauses(markdown, { sourceFile = 'PRD.md' } = {}) {
  if (typeof markdown !== 'string' || !markdown.trim()) return [];

  const lines = markdown.split(/\r?\n/);
  const clauses = [];
  // Occurrence counter per (headingPath, hash). Two byte-identical clauses
  // under one heading are rare but legal, and they must not share an id.
  const seen = new Map();
  const headings = [];
  let fenced = false;
  // The block being accumulated: paragraph lines, or one list item plus its
  // continuation lines.
  let buffer = [];
  let bufferLine = 0;

  // A document with exactly one H1 is using it as a title, not as a section,
  // so it is dropped from every citation — `PRD.md § PRD.md — PortOS ›
  // Overview` reads as a bug. A document that sections with H1s keeps them.
  const titleH1 = countTopLevelHeadings(lines) === 1;
  const headingPath = () => headings.slice(titleH1 ? 1 : 0).filter(Boolean).join(' › ');

  const flush = () => {
    if (!buffer.length) return;
    const raw = flatten(buffer.join(' '));
    buffer = [];
    if (raw.length < MIN_CLAUSE_CHARS) return;
    push(raw, bufferLine);
  };

  const push = (raw, line) => {
    const path = headingPath();
    const hash = contentHash(raw);
    const key = `${path}:${hash}`;
    const occurrence = seen.get(key) || 0;
    seen.set(key, occurrence + 1);
    clauses.push({
      id: `${sourceFile}#${slug(path) || 'document'}:${hash}${occurrence ? `~${occurrence}` : ''}`,
      heading: headings.filter(Boolean).at(-1) || sourceFile,
      headingPath: path,
      text: raw.length > PRD_MAX_CLAUSE_CHARS ? `${raw.slice(0, PRD_MAX_CLAUSE_CHARS - 1)}…` : raw,
      sourceFile,
      line,
    });
  };

  lines.forEach((line, index) => {
    const lineNumber = index + 1;

    if (FENCE.test(line)) {
      flush();
      fenced = !fenced;
      return;
    }
    if (fenced) return;

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const depth = heading[1].length;
      headings.length = Math.max(depth - 1, 0);
      headings[depth - 1] = flatten(heading[2]);
      return;
    }

    if (!line.trim() || RULE.test(line)) {
      flush();
      return;
    }

    if (TABLE_ROW.test(line)) {
      flush();
      // Look AHEAD for the divider rather than retracting an already-pushed
      // row: a retraction would leave the duplicate-occurrence counter
      // incremented, and a later identical clause would silently take a `~1`
      // id that nothing else agrees with.
      if (TABLE_DIVIDER.test(line) || TABLE_DIVIDER.test(lines[index + 1] || '')) return;
      const row = flattenTableRow(line);
      if (row.length >= MIN_CLAUSE_CHARS) push(row, lineNumber);
      return;
    }

    const content = line.replace(BLOCKQUOTE, '');
    // A new list item ends the previous block; an indented continuation of one
    // does not, so a nested bullet stays with the item it qualifies.
    if (LIST_ITEM.test(content)) flush();
    if (!buffer.length) bufferLine = lineNumber;
    buffer.push(content.replace(LIST_ITEM, '').trim());
  });

  flush();
  return clauses;
}

/** Clause lookup by id, for rendering a verdict's cited clause. */
export function indexClausesById(clauses) {
  return new Map((Array.isArray(clauses) ? clauses : []).map((clause) => [clause.id, clause]));
}

/** `PRD.md § Functional Requirements › AI Agent Orchestration` — a human-readable citation. */
export function formatClauseCitation(clause) {
  if (!clause?.sourceFile) return '';
  return clause.headingPath ? `${clause.sourceFile} § ${clause.headingPath}` : clause.sourceFile;
}
