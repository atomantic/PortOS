/**
 * Digital Twin — Twin Personas (M34 P7)
 *
 * A persona is a named context variant (Professional, Casual, Family, …) whose
 * `instructions` are prepended to the embodied-twin context so the twin
 * modulates voice/behavior per context without forking the underlying
 * documents. One persona can be marked "active" (`meta.settings.activePersonaId`);
 * the CoS agent prompt builder asks for the active persona, while the
 * identity-building paths (enrichment, analysis) stay persona-free.
 *
 * Personas live in `meta.personas`, mirroring how testHistory / enrichment
 * already live in meta.json.
 */

import { generateId, now } from './digital-twin-helpers.js';
import { loadMeta, saveMeta } from './digital-twin-meta.js';

export async function getPersonas() {
  const meta = await loadMeta();
  return Array.isArray(meta.personas) ? meta.personas : [];
}

export async function getPersonaById(id) {
  const personas = await getPersonas();
  return personas.find(p => p.id === id) || null;
}

export async function createPersona({ name, description, instructions, traitAdjustments }) {
  const meta = await loadMeta();
  if (!Array.isArray(meta.personas)) meta.personas = [];

  const timestamp = now();
  const persona = {
    id: generateId(),
    name,
    ...(description ? { description } : {}),
    instructions,
    ...(traitAdjustments ? { traitAdjustments } : {}),
    createdAt: timestamp,
    updatedAt: timestamp
  };

  meta.personas.push(persona);
  await saveMeta(meta);
  console.log(`🎭 Created persona: ${name}`);
  return persona;
}

export async function updatePersona(id, updates) {
  const meta = await loadMeta();
  const persona = (meta.personas || []).find(p => p.id === id);
  if (!persona) {
    throw new Error(`Persona ${id} not found`);
  }

  // Only apply keys that were actually provided so an omitted field preserves
  // the original (and description: '' can intentionally clear it).
  if (updates.name !== undefined) persona.name = updates.name;
  if (updates.description !== undefined) persona.description = updates.description;
  if (updates.instructions !== undefined) persona.instructions = updates.instructions;
  // traitAdjustments: absent (undefined) preserves the original; an explicit
  // null clears it back to an instructions-only persona; an object replaces it.
  if (updates.traitAdjustments !== undefined) {
    if (updates.traitAdjustments === null) {
      delete persona.traitAdjustments;
    } else {
      persona.traitAdjustments = updates.traitAdjustments;
    }
  }
  persona.updatedAt = now();

  await saveMeta(meta);
  return persona;
}

export async function deletePersona(id) {
  const meta = await loadMeta();
  const before = (meta.personas || []).length;
  meta.personas = (meta.personas || []).filter(p => p.id !== id);

  // Clearing the active persona when it's the one being deleted keeps the
  // settings pointer from dangling at a non-existent id.
  if (meta.settings?.activePersonaId === id) {
    meta.settings.activePersonaId = null;
  }

  await saveMeta(meta);
  return { deleted: before !== meta.personas.length };
}

/**
 * Set (or clear, with personaId === null) the active persona. Validates the id
 * exists so the settings pointer can't dangle.
 */
export async function setActivePersona(personaId) {
  const meta = await loadMeta();
  if (personaId !== null && !(meta.personas || []).some(p => p.id === personaId)) {
    throw new Error(`Persona ${personaId} not found`);
  }
  if (!meta.settings) meta.settings = {};
  meta.settings.activePersonaId = personaId;
  await saveMeta(meta);
  return meta.settings;
}

export async function getActivePersona() {
  const meta = await loadMeta();
  const id = meta.settings?.activePersonaId;
  if (!id) return null;
  return (meta.personas || []).find(p => p.id === id) || null;
}
