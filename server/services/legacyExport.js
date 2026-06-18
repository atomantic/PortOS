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
    // v1 source: completed goal milestones. PortOS has no first-class life
    // "decisions" store (decisionLog.js is CoS task scheduling), so the manifest
    // documents this provenance. Tracked for a richer source in a follow-up.
    present: (d) => collectMilestones(d.goals).length > 0,
    counts: (d) => ({ milestones: collectMilestones(d.goals).length }),
    files: (d) => [
      { name: 'decisions/key-decisions.md', data: buildDecisionsMd(d.goals) },
    ],
    source: 'Derived from completed goal milestones (PortOS has no dedicated life-decisions store in v1).',
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

function collectMilestones(goals) {
  const out = [];
  for (const g of goals) {
    for (const m of (Array.isArray(g.milestones) ? g.milestones : [])) {
      if (m.completedAt) out.push({ goal: g.title, ...m });
    }
  }
  return out;
}

function buildDecisionsMd(goals) {
  const milestones = collectMilestones(goals);
  const out = [mdHeader('Key Decisions', 'Derived from completed goal milestones')];
  out.push('> *Source note:* PortOS has no dedicated life-decisions store in v1, so this section is derived from completed milestones across goals.');
  for (const m of milestones) {
    const when = m.completedAt ? ` _(completed ${String(m.completedAt).slice(0, 10)})_` : '';
    out.push(`- **${redactSecrets(String(m.goal || 'Goal'))}** — ${redactSecrets(String(m.title || m.description || ''))}${when}`);
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
export function buildManifest(files, { sections, portosVersion, generatedAt }) {
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
    pdf: { included: false }, // PDF is a follow-up (Phase 2)
  };
}

/**
 * Build the full legacy-export zip. Returns `{ buffer, manifest }`.
 * `io` (optional) receives `legacy-export:*` progress events.
 */
export async function buildLegacyZip({ sections = null, io = null } = {}) {
  emit(io, 'legacy-export:started', { sections });
  const data = await gatherLegacyData();
  emit(io, 'legacy-export:progress', { phase: 'gathered' });

  const { files, sections: sectionMeta } = buildBundleFiles(data, { sections });
  const portosVersion = await getCurrentVersion().catch(() => '0.0.0');
  const generatedAt = new Date().toISOString();

  // README first, then content files, then the manifest (which hashes the
  // content files — build it before adding manifest.json so it doesn't hash
  // itself).
  const readme = { name: 'README.md', data: Buffer.from(README_PRIVACY_BANNER, 'utf-8') };
  const contentFiles = [readme, ...files];
  const manifest = buildManifest(contentFiles, { sections: sectionMeta, portosVersion, generatedAt });
  const manifestFile = { name: 'manifest.json', data: Buffer.from(jsonFile(manifest), 'utf-8') };

  const buffer = createZip([...contentFiles, manifestFile]);
  console.log(`📦 Legacy export: ${manifest.fileCount} files, ${(buffer.length / 1024).toFixed(1)} KB`);
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
  return { sections, fileCount: files.length + 2 /* README + manifest */, estimatedBytes };
}

function emit(io, event, payload) {
  if (io && typeof io.emit === 'function') io.emit(event, payload);
}
