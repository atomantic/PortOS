/**
 * Deterministic Skill Curator: inactivity transitions (active → stale → archived) for agent-created local skills, archive/restore, pin/lock/adopt controls and ledger rollback.
 *
 * Zero provider calls (AGENTS.md AI Provider Usage Policy): every decision is
 * arithmetic over `skillUsageStore.js` telemetry. The pass runs only from the
 * default-off `job-skill-curator` script job or an explicit user request.
 *
 * Curator-managed means: a `local` skill whose usage record says
 * `createdBy: 'agent'` (set when an agent creates it, or by an explicit
 * `adopt`), not `pinned`, not `locked`, and not named by any autonomous job
 * (paused or disabled jobs included). Everything else is left alone. The idle
 * clock is the latest view/use/patch/restore/creation stamp; a never-used
 * skill's clock never starts before it was adopted, and a managed skill with
 * no stamp at all starts its clock at this pass (the grace floor). A skill is
 * always `stale` for at least one pass before it is archived, and archival is
 * a move into `data/skills/.archive/`, never a delete; every move is a ledger
 * entry, so it is reversible by `restore` or a single-entry rollback.
 *
 * All file moves share the skill service's write tail.
 */

import { dirname, join } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { DAY, ensureDir, pathExists, renameGuarded } from '../../lib/fileUtils.js';
import { isPathAtOrInsideDir } from '../../lib/pathContainment.js';
import { escapeRegExp } from '../../lib/textUtils.js';
import { resolveSkillRef, SKILL_FILE, toSkillSummary } from '../../lib/skills/skillRegistry.js';
import { ARCHIVE_DIR, captureSkillDir, parseLedgerPath, rollbackLedgerEntry } from './skillLedger.js';
import {
  getCuratorConfig, recordSkillMutation, scanArchivedSkills, scanLocalSkills, withSkillWriteLock,
} from './skillService.js';
import { emptyUsageRecord, ensureRecord, lastActivityAt, readUsage, rekeyRecord, toUsageSummary, tryReadUsage, updateUsage } from './skillUsageStore.js';

export const SKILL_CURATOR_JOB_ID = 'job-skill-curator';

const fail = (code, message, status) => {
  throw new ServerError(message, { status, code });
};

/** The curator's idle clock for one record, or null when it has no stamp at all. */
export const idleClockStart = (record) => {
  const activity = lastActivityAt(record);
  const adopted = Date.parse(record?.adoptedAt || '');
  if (record?.useCount === 0 && Number.isFinite(adopted)) return Math.max(activity ?? adopted, adopted);
  return activity;
};

const mentionPattern = (token) => new RegExp(`(^|[^a-z0-9._/:-])${escapeRegExp(token.toLowerCase())}($|[^a-z0-9._/:-])`);

/** True when a job's text names the skill by id, tier-relative path or bare name. */
export const isSkillMentioned = (text, skill) => [skill.id, skill.path, skill.name]
  .some((token) => token && mentionPattern(token).test(text));

/**
 * Ids of skills any autonomous job names. A job is matched on its name,
 * description and prompt template regardless of enabled state. Over-matching
 * only protects a skill from archival, so a common-word name errs safe. An
 * unreadable job store throws: the pass must not archive what it cannot check.
 */
async function collectJobReferencedSkillIds(skills) {
  const { getAllJobs } = await import('../autonomousJobs.js');
  const jobs = await getAllJobs();
  const text = (Array.isArray(jobs) ? jobs : [])
    .map((job) => [job?.name, job?.description, job?.promptTemplate].filter((value) => typeof value === 'string').join('\n'))
    .join('\n').toLowerCase();
  return new Set(skills.filter((skill) => isSkillMentioned(text, skill)).map((skill) => skill.id));
}

/**
 * Pure transition plan for one pass over the active local skills.
 *
 * @returns {{ transitions: object[], skipped: object[], tracked: object[] }}
 */
