/**
 * Character Sheet Service
 *
 * The Character's `level` is **life experience = age**: each year lived is a level
 * (`level = Math.floor(ageYears)`), derived on read from the canonical `birthDate`
 * (see #2673, epic #2672). `xp` survives only as a cumulative stat — it no longer
 * drives level. HP/damage/rest mechanics are retained for backward-compat with a
 * flat maxHp (no longer scaled off level).
 *
 * `skills` are likewise derived on read, from each domain's existing stats
 * (see `characterSkills.js`, #2674).
 */

import crypto from 'crypto';
import path from 'path';
import { atomicWrite, ensureDir, readJSONFile, PATHS } from '../lib/fileUtils.js';
import * as jiraService from './jira.js';
import * as cosService from './cos.js';
import { getBirthDate } from './meatspace.js';
import { getCharacterSkills } from './characterSkills.js';

const CHARACTER_FILE = path.join(PATHS.data, 'character.json');

// HP is no longer scaled off level (level is now age, which would balloon maxHp). The
// damage/rest mechanics survive for backward-compat against a flat maxHp.
const DEFAULT_MAX_HP = 15;

// Derived fields getCharacter() attaches on read; they are stripped before persisting so a
// stale age-level (or a per-machine usage-derived skill set) never lands on disk or in the
// federated snapshot. `skills` is per-machine by design — see characterSkills.js (#2674).
const DERIVED_FIELDS = ['level', 'ageYears', 'skills'];

/**
 * Copy `record` without any derived field. The single chokepoint for that rule — used by the
 * persist path (saveCharacter), the federation wire projection (getWireCharacter), and
 * dataSync's character merge — so adding a derived field to the list above can't be forgotten
 * at one of the three sites.
 */
export function stripDerivedFields(record) {
  const out = { ...record };
  for (const field of DERIVED_FIELDS) delete out[field];
  return out;
}

// Pure: fractional years lived since birthDate (whole years + progress toward the next
// birthday), or null when birthDate is unset/invalid/future. Uses **calendar** birthdays,
// not a fixed 365.25-day average — averaging would tick the level up to a day early across
// leap years. UTC components are used on both sides so the tick lands on the birthday's UTC
// date regardless of the server's local timezone.
export function ageYearsFromBirthDate(birthDate, now = new Date()) {
  if (!birthDate) return null;
  const birth = new Date(birthDate);
  if (Number.isNaN(birth.getTime()) || birth.getTime() > now.getTime()) return null;

  // Completed calendar years = how many birthdays have passed.
  let years = now.getUTCFullYear() - birth.getUTCFullYear();
  const lastBirthday = new Date(birth);
  lastBirthday.setUTCFullYear(birth.getUTCFullYear() + years);
  if (lastBirthday.getTime() > now.getTime()) {
    years -= 1;
    lastBirthday.setUTCFullYear(lastBirthday.getUTCFullYear() - 1);
  }
  if (years < 0) return null;

  // Fraction of the way from the last birthday to the next (progress toward next birthday).
  const nextBirthday = new Date(lastBirthday);
  nextBirthday.setUTCFullYear(lastBirthday.getUTCFullYear() + 1);
  const span = nextBirthday.getTime() - lastBirthday.getTime();
  // frac ∈ [0, 1): now is always ≥ lastBirthday and < nextBirthday. Do NOT round the sum —
  // rounding e.g. 25.997 to 25.99→26.00 would push floor(ageYears) to the wrong level a day
  // early. levelFromAge() floors this, and display consumers round the fractional part.
  const frac = span > 0 ? Math.min(0.999999, Math.max(0, (now.getTime() - lastBirthday.getTime()) / span)) : 0;

  return years + frac;
}

// Pure: age-based level = whole years lived. null when age is unknown.
export function levelFromAge(ageYears) {
  return Number.isFinite(ageYears) ? Math.floor(ageYears) : null;
}

// Legacy pre-#2673 XP→level curve, retained ONLY for the federation wire projection
// (getWireCharacter) so an older peer — which still levels off XP — receives a level
// consistent with the shared `xp`. NOT used for the live age-based level.
const LEGACY_XP_THRESHOLDS = [
  0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000,
  85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000
];
function legacyLevelFromXp(xp) {
  const safe = Number.isFinite(xp) ? xp : 0;
  for (let i = LEGACY_XP_THRESHOLDS.length - 1; i >= 0; i--) {
    if (safe >= LEGACY_XP_THRESHOLDS[i]) return i + 1;
  }
  return 1;
}

function createEvent(type, description, overrides = {}) {
  return {
    id: crypto.randomUUID(),
    type,
    description,
    xp: 0,
    damage: 0,
    diceNotation: null,
    diceRolls: [],
    hpRecovered: 0,
    ...overrides,
    timestamp: new Date().toISOString()
  };
}

export function createDefaultCharacter() {
  const now = new Date().toISOString();
  return {
    name: 'Adventurer',
    class: 'Developer',
    xp: 0,
    hp: DEFAULT_MAX_HP,
    maxHp: DEFAULT_MAX_HP,
    events: [],
    syncedJiraTickets: [],
    syncedTaskIds: [],
    createdAt: now,
    updatedAt: now
  };
}

