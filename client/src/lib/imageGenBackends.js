import { Cpu, Terminal, Cloud } from 'lucide-react';

export const IMAGE_GEN_MODE = { LOCAL: 'local', CODEX: 'codex', EXTERNAL: 'external' };

const META = {
  [IMAGE_GEN_MODE.LOCAL]:    { label: 'Local',    icon: Cpu },
  [IMAGE_GEN_MODE.CODEX]:    { label: 'Codex',    icon: Terminal },
  [IMAGE_GEN_MODE.EXTERNAL]: { label: 'External', icon: Cloud },
};

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
