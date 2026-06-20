/**
 * Legacy Export — a portable, self-contained identity bundle.
 *
 * Gathers identity across every PortOS domain (digital twin, autobiography,
 * brain, memories, goals, health) into a zip of Markdown + machine-readable
 * JSON + a SHA-256 `manifest.json`. The bundle is readable with **zero PortOS
 * running** — plain Markdown/JSON, no database. Closes the GOALS "Knowledge
 * Legacy" gap (issue #901).
 *
 * Modeled after `backup.js`: gather data (each source degrades to a fallback so
 * one missing domain never fails the export), build per-section Markdown + JSON,
 * compute a SHA-256 manifest, emit `legacy-export:*` socket events, and return a
 * single zip Buffer via the dependency-free `zipWriter.js`.
 *
 * Phase 1 (this file): server-side zip bundle, no PDF, no client UI. PDF
 * rendering and the export UI are tracked as follow-up issues.
 */

import { createHash } from 'crypto';
import { hostname } from 'os';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { createZip } from '../lib/zipWriter.js';
import { getCurrentVersion } from './updateChecker.js';
import { exportDigitalTwin } from './digital-twin-export.js';
import { getStories } from './autobiography.js';
import { getGenomeSummary } from './genome.js';
import { getTasteProfile } from './taste-questionnaire.js';
import { getChronotype, getLongevity } from './identity.js';
import { getTraits } from './digital-twin-analysis.js';
import { getAll as getBrainAll } from './brainStorage.js';
import { getMemories } from './memory.js';
import { getGoalsTree } from './identity/goals.js';
import { getLatestMetricValues } from './appleHealthQuery.js';

const MACHINE_HOST = hostname().toLowerCase().replace(/[^\w.\-]/g, '_') || 'unknown';

// Brain entity stores that belong in a personal legacy bundle. We deliberately
// skip operational stores (`admin`, `buckets`, `inbox`) — they're workflow
// scaffolding, not identity.
const BRAIN_LEGACY_TYPES = ['people', 'projects', 'ideas', 'journals', 'links'];

// Health metrics surfaced in the summary, with the human label used in Markdown.
// Each value carries its own freshness date (last sync) as the source caveat.
// Keys are the canonical stored metric names — `heart_rate_variability_sdnn`
// (the alias in appleHealthQuery resolves it to `heart_rate_variability` too).
// Only metrics whose points expose a numeric `qty`/`Avg`/`value` are listed:
// `getLatestMetricValues` can't extract sleep (stored as `totalSleep`), so sleep
// is left to the dedicated health follow-up rather than perpetually reported absent.
const HEALTH_METRICS = [
  ['resting_heart_rate', 'Resting heart rate', 'bpm'],
  ['heart_rate_variability_sdnn', 'Heart rate variability', 'ms'],
  ['weight_body_mass', 'Body mass', ''],
  ['step_count', 'Daily steps', ''],
  ['vo2_max', 'VO₂ max', ''],
];

// Soft size guardrail (issue #901 open Q3). The bundle is intentionally a FULL
// plaintext dump — silently truncating identity data would defeat its purpose —
// so instead of capping, the preview surfaces a warning above this threshold so
// the user knows a large export is coming (and which section drives it). The
// estimate is of the uncompressed content; the delivered zip is deflated and
// smaller. 25 MB is generous for text identity data; a bundle past it is almost
// always a very large brain/memory corpus the user should be aware of.
const SIZE_WARNING_BYTES = 25 * 1024 * 1024;

const HEALTH_CAVEAT =
  '> ⚠️ **Source caveat:** the figures below are device-reported (Apple Health / manual lab entry) ' +
  'and unvalidated. They are a personal-tracking snapshot, **not a verified medical record**, and ' +
  'each line states its own source and freshness.';

/**
 * Mask obvious secrets that may have been pasted into free-text identity
 * content (brain notes, journals, autobiography). Defense-in-depth: the bundle
 * leaves the machine, so a stray API key in a note must not ride along. Pure,
 * conservative — only high-confidence token shapes are touched so prose is never
 * mangled.
 */
