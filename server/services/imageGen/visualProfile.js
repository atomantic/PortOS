import { createHash } from 'node:crypto';
import { normalizeUniverseVisualProfile, visualProfileAdditions } from '../../lib/universeVisualProfile.js';

export const imageVisualProfileRevision = profile => createHash('sha256').update(JSON.stringify(normalizeUniverseVisualProfile(profile))).digest('hex');

/** Snapshot once before enqueue, shared by preview and every image submit. */
export function applyImageVisualProfile(params, input) {
  const profile = normalizeUniverseVisualProfile(input);
  if (!profile) return params;
  const additions = visualProfileAdditions(profile);
  const existing = params.promptAdditions || [];
  const missing = additions.filter(part => !String(params.prompt || '').includes(part.text));
  const avoid = profile.generation.enabled ? profile.generation.avoid : '';
  const negativePrompt = avoid && !String(params.negativePrompt || '').includes(avoid)
    ? [params.negativePrompt, avoid].filter(Boolean).join(', ') : params.negativePrompt;
  return {
    ...params,
    prompt: [params.prompt, ...missing.map(part => `${part.label}: ${part.text}`)].filter(Boolean).join('\n\n'),
    negativePrompt,
    promptAdditions: [...existing, ...additions.filter(part => !existing.some(a => a.id === part.id)),
      ...(avoid && !existing.some(a => a.id === 'universe-photography-avoid') ? [{ id: 'universe-photography-avoid', label: 'Universe photography · Avoid', text: avoid }] : [])],
    visualProfile: profile,
    visualProfileRevision: imageVisualProfileRevision(profile),
  };
}
