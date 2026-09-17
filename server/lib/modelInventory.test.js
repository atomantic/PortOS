/**
 * The id scheme's real input matrix.
 *
 * Both halves of it carry a separator that also appears inside the payload: an
 * Ollama tag is `qwen3:8b` and an LM Studio id is `org/repo`, so a greedy split
 * or a blind `replace` truncates the very identifier the delete action needs.
 * The round trip is the contract — a manifest entry that cannot be parsed back
 * into `{ backend, key }` is an inventory row nothing can act on.
 */
import { describe, expect, it } from 'vitest';
import {
  hfInventoryRow,
  localModelInventoryRow,
  loraInventoryRow,
  modelInventoryId,
  parseModelInventoryId,
  presentInventoryRow,
} from './modelInventory.js';

describe('modelInventoryId round trip', () => {
  it.each([
    ['huggingface', 'models--black-forest-labs--FLUX.1-dev', 'hf:models--black-forest-labs--FLUX.1-dev'],
    ['lora', 'lora-example-v1.safetensors', 'lora:lora-example-v1.safetensors'],
    // The two that a naive split gets wrong.
    ['ollama', 'qwen3:8b', 'ollama:qwen3:8b'],
    ['lmstudio', 'org/example-model-GGUF@Q4_K_M', 'lmstudio:org/example-model-GGUF@Q4_K_M'],
  ])('%s/%s survives both directions', (backend, key, id) => {
    expect(modelInventoryId(backend, key)).toBe(id);
    expect(parseModelInventoryId(id)).toEqual({ backend, key });
  });

  it('refuses an id it cannot mint or read rather than inventing one', () => {
    expect(modelInventoryId('unknown', 'x')).toBeNull();
    expect(modelInventoryId('ollama', '   ')).toBeNull();
    expect(modelInventoryId('ollama', undefined)).toBeNull();
    expect(parseModelInventoryId('no-separator')).toBeNull();
    expect(parseModelInventoryId(':leading')).toBeNull();
    expect(parseModelInventoryId('ollama:')).toBeNull();
    expect(parseModelInventoryId('unknownprefix:key')).toBeNull();
  });
});

describe('row builders', () => {
  // The scan and the install chokepoints both call these. The fields asserted here
  // are the ones a drifted second copy would get wrong in a way the user feels: a
  // delete action pointed at the wrong identifier, or a destructive row that lost
  // the warning that makes it destructive.
  it('gives a LoRA the high-risk treatment and a delete keyed by filename', () => {
    const row = loraInventoryRow({ filename: 'lora-example-v1.safetensors', name: 'Example', sizeBytes: 512 });
    expect(row).toMatchObject({
      id: 'lora:lora-example-v1.safetensors',
      backend: 'lora',
      risk: 'high',
      managePath: '/models/loras',
      action: { type: 'lora', filename: 'lora-example-v1.safetensors' },
    });
  });

  it('keys a Hugging Face row by its CACHE DIRECTORY, which is what the delete route takes', () => {
    const row = hfInventoryRow({ dirName: 'models--org--repo', name: 'org/repo', sizeBytes: 700 });
    expect(row).toMatchObject({
      id: 'hf:models--org--repo',
      action: { type: 'hf-model', dirName: 'models--org--repo' },
      sizeIsEstimate: false,
    });
  });

  it('marks Ollama sizes as estimates and warns only where a delete takes more than asked', () => {
    // Ollama tags share layers, so the per-tag size is an upper bound.
    expect(localModelInventoryRow({ backend: 'ollama', modelId: 'qwen3:8b' })).toMatchObject({
      id: 'ollama:qwen3:8b',
      sizeIsEstimate: true,
      cleanupReason: null,
      action: { type: 'local-model', backend: 'ollama', modelId: 'qwen3:8b' },
    });
    // Deleting an LM Studio entry removes every quantization in the folder.
    expect(localModelInventoryRow({ backend: 'lmstudio', modelId: 'org/repo' })).toMatchObject({
      sizeIsEstimate: false,
      cleanupReason: expect.stringContaining('whole LM Studio model folder'),
    });
  });

  it('offers no delete action for a backend that is not available to perform one', () => {
    expect(localModelInventoryRow({ backend: 'ollama', modelId: 'qwen3:8b', deletable: false }).action).toBeNull();
  });
});

describe('presentInventoryRow', () => {
  // Residency is the fact a STORED row can never carry. Deriving it on read is what
  // keeps a one-click delete off a local model nobody has verified is unloaded.
  it('presents a local model as residency-unknown and a file-backed one as known', () => {
    expect(presentInventoryRow({ id: 'ollama:qwen3:8b', backend: 'ollama' }))
      .toMatchObject({ loaded: false, residencyUnknown: true, inventoryUnknown: false });
    expect(presentInventoryRow({ id: 'lmstudio:org/repo', backend: 'lmstudio' }).residencyUnknown).toBe(true);
    expect(presentInventoryRow({ id: 'hf:models--org--repo', backend: 'huggingface' }).residencyUnknown).toBe(false);
    expect(presentInventoryRow({ id: 'lora:a.safetensors', backend: 'lora' }).residencyUnknown).toBe(false);
  });

  it('never lets a stored value override a live one', () => {
    const stale = { id: 'ollama:qwen3:8b', backend: 'ollama', loaded: true, residencyUnknown: false };
    expect(presentInventoryRow(stale)).toMatchObject({ loaded: false, residencyUnknown: true });
  });
});
