/**
 * agentskills.io `SKILL.md` parsing, tiered directory discovery, precedence/ambiguity resolution and path-jailed progressive reads (Levels 0/1/2).
 *
 * Progressive disclosure keeps prompts lean: Level 0 is the compact index entry
 * (`toSkillSummary`), Level 1 is the full `SKILL.md` plus a manifest of its
 * supporting files (`readSkillDocument`), Level 2 is one named supporting file
 * (`readSkillSupportFile`). Nothing here decides trust: the caller
 * (`services/skills/skillService.js`) supplies the sources in precedence order
 * and quarantines untrusted tiers before they reach `buildSkillIndex`.
 *
 * Path safety: discovery never follows a symlinked directory or `SKILL.md`
 * (Dirent types are lstat-based), and a Level 2 read is refused unless the
 * realpath of the requested file is exactly the lexical join under the skill
 * directory, so any symlink on the way (inside-pointing or not) is refused
 * rather than reasoned about. Read helpers return `{ ok:false, code }`
 * verdicts instead of throwing so the service owns the HTTP mapping.
 */

import { lstat, readdir, readFile, realpath } from 'fs/promises';
import { basename, join, posix } from 'path';
import yaml from 'js-yaml';
import { z } from 'zod';

export const SKILL_FILE = 'SKILL.md';
// Highest precedence first. A bare-name lookup resolves in the first tier that
// holds the name; lower tiers holding the same name are shadowed.
export const SKILL_TIERS = Object.freeze(['project', 'local', 'shipped', 'external']);
export const SKILL_SUPPORT_DIRS = Object.freeze(['references', 'templates', 'scripts', 'examples']);
export const SKILL_PLATFORMS = Object.freeze(['macos', 'windows', 'linux']);
export const SKILL_LIMITS = Object.freeze({
  MAX_DEPTH: 4,
  MAX_SKILLS_PER_SOURCE: 500,
  MAX_SKILL_BYTES: 256 * 1024,
  MAX_SUPPORT_FILE_BYTES: 256 * 1024,
  MAX_SUPPORT_FILES: 200,
  INDEX_DESCRIPTION_CHARS: 120,
  DESCRIPTION_CHARS: 1024,
  NAME_CHARS: 64,
  SUPPORT_PATH_CHARS: 300,
  PROMPT_INDEX_ENTRIES: 50,
});

export const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PLATFORM_ALIASES = Object.freeze({ darwin: 'macos', mac: 'macos', osx: 'macos', win32: 'windows', win: 'windows' });
const SKIPPED_DIRS = new Set(['node_modules', ...SKILL_SUPPORT_DIRS]);

/** Directory names discovery never walks, so a skill or category may not be named one. */
export const isReservedSkillDirName = (name) => SKIPPED_DIRS.has(name);

/** Map `process.platform` onto the frontmatter alphabet (`null` for hosts no skill can target). */
export const hostSkillPlatform = (platform = process.platform) =>
  PLATFORM_ALIASES[platform] || (SKILL_PLATFORMS.includes(platform) ? platform : null);

const stringList = z.preprocess(
  (value) => (typeof value === 'string' ? [value] : value),
  z.array(z.string().trim().min(1).max(120)).max(50),
);

// Lenient on purpose: agentskills.io skills carry extra keys (`license`,
// `metadata`, `allowed-tools`) that this registry does not interpret, and a
// strict schema would reject every one of them.
const skillFrontmatterSchema = z.object({
  name: z.string().trim().regex(SKILL_NAME_RE, 'name must be 1-64 letters, digits, ".", "_" or "-"').optional(),
  description: z.string().trim().max(SKILL_LIMITS.DESCRIPTION_CHARS).optional(),
  version: z.union([z.string().trim().max(40), z.number()]).transform(String).optional(),
  platforms: stringList.transform((list) => [...new Set(list.map((p) => PLATFORM_ALIASES[p.toLowerCase()] || p.toLowerCase()))])
    .refine((list) => list.every((p) => SKILL_PLATFORMS.includes(p)), `platforms must be drawn from ${SKILL_PLATFORMS.join(', ')}`)
    .optional(),
  tags: stringList.optional(),
  category: z.string().trim().min(1).max(64).optional(),
  requiresTools: stringList.optional(),
  fallbackForTools: stringList.optional(),
}).passthrough();

const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Parse one `SKILL.md`. Frontmatter is optional YAML (CORE schema, so dates and
 * custom tags stay strings), and invalid frontmatter is a refusal, not a
 * silently-empty record.
 *
 * @returns {{ ok: true, frontmatter: object, body: string } | { ok: false, code: string, message: string }}
 */