export function planCuratorPass({ skills, usage, protectedIds = new Set(), config, now }) {
  const transitions = [];
  const skipped = [];
  const tracked = [];
  for (const skill of skills) {
    const record = usage.skills[skill.id];
    const base = { id: skill.id, name: skill.name, path: skill.path };
    const reason = record?.createdBy !== 'agent' ? 'not-agent-created'
      : record.pinned ? 'pinned'
        : record.locked ? 'locked'
          : protectedIds.has(skill.id) ? 'job-referenced' : null;
    if (reason) {
      skipped.push({ ...base, reason });
      continue;
    }
    const start = idleClockStart(record);
    if (start === null) {
      tracked.push(base);
      continue;
    }
    const idleDays = Math.floor((now - start) / DAY);
    // A skill found in the active tree is active whatever its record says (a
    // hand move or rollback brought it back).
    const from = record.state === 'archived' ? 'active' : record.state;
    let to = from;
    if (from === 'stale' && idleDays < config.staleAfterDays) to = 'active';
    else if (from === 'stale' && idleDays >= config.archiveAfterDays) to = 'archived';
    else if (from === 'active' && idleDays >= config.staleAfterDays) to = 'stale';
    if (to !== from || record.state !== from) transitions.push({ ...base, from: record.state, to, idleDays });
  }
  return { transitions, skipped, tracked };
}

const archiveStamp = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

const archiveIdOf = (archiveRel) => `archive:${archiveRel.slice(ARCHIVE_DIR.length + 1)}`;

const relocate = (manifest, fromDir, toDir) => manifest?.map((file) => ({ ...file, path: `${toDir}${file.path.slice(fromDir.length)}` })) ?? null;

/** Move one active local skill into `.archive/` (caller holds the write lock). */
async function moveToArchive(skill, { actor, now }) {
  let archiveRel = `${ARCHIVE_DIR}/${skill.path}`;
  if (await pathExists(join(skill.root, ...archiveRel.split('/')))) archiveRel = `${archiveRel}-${archiveStamp(now)}`;
  const before = await captureSkillDir(skill.path);
  const target = join(skill.root, ...archiveRel.split('/'));
  await ensureDir(dirname(target));
  await renameGuarded(skill.dir, target);
  const summary = toSkillSummary(skill);
  await recordSkillMutation({ actor, action: 'archive', skill: summary, before, after: relocate(before, skill.path, archiveRel) });
  await updateUsage((doc) => {
    Object.assign(rekeyRecord(doc, skill.id, archiveIdOf(archiveRel)), { state: 'archived', archivedAt: now.toISOString(), originalId: skill.id });
  });
  console.log(`🗄️ Skill ${skill.id} archived to ${archiveRel} (${actor})`);
  return { skill: summary, archivePath: archiveRel };
}

/**
 * One curator pass. `dryRun` returns the exact plan without touching disk.
 * Fails closed on an unreadable usage file or job store.
 */
export function runCuratorPass({ dryRun = false, now = new Date() } = {}) {
  return withSkillWriteLock(async () => {
    const config = await getCuratorConfig();
    const { scanned } = await scanLocalSkills();
    const usage = await readUsage();
    const protectedIds = await collectJobReferencedSkillIds(scanned.skills);
    const plan = planCuratorPass({ skills: scanned.skills, usage, protectedIds, config, now: now.getTime() });
    const result = {
      dryRun,
      ranAt: now.toISOString(),
      config: { staleAfterDays: config.staleAfterDays, archiveAfterDays: config.archiveAfterDays },
      transitions: plan.transitions,
      skipped: plan.skipped,
      tracked: plan.tracked,
      failures: [],
    };
    if (dryRun) return result;

    const byId = new Map(scanned.skills.map((skill) => [skill.id, skill]));
    for (const transition of plan.transitions.filter((entry) => entry.to === 'archived')) {
      await moveToArchive(byId.get(transition.id), { actor: 'curator', now }).catch((error) => {
        console.warn(`⚠️ Skill curator could not archive ${transition.id}: ${error.message}`);
        result.failures.push({ id: transition.id, error: error.message });
      });
    }
    const at = now.toISOString();
    const counts = { stale: 0, active: 0, archived: 0 };
    for (const transition of plan.transitions) counts[transition.to] += 1;
    counts.archived -= result.failures.length;
    await updateUsage((doc) => {
      for (const transition of plan.transitions) {
        if (transition.to !== 'archived') ensureRecord(doc, transition.id).state = transition.to;
      }
      for (const entry of plan.tracked) ensureRecord(doc, entry.id).adoptedAt = at;
      doc.curator = { ...(doc.curator || {}), lastRun: { at, ...counts, tracked: plan.tracked.length, failures: result.failures.length } };
    });
    console.log(`🧹 Skill curator pass: ${counts.stale} stale, ${counts.archived} archived, ${counts.active} reactivated, ${plan.tracked.length} newly tracked`);
    return result;
  });
}