// Read the persisted record (no derived fields), creating the default on first access.
// Mutating paths build on this so they never re-persist a derived age-level.
async function loadRawCharacter() {
  const data = await readJSONFile(CHARACTER_FILE, null);
  if (data) return data;
  const character = createDefaultCharacter();
  await ensureDir(PATHS.data);
  await atomicWrite(CHARACTER_FILE, character);
  return character;
}

// Attach the derived read-only fields to a raw record: `ageYears`/`level` from the canonical
// birthDate (#2673), and the per-domain `skills` from each domain's existing stats (#2674).
// `level` is null when no birthDate is set, so callers can render a "set your birth date"
// prompt. Neither is ever persisted — see DERIVED_FIELDS / saveCharacter.
// `withSkills: false` skips the skill fan-out (six domain stat reads) for callers that only
// want the persisted fields plus the age level — deriving skills nobody reads is pure waste.
// Skipping OMITS the key rather than setting it to [] or null: an absent `skills` means "not
// computed", which must not be confused with "computed, and every domain is empty".
async function enrichCharacter(raw, { withSkills = true } = {}) {
  const [{ birthDate }, skills] = await Promise.all([
    getBirthDate().catch(() => ({ birthDate: null })),
    withSkills ? getCharacterSkills() : Promise.resolve(undefined),
  ]);
  const ageYears = ageYearsFromBirthDate(birthDate);
  const enriched = { ...raw, ageYears, level: levelFromAge(ageYears) };
  // Drop any stale persisted key when skills weren't computed, so a hand-edited
  // character.json can't pass its own `skills` off as freshly derived.
  if (withSkills) enriched.skills = skills;
  else delete enriched.skills;
  return enriched;
}

export async function getCharacter(options = {}) {
  return enrichCharacter(await loadRawCharacter(), options);
}

// Apply a partial patch of human-authored fields (name/class/avatarPath). Reads the RAW
// record so the derived fan-out runs once — on the enriched record saveCharacter returns —
// rather than once here and once again on save.
export async function updateCharacterFields(patch = {}) {
  const character = await loadRawCharacter();
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) character[key] = value;
  }
  return saveCharacter(character);
}

// Federation wire projection: the persisted record plus a backward-compatible integer `level`
// for pre-#2673 peers, whose CharacterSheet indexes XP thresholds by `character.level` and
// NaNs without it. The level is the LEGACY xp-derived value (what those peers compute from the
// same shared `xp`), NOT the age level — deliberately so it stays a pure function of
// `character.json`: the file-mtime checksum that fingerprints the `character` category then
// still invalidates correctly, whereas an age/time-derived level would drift out of sync with
// that checksum on a birthday or a birthDate edit (which touch a different file). It is not
// persisted, and new peers ignore the remote level (applyCharacterRemote no longer merges it),
// so this projection is invisible to same-version installs.
export async function getWireCharacter() {
  const raw = await readJSONFile(CHARACTER_FILE, null);
  if (!raw) return null;
  // Strip every derived field a hand-edited or legacy character.json might be carrying before
  // it goes out on the wire: `level` is then re-added below as the legacy xp-derived value,
  // but `skills`/`ageYears` must never federate at all (skills are per-machine — see
  // characterSkills.js — and ageYears is a pure function of the peer's own birthDate). Without
  // this, applyCharacterRemote's no-local branch writes the payload verbatim and a stale key
  // would self-propagate across peers.
  return { ...stripDerivedFields(raw), level: legacyLevelFromXp(raw.xp) };
}

export async function saveCharacter(data) {
  await ensureDir(PATHS.data);
  // Never persist derived fields — level is age-derived on read (#2673), skills are
  // usage-derived and per-machine (#2674). Stripping them keeps stale values off disk and out
  // of the federated character snapshot.
  const persist = stripDerivedFields(data);
  persist.updatedAt = new Date().toISOString();
  await atomicWrite(CHARACTER_FILE, persist);
  return enrichCharacter(persist);
}

// Persist a freshly-rendered avatar path onto the singleton character. Lets the
// avatar-generation route fold persistence in (it already knows the character
// context) instead of forcing a second `PUT /api/character` round-trip.
export async function setAvatar(avatarPath) {
  const character = await updateCharacterFields({ avatarPath });
  console.log(`🖼️ Character avatar set → ${avatarPath}`);
  return character;
}

export function rollDice(notation) {
  const match = notation.match(/^(\d+)d(\d+)([+-]\d+)?$/);
  if (!match) throw new Error(`Invalid dice notation: ${notation}`);

  const count = parseInt(match[1], 10);
  const sides = parseInt(match[2], 10);
  const modifier = match[3] ? parseInt(match[3], 10) : 0;

  const rolls = [];
  for (let i = 0; i < count; i++) {
    rolls.push(Math.floor(Math.random() * sides) + 1);
  }

  const total = rolls.reduce((sum, r) => sum + r, 0) + modifier;
  return { rolls, modifier, total: Math.max(0, total) };
}

