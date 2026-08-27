/**
 * Image-gen backend metadata for the UI. The pure constants + helpers live in
 * `imageGenModes.js` (a dependency-free leaf the server-side parity suite can
 * import — see its header) and are re-exported here so client consumers keep
 * one import site; this file adds only what needs client packages: the
 * per-mode lucide icons and the settings-driven backend derivation.
 */

import { Cpu, Terminal, Cloud, Sparkles } from 'lucide-react';
import { IMAGE_GEN_MODE, MODE_LABELS } from './imageGenModes.js';

export * from './imageGenModes.js';

const MODE_ICONS = {
  [IMAGE_GEN_MODE.LOCAL]: Cpu,
  [IMAGE_GEN_MODE.CODEX]: Terminal,
  [IMAGE_GEN_MODE.GROK]: Sparkles,
  [IMAGE_GEN_MODE.AGY]: Sparkles,
  [IMAGE_GEN_MODE.EXTERNAL]: Cloud,
};

const metaFor = (mode) => ({ label: MODE_LABELS[mode], icon: MODE_ICONS[mode] });

// Older peers and servers only return `connected`; newer local probes add a
// three-way readiness result. Keep the compatibility read in one place so the
// Image Gen page and Settings describe the same response identically.
export const imageGenReadiness = (status) => {
  if (['ready', 'unavailable', 'unknown'].includes(status?.readiness)) return status.readiness;
  return status?.connected ? 'ready' : 'unavailable';
};

export function deriveAvailableBackends(settings, { excludeExternal = false } = {}) {
  const ig = settings?.imageGen || {};
  const out = [];
  if ((ig.local?.pythonPath || '').trim())
    out.push({ id: IMAGE_GEN_MODE.LOCAL, ...metaFor(IMAGE_GEN_MODE.LOCAL) });
  if (ig.codex?.enabled === true)
    out.push({ id: IMAGE_GEN_MODE.CODEX, ...metaFor(IMAGE_GEN_MODE.CODEX) });
  if (ig.grok?.enabled === true)
    out.push({ id: IMAGE_GEN_MODE.GROK, ...metaFor(IMAGE_GEN_MODE.GROK) });
  if (ig.agy?.enabled === true)
    out.push({ id: IMAGE_GEN_MODE.AGY, ...metaFor(IMAGE_GEN_MODE.AGY) });
  if (!excludeExternal && (ig.external?.sdapiUrl || ig.sdapiUrl || '').trim())
    out.push({ id: IMAGE_GEN_MODE.EXTERNAL, ...metaFor(IMAGE_GEN_MODE.EXTERNAL) });
  return out;
}