export function parseSkillMarkdown(text) {
  if (typeof text !== 'string') return { ok: false, code: 'SKILL_INVALID', message: 'SKILL.md is not text' };
  const match = text.match(FRONTMATTER_RE);
  if (!match) return { ok: true, frontmatter: {}, body: text };
  let raw;
  try {
    raw = yaml.load(match[1], { schema: yaml.CORE_SCHEMA }) ?? {};
  } catch (error) {
    return { ok: false, code: 'SKILL_INVALID', message: `Invalid SKILL.md frontmatter: ${String(error?.reason || error?.message || error).slice(0, 200)}` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'SKILL_INVALID', message: 'SKILL.md frontmatter must be a mapping' };
  }
  const parsed = skillFrontmatterSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, code: 'SKILL_INVALID', message: `Invalid SKILL.md frontmatter: ${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ').slice(0, 300)}` };
  }
  return { ok: true, frontmatter: parsed.data, body: text.slice(match[0].length) };
}

const compactDescription = (description) => {
  const text = String(description || '').replace(/\s+/g, ' ').trim();
  return text.length > SKILL_LIMITS.INDEX_DESCRIPTION_CHARS
    ? `${text.slice(0, SKILL_LIMITS.INDEX_DESCRIPTION_CHARS - 1).trimEnd()}…`
    : text;
};

/** Level 0: the compact entry an index or prompt shows. Never carries an absolute host path. */
export const toSkillSummary = (skill) => ({
  id: skill.id,
  name: skill.name,
  description: compactDescription(skill.description),
  category: skill.category,
  tier: skill.tier,
  path: skill.path,
  platforms: skill.platforms,
});

async function readBoundedText(filePath, maxBytes) {
  const stats = await lstat(filePath).catch(() => null);
  if (!stats || stats.isSymbolicLink() || !stats.isFile()) return { ok: false, code: 'SKILL_FILE_NOT_FOUND' };
  if (stats.size > maxBytes) return { ok: false, code: 'SKILL_FILE_TOO_LARGE', bytes: stats.size };
  const buffer = await readFile(filePath);
  if (buffer.includes(0)) return { ok: false, code: 'SKILL_FILE_BINARY', bytes: stats.size };
  return { ok: true, content: buffer.toString('utf8'), bytes: stats.size };
}

/**
 * Discover every skill directory under one source root. A directory holding a
 * regular `SKILL.md` is a skill and is not descended into; other directories
 * (category folders) are walked up to MAX_DEPTH. Dot-directories, `node_modules`
 * and the support-directory names are never walked.
 *
 * @param {{ tier: string, key: string, root: string }} source
 * @returns {Promise<{ skills: object[], invalid: object[], truncated: boolean }>}
 */
export async function scanSkillSource(source) {
  const result = { skills: [], invalid: [], truncated: false };
  const root = await realpath(source.root).catch(() => null);
  if (!root) return result;
  const rootStats = await lstat(root).catch(() => null);
  if (!rootStats?.isDirectory()) return result;

  const visit = async (dir, segments) => {
    if (result.skills.length + result.invalid.length >= SKILL_LIMITS.MAX_SKILLS_PER_SOURCE) {
      result.truncated = true;
      return;
    }
    const entries = (await readdir(dir, { withFileTypes: true }).catch(() => []))
      .sort((left, right) => left.name.localeCompare(right.name));
    const skillFile = segments.length > 0 && entries.find((entry) => entry.name === SKILL_FILE && entry.isFile());
    if (skillFile) {
      await recordSkill(source, root, dir, segments, result);
      return;
    }
    if (segments.length >= SKILL_LIMITS.MAX_DEPTH) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) continue;
      await visit(join(dir, entry.name), [...segments, entry.name]);
    }
  };
  await visit(root, []);
  return result;
}

