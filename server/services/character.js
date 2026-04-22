/**
 * Character Sheet Service
 * D&D 5e-style character tracking XP, HP, level, damage, rests, and events.
 */

import crypto from 'crypto';
import path from 'path';
import { writeFile } from 'fs/promises';
import { ensureDir, readJSONFile, PATHS } from '../lib/fileUtils.js';
import * as jiraService from './jira.js';
import * as cosService from './cos.js';

const CHARACTER_FILE = path.join(PATHS.data, 'character.json');

const BASE_HP = 10;
const HP_PER_LEVEL = 5;

const XP_THRESHOLDS = [
  0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000,
  85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000
];

function getLevelFromXP(xp) {
  for (let i = XP_THRESHOLDS.length - 1; i >= 0; i--) {
    if (xp >= XP_THRESHOLDS[i]) return i + 1;
  }
  return 1;
}

function getMaxHP(level) {
  return BASE_HP + (level * HP_PER_LEVEL);
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

function recalcLevel(character) {
  const oldLevel = character.level;
  character.level = getLevelFromXP(character.xp);
  character.maxHp = getMaxHP(character.level);
  const leveledUp = character.level > oldLevel;
  if (leveledUp) {
    character.hp = character.maxHp;
    console.log(`🎉 Level up! ${oldLevel} -> ${character.level}`);
  }
  return leveledUp;
}

export function createDefaultCharacter() {
  const now = new Date().toISOString();
  return {
    name: 'Adventurer',
    class: 'Developer',
    xp: 0,
    hp: 15,
    maxHp: 15,
    level: 1,
    events: [],
    syncedJiraTickets: [],
    syncedTaskIds: [],
    createdAt: now,
    updatedAt: now
  };
}

export async function getCharacter() {
  const data = await readJSONFile(CHARACTER_FILE, null);
  if (data) return data;
  const character = createDefaultCharacter();
  await saveCharacter(character);
  return character;
}

export async function saveCharacter(data) {
  await ensureDir(PATHS.data);
  data.updatedAt = new Date().toISOString();
  await writeFile(CHARACTER_FILE, JSON.stringify(data, null, 2));
  return data;
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
  const leveledUp = recalcLevel(character);

  character.events.push(createEvent('xp', description || `Gained ${amount} XP from ${source}`, { xp: amount }));
  await saveCharacter(character);

  console.log(`✨ +${amount} XP (${source}) — total ${character.xp} XP, level ${character.level}`);
  return { character, leveledUp, newLevel: character.level };
}

export async function takeDamage(diceNotation, description) {
  const character = await getCharacter();
  const roll = rollDice(diceNotation);

  character.hp = Math.max(0, character.hp - roll.total);

  character.events.push(createEvent('damage', description || `Took ${roll.total} damage (${diceNotation})`, {
    damage: roll.total, diceNotation, diceRolls: roll.rolls
  }));
  await saveCharacter(character);

  console.log(`💥 ${roll.total} damage (${diceNotation}: [${roll.rolls}]+${roll.modifier}) — ${character.hp}/${character.maxHp} HP`);
  return { character, roll, totalDamage: roll.total };
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
  await saveCharacter(character);

  console.log(`🛏️ ${type} rest — recovered ${hpRecovered} HP (${character.hp}/${character.maxHp})`);
  return { character, hpRecovered };
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

  const leveledUp = recalcLevel(character);

  const logEntry = createEvent('custom', event.description, {
    xp: event.xp || 0,
    damage: roll ? roll.total : 0,
    diceNotation: event.diceNotation || null,
    diceRolls: roll ? roll.rolls : []
  });

  character.events.push(logEntry);
  await saveCharacter(character);

  console.log(`📝 Custom event: ${event.description}`);
  return { character, event: logEntry, leveledUp };
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

  const leveledUp = recalcLevel(character);
  await saveCharacter(character);

  console.log(`🎫 Synced ${ticketCount} JIRA tickets for ${totalXP} XP`);
  return { character, ticketCount, totalXP, leveledUp };
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

  const leveledUp = recalcLevel(character);
  await saveCharacter(character);

  console.log(`✅ Synced ${taskCount} tasks for ${totalXP} XP`);
  return { character, taskCount, totalXP, leveledUp };
}
