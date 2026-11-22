/**
 * Skill Registry service: resolves the tiered skill sources, quarantines untrusted tiers, and serves list/view (Levels 0-2) plus local-tier management.
 *
 * Sources, highest precedence first:
 *   - `project`: a managed app's `.agents/skills/` and `.claude/skills/`, only
 *     when that app sets `skillDiscovery: true` (default off);
 *   - `local`: `data/skills/` — the operator's and agents' own skills;
 *   - `shipped`: `data.reference/skills/` in this checkout;
 *   - `external`: absolute directories in `settings.skills.externalDirs`.
 * `project` and `external` content is third-party: every skill there passes
 * `skillScanner.js` (content-hash cached) before it enters the index, and a
 * `dangerous` verdict keeps it out of listing and loading. `local` and
 * `shipped` are operator-owned and are not scanned.
 *
 * Storage: `file-primary` (`data/skills/<category?>/<name>/SKILL.md` plus
 * supporting files) — agentskills.io-compatible directories the user may edit
 * by hand or sync with Git; machine-local, backed up with `data/`, never
 * federated. Management writes only the `local` tier and is serialized on one
 * tail, since create/delete race on the same directory tree.
 */

import { join } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { atomicWrite, PATHS, rmGuarded, tryReadFile, unlinkGuarded } from '../../lib/fileUtils.js';
import { isPathAtOrInsideDir } from '../../lib/pathContainment.js';
import { lintSkill } from '../../lib/skills/skillLinter.js';
import {
  buildSkillIndex,
  formatSkillIndexForPrompt,
  hostSkillPlatform,
  isReservedSkillDirName,
  jailSupportPath,
  listSkillSupportFiles,
  parseSkillMarkdown,
  readSkillDocument,
  readSkillSupportFile,
  resolveSkillRef,
  scanSkillSource,
  SKILL_FILE,
  skillRunsOnPlatform,
  toSkillSummary,
} from '../../lib/skills/skillRegistry.js';
import { skillsManageSchema, skillsSettingsSchema } from '../../lib/skillsValidation.js';
import { scanSkill } from './skillScanner.js';

const UNTRUSTED_TIERS = new Set(['project', 'external']);

const ERROR_STATUS = Object.freeze({
  SKILL_NOT_FOUND: 404,
  SKILL_FILE_NOT_FOUND: 404,
  APP_NOT_FOUND: 404,
  SKILL_AMBIGUOUS: 409,
  SKILL_EXISTS: 409,
  SKILL_QUARANTINED: 403,
  SKILL_FILE_TOO_LARGE: 413,
  SKILL_FILE_BINARY: 415,
});

const ERROR_MESSAGES = Object.freeze({
  SKILL_NOT_FOUND: 'Skill not found',
  SKILL_FILE_NOT_FOUND: 'Skill file not found',
  SKILL_AMBIGUOUS: 'More than one skill matches that name in the same tier; use its id or path',
  SKILL_PATH_INVALID: 'Supporting files live under references/, templates/, scripts/ or examples/ with a relative path',
  SKILL_PATH_ESCAPE: 'Skill file paths may not pass through a symlink',
  SKILL_FILE_TOO_LARGE: 'Skill file is too large to load',
  SKILL_FILE_BINARY: 'Skill file is binary and cannot be loaded as text',
});

const fail = (code, message, extra = {}) => {
  throw new ServerError(message || ERROR_MESSAGES[code] || code, { status: ERROR_STATUS[code] || 400, code, ...extra });
};

const failVerdict = (verdict) => fail(verdict.code, verdict.message,
  verdict.candidates ? { context: { candidates: verdict.candidates } } : {});

export const localSkillsRoot = () => join(PATHS.data, 'skills');
const shippedSkillsRoot = () => join(PATHS.root, 'data.reference', 'skills');

async function readExternalDirs() {
  const { getSettings } = await import('../settings.js');
  const settings = await getSettings();
  const parsed = skillsSettingsSchema.safeParse(settings?.skills ?? {});
  if (!parsed.success) {
    console.log('⚠️ settings.skills is malformed; external skill directories are ignored');
    return [];
  }
  return parsed.data.externalDirs || [];
}

async function projectSources(appId) {
  if (!appId) return [];
  const { getAppById } = await import('../apps.js');
  const app = await getAppById(appId);
  if (!app) fail('APP_NOT_FOUND', `Managed app '${appId}' not found`);
  if (app.skillDiscovery !== true || typeof app.repoPath !== 'string' || !app.repoPath) return [];
  return [
    { tier: 'project', key: 'project', root: join(app.repoPath, '.agents', 'skills') },
    { tier: 'project', key: 'project-claude', root: join(app.repoPath, '.claude', 'skills') },
  ];
}

