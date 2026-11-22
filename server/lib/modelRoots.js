/**
 * The one declaration of every directory PortOS keeps (or has kept) model weights in, with its kind and owning runtime.
 *
 * Weights belong in the shared Hugging Face hub cache (`hf-hub`), where the Models
 * panel can size, label and delete them. Every other root exists because a runtime
 * owns its own layout (`local-dir`), because it holds artifacts converted from hub
 * weights (`derived-cache`), or because the runtime that wrote it has been retired
 * (`legacy-runtime`). Declaring them here — instead of as a `join(homedir(), …)`
 * at each use site — is what lets the inventory scan every root and what stops a new
 * runtime from quietly growing a second store the app cannot see.
 *
 * Paths resolve lazily (env overrides and `HOME` are read at call time) and this
 * module never touches the disk; scanning and deleting live in
 * `services/modelStoreStorage.js`. A root's `backend` is its inventory backend id
 * (`lib/modelInventory.js`), or null when another module already inventories it.
 */

import { homedir } from 'os';
import { join } from 'path';
import { getHfCacheRoot } from './hfCache.js';
import { PATHS } from './paths.js';
import { slotstreamCacheDir } from './slotstreamModels.js';

export const MODEL_ROOT_KINDS = Object.freeze({
  'hf-hub': 'The shared Hugging Face hub cache: the one place downloaded weights belong.',
  'local-dir': 'A runtime-owned or hand-placed weights directory outside the hub cache.',
  'derived-cache': 'Regenerable artifacts converted from hub weights.',
  'legacy-runtime': 'Leftovers of a retired runtime that nothing in PortOS reads.',
});

const portosHome = () => join(homedir(), '.portos');

// `managed` marks a layout PortOS (or the runtime it supervises) writes itself; a
// root with `managed: false` collects whatever a person downloaded by hand, so any
// large weight file in it is reported as unmanaged. The order is the display order.
const ROOT_DEFINITIONS = [
  { id: 'hf-hub', kind: 'hf-hub', backend: 'huggingface', owner: 'Hugging Face / PortOS media installers', managed: true, path: () => getHfCacheRoot() },
  { id: 'mtplx', kind: 'local-dir', backend: 'mtplx', owner: 'MTPLX', managed: true, path: () => process.env.MTPLX_HOME || join(homedir(), '.mtplx') },
  { id: 'hy3dgen', kind: 'local-dir', backend: 'hy3dgen', owner: 'Hunyuan3D image-to-3D', managed: true, path: () => process.env.HY3DGEN_MODELS || join(homedir(), '.cache', 'hy3dgen') },
  {
    id: 'hf-xet-cache', kind: 'derived-cache', backend: 'hf-xet-cache', owner: 'huggingface_hub (xet)', managed: true,
    path: () => {
      if (process.env.HF_XET_CACHE) return process.env.HF_XET_CACHE;
      const hfHome = process.env.HF_HOME
        || join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'huggingface');
      return join(hfHome, 'xet');
    },
  },
  { id: 'pixie-forge', kind: 'local-dir', backend: 'pixie-forge', owner: 'Pixie Forge', managed: true, path: () => process.env.PIXIE_FORGE_HOME || join(homedir(), '.pixie-forge') },
  { id: 'slotstream', kind: 'local-dir', backend: 'slotstream', owner: 'Slotstream', managed: true, path: () => slotstreamCacheDir() },
  { id: 'fastvideo-mlx', kind: 'derived-cache', backend: 'fastvideo-mlx', owner: 'FastVideo MLX runtime', managed: true, path: () => join(portosHome(), 'fastvideo', 'mlx-checkpoints') },
  { id: 'auk-ckpts', kind: 'local-dir', backend: 'auk-ckpts', owner: 'AuK voice runtime', managed: true, path: () => join(portosHome(), 'auk', 'ckpts') },
  // Hand-placed weights: `hf download --local-dir`, `curl -o`, and the cwd-relative
  // `models/` paths the llama-server presets use. Nothing manages these layouts.
  { id: 'portos-models', kind: 'local-dir', backend: 'portos-models', owner: 'Manual installs', managed: false, path: () => process.env.PORTOS_MODELS_HOME || join(portosHome(), 'models') },
  { id: 'repo-models', kind: 'local-dir', backend: 'repo-models', owner: 'llama-server presets and manual downloads', managed: false, path: () => process.env.PORTOS_REPO_MODELS_DIR || join(PATHS.root, 'models') },
  { id: 'legacy-hunyuan', kind: 'legacy-runtime', backend: 'legacy-runtime', owner: 'Retired HunyuanVideo MLX runtime', managed: true, path: () => join(portosHome(), 'hunyuan-video-mlx') },
];

/** Every declared root with its path resolved now. */
export const resolveModelRoots = () => ROOT_DEFINITIONS.map(({ path, ...root }) => ({ ...root, path: path() }));

/** The resolved directory of one declared root; throws on an id nobody declared. */
export function modelRootPath(id) {
  const root = ROOT_DEFINITIONS.find((entry) => entry.id === id);
  if (!root) throw new Error(`Unknown model root: ${id}`);
  return root.path();
}

/** The roots whose weights the file-system store scanner inventories (everything but the hub cache). */
export const storeModelRootIds = () => ROOT_DEFINITIONS.filter((root) => root.backend && root.id !== 'hf-hub').map((root) => root.id);

/** The declared root for an inventory backend id, or null. */
export const modelRootForBackend = (backend) => {
  const root = ROOT_DEFINITIONS.find((entry) => entry.backend === backend);
  return root ? { ...root, path: root.path() } : null;
};