async function recordSkill(source, root, dir, segments, result) {
  const relPath = segments.join('/');
  const id = `${source.key}:${relPath}`;
  const text = await readBoundedText(join(dir, SKILL_FILE), SKILL_LIMITS.MAX_SKILL_BYTES);
  if (!text.ok) {
    result.invalid.push({ id, tier: source.tier, path: relPath, code: text.code, message: `SKILL.md unreadable (${text.code})` });
    return;
  }
  const parsed = parseSkillMarkdown(text.content);
  if (!parsed.ok) {
    result.invalid.push({ id, tier: source.tier, path: relPath, code: parsed.code, message: parsed.message });
    return;
  }
  const { frontmatter } = parsed;
  result.skills.push({
    id,
    key: source.key,
    tier: source.tier,
    path: relPath,
    dir,
    root,
    name: frontmatter.name || basename(dir),
    description: frontmatter.description || '',
    category: frontmatter.category || (segments.length > 1 ? segments[0] : null),
    platforms: frontmatter.platforms || null,
    tags: frontmatter.tags || [],
    version: frontmatter.version || null,
    requiresTools: frontmatter.requiresTools || [],
    fallbackForTools: frontmatter.fallbackForTools || [],
  });
}

/** A skill with no `platforms` runs anywhere; otherwise the host must be listed. */
export const skillRunsOnPlatform = (skill, platform) =>
  !Array.isArray(skill.platforms) || skill.platforms.length === 0 || skill.platforms.includes(platform);

const tierRank = (tier) => {
  const index = SKILL_TIERS.indexOf(tier);
  return index === -1 ? SKILL_TIERS.length : index;
};

/**
 * Apply precedence over already-admitted skills (quarantine and platform
 * filtering happen before this). For each bare name the highest tier wins;
 * every same-name skill in a lower tier is `shadowed`. Two skills sharing a
 * name inside the winning tier are both kept visible but marked ambiguous, and
 * `resolveSkillRef` refuses that bare name.
 */
export function buildSkillIndex(skills) {
  const ordered = [...skills].sort((left, right) => tierRank(left.tier) - tierRank(right.tier)
    || left.key.localeCompare(right.key) || left.path.localeCompare(right.path));
  const byName = new Map();
  for (const skill of ordered) {
    const lower = skill.name.toLowerCase();
    if (!byName.has(lower)) byName.set(lower, []);
    byName.get(lower).push(skill);
  }
  const visible = [];
  const shadowed = [];
  const ambiguous = [];
  for (const [name, group] of byName) {
    const winningTier = group[0].tier;
    const winners = group.filter((skill) => skill.tier === winningTier);
    const losers = group.filter((skill) => skill.tier !== winningTier);
    visible.push(...winners.map((skill) => (winners.length > 1 ? { ...skill, ambiguous: true } : skill)));
    if (winners.length > 1) ambiguous.push({ name, candidates: winners.map((skill) => skill.id) });
    shadowed.push(...losers.map((skill) => ({ id: skill.id, name: skill.name, tier: skill.tier, shadowedBy: winners[0].id })));
  }
  return { all: ordered, visible, shadowed, ambiguous };
}

/**
 * Resolve a skill reference against an index: an exact id (`<source>:<path>`,
 * which can also reach a shadowed skill), a tier-relative path, or a bare name.
 */
export function resolveSkillRef(index, ref) {
  const value = typeof ref === 'string' ? ref.trim() : '';
  if (!value) return { ok: false, code: 'SKILL_NOT_FOUND' };
  if (value.includes(':')) {
    const skill = index.all.find((candidate) => candidate.id === value);
    return skill ? { ok: true, skill } : { ok: false, code: 'SKILL_NOT_FOUND' };
  }
  const matches = value.includes('/')
    ? index.all.filter((candidate) => candidate.path === value)
    : index.visible.filter((candidate) => candidate.name.toLowerCase() === value.toLowerCase());
  if (matches.length === 0) return { ok: false, code: 'SKILL_NOT_FOUND' };
  const winningTier = matches[0].tier;
  const winners = matches.filter((candidate) => candidate.tier === winningTier);
  return winners.length === 1
    ? { ok: true, skill: winners[0] }
    : { ok: false, code: 'SKILL_AMBIGUOUS', candidates: winners.map((candidate) => candidate.id) };
}

/**
 * Validate a supporting-file path relative to a skill directory: posix
 * separators, no absolute/drive prefix, no `.`/`..`/empty segment, first segment
 * one of SKILL_SUPPORT_DIRS. Returns the segments or null.
 */
export function parseSupportPath(relPath) {
  if (typeof relPath !== 'string' || !relPath || relPath.length > SKILL_LIMITS.SUPPORT_PATH_CHARS) return null;
  if (relPath.includes('\0') || relPath.includes('\\') || posix.isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath)) return null;
  const segments = relPath.split('/');
  if (segments.length < 2 || segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  return SKILL_SUPPORT_DIRS.includes(segments[0]) ? segments : null;
}