async function resolveActiveLocal(ref) {
  const { index } = await scanLocalSkills();
  const resolved = resolveSkillRef(index, ref);
  if (resolved.ok) return resolved.skill;
  if (resolved.code === 'SKILL_AMBIGUOUS') fail('SKILL_AMBIGUOUS', `More than one local skill matches '${ref}'; use its id`, 409);
  return fail('SKILL_NOT_FOUND', `No active local skill matches '${ref}'; only local skills can be pinned, locked, adopted or archived`, 404);
}

/**
 * Restore an archived skill to the path it was archived from. Refused when a
 * local skill now holds that name or path. `ref` is the archive id
 * (`archive:<path>`), its archive-relative path, its name, or the original
 * `local:` id.
 */
async function restoreFromArchive(ref, { actor, now }) {
  const { index } = await scanArchivedSkills();
  const doc = await readUsage();
  // The original `local:` id names the archived record that remembers it.
  const byOriginal = Object.keys(doc.skills).find((id) => id.startsWith('archive:') && doc.skills[id].originalId === ref);
  const resolved = resolveSkillRef(index, byOriginal || ref);
  if (!resolved.ok) fail(resolved.code, resolved.code === 'SKILL_AMBIGUOUS' ? `More than one archived skill matches '${ref}'; use its id` : `No archived skill matches '${ref}'`, resolved.code === 'SKILL_AMBIGUOUS' ? 409 : 404);
  const archived = resolved.skill;
  const originalId = doc.skills[archived.id]?.originalId;
  // The usage file is data, so its remembered path is validated like any
  // ledger path (and must not land back inside .archive/).
  const remembered = originalId?.startsWith('local:') ? originalId.slice('local:'.length) : null;
  const restorePath = remembered && parseLedgerPath(`${remembered}/${SKILL_FILE}`) && !remembered.startsWith('.') ? remembered : archived.path;
  const { scanned } = await scanLocalSkills();
  if (scanned.skills.some((skill) => skill.name.toLowerCase() === archived.name.toLowerCase())) {
    fail('SKILL_EXISTS', `A local skill named '${archived.name}' already exists; rename or remove it before restoring`, 409);
  }
  const localRoot = dirname(archived.root);
  const target = join(localRoot, ...restorePath.split('/'));
  if (target === localRoot || !isPathAtOrInsideDir(localRoot, target)) fail('SKILL_PATH_ESCAPE', 'Restore target escapes the local skills directory', 403);
  if (await pathExists(target)) fail('SKILL_EXISTS', `Something already occupies ${restorePath}`, 409);
  const archiveRel = `${ARCHIVE_DIR}/${archived.path}`;
  const before = await captureSkillDir(archiveRel);
  await ensureDir(dirname(target));
  await renameGuarded(archived.dir, target);
  const id = `local:${restorePath}`;
  const summary = { id, name: archived.name, path: restorePath };
  await recordSkillMutation({ actor, action: 'restore', skill: summary, before, after: relocate(before, archiveRel, restorePath) });
  const usage = await updateUsage((usageDoc) => {
    const record = rekeyRecord(usageDoc, archived.id, id);
    Object.assign(record, { state: 'active', archivedAt: null, originalId: null, restoredAt: now.toISOString() });
    return toUsageSummary(record);
  });
  console.log(`♻️ Skill ${id} restored from ${archiveRel} (${actor})`);
  return { skill: summary, usage };
}

const FLAG_ACTIONS = {
  pin: (record) => { record.pinned = true; },
  unpin: (record) => { record.pinned = false; },
  lock: (record) => { record.locked = true; },
  unlock: (record) => { record.locked = false; },
  // Provenance is declared, never inferred: adopting hands a skill to the
  // curator without touching its history (a never-used skill's clock starts now).
  adopt: (record, at) => {
    if (record.createdBy === 'agent') return;
    record.createdBy = 'agent';
    record.adoptedAt = at;
  },
};

/**
 * pin | unpin | lock | unlock | adopt | archive | restore on one local skill.
 * These are the operator's controls: a lock does not stop them, but archiving
 * a pinned skill is refused, as the curator would.
 */
