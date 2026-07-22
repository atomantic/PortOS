import { Cpu, Terminal, Cloud } from 'lucide-react';

export const IMAGE_GEN_MODE = Object.freeze({ LOCAL: 'local', CODEX: 'codex', EXTERNAL: 'external' });

// Shipped default Codex reasoning-effort level — the client mirror of the
// server's CODEX_IMAGEGEN_DEFAULT_EFFORT (server/services/imageGen/modes.js).
// A Codex job with no explicit effort renders at this level, so any UI that
// displays or pre-fills "the effort a job used" must resolve an absent value to
// this default rather than showing a blank.
export const CODEX_IMAGEGEN_DEFAULT_EFFORT = 'low';

const META = {
  [IMAGE_GEN_MODE.LOCAL]:    { label: 'Local',    icon: Cpu },
  [IMAGE_GEN_MODE.CODEX]:    { label: 'Codex',    icon: Terminal },
  [IMAGE_GEN_MODE.EXTERNAL]: { label: 'External', icon: Cloud },
};

// Backends that support image-to-image (init image / reference editing). The
// external SD-API path does not. Single source of truth for i2i gating in the UI.
export const I2I_CAPABLE_MODES = Object.freeze([IMAGE_GEN_MODE.LOCAL, IMAGE_GEN_MODE.CODEX]);

// True when a mode can run image-to-image.
export const isI2iCapableMode = (mode) => I2I_CAPABLE_MODES.includes(mode);

// Pick the best available i2i backend from a list of `{ id }` backends,
// preferring local (its form exposes strength + LoRAs), else codex. Returns
// null when neither is installed.
export function pickI2iMode(backends) {
  for (const mode of I2I_CAPABLE_MODES) {
    if (backends.some((b) => b.id === mode)) return mode;
  }
  return null;
}

export function deriveAvailableBackends(settings, { excludeExternal = false } = {}) {
  const ig = settings?.imageGen || {};
  const out = [];
  if ((ig.local?.pythonPath || '').trim())
    out.push({ id: IMAGE_GEN_MODE.LOCAL, ...META[IMAGE_GEN_MODE.LOCAL] });
  if (ig.codex?.enabled === true)
    out.push({ id: IMAGE_GEN_MODE.CODEX, ...META[IMAGE_GEN_MODE.CODEX] });
  if (!excludeExternal && (ig.external?.sdapiUrl || ig.sdapiUrl || '').trim())
    out.push({ id: IMAGE_GEN_MODE.EXTERNAL, ...META[IMAGE_GEN_MODE.EXTERNAL] });
  return out;
}