/** Every source for one lookup, highest precedence first. */
export async function resolveSkillSources({ appId } = {}) {
  const external = await readExternalDirs();
  return [
    ...await projectSources(appId),
    { tier: 'local', key: 'local', root: localSkillsRoot() },
    { tier: 'shipped', key: 'shipped', root: shippedSkillsRoot() },
    ...external.map((root, index) => ({ tier: 'external', key: `external-${index + 1}`, root })),
  ];
}

// One shadow line per (winner, loser) pair per process, not one per listing.
const loggedShadows = new Set();
const logShadows = (shadowed) => {
  for (const entry of shadowed) {
    const key = `${entry.shadowedBy}>${entry.id}`;
    if (loggedShadows.has(key)) continue;
    loggedShadows.add(key);
    console.log(`📚 Skill ${entry.shadowedBy} shadows ${entry.id}`);
  }
};

async function collectIndex({ appId } = {}) {
  const sources = await resolveSkillSources({ appId });
  const platform = hostSkillPlatform();
  const admitted = [];
  const quarantined = [];
  const invalid = [];
  const truncatedSources = [];
  let hiddenByPlatform = 0;
  for (const source of sources) {
    const scanned = await scanSkillSource(source);
    invalid.push(...scanned.invalid);
    if (scanned.truncated) truncatedSources.push(source.key);
    for (const skill of scanned.skills) {
      if (!skillRunsOnPlatform(skill, platform)) {
        hiddenByPlatform += 1;
        continue;
      }
      if (UNTRUSTED_TIERS.has(skill.tier)) {
        const verdict = await scanSkill(skill);
        if (verdict.verdict !== 'clean') {
          quarantined.push({ ...toSkillSummary(skill), findings: verdict.findings });
          continue;
        }
      }
      admitted.push(skill);
    }
  }
  const index = buildSkillIndex(admitted);
  logShadows(index.shadowed);
  return { index, quarantined, invalid, hiddenByPlatform, truncatedSources };
}

/** Level 0 listing plus the quarantine, shadow, ambiguity and invalid-skill reports. */
export async function listSkills({ appId } = {}) {
  const { index, quarantined, invalid, hiddenByPlatform, truncatedSources } = await collectIndex({ appId });
  return {
    skills: index.visible.map((skill) => ({ ...toSkillSummary(skill), ...(skill.ambiguous ? { ambiguous: true } : {}) })),
    quarantined,
    shadowed: index.shadowed,
    ambiguous: index.ambiguous,
    invalid,
    hiddenByPlatform,
    ...(truncatedSources.length ? { truncatedSources } : {}),
  };
}

/** Level 1 (no `file`) or Level 2 (`file`) read. A quarantined skill is refused by name. */
export async function viewSkill({ ref, appId, file } = {}) {
  const { index, quarantined } = await collectIndex({ appId });
  const resolved = resolveSkillRef(index, ref);
  if (!resolved.ok) {
    const blocked = quarantined.find((skill) => skill.id === ref || skill.path === ref || skill.name.toLowerCase() === String(ref).toLowerCase());
    if (blocked && resolved.code === 'SKILL_NOT_FOUND') {
      fail('SKILL_QUARANTINED', `Skill ${blocked.id} is quarantined by the security scan`, { context: { findings: blocked.findings } });
    }
    failVerdict(resolved);
  }
  const result = file ? await readSkillSupportFile(resolved.skill, file) : await readSkillDocument(resolved.skill);
  if (!result.ok) failVerdict(result);
  return result;
}

/** The Level 0 index section for an agent briefing, or '' when no skill is visible. */
export async function buildSkillIndexPromptSection({ appId } = {}) {
  const { index } = await collectIndex({ appId });
  return formatSkillIndexForPrompt(index.visible.map(toSkillSummary));
}

let manageTail = Promise.resolve();
const serializeManage = (work) => {
  const run = manageTail.then(work, work);
  manageTail = run.catch(() => {});
  return run;
};

async function localIndex() {
  const scanned = await scanSkillSource({ tier: 'local', key: 'local', root: localSkillsRoot() });
  return { scanned, index: buildSkillIndex(scanned.skills) };
}

async function resolveLocalSkill(ref) {
  const { index } = await localIndex();
  const resolved = resolveSkillRef(index, ref);
  if (!resolved.ok) failVerdict(resolved);
  return resolved.skill;
}

const assertParses = (content) => {
  const parsed = parseSkillMarkdown(content);
  if (!parsed.ok) fail(parsed.code, parsed.message);
  return parsed;
};

async function lintLocalSkill(skillDir, content, frontmatter) {
  const { files } = await listSkillSupportFiles(skillDir);
  return lintSkill({ content, frontmatter, referenceFileCount: files.filter((entry) => entry.path.startsWith('references/')).length });
}

async function refreshedSummary(dir) {
  const { scanned } = await localIndex();
  const skill = scanned.skills.find((candidate) => candidate.dir === dir);
  return skill ? toSkillSummary(skill) : null;
}