export async function addXP(amount, source, description) {
  const character = await loadRawCharacter();
  character.xp += amount;

  character.events.push(createEvent('xp', description || `Gained ${amount} XP from ${source}`, { xp: amount }));
  const saved = await saveCharacter(character);

  console.log(`✨ +${amount} XP (${source}) — total ${saved.xp} XP, level ${saved.level ?? '—'}`);
  // xp no longer drives level (level is age-derived, #2673) — an XP gain never levels up.
  return { character: saved, leveledUp: false, newLevel: saved.level };
}

export async function takeDamage(diceNotation, description) {
  const character = await loadRawCharacter();
  const roll = rollDice(diceNotation);

  character.hp = Math.max(0, character.hp - roll.total);

  character.events.push(createEvent('damage', description || `Took ${roll.total} damage (${diceNotation})`, {
    damage: roll.total, diceNotation, diceRolls: roll.rolls
  }));
  const saved = await saveCharacter(character);

  console.log(`💥 ${roll.total} damage (${diceNotation}: [${roll.rolls}]+${roll.modifier}) — ${saved.hp}/${saved.maxHp} HP`);
  return { character: saved, roll, totalDamage: roll.total };
}

export async function takeRest(type) {
  const character = await loadRawCharacter();
  const oldHp = character.hp;

  if (type === 'long') {
    character.hp = character.maxHp;
  } else {
    character.hp = Math.min(character.maxHp, character.hp + Math.floor(character.maxHp * 0.25));
  }

  const hpRecovered = character.hp - oldHp;

  character.events.push(createEvent('rest', `${type === 'long' ? 'Long' : 'Short'} rest — recovered ${hpRecovered} HP`, { hpRecovered }));
  const saved = await saveCharacter(character);

  console.log(`🛏️ ${type} rest — recovered ${hpRecovered} HP (${saved.hp}/${saved.maxHp})`);
  return { character: saved, hpRecovered };
}

export async function addEvent(event) {
  const character = await loadRawCharacter();
  let roll = null;

  if (event.xp) {
    character.xp += event.xp;
  }

  if (event.diceNotation) {
    roll = rollDice(event.diceNotation);
    character.hp = Math.max(0, character.hp - roll.total);
  }

  const logEntry = createEvent('custom', event.description, {
    xp: event.xp || 0,
    damage: roll ? roll.total : 0,
    diceNotation: event.diceNotation || null,
    diceRolls: roll ? roll.rolls : []
  });

  character.events.push(logEntry);
  const saved = await saveCharacter(character);

  console.log(`📝 Custom event: ${event.description}`);
  return { character: saved, event: logEntry, leveledUp: false };
}

const delay = ms => new Promise(r => setTimeout(r, ms));

export async function syncJiraXP() {
  const character = await loadRawCharacter();
  const config = await jiraService.getInstances();
  const instances = config.instances || {};
  let totalXP = 0;
  let ticketCount = 0;

  for (const [instanceId] of Object.entries(instances)) {
    let projects;
    try {
      projects = await jiraService.getProjects(instanceId);
    } catch {
      console.warn(`⚠️ Could not fetch projects for JIRA instance ${instanceId}`);
      continue;
    }

    for (let i = 0; i < projects.length; i++) {
      if (i > 0) await delay(500); // Rate-limit JIRA API calls
      const project = projects[i];
      let tickets;
      try {
        tickets = await jiraService.getMyCurrentSprintTickets(instanceId, project.key);
      } catch {
        console.warn(`⚠️ Could not fetch tickets for ${project.key}`);
        continue;
      }

      for (const ticket of tickets.filter(t => t.statusCategory === 'Done' || t.status === 'Done')) {
        if (character.syncedJiraTickets.includes(ticket.key)) continue;

        const xp = (ticket.storyPoints || 1) * 50;
        character.xp += xp;
        totalXP += xp;
        ticketCount++;
        character.syncedJiraTickets.push(ticket.key);
        character.events.push(createEvent('xp', `JIRA ${ticket.key}: ${ticket.summary} (${ticket.storyPoints || 0} pts)`, { xp }));
      }
    }
  }

  const saved = await saveCharacter(character);

  console.log(`🎫 Synced ${ticketCount} JIRA tickets for ${totalXP} XP`);
  return { character: saved, ticketCount, totalXP, leveledUp: false };
}

export async function syncTaskXP() {
  const character = await loadRawCharacter();
  const { user: userTasks, cos: cosTasks } = await cosService.getAllTasks();
  let totalXP = 0;
  let taskCount = 0;

  const allTasks = [...(userTasks.tasks || []), ...(cosTasks.tasks || [])];

  for (const task of allTasks.filter(t => t.status === 'completed')) {
    if (character.syncedTaskIds.includes(task.id)) continue;

    const xp = 25;
    character.xp += xp;
    totalXP += xp;
    taskCount++;
    character.syncedTaskIds.push(task.id);
    character.events.push(createEvent('xp', `Task: ${task.title || task.description || task.id}`, { xp }));
  }

  const saved = await saveCharacter(character);

  console.log(`✅ Synced ${taskCount} tasks for ${totalXP} XP`);
  return { character: saved, taskCount, totalXP, leveledUp: false };
}
