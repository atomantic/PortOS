import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { DIGITAL_TWIN_DIR } from './digital-twin-helpers.js';
import { loadMeta } from './digital-twin-meta.js';

export async function getDigitalTwinForPrompt(options = {}) {
  const { maxTokens = 4000 } = options;
  const meta = await loadMeta();

  if (!meta.settings.autoInjectToCoS) {
    return '';
  }

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

  let output = '';
  let tokenCount = 0;
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