const MANAGE_ACTIONS = {
  async create(args) {
    const parsed = assertParses(args.content);
    if (parsed.frontmatter.name && parsed.frontmatter.name !== args.name) {
      fail('SKILL_INVALID', `Frontmatter name '${parsed.frontmatter.name}' does not match '${args.name}'`);
    }
    const { scanned } = await localIndex();
    if (scanned.skills.some((skill) => skill.name.toLowerCase() === args.name.toLowerCase())) {
      fail('SKILL_EXISTS', `A local skill named '${args.name}' already exists`);
    }
    if ([args.name, args.category].some((segment) => segment && isReservedSkillDirName(segment))) {
      fail('SKILL_INVALID', 'Skill and category names may not be a supporting-file folder name or node_modules');
    }
    const root = localSkillsRoot();
    // A category folder that is itself a skill would hide the new one from discovery.
    if (args.category && await tryReadFile(join(root, args.category, SKILL_FILE)) !== null) {
      fail('SKILL_INVALID', `'${args.category}' is a skill, not a category folder`);
    }
    const dir = join(root, ...(args.category ? [args.category] : []), args.name);
    if (await tryReadFile(join(dir, SKILL_FILE)) !== null) fail('SKILL_EXISTS', `A local skill already exists at ${args.category ? `${args.category}/` : ''}${args.name}`);
    await atomicWrite(join(dir, SKILL_FILE), args.content);
    const created = (await localIndex()).scanned.skills.find((skill) => skill.name.toLowerCase() === args.name.toLowerCase());
    return { skill: created ? toSkillSummary(created) : null, warnings: await lintLocalSkill(dir, args.content, parsed.frontmatter) };
  },
  async patch(args) {
    const skill = await resolveLocalSkill(args.name);
    const current = await tryReadFile(join(skill.dir, SKILL_FILE));
    if (current === null) fail('SKILL_FILE_NOT_FOUND');
    const occurrences = current.split(args.oldString).length - 1;
    if (occurrences === 0) fail('SKILL_PATCH_NO_MATCH', 'oldString does not occur in SKILL.md');
    if (occurrences > 1 && !args.replaceAll) fail('SKILL_PATCH_AMBIGUOUS', `oldString occurs ${occurrences} times; make it unique or set replaceAll`);
    const next = args.replaceAll ? current.split(args.oldString).join(args.newString) : current.replace(args.oldString, () => args.newString);
    const parsed = assertParses(next);
    await atomicWrite(join(skill.dir, SKILL_FILE), next);
    return { skill: await refreshedSummary(skill.dir), replacements: args.replaceAll ? occurrences : 1, warnings: await lintLocalSkill(skill.dir, next, parsed.frontmatter) };
  },
  async write_file(args) {
    const skill = await resolveLocalSkill(args.name);
    const jailed = await jailSupportPath(skill.dir, args.path, { mustExist: false });
    if (!jailed.ok) failVerdict(jailed);
    await atomicWrite(jailed.path, args.content);
    const content = await tryReadFile(join(skill.dir, SKILL_FILE)) ?? '';
    const parsed = parseSkillMarkdown(content);
    return { skill: toSkillSummary(skill), path: args.path, warnings: await lintLocalSkill(skill.dir, content, parsed.ok ? parsed.frontmatter : {}) };
  },
  async remove_file(args) {
    const skill = await resolveLocalSkill(args.name);
    const jailed = await jailSupportPath(skill.dir, args.path);
    if (!jailed.ok) failVerdict(jailed);
    await unlinkGuarded(jailed.path);
    return { skill: toSkillSummary(skill), path: args.path, warnings: [] };
  },
  async delete(args) {
    const skill = await resolveLocalSkill(args.name);
    // Belt and braces: the resolved directory is a canonical child of the local root.
    if (skill.dir === skill.root || !isPathAtOrInsideDir(skill.root, skill.dir)) fail('SKILL_PATH_ESCAPE');
    await rmGuarded(skill.dir, { recursive: true, force: true });
    return { skill: toSkillSummary(skill), deleted: true, warnings: [] };
  },
};

/**
 * Create, patch, write/remove a supporting file, or delete a `local` skill.
 * Lint warnings are advisory and never block a valid write.
 */
export function manageSkill(input) {
  const parsed = skillsManageSchema.safeParse(input);
  if (!parsed.success) {
    fail('VALIDATION_ERROR', `Invalid skills.manage arguments: ${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`);
  }
  const args = parsed.data;
  return serializeManage(async () => {
    const result = await MANAGE_ACTIONS[args.action](args);
    console.log(`📚 Skill ${args.action}: ${result.skill?.id || args.name}`);
    return { ok: true, action: args.action, ...result };
  });
}

export async function getSkillsConfig() {
  return { externalDirs: await readExternalDirs() };
}

export async function updateSkillsConfig(patch) {
  const { updateSettingsWith } = await import('../settings.js');
  await updateSettingsWith((current) => ({ ...current, skills: { ...(current.skills || {}), ...patch } }));
  return getSkillsConfig();
}