export function applySkillLifecycleAction({ ref, action }, { actor = 'user', now = new Date() } = {}) {
  return withSkillWriteLock(async () => {
    if (action === 'restore') return { ok: true, action, ...await restoreFromArchive(ref, { actor, now }) };
    const skill = await resolveActiveLocal(ref);
    if (action === 'archive') {
      if ((await readUsage()).skills[skill.id]?.pinned) fail('SKILL_PINNED', `Skill ${skill.id} is pinned; unpin it before archiving`, 409);
      const moved = await moveToArchive(skill, { actor, now });
      return { ok: true, action, ...moved };
    }
    const usage = await updateUsage((doc) => {
      const record = ensureRecord(doc, skill.id);
      FLAG_ACTIONS[action](record, now.toISOString());
      return toUsageSummary(record);
    });
    console.log(`📌 Skill ${action}: ${skill.id}`);
    return { ok: true, action, skill: toSkillSummary(skill), usage };
  });
}

/**
 * Roll back one ledger entry, then bring the skill's usage record in line with
 * where its files now are (active, archived, or gone).
 */
export function rollbackSkillLedgerEntry(entryId, { actor = 'user', now = new Date() } = {}) {
  return withSkillWriteLock(async () => {
    const { ledgerMaxBytes } = await getCuratorConfig();
    const { rolledBack, ...result } = await rollbackLedgerEntry(entryId, { actor, maxBytes: ledgerMaxBytes, now });
    const skill = rolledBack.skill;
    let usageReconciled = true;
    if (skill?.id && skill.path) {
      const { scanned } = await scanLocalSkills();
      const active = scanned.skills.some((candidate) => candidate.path === skill.path);
      const archivedFile = result.restored.find((path) => path.startsWith(`${ARCHIVE_DIR}/`) && path.endsWith(`/${SKILL_FILE}`));
      // The files are already back; a usage failure is reported, not hidden
      // behind a plain success, and never undoes the restore.
      usageReconciled = await updateUsage((doc) => {
        // The record may sit under the skill's own id or under an archive id
        // that remembers it; follow the files to wherever they now are.
        const fromId = doc.skills[skill.id] ? skill.id
          : Object.keys(doc.skills).find((id) => id.startsWith('archive:') && doc.skills[id].originalId === skill.id);
        const activeFields = { state: 'active', archivedAt: null, originalId: null, restoredAt: now.toISOString() };
        if (active) {
          if (fromId) Object.assign(rekeyRecord(doc, fromId, skill.id), activeFields);
          // A resurrected delete gets back the provenance, lock and counters it had.
          else if (rolledBack.usageBefore) doc.skills[skill.id] = { ...emptyUsageRecord(), ...rolledBack.usageBefore, ...activeFields };
        } else if (archivedFile) {
          const archiveId = archiveIdOf(archivedFile.slice(0, -(SKILL_FILE.length + 1)));
          if (fromId) Object.assign(rekeyRecord(doc, fromId, archiveId), { state: 'archived', archivedAt: now.toISOString(), originalId: skill.id });
        } else if (fromId) {
          // The skill is gone: a later skill at this path must start fresh.
          delete doc.skills[fromId];
        }
      }).then(() => true, (error) => {
        console.warn(`⚠️ Skill usage for ${skill.id} not reconciled after rollback: ${error.message}`);
        return false;
      });
    }
    return { ok: true, ...result, rolledBack: { id: rolledBack.id, action: rolledBack.action, skill }, usageReconciled };
  });
}

/** Counts, thresholds, last pass and the scheduled job's state for the UI. */
export async function getCuratorStatus() {
  const config = await getCuratorConfig();
  const usage = await tryReadUsage();
  const { scanned } = await scanLocalSkills();
  const { scanned: archived } = await scanArchivedSkills();
  const records = usage.ok ? scanned.skills.map((skill) => usage.doc.skills[skill.id]) : [];
  const counts = usage.ok ? {
    active: records.filter((record) => (record?.state || 'active') === 'active').length,
    stale: records.filter((record) => record?.state === 'stale').length,
    archived: archived.skills.length,
    pinned: records.filter((record) => record?.pinned).length,
    locked: records.filter((record) => record?.locked).length,
    agentCreated: records.filter((record) => record?.createdBy === 'agent').length,
  } : null;
  const { getJob } = await import('../autonomousJobs.js');
  const job = await getJob(SKILL_CURATOR_JOB_ID).catch(() => null);
  return {
    config,
    usageAvailable: usage.ok,
    counts,
    lastRun: usage.ok ? usage.doc.curator?.lastRun ?? null : null,
    job: job ? { id: job.id, enabled: job.enabled === true, lastRun: job.lastRun ?? null } : null,
  };
}