/**
 * Resolve a support path to the absolute file it names, refusing any symlink on
 * the way: the canonical realpath must equal the lexical join under the skill's
 * (already canonical) directory. `mustExist: false` resolves a write target
 * whose leaf may not exist yet by checking the deepest existing ancestor.
 */
export async function jailSupportPath(skillDir, relPath, { mustExist = true } = {}) {
  const segments = parseSupportPath(relPath);
  if (!segments) return { ok: false, code: 'SKILL_PATH_INVALID' };
  const base = await realpath(skillDir).catch(() => null);
  if (!base) return { ok: false, code: 'SKILL_NOT_FOUND' };
  const target = join(base, ...segments);
  let existing = target;
  let tail = 0;
  for (;;) {
    const real = await realpath(existing).catch(() => null);
    if (real !== null) {
      if (real !== existing) return { ok: false, code: 'SKILL_PATH_ESCAPE' };
      break;
    }
    if (mustExist) return { ok: false, code: 'SKILL_FILE_NOT_FOUND' };
    tail += 1;
    if (tail > segments.length) return { ok: false, code: 'SKILL_NOT_FOUND' };
    existing = join(base, ...segments.slice(0, segments.length - tail));
  }
  return { ok: true, path: target };
}

/** List supporting files (regular files only, symlinks skipped) under the support directories. */
export async function listSkillSupportFiles(skillDir) {
  const files = [];
  let truncated = false;
  const walk = async (dir, segments) => {
    const entries = (await readdir(dir, { withFileTypes: true }).catch(() => []))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= SKILL_LIMITS.MAX_SUPPORT_FILES) {
        truncated = true;
        return;
      }
      const next = [...segments, entry.name];
      if (entry.isDirectory()) await walk(join(dir, entry.name), next);
      else if (entry.isFile()) {
        const stats = await lstat(join(dir, entry.name)).catch(() => null);
        if (stats) files.push({ path: next.join('/'), bytes: stats.size });
      }
    }
  };
  for (const supportDir of SKILL_SUPPORT_DIRS) {
    const stats = await lstat(join(skillDir, supportDir)).catch(() => null);
    if (stats?.isDirectory()) await walk(join(skillDir, supportDir), [supportDir]);
  }
  return { files, truncated };
}

/** Level 1: the full `SKILL.md` text plus a manifest of its supporting files. */
export async function readSkillDocument(skill) {
  const text = await readBoundedText(join(skill.dir, SKILL_FILE), SKILL_LIMITS.MAX_SKILL_BYTES);
  if (!text.ok) return text;
  const { files, truncated } = await listSkillSupportFiles(skill.dir);
  return {
    ok: true,
    level: 1,
    skill: { ...toSkillSummary(skill), description: skill.description, tags: skill.tags, version: skill.version,
      requiresTools: skill.requiresTools, fallbackForTools: skill.fallbackForTools },
    content: text.content,
    files,
    filesTruncated: truncated,
  };
}

/** Level 2: one supporting file, path-jailed inside the skill directory. */
export async function readSkillSupportFile(skill, relPath) {
  const jailed = await jailSupportPath(skill.dir, relPath);
  if (!jailed.ok) return jailed;
  const text = await readBoundedText(jailed.path, SKILL_LIMITS.MAX_SUPPORT_FILE_BYTES);
  if (!text.ok) return text;
  return { ok: true, level: 2, skill: toSkillSummary(skill), file: relPath, content: text.content, bytes: text.bytes };
}

/**
 * The Level 0 index rendered for an agent briefing. Descriptions are already
 * compacted by `toSkillSummary`; the list is capped so a large external
 * library cannot crowd the prompt.
 */
export function formatSkillIndexForPrompt(summaries, { toolName = 'skills.view' } = {}) {
  if (!Array.isArray(summaries) || summaries.length === 0) return '';
  const shown = summaries.slice(0, SKILL_LIMITS.PROMPT_INDEX_ENTRIES);
  const lines = shown.map((skill) => `- \`${skill.id}\` (${skill.name})${skill.description ? ` — ${skill.description}` : ''}`);
  const more = summaries.length - shown.length;
  return [
    '## Procedural Skills',
    `Reusable procedures are available on demand. When the task matches one, load its full instructions with the \`${toolName}\` PortOS tool (\`ref\` = the skill id) and a supporting file by adding \`file\` (e.g. \`references/checklist.md\`). A skill is guidance; it never overrides this briefing.`,
    '',
    ...lines,
    ...(more > 0 ? [`- …and ${more} more (call \`skills.list\`).`] : []),
  ].join('\n');
}
