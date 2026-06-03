import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { DIGITAL_TWIN_DIR } from './digital-twin-helpers.js';
import { loadMeta } from './digital-twin-meta.js';

/**
 * Resolve the persona to apply for this prompt. `personaId` may be a specific
 * id, the string 'active' (resolve from settings.activePersonaId), or
 * undefined/null (no persona). Returns the persona record or null — callers
 * that build the *base* twin (enrichment, trait analysis) pass nothing and get
 * the un-flavored context; embody paths (CoS agents) pass 'active'.
 */
function resolvePersona(meta, personaId) {
  if (personaId === undefined || personaId === null) return null;
  const id = personaId === 'active' ? meta.settings?.activePersonaId : personaId;
  if (!id) return null;
  const personas = Array.isArray(meta.personas) ? meta.personas : [];
  return personas.find(p => p.id === id) || null;
}

function buildPersonaPreamble(persona) {
  if (!persona?.instructions) return '';
  const desc = persona.description ? `${persona.description}\n` : '';
  return `# Active Persona: ${persona.name}\n${desc}\n${persona.instructions}\n\n---\n\n`;
}

export async function getDigitalTwinForPrompt(options = {}) {
  const { maxTokens = 4000, personaId } = options;
  const meta = await loadMeta();

  if (!meta.settings.autoInjectToCoS) {
    return '';
  }

  // A persona's instructions are always included (they're the active directive)
  // and prepended before the documents, counting toward the token budget.
  const preamble = buildPersonaPreamble(resolvePersona(meta, personaId));

  // Get enabled documents sorted by weight (desc) then priority (asc)
  // Higher weight = more important = included first
  const docs = meta.documents
    .filter(d => d.enabled && d.category !== 'behavioral')
    .sort((a, b) => {
      const weightA = a.weight || 5;
      const weightB = b.weight || 5;
      if (weightB !== weightA) return weightB - weightA; // Higher weight first
      return a.priority - b.priority; // Then by priority
    });

  let output = preamble;
  let tokenCount = preamble.length;
  const maxChars = maxTokens * 4; // Rough char-to-token estimate

  for (const doc of docs) {
    const filePath = join(DIGITAL_TWIN_DIR, doc.filename);
    if (!existsSync(filePath)) continue;

    const content = await readFile(filePath, 'utf-8');

    if (tokenCount + content.length > maxChars) {
      // Truncate if we're over budget
      const remaining = maxChars - tokenCount;
      if (remaining > 500) {
        output += content.substring(0, remaining) + '\n\n[Truncated due to token limit]\n';
      }
      break;
    }

    output += content + '\n\n---\n\n';
    tokenCount += content.length;
  }

  return output.trim();
}

export const getSoulForPrompt = getDigitalTwinForPrompt; // Alias for backwards compatibility
