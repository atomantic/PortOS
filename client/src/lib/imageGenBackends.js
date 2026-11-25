/**
 * Image-gen backend metadata for the UI.
 *
 * Icon metadata, `deriveAvailableBackends`, `isLocalImageConfigured`, and
 * `imageGenReadiness(status)` — a compatibility-safe `ready` / `unavailable` / `unknown`
 * read of image-gen status responses; re-exports everything from `imageGenModes.js` so consumers keep
 * one import site.
 *
 * The pure constants + helpers live in `imageGenModes.js` (a dependency-free leaf the server-side
 * parity suite can import — see its header) and are re-exported here so client consumers keep one
 * import site; this file adds only what needs client packages: the per-mode lucide icons and the
 * settings-driven backend derivation.
 */

import { Cpu, Terminal, Cloud, Sparkles, Zap } from 'lucide-react';
import {
  IMAGE_GEN_MODE, IMAGE_RUNTIME_READINESS, LOCAL_IMAGEGEN_DEFAULT_MODEL, MODE_LABELS, isSelfManagedLocalImageModelId,
} from './imageGenModes.js';

export * from './imageGenModes.js';

const MODE_ICONS = {
  [IMAGE_GEN_MODE.LOCAL]: Cpu,
  [IMAGE_GEN_MODE.CODEX]: Terminal,
  [IMAGE_GEN_MODE.GROK]: Sparkles,
  [IMAGE_GEN_MODE.AGY]: Sparkles,
  [IMAGE_GEN_MODE.FAL]: Zap,
  [IMAGE_GEN_MODE.RUNWAY]: Cloud,
  [IMAGE_GEN_MODE.HIGGSFIELD]: Cloud,
  [IMAGE_GEN_MODE.GOOGLE]: Cloud,
  [IMAGE_GEN_MODE.EXTERNAL]: Cloud,
};

const metaFor = (mode) => ({ label: MODE_LABELS[mode], icon: MODE_ICONS[mode] });

// Older peers and servers only return `connected`; newer local probes add a
// three-way readiness result. Keep the compatibility read in one place so the
// Image Gen page and Settings describe the same response identically.
export const imageGenReadiness = (status) => {
  if (Object.values(IMAGE_RUNTIME_READINESS).includes(status?.readiness)) return status.readiness;
  return status?.connected ? 'ready' : 'unavailable';
};

// Selecting Local without a pin opts into the shipped default. The per-model
// status probe still decides whether the runtime can render.
export function isLocalImageConfigured(local, mode) {
  const modelId = local?.modelId || (mode === IMAGE_GEN_MODE.LOCAL ? LOCAL_IMAGEGEN_DEFAULT_MODEL : null);
  return Boolean((local?.pythonPath || '').trim() || isSelfManagedLocalImageModelId(modelId));
}

export function deriveAvailableBackends(settings, { excludeExternal = false } = {}) {
  const ig = settings?.imageGen || {};
  const out = [];
  if (isLocalImageConfigured(ig.local, ig.mode))
    out.push({ id: IMAGE_GEN_MODE.LOCAL, ...metaFor(IMAGE_GEN_MODE.LOCAL) });
  if (ig.codex?.enabled === true)
    out.push({ id: IMAGE_GEN_MODE.CODEX, ...metaFor(IMAGE_GEN_MODE.CODEX) });
  if (ig.grok?.enabled === true)
    out.push({ id: IMAGE_GEN_MODE.GROK, ...metaFor(IMAGE_GEN_MODE.GROK) });
  if (ig.agy?.enabled === true)
    out.push({ id: IMAGE_GEN_MODE.AGY, ...metaFor(IMAGE_GEN_MODE.AGY) });
  if (ig.runway?.enabled === true)
    out.push({ id: IMAGE_GEN_MODE.RUNWAY, ...metaFor(IMAGE_GEN_MODE.RUNWAY) });
  if (ig.fal?.enabled === true)
    out.push({ id: IMAGE_GEN_MODE.FAL, ...metaFor(IMAGE_GEN_MODE.FAL) });
  if (ig.higgsfield?.enabled === true)
    out.push({ id: IMAGE_GEN_MODE.HIGGSFIELD, ...metaFor(IMAGE_GEN_MODE.HIGGSFIELD) });
  if (ig.google?.enabled === true)
    out.push({ id: IMAGE_GEN_MODE.GOOGLE, ...metaFor(IMAGE_GEN_MODE.GOOGLE) });
  if (!excludeExternal && (ig.external?.sdapiUrl || ig.sdapiUrl || '').trim())
    out.push({ id: IMAGE_GEN_MODE.EXTERNAL, ...metaFor(IMAGE_GEN_MODE.EXTERNAL) });
  return out;
}
