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
 * tail (`withSkillWriteLock`), since create/delete race on the same directory
 * tree; the Skill Curator (`skillCurator.js`) shares that tail.
 *
 * Curator integration (#17391): every Level 1/2 read counts toward the skill's
 * telemetry (`skillUsageStore.js`), every local write is recorded in the
 * mutation ledger (`skillLedger.js`) with before/after blobs, and an `agent`
 * write is refused on a `locked` skill (and when the usage file cannot be read,
 * so a lock is never assumed absent). Deleting a `pinned` skill is refused for
 * every actor. The Level 0 index is not counted: it is injected into every
 * full briefing, so counting it would make every listed skill look in use.
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
import { SKILL_CURATOR_DEFAULTS, skillsCuratorSettingsSchema, skillsManageSchema, skillsSettingsSchema } from '../../lib/skillsValidation.js';
import { appendLedgerEntry, ARCHIVE_DIR, captureSkillDir } from './skillLedger.js';
import { scanSkill } from './skillScanner.js';
import { emptyUsageRecord, ensureRecord, readUsage, recordSkillEvents, toUsageSummary, tryReadUsage, updateUsage } from './skillUsageStore.js';

const UNTRUSTED_TIERS = new Set(['project', 'external']);

const ERROR_STATUS = Object.freeze({
  SKILL_NOT_FOUND: 404,
  SKILL_FILE_NOT_FOUND: 404,
  APP_NOT_FOUND: 404,
  SKILL_AMBIGUOUS: 409,
  SKILL_EXISTS: 409,
  SKILL_QUARANTINED: 403,
  SKILL_LOCKED: 423,
  SKILL_PINNED: 409,
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

// Each field is parsed on its own, so a bad curator threshold never hides the
// external skill directories (or the reverse).
const SKILLS_SETTING_FIELDS = Object.freeze(['externalDirs', 'curator']);

async function readSkillsSettings() {
  const { getSettings } = await import('../settings.js');
  const stored = (await getSettings())?.skills ?? {};
  const settings = {};
  for (const field of SKILLS_SETTING_FIELDS) {
    if (stored[field] === undefined) continue;
    const parsed = skillsSettingsSchema.safeParse({ [field]: stored[field] });
    if (parsed.success) settings[field] = parsed.data[field];
    else console.log(`⚠️ settings.skills.${field} is malformed; ${field === 'curator' ? 'curator defaults apply' : 'external skill directories are ignored'}`);
  }
  return settings;
}

const readExternalDirs = async () => (await readSkillsSettings()).externalDirs || [];

/** Curator thresholds and the ledger cap, shipped defaults filled in. */
export async function getCuratorConfig() {
  const { curator } = await readSkillsSettings();
  return { ...SKILL_CURATOR_DEFAULTS, ...(curator || {}) };
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

const archiveSource = () => ({ tier: 'local', key: 'archive', root: join(localSkillsRoot(), ARCHIVE_DIR) });

/** Skills the curator (or a human) archived under `data/skills/.archive/`, indexed on their own. */
export async function scanArchivedSkills() {
  const scanned = await scanSkillSource(archiveSource());
  return { scanned, index: buildSkillIndex(scanned.skills) };
}

/**
 * Level 0 listing plus the quarantine, shadow, ambiguity and invalid-skill
 * reports, each visible skill annotated with its curator telemetry. When the
 * usage file is unreadable the telemetry is omitted and `usageUnavailable` is
 * set — never zero counts that would read as "never used".
 */
export async function listSkills({ appId } = {}) {
  const { index, quarantined, invalid, hiddenByPlatform, truncatedSources } = await collectIndex({ appId });
  const usage = await tryReadUsage();
  const withUsage = (summary) => (usage.ok ? { ...summary, usage: toUsageSummary(usage.doc.skills[summary.id]) } : summary);
  const archived = (await scanArchivedSkills()).scanned.skills.map((skill) => ({
    ...withUsage(toSkillSummary(skill)),
    originalId: usage.ok ? usage.doc.skills[skill.id]?.originalId ?? null : null,
  }));
  return {
    skills: index.visible.map((skill) => withUsage({ ...toSkillSummary(skill), ...(skill.ambiguous ? { ambiguous: true } : {}) })),
    archived,
    ...(usage.ok ? {} : { usageUnavailable: true }),
    quarantined,
    shadowed: index.shadowed,
    ambiguous: index.ambiguous,
    invalid,
    hiddenByPlatform,
    ...(truncatedSources.length ? { truncatedSources } : {}),
  };
}

/**
 * Level 1 (no `file`) or Level 2 (`file`) read. A quarantined skill is refused
 * by name. A successful read counts as a `view`; an `agent` read also counts
 * as a `use`, since the skill's text then enters an agent's prompt.
 */
export async function viewSkill({ ref, appId, file } = {}, { actor = 'user' } = {}) {
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
  // Telemetry never blocks a read: an unreadable usage file skips the count.
  await recordSkillEvents(resolved.skill.id, actor === 'agent' ? ['view', 'use'] : ['view'])
    .catch((error) => console.log(`⚠️ Skill usage for ${resolved.skill.id} not counted: ${error.message}`));
  return result;
}

/** The Level 0 index section for an agent briefing, or '' when no skill is visible. */
export async function buildSkillIndexPromptSection({ appId } = {}) {
  const { index } = await collectIndex({ appId });
  return formatSkillIndexForPrompt(index.visible.map(toSkillSummary));
}

let manageTail = Promise.resolve();
/** The one tail every local skill-tree write (manage, curator, rollback) runs on. */
export const withSkillWriteLock = (work) => {
  const run = manageTail.then(work, work);
  manageTail = run.catch(() => {});
  return run;
};

/** Discover the `local` tier on its own (no other tier, no quarantine). */
export async function scanLocalSkills() {
  const scanned = await scanSkillSource({ tier: 'local', key: 'local', root: localSkillsRoot() });
  return { scanned, index: buildSkillIndex(scanned.skills) };
}

async function resolveLocalSkill(ref) {
  const { index } = await scanLocalSkills();
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
  const { scanned } = await scanLocalSkills();
  const skill = scanned.skills.find((candidate) => candidate.dir === dir);
  return skill ? toSkillSummary(skill) : null;
}

const MANAGE_ACTIONS = {
  async create(args) {
    const parsed = assertParses(args.content);
    if (parsed.frontmatter.name && parsed.frontmatter.name !== args.name) {
      fail('SKILL_INVALID', `Frontmatter name '${parsed.frontmatter.name}' does not match '${args.name}'`);
    }
    const { scanned } = await scanLocalSkills();
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
    const created = (await scanLocalSkills()).scanned.skills.find((skill) => skill.name.toLowerCase() === args.name.toLowerCase());
    return { skill: created ? toSkillSummary(created) : null, warnings: await lintLocalSkill(dir, args.content, parsed.frontmatter) };
  },
  async patch(args, skill) {
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
  async write_file(args, skill) {
    const jailed = await jailSupportPath(skill.dir, args.path, { mustExist: false });
    if (!jailed.ok) failVerdict(jailed);
    await atomicWrite(jailed.path, args.content);
    const content = await tryReadFile(join(skill.dir, SKILL_FILE)) ?? '';
    const parsed = parseSkillMarkdown(content);
    return { skill: toSkillSummary(skill), path: args.path, warnings: await lintLocalSkill(skill.dir, content, parsed.ok ? parsed.frontmatter : {}) };
  },
  async remove_file(args, skill) {
    const jailed = await jailSupportPath(skill.dir, args.path);
    if (!jailed.ok) failVerdict(jailed);
    await unlinkGuarded(jailed.path);
    return { skill: toSkillSummary(skill), path: args.path, warnings: [] };
  },
  async delete(_args, skill) {
    // Belt and braces: the resolved directory is a canonical child of the local root.
    if (skill.dir === skill.root || !isPathAtOrInsideDir(skill.root, skill.dir)) fail('SKILL_PATH_ESCAPE');
    await rmGuarded(skill.dir, { recursive: true, force: true });
    return { skill: toSkillSummary(skill), deleted: true, warnings: [] };
  },
};

/**
 * Refuse an `agent` write on a locked skill, and a delete of a pinned one by
 * anyone. Both read the usage file strictly: when it cannot be read the guard
 * cannot be verified, so the write is refused rather than assumed allowed.
 */
async function assertManageAllowed(action, skill, actor) {
  if (actor !== 'agent' && action !== 'delete') return;
  const doc = await readUsage();
  const record = skill ? doc.skills[skill.id] : null;
  if (actor === 'agent' && record?.locked) fail('SKILL_LOCKED', `Skill ${skill.id} is locked; only a human edit through the PortOS UI may change it`);
  if (action === 'delete' && record?.pinned) fail('SKILL_PINNED', `Skill ${skill.id} is pinned; unpin it before deleting`);
}

/**
 * Append a ledger entry for a mutation that already happened. The `before`
 * snapshot was taken (and could refuse the write) before mutating; a failure
 * here leaves the change in place, so it is reported loudly instead.
 */
export async function recordSkillMutation({ actor, action, skill, before, after, ...extra }) {
  // `after: undefined` means the after-state could not be captured: recorded
  // as such, never as `null` (which would claim the skill no longer exists).
  if (after === undefined) Object.assign(extra, { afterUnavailable: true });
  const { ledgerMaxBytes } = await getCuratorConfig();
  return appendLedgerEntry({ actor, action, skill, before, after, ...extra }, { maxBytes: ledgerMaxBytes })
    .catch((error) => console.warn(`⚠️ Skill ledger entry for ${action} ${skill.id} not recorded: ${error.message}`));
}

function noteManageUsage(action, skillId, actor) {
  const at = new Date().toISOString();
  return updateUsage((doc) => {
    if (action === 'delete') {
      delete doc.skills[skillId];
      return;
    }
    const record = ensureRecord(doc, skillId);
    if (action === 'create') {
      // A brand-new skill never inherits a leftover row at its path.
      doc.skills[skillId] = { ...emptyUsageRecord(), createdAt: at, createdBy: actor === 'user' ? 'user' : 'agent' };
      return;
    }
    record.patchCount += 1;
    record.lastPatchedAt = at;
    if (record.state === 'stale') record.state = 'active';
  }).catch((error) => console.log(`⚠️ Skill usage for ${skillId} not updated: ${error.message}`));
}

/**
 * Create, patch, write/remove a supporting file, or delete a `local` skill.
 * Lint warnings are advisory and never block a valid write. `actor` is
 * `agent` for the CoS tool and the agent-facing REST route, `user` for the
 * PortOS UI's edit route; only `agent` writes honor a skill's lock.
 */
export function manageSkill(input, { actor = 'agent' } = {}) {
  const parsed = skillsManageSchema.safeParse(input);
  if (!parsed.success) {
    fail('VALIDATION_ERROR', `Invalid skills.manage arguments: ${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`);
  }
  const args = parsed.data;
  return withSkillWriteLock(async () => {
    const skill = args.action === 'create' ? null : await resolveLocalSkill(args.name);
    await assertManageAllowed(args.action, skill, actor);
    const before = skill ? await captureSkillDir(skill.path) : null;
    // A delete drops the usage row; the ledger keeps it so a rollback can
    // bring back the skill's provenance, lock and counters with its files.
    const usageBefore = args.action === 'delete' ? (await tryReadUsage()).doc?.skills[skill.id] ?? null : null;
    const result = await MANAGE_ACTIONS[args.action](args, skill);
    const target = result.skill || (skill ? toSkillSummary(skill) : null);
    if (target) {
      const after = args.action === 'delete' ? null : await captureSkillDir(target.path).catch((error) => {
        console.warn(`⚠️ Skill ledger snapshot of ${target.id} failed: ${error.message}`);
        return undefined;
      });
      await recordSkillMutation({ actor, action: args.action, skill: target, before, after, ...(usageBefore ? { usageBefore } : {}) });
      await noteManageUsage(args.action, target.id, actor);
    }
    console.log(`📚 Skill ${args.action}: ${target?.id || args.name}`);
    return { ok: true, action: args.action, ...result };
  });
}

export async function getSkillsConfig() {
  return { externalDirs: await readExternalDirs(), curator: await getCuratorConfig() };
}

export async function updateSkillsConfig(patch) {
  const { getSettings, updateSettingsWith } = await import('../settings.js');
  // A partial curator save merges into the stored thresholds, so the merged
  // pair is what must satisfy archiveAfterDays > staleAfterDays.
  if (patch.curator) {
    const stored = (await getSettings())?.skills?.curator || {};
    const merged = skillsCuratorSettingsSchema.safeParse({ ...SKILL_CURATOR_DEFAULTS, ...stored, ...patch.curator });
    if (!merged.success) fail('VALIDATION_ERROR', merged.error.issues.map((issue) => issue.message).join('; '));
  }
  await updateSettingsWith((current) => {
    const skills = { ...(current.skills || {}), ...patch };
    if (patch.curator) skills.curator = { ...(current.skills?.curator || {}), ...patch.curator };
    return { ...current, skills };
  });
  return getSkillsConfig();
}
