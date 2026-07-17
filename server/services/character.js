/**
 * Character Sheet Service
 *
 * The Character's `level` is **life experience = age**: each year lived is a level
 * (`level = Math.floor(ageYears)`), derived on read from the canonical `birthDate`
 * (see #2673, epic #2672). `xp` survives only as a cumulative stat — it no longer
 * drives level. HP/damage/rest mechanics are retained for backward-compat with a
 * flat maxHp (no longer scaled off level).
 */

import crypto from 'crypto';
import path from 'path';
import { atomicWrite, ensureDir, readJSONFile, PATHS } from '../lib/fileUtils.js';
import * as jiraService from './jira.js';
import * as cosService from './cos.js';
import { getBirthDate } from './meatspace.js';

const CHARACTER_FILE = path.join(PATHS.data, 'character.json');

// HP is no longer scaled off level (level is now age, which would balloon maxHp). The
// damage/rest mechanics survive for backward-compat against a flat maxHp.
const DEFAULT_MAX_HP = 15;

// Derived fields getCharacter() attaches on read; they are stripped before persisting so a
// stale age-level never lands on disk or in the federated snapshot.
const DERIVED_FIELDS = ['level', 'ageYears'];

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

// Attach the age-derived read-only fields (`ageYears`, `level`) to a raw record. `level` is
// null when no birthDate is set, so callers can render a "set your birth date" prompt.
async function enrichCharacter(raw) {
  const { birthDate } = await getBirthDate().catch(() => ({ birthDate: null }));
  const ageYears = ageYearsFromBirthDate(birthDate);
  return { ...raw, ageYears, level: levelFromAge(ageYears) };
}

export async function getCharacter() {
  return enrichCharacter(await loadRawCharacter());
}

export async function saveCharacter(data) {
  await ensureDir(PATHS.data);
  // Never persist derived fields — level is age-derived on read (#2673). Stripping them
  // keeps a stale level off disk and out of the federated character snapshot.
  const persist = { ...data };
  for (const field of DERIVED_FIELDS) delete persist[field];
  persist.updatedAt = new Date().toISOString();
  await atomicWrite(CHARACTER_FILE, persist);
  return enrichCharacter(persist);
}

// Persist a freshly-rendered avatar path onto the singleton character. Lets the
// avatar-generation route fold persistence in (it already knows the character
// context) instead of forcing a second `PUT /api/character` round-trip.
export async function setAvatar(avatarPath) {
  const character = await getCharacter();
  character.avatarPath = avatarPath;
  await saveCharacter(character);
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
  const character = await getCharacter();
  character.xp += amount;

  character.events.push(createEvent('xp', description || `Gained ${amount} XP from ${source}`, { xp: amount }));
  const saved = await saveCharacter(character);

  console.log(`✨ +${amount} XP (${source}) — total ${saved.xp} XP, level ${saved.level ?? '—'}`);
  // xp no longer drives level (level is age-derived, #2673) — an XP gain never levels up.
  return { character: saved, leveledUp: false, newLevel: saved.level };
}

export async function takeDamage(diceNotation, description) {
  const character = await getCharacter();
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
  const character = await getCharacter();
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
  const character = await getCharacter();
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
  const character = await getCharacter();
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
  const character = await getCharacter();
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