export function redactSecrets(text) {
  if (typeof text !== 'string' || !text) return text;
  return text
    // OpenAI / Anthropic style: sk-..., sk-ant-...
    .replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]')
    // GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_, github_pat_
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED]')
    // AWS access key id
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]')
    // Slack tokens
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED]')
    // Bearer tokens in headers
    .replace(/\bBearer\s+[A-Za-z0-9._-]{20,}\b/g, 'Bearer [REDACTED]')
    // PEM private-key blocks
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    // Quoted config/JSON secret assignments — `"password": "..."`, `api_key='...'`.
    // Require the value to be QUOTE-DELIMITED so free-text prose like
    // `my secret: I never learned to swim` is not mangled (a real false-positive
    // risk in autobiography/journal content). Token-shaped secrets pasted into
    // prose are already caught by the specific patterns above, quoted or not.
    .replace(/(["']?(?:password|passwd|secret|api[_-]?key|token)["']?\s*[:=]\s*)(["'])[^"'\n]{6,}\2/gi, '$1$2[REDACTED]$2');
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Gather identity data across every domain. Each source is independently
 * `.catch`-guarded so a single unavailable backend (e.g. Postgres-backed brain
 * when running file-only) degrades to an empty section instead of failing the
 * whole export.
 */
export async function gatherLegacyData() {
  const brainEntries = {};
  await Promise.all(BRAIN_LEGACY_TYPES.map(async (type) => {
    brainEntries[type] = await getBrainAll(type).catch(() => []);
  }));

  const [
    twinPrompt, claudeMd, stories, genome, taste, chronotype, longevity, traits,
    memoriesResult, goalsTree, healthValues,
  ] = await Promise.all([
    exportDigitalTwin('system_prompt').then(r => r?.content || '').catch(() => ''),
    exportDigitalTwin('claude_md').then(r => r?.content || '').catch(() => ''),
    getStories().catch(() => []),
    getGenomeSummary().catch(() => ({ uploaded: false })),
    getTasteProfile().catch(() => ({ sections: [] })),
    getChronotype().catch(() => null),
    getLongevity().catch(() => null),
    getTraits().catch(() => null),
    getMemories({ limit: 100000 }).catch(() => ({ total: 0, memories: [] })),
    getGoalsTree().catch(() => ({ roots: [], flat: [] })),
    getLatestMetricValues(HEALTH_METRICS.map(m => m[0])).catch(() => ({})),
  ]);

  return {
    twinPrompt,
    claudeMd,
    stories: Array.isArray(stories) ? stories : [],
    genome: genome || { uploaded: false },
    taste: taste || { sections: [] },
    chronotype: chronotype || null,
    longevity: longevity || null,
    traits: traits || null,
    brain: brainEntries,
    memories: Array.isArray(memoriesResult?.memories) ? memoriesResult.memories : [],
    goals: Array.isArray(goalsTree?.flat) ? goalsTree.flat : [],
    health: healthValues || {},
  };
}

// === Section descriptors ===
// Each section is self-describing: how to detect presence, count records, and
// render Markdown + machine-readable JSON. The route's section-filter and the
// manifest both iterate this one list, so adding a domain is a single entry.

const SECTIONS = [
  {
    key: 'identity',
    dir: 'identity',
    label: 'Identity & Values',
    present: (d) => !!(d.twinPrompt || d.claudeMd || d.traits || d.chronotype || d.longevity || d.taste?.sections?.length),
    counts: (d) => ({ hasTwinPrompt: !!d.twinPrompt, traits: d.traits?.dimensions ? Object.keys(d.traits.dimensions).length : 0 }),
    files: (d) => {
      const out = [];
      if (d.twinPrompt) out.push({ name: 'identity/digital-twin-prompt.md', data: redactSecrets(d.twinPrompt) });
      if (d.claudeMd) out.push({ name: 'identity/claude.md', data: redactSecrets(d.claudeMd) });
      out.push({ name: 'identity/profile.md', data: buildIdentityProfileMd(d) });
      out.push({ name: 'data/identity.json', data: jsonFile({
        traits: d.traits || null,
        chronotype: d.chronotype || null,
        longevity: d.longevity || null,
        taste: d.taste || null,
        genome: d.genome || null,
      }) });
      return out;
    },
  },
  {
    key: 'autobiography',
    dir: 'autobiography',
    label: 'Life Stories',
    present: (d) => d.stories.length > 0,
    counts: (d) => ({ stories: d.stories.length }),
    files: (d) => [
      { name: 'autobiography/autobiography.md', data: buildAutobiographyMd(d.stories) },
      { name: 'data/autobiography.json', data: jsonFile(d.stories) },
    ],
  },
  {
    key: 'brain',
    dir: 'brain',
    label: 'Brain & Memories',
    present: (d) => d.memories.length > 0 || BRAIN_LEGACY_TYPES.some(t => (d.brain[t] || []).length > 0),
    counts: (d) => ({
      memories: d.memories.length,
      ...Object.fromEntries(BRAIN_LEGACY_TYPES.map(t => [t, (d.brain[t] || []).length])),
    }),
    files: (d) => {
      const out = [];
      for (const type of BRAIN_LEGACY_TYPES) {
        const records = d.brain[type] || [];
        if (records.length === 0) continue;
        out.push({ name: `brain/${type}.md`, data: buildBrainTypeMd(type, records) });
      }
      if (d.memories.length > 0) {
        out.push({ name: 'brain/memories.md', data: buildMemoriesMd(d.memories) });
      }
      out.push({ name: 'data/brain.json', data: jsonFile({ ...d.brain, memories: d.memories }) });
      return out;
    },
  },
  {
    key: 'goals',
    dir: 'goals',
    label: 'Goals & Milestones',
    present: (d) => d.goals.length > 0,
    counts: (d) => ({ goals: d.goals.length }),
    files: (d) => [
      { name: 'goals/goals.md', data: buildGoalsMd(d.goals) },
      { name: 'data/goals.json', data: jsonFile(d.goals) },
    ],
  },
  {
    key: 'decisions',
    dir: 'decisions',
    label: 'Key Decisions',
    // Derived (never a first-class entity) from three existing signals:
    // completed goals, completed goal milestones, and decision-tagged brain
    // entries. PortOS has no dedicated life-decisions store (decisionLog.js is
    // CoS task scheduling), and an ADR records why we keep deriving rather than
    // add one (docs/decisions/2026-06-19-legacy-export-decisions-source.md).
    present: (d) => collectDecisions(d).length > 0,
    counts: (d) => ({ decisions: collectDecisions(d).length }),
    files: (d) => [
      { name: 'decisions/key-decisions.md', data: buildDecisionsMd(d) },
    ],
    source: 'Derived from completed goals, completed goal milestones, and decision-tagged brain entries (PortOS has no dedicated life-decisions store; see ADR 2026-06-19-legacy-export-decisions-source).',
  },
  {
    key: 'health',
    dir: 'health',
    label: 'Health Summary',
    present: (d) => HEALTH_METRICS.some(([metric]) => d.health[metric]),
    counts: (d) => ({ metrics: HEALTH_METRICS.filter(([m]) => d.health[m]).length }),
    files: (d) => [
      { name: 'health/health-summary.md', data: buildHealthMd(d.health) },
      { name: 'data/health.json', data: jsonFile(d.health) },
    ],
    source: 'Device-reported (Apple Health) and manual lab entry — unvalidated, not a medical record.',
  },
];

export function getSectionKeys() {
  return SECTIONS.map(s => s.key);
}

// === Markdown builders (pure) ===

function mdHeader(title, subtitle) {
  return `# ${title}\n\n*${subtitle}*\n`;
}

function buildIdentityProfileMd(d) {
  const out = [mdHeader('Identity Profile', 'Personality, chronotype, taste, genome, and longevity')];
  if (d.traits?.dimensions) {
    out.push('## Personality Traits\n');
    const lines = Object.entries(d.traits.dimensions)
      .filter(([, v]) => v?.score != null)
      .map(([k, v]) => `- **${titleize(k)}**: ${v.score}/100${v.label ? ` (${v.label})` : ''}`);
    if (lines.length) out.push(lines.join('\n'));
    if (d.traits.summary) out.push(`\n${redactSecrets(d.traits.summary)}`);
  }
  if (d.chronotype?.type) {
    out.push('## Chronotype\n');
    out.push(`**Type**: ${d.chronotype.type}${d.chronotype.confidence ? ` (${Math.round(d.chronotype.confidence * 100)}% confidence)` : ''}`);
  }
  const completed = (d.taste?.sections || []).filter(s => s.status === 'complete');
  if (completed.length) {
    out.push('## Taste Profile\n');
    for (const s of completed) {
      out.push(`### ${s.label}\n`);
      if (s.summary) out.push(redactSecrets(s.summary));
    }
  }
  if (d.genome?.uploaded) {
    out.push('## Genome\n');
    const g = [`- **SNPs analyzed**: ${num(d.genome.snpCount) != null ? d.genome.snpCount.toLocaleString() : 'unknown'}`];
    if (d.genome.markerCount) g.push(`- **Markers tracked**: ${d.genome.markerCount}`);
    out.push(g.join('\n'));
  }
  if (d.longevity?.estimatedLifeExpectancy) {
    out.push('## Longevity\n');
    out.push(`- **Estimated life expectancy**: ${d.longevity.estimatedLifeExpectancy} years`);
  }
  return out.join('\n\n');
}

function buildAutobiographyMd(stories) {
  const out = [mdHeader('Autobiography', `${stories.length} life ${stories.length === 1 ? 'story' : 'stories'}`)];
  const sorted = [...stories].sort((a, b) =>
    (a.themeId || '').localeCompare(b.themeId || '') ||
    String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  let theme = null;
  for (const story of sorted) {
    if (story.themeId !== theme) {
      theme = story.themeId;
      out.push(`## ${theme ? titleize(theme) : 'Miscellaneous'}\n`);
    }
    if (story.prompt) out.push(`> *${redactSecrets(story.prompt)}*\n`);
    if (story.content) out.push(redactSecrets(story.content));
  }
  return out.join('\n\n');
}

function buildBrainTypeMd(type, records) {
  const out = [mdHeader(titleize(type), `${records.length} ${records.length === 1 ? 'entry' : 'entries'} from the Brain`)];
  for (const r of records) {
    const title = r.title || r.name || r.label || r.id;
    out.push(`## ${redactSecrets(String(title))}`);
    const body = r.content || r.body || r.text || r.notes || r.description || '';
    if (body) out.push(redactSecrets(String(body)));
    if (Array.isArray(r.tags) && r.tags.length) out.push(`*Tags: ${r.tags.join(', ')}*`);
  }
  return out.join('\n\n');
}

function buildMemoriesMd(memories) {
  const out = [mdHeader('Memories', `${memories.length} ${memories.length === 1 ? 'memory' : 'memories'}`)];
  const byCategory = {};
  for (const m of memories) {
    const cat = m.category || 'uncategorized';
    (byCategory[cat] ||= []).push(m);
  }
  for (const [cat, items] of Object.entries(byCategory)) {
    out.push(`## ${titleize(cat)}\n`);
    for (const m of items) {
      const text = m.summary || m.content || '';
      if (text) out.push(`- ${redactSecrets(String(text))}`);
    }
  }
  return out.join('\n\n');
}

function buildGoalsMd(goals) {
  const out = [mdHeader('Goals & Milestones', `${goals.length} ${goals.length === 1 ? 'goal' : 'goals'}`)];
  const active = goals.filter(g => g.status !== 'abandoned');
  for (const g of active) {
    const status = g.status === 'completed' ? ' [completed]' : num(g.progress) != null ? ` (${g.progress}%)` : '';
    out.push(`## ${redactSecrets(String(g.title || 'Untitled'))}${status}`);
    if (g.description) out.push(redactSecrets(String(g.description)));
    const ms = Array.isArray(g.milestones) ? g.milestones : [];
    if (ms.length) {
      out.push(ms.map(m => `- [${m.completedAt ? 'x' : ' '}] ${redactSecrets(String(m.title || m.description || ''))}`).join('\n'));
    }
  }
  return out.join('\n\n');
}

// Tokens that mark a brain entry (idea / journal / project) as a deliberate
// life decision — matched case-insensitively against tags and the title.
const DECISION_TOKENS = ['decision', 'decided', 'choice', 'chose', 'pivot'];

function isDecisionEntry(record) {
  const tags = Array.isArray(record?.tags) ? record.tags : [];
  if (tags.some(t => DECISION_TOKENS.includes(String(t).toLowerCase()))) return true;
  const title = String(record?.title || record?.name || record?.label || '').toLowerCase();
  return DECISION_TOKENS.some(tok => title.includes(tok));
}

// Gather the decision signals into a single, dated, deduped list. Each item is
// `{ label, detail, date }`. Derivation, not a stored entity — see the ADR.
function collectDecisions(d) {
  const out = [];
  const goals = Array.isArray(d?.goals) ? d.goals : [];
  for (const g of goals) {
    if (g.status === 'completed') {
      out.push({ label: g.title || 'Goal', detail: g.description || '', date: g.completedAt || g.updatedAt || '' });
    }
    for (const m of (Array.isArray(g.milestones) ? g.milestones : [])) {
      if (m.completedAt) {
        out.push({ label: g.title || 'Goal', detail: m.title || m.description || '', date: m.completedAt });
      }
    }
  }
  const brain = d?.brain || {};
  for (const type of ['ideas', 'journals', 'projects']) {
    for (const r of (Array.isArray(brain[type]) ? brain[type] : [])) {
      if (!isDecisionEntry(r)) continue;
      out.push({
        label: r.title || r.name || r.label || 'Note',
        detail: r.content || r.body || r.text || r.notes || r.description || '',
        date: r.updatedAt || r.createdAt || '',
      });
    }
  }
  // Dedup on label+detail (the same milestone could be reachable twice), then
  // sort newest-first with undated items last.
  const seen = new Set();
  const deduped = out.filter(item => {
    const key = `${item.label} ${item.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  deduped.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return deduped;
}

function buildDecisionsMd(d) {
  const decisions = collectDecisions(d);
  const out = [mdHeader('Key Decisions', 'Derived from completed goals, milestones, and decision-tagged notes')];
  out.push('> *Source note:* PortOS has no dedicated life-decisions store, so this section is **derived** — from goals carried to completion, completed milestones across goals, and Brain entries you tagged or titled as a decision. Tag a note `decision` to surface it here.');
  for (const item of decisions) {
    const when = item.date ? ` _(${String(item.date).slice(0, 10)})_` : '';
    // The decisions section is a digest — truncate a long brain-entry body to a
    // single-line summary (the full text already lives in the Brain section).
    // Redact BEFORE truncating: clipping first could cut a token-shaped secret
    // below redactSecrets' min-length and leak a partial key (e.g. `ghp_0123…`).
    const detail = item.detail ? ` — ${truncateOneLine(redactSecrets(String(item.detail)), 280)}` : '';
    out.push(`- **${redactSecrets(String(item.label || 'Decision'))}**${detail}${when}`);
  }
  return out.join('\n\n');
}

function buildHealthMd(health) {
  const out = [mdHeader('Health Summary', 'Self-tracked vitals'), HEALTH_CAVEAT];
  const lines = [];
  for (const [metric, label, unit] of HEALTH_METRICS) {
    const v = health[metric];
    if (!v) continue;
    const value = v.value != null ? v.value : v;
    const date = v.date ? ` (last sync ${String(v.date).slice(0, 10)})` : '';
    lines.push(`- **${label}**: ${value}${unit ? ` ${unit}` : ''} — Apple Health${date}`);
  }
  out.push(lines.length ? lines.join('\n') : '_No health metrics available._');
  return out.join('\n\n');
}

// Collapse whitespace/newlines and clip to `max` chars with an ellipsis — used
// to keep the derived decisions digest to one line per item. Pure.
function truncateOneLine(text, max) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function titleize(s) {
  return String(s || '')
    .replace(/([A-Z])/g, ' $1')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, c => c.toUpperCase());
}

// Serialize to JSON with the SAME secret redaction the Markdown renderers
// apply — the `data/*.json` mirror is the half of the bundle most likely to be
// machine-scraped, so a token pasted into a note must not ride along in it
// either. The replacer touches every string value.
function jsonFile(obj) {
  return JSON.stringify(obj, (_key, value) => (typeof value === 'string' ? redactSecrets(value) : value), 2);
}

// === Bundle assembly ===

const README_PRIVACY_BANNER =
  '# PortOS Legacy Export\n\n' +
  '> ⚠️ **Privacy notice:** this bundle contains your full plaintext identity — autobiography, ' +
  'brain notes, memories, goals, and health/genome summaries. It was generated on your machine, ' +
  'at your request, and is **not** uploaded anywhere by PortOS. Treat the file as sensitive: anyone ' +
  'who opens it can read everything inside.\n\n' +
  'This is a self-contained portrait of your identity, knowledge, and life story — readable with no ' +
  'PortOS running. Open any `.md` file for the human-readable record; the `data/` folder mirrors each ' +
  'section as machine-readable JSON, and `manifest.json` indexes every file with a SHA-256 checksum.\n';

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Build the list of bundle files for the selected sections. Pure over gathered
 * `data` — no I/O. Returns `{ files, sections }` where `files` is the
 * `{ name, data }` list ready for `createZip` and `sections` is the manifest's
 * per-section presence/counts metadata.
 */
export function buildBundleFiles(data, { sections: selected = null } = {}) {
  const wanted = Array.isArray(selected) && selected.length
    ? SECTIONS.filter(s => selected.includes(s.key))
    : SECTIONS;

  const files = [];
  const sectionMeta = {};

  for (const section of SECTIONS) {
    const present = section.present(data);
    const included = wanted.includes(section);
    sectionMeta[section.key] = {
      label: section.label,
      present,
      included: included && present,
      ...(present ? section.counts(data) : {}),
      ...(section.source ? { source: section.source } : {}),
    };
    if (included && present) {
      for (const f of section.files(data)) {
        files.push({ name: f.name, data: Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf-8') });
      }
    }
  }

  return { files, sections: sectionMeta };
}

/**
 * Build the manifest object (SHA-256 per file). `kind`/`schemaVersion` let a
 * future reader (or `parseZip` round-trip verifier) validate the bundle.
 */
export function buildManifest(files, { sections, portosVersion, generatedAt, pdfIncluded = false }) {
  const fileHashes = {};
  for (const f of files) fileHashes[f.name] = sha256(f.data);
  return {
    schemaVersion: 1,
    kind: 'portos-legacy-export',
    generatedAt,
    portosVersion,
    host: MACHINE_HOST,
    sections,
    files: fileHashes,
    fileCount: files.length,
    pdf: { included: !!pdfIncluded, ...(pdfIncluded ? { file: 'legacy-portrait.pdf' } : {}) },
  };
}

// === PDF rendering (Phase 2) ===
// A rendered, human-readable portrait of the same per-section Markdown the
// bundle already produces. Uses pdf-lib (already a dependency, shared with
// `pipeline/comicPdf.js`) — Helvetica family, basic word-wrap, heading sizing.
// No images, no external fonts: the Markdown bundle stays the primary artifact;
// the PDF is a convenience for reading/printing offline.

const PDF_PAGE = { width: 612, height: 792 };       // US Letter, in points
const PDF_MARGIN = 56;                              // ~0.78in
const PDF_LINE_GAP = 4;                             // extra leading between lines
const PDF_TEXT_WIDTH = PDF_PAGE.width - PDF_MARGIN * 2;

// Heading sizes by Markdown level (`#`=1 … `###`=3); anything deeper uses level 3.
const PDF_HEADING_SIZE = { 1: 22, 2: 16, 3: 13 };
const PDF_BODY_SIZE = 11;

// Strip the inline Markdown emphasis/link syntax pdf-lib can't render so it
// doesn't print literal `**`/`*`/`[text](url)` markers. Pure.
function stripInlineMarkdown(text) {
  return String(text)
    .replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, '$1')  // [label](url) / ![alt](src) → label
    .replace(/\*\*([^*]+)\*\*/g, '$1')            // **bold**
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')      // *italic* (leave bare * alone)
    .replace(/`([^`]+)`/g, '$1');                 // `code`
}

// WinAnsi (pdf-lib's StandardFont encoding) can't encode arbitrary Unicode —
// an unencodable glyph throws at draw time. Map the few non-ASCII characters
// our Markdown builders actually emit (VO₂, ⚠️, smart quotes) to safe ASCII,
// then drop anything still outside the encodable range. Pure.
//
// pdf-lib's WinAnsi encoder also throws on control bytes that ARE ≤ 0xFF —
// the C0 controls (0x00–0x1F), DEL (0x7F), and the undefined C1 range
// (0x80–0x9F) — so a stray control char pasted into free-text identity content
// (brain notes, journals, autobiography) must be stripped BEFORE it reaches
// `widthOfTextAtSize`/`drawText`, or the whole PDF render throws. Tabs become a
// space (lines are already newline-split before they reach here).
function toWinAnsi(text) {
  return String(text)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/₂/g, '2')   // subscript 2 (VO₂)
    .replace(/[•·]/g, '-') // bullet / middot → ASCII dash (U+2022 is > 0xFF, would otherwise be stripped)
    .replace(/[✅⚠️⚡]/g, '')  // ✅ ⚠ emoji-variation ⚡
    .replace(/\t/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F-\x9F]/g, '')  // control bytes WinAnsi can't encode
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x00-\xFF]/g, '');         // anything still above the WinAnsi range
}

// Word-wrap a single logical line to fit `maxWidth` at `size`. A single token
// longer than the line (e.g. a long URL) is hard-broken so it never overflows.
// Pure given the font's metrics.
function wrapLine(text, font, size, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    // The word itself overflows — hard-break it character by character.
    if (font.widthOfTextAtSize(word, size) > maxWidth) {
      let chunk = '';
      for (const ch of word) {
        if (font.widthOfTextAtSize(chunk + ch, size) > maxWidth && chunk) {
          lines.push(chunk);
          chunk = ch;
        } else {
          chunk += ch;
        }
      }
      current = chunk;
    } else {
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Render the per-section Markdown into a single PDF. Pure-ish (async only for
 * pdf-lib's font embedding) — takes the same `{ name, data }` content files
 * `buildBundleFiles` produces and walks the `.md` ones in bundle order.
 * Returns the PDF bytes (Uint8Array). `meta` stamps the title page.
 *
 * @returns {Promise<{ bytes: Uint8Array, pageCount: number }>}
 */
export async function buildLegacyPdf(contentFiles, { portosVersion = '0.0.0', generatedAt = '' } = {}) {
  const pdf = await PDFDocument.create();
  pdf.setTitle('PortOS Legacy Export');
  pdf.setProducer('PortOS');
  pdf.setCreator('PortOS legacy export');

  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let page = pdf.addPage([PDF_PAGE.width, PDF_PAGE.height]);
  let cursor = PDF_PAGE.height - PDF_MARGIN;

  // Draw one wrapped block; paginates when the cursor runs past the bottom margin.
  const draw = (raw, { size = PDF_BODY_SIZE, bold = false, color = rgb(0.12, 0.12, 0.12), gapAfter = PDF_LINE_GAP } = {}) => {
    const f = bold ? fontBold : font;
    const text = toWinAnsi(stripInlineMarkdown(raw));
    for (const line of wrapLine(text, f, size, PDF_TEXT_WIDTH)) {
      if (cursor - size < PDF_MARGIN) {
        page = pdf.addPage([PDF_PAGE.width, PDF_PAGE.height]);
        cursor = PDF_PAGE.height - PDF_MARGIN;
      }
      page.drawText(line, { x: PDF_MARGIN, y: cursor - size, size, font: f, color });
      cursor -= size + gapAfter;
    }
  };
  const space = (h = PDF_BODY_SIZE) => { cursor -= h; };

  // Title page.
  draw('PortOS Legacy Export', { size: 28, bold: true, color: rgb(0, 0, 0) });
  space(6);
  draw('A self-contained portrait of identity, knowledge, and life story.', { size: 12, color: rgb(0.35, 0.35, 0.35) });
  if (generatedAt) draw(`Generated: ${generatedAt.slice(0, 19).replace('T', ' ')} UTC`, { size: 10, color: rgb(0.45, 0.45, 0.45) });
  draw(`PortOS ${portosVersion}`, { size: 10, color: rgb(0.45, 0.45, 0.45) });

  const markdownFiles = contentFiles.filter(f => f.name.endsWith('.md'));
  for (const file of markdownFiles) {
    page = pdf.addPage([PDF_PAGE.width, PDF_PAGE.height]);
    cursor = PDF_PAGE.height - PDF_MARGIN;
    const lines = file.data.toString('utf-8').split('\n');
    for (const rawLine of lines) {
      const line = rawLine.replace(/\s+$/, '');
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        const level = Math.min(heading[1].length, 3);
        space(6);
        draw(heading[2], { size: PDF_HEADING_SIZE[level], bold: true, color: rgb(0, 0, 0), gapAfter: 6 });
        continue;
      }
      if (line.trim() === '') { space(6); continue; }
      const quote = line.match(/^>\s?(.*)$/);
      if (quote) {
        draw(quote[1], { color: rgb(0.4, 0.4, 0.4) });
        continue;
      }
      const bullet = line.match(/^[-*]\s+\[[ xX]\]\s+(.*)$/) || line.match(/^[-*]\s+(.*)$/);
      if (bullet) {
        draw(`• ${bullet[1]}`);
        continue;
      }
      draw(line);
    }
  }

  const bytes = await pdf.save();
  return { bytes, pageCount: pdf.getPageCount() };
}

/**
 * Build the full legacy-export zip. Returns `{ buffer, manifest }`.
 * `io` (optional) receives `legacy-export:*` progress events.
 * `includePdf` adds a rendered `legacy-portrait.pdf` (Phase 2); default false —
 * the Markdown bundle is the primary artifact.
 */
export async function buildLegacyZip({ sections = null, io = null, includePdf = false } = {}) {
  emit(io, 'legacy-export:started', { sections });
  const data = await gatherLegacyData();
  emit(io, 'legacy-export:progress', { phase: 'gathered' });

  const { files, sections: sectionMeta } = buildBundleFiles(data, { sections });
  const portosVersion = await getCurrentVersion().catch(() => '0.0.0');
  const generatedAt = new Date().toISOString();

  // README first, then content files. The optional rendered PDF is derived from
  // those same Markdown files (so it carries no data the bundle doesn't already
  // expose) and joins the hashed file set. The manifest hashes every content
  // file — build it before adding manifest.json so it doesn't hash itself.
  const readme = { name: 'README.md', data: Buffer.from(README_PRIVACY_BANNER, 'utf-8') };
  const contentFiles = [readme, ...files];

  if (includePdf) {
    const { bytes, pageCount } = await buildLegacyPdf(contentFiles, { portosVersion, generatedAt });
    contentFiles.push({ name: 'legacy-portrait.pdf', data: Buffer.from(bytes) });
    emit(io, 'legacy-export:progress', { phase: 'pdf', pageCount });
  }

  const manifest = buildManifest(contentFiles, { sections: sectionMeta, portosVersion, generatedAt, pdfIncluded: includePdf });
  const manifestFile = { name: 'manifest.json', data: Buffer.from(jsonFile(manifest), 'utf-8') };

  // Deflate the bundle (per-entry, kept only where it shrinks the file) — the
  // identity bundle is overwhelmingly text, so this is a large win for free and
  // directly answers issue #901 open Q5. Manifest hashes are of the original
  // (uncompressed) bytes, so they're unchanged by compression.
  const buffer = createZip([...contentFiles, manifestFile], { compress: true });
  console.log(`📦 Legacy export: ${manifest.fileCount} files${includePdf ? ' (+PDF)' : ''}, ${(buffer.length / 1024).toFixed(1)} KB`);
  emit(io, 'legacy-export:completed', { fileCount: manifest.fileCount, bytes: buffer.length });
  return { buffer, manifest };
}

/**
 * Lightweight preview — section presence + counts + an estimated byte size,
 * WITHOUT building the zip. Used by `GET /api/legacy-export/preview`.
 */
export async function previewLegacyExport() {
  const data = await gatherLegacyData();
  const { files, sections } = buildBundleFiles(data, { sections: null });
  const estimatedBytes = files.reduce((sum, f) => sum + f.data.length, 0);

  // Soft size guardrail: warn (don't truncate) when the uncompressed estimate is
  // large, and point at the biggest section so the user knows what's driving it.
  let sizeWarning = null;
  if (estimatedBytes > SIZE_WARNING_BYTES) {
    const bySection = sectionByteEstimates(files);
    const largest = Object.entries(bySection).sort((a, b) => b[1] - a[1])[0];
    sizeWarning = {
      thresholdBytes: SIZE_WARNING_BYTES,
      estimatedBytes,
      largestSection: largest ? largest[0] : null,
    };
  }

  return {
    sections,
    fileCount: files.length + 2 /* README + manifest */,
    estimatedBytes,
    sizeWarning,
  };
}

// Sum content bytes per section so the preview can name what's driving a large
// bundle. A `data/<section>.json` mirror is attributed to its section (not a
// generic "data" bucket); everything else uses its first path segment. Pure.
function sectionByteEstimates(files) {
  const out = {};
  for (const f of files) {
    let section;
    const dataMirror = f.name.match(/^data\/([^/]+)\.json$/);
    if (dataMirror) section = dataMirror[1];
    else section = f.name.includes('/') ? f.name.slice(0, f.name.indexOf('/')) : f.name;
    out[section] = (out[section] || 0) + f.data.length;
  }
  return out;
}

function emit(io, event, payload) {
  if (io && typeof io.emit === 'function') io.emit(event, payload);
}
