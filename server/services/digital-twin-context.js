import { readFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { DIGITAL_TWIN_DIR } from './digital-twin-helpers.js';
import { loadMeta } from './digital-twin-meta.js';
import { renderTraitBlendDirective } from '../lib/personaTraitBlend.js';
import { getPrivacyTwinContext } from './privacyTwinContext.js';

// Twin document markdown is re-read on every agent prompt build
// (getDigitalTwinForPrompt runs per prompt, per twin test). These files rarely
// change, so cache their contents keyed by path + mtime and only re-read when
// the file actually changes on disk. A cheap fs.stat gates the expensive read.
const docContentCache = new Map();

async function readTwinDoc(filePath) {
  const { mtimeMs } = await stat(filePath);
  const cached = docContentCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.content;
  const content = await readFile(filePath, 'utf-8');
  docContentCache.set(filePath, { mtimeMs, content });
  return content;
}

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

/**
 * Build the persona preamble. Beyond the free-text instructions, a persona may
 * carry `traitAdjustments` that blend against the base twin's quantitative
 * `traits` (communicationProfile + bigFive) into a Communication Calibration
 * directive (P7 trait-blending). `baseTraits` is the un-flavored twin profile;
 * the directive renders relative to it, falling back to directional intent when
 * a baseline value is missing.
 */
function buildPersonaPreamble(persona, baseTraits) {
  if (!persona?.instructions) return '';
  const desc = persona.description ? `${persona.description}\n` : '';
  const calibration = renderTraitBlendDirective(baseTraits, persona.traitAdjustments, persona.name);
  const calibrationBlock = calibration ? `\n\n${calibration}` : '';
  return `# Active Persona: ${persona.name}\n${desc}\n${persona.instructions}${calibrationBlock}\n\n---\n\n`;
}

export async function getDigitalTwinForPrompt(options = {}) {
  const { maxTokens = 4000, personaId } = options;
  const meta = await loadMeta();

  if (!meta.settings.autoInjectToCoS) {
    return '';
  }

  // A persona's instructions are always included (they're the active directive)
  // and prepended before the documents, counting toward the token budget. When
  // the persona carries trait adjustments, they blend against the base twin's
  // quantitative traits into a Communication Calibration directive.
  const preamble = buildPersonaPreamble(resolvePersona(meta, personaId), meta.traits);

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

  // Privacy Vault identity dossier — opt-in TWICE: the GLOBAL gate here
  // (includePrivacyContext, default false) plus the per-field share_with_twin
  // gate inside getPrivacyTwinContext. Injected before documents as an
  // authoritative identity block, counting toward the same token budget. Never
  // cached to disk — decrypted at injection time only. Failures degrade to no
  // block rather than failing the whole prompt (this also runs outside the
  // request lifecycle for CoS agent spawns).
  if (meta.settings?.includePrivacyContext === true) {
    const privacyBlock = await getPrivacyTwinContext()
      .catch(err => { console.log(`⚠️ Privacy twin context retrieval failed: ${err.message}`); return ''; });
    if (privacyBlock && tokenCount + privacyBlock.length + 8 <= maxChars) {
      output += `${privacyBlock}\n\n---\n\n`;
      tokenCount += privacyBlock.length + 8;
    }
  }

  for (const doc of docs) {
    const filePath = join(DIGITAL_TWIN_DIR, doc.filename);
    if (!existsSync(filePath)) continue;

    const content = await readTwinDoc(filePath);

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
