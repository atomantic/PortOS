import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  MINIMAX_H3_HOST_RESERVE_GB,
  MINIMAX_H3_MEMORY_PROFILES,
  applyMiniMaxH3MemoryProfiles,
  miniMaxH3MemoryDeclineReason,
  sanitizeMiniMaxH3MemoryProfiles,
  selectMiniMaxH3MemoryProfile,
  validateMiniMaxH3MemoryProfileTable,
} from './minimaxH3Memory.js';

const MLX_SPEC = MINIMAX_H3_MEMORY_PROFILES.minimax_h3_8bit;
const REF2VA_SPEC = MINIMAX_H3_MEMORY_PROFILES.minimax_h3_ref2va_8bit;
const CUDA_SPEC = MINIMAX_H3_MEMORY_PROFILES.minimax_h3_cuda;

const mlxEntry = (overrides = {}) => ({
  id: 'minimax_h3_8bit',
  repo: MLX_SPEC.shippedRepo,
  revision: MLX_SPEC.shippedRevision,
  ...overrides,
});

const cudaEntry = (overrides = {}) => ({
  id: 'minimax_h3_cuda',
  repo: CUDA_SPEC.shippedRepo,
  revision: CUDA_SPEC.shippedRevision,
  ...overrides,
});

const ref2vaEntry = (overrides = {}) => ({
  id: 'minimax_h3_ref2va_8bit',
  repo: REF2VA_SPEC.shippedRepo,
  revision: REF2VA_SPEC.shippedRevision,
  ...overrides,
});

const decorated = (entry) => applyMiniMaxH3MemoryProfiles([entry])[0];

describe('applyMiniMaxH3MemoryProfiles', () => {
  it('attaches the shipped table to a pinned entry without mutating it', () => {
    const entry = mlxEntry();
    const next = decorated(entry);
    expect(next).not.toBe(entry);
    expect(entry).not.toHaveProperty('memoryProfiles');
    expect(next.memoryProfiles).toEqual([...MLX_SPEC.profiles]);
  });

  it('attaches the Ref2VA profile only to its pinned weights', () => {
    expect(decorated(ref2vaEntry()).memoryProfiles).toEqual([...REF2VA_SPEC.profiles]);
    expect(decorated(ref2vaEntry({ revision: 'deadbeef' }))).not.toHaveProperty('memoryProfiles');
  });

  it('leaves an explicit user value alone, including a deliberate empty list', () => {
    expect(decorated(mlxEntry({ memoryProfiles: [] })).memoryProfiles).toEqual([]);
    expect(decorated(mlxEntry({ memoryProfiles: null })).memoryProfiles).toBeNull();
  });

  it('skips an entry re-pointed off the pinned weights', () => {
    // A placement recipe is validated against ONE set of weights, so a fork or a
    // moved revision must not inherit a capacity claim we cannot back.
    expect(decorated(mlxEntry({ repo: 'someone/h3-fork' }))).not.toHaveProperty('memoryProfiles');
    expect(decorated(mlxEntry({ revision: 'deadbeef' }))).not.toHaveProperty('memoryProfiles');
  });

  it('leaves a custom model untouched', () => {
    expect(decorated({ id: 'user-model', repo: 'example/custom' })).not.toHaveProperty('memoryProfiles');
  });
});

describe('selectMiniMaxH3MemoryProfile', () => {
  it('picks the richest CUDA profile this host can hold, and reports the allocator budget', () => {
    const model = decorated(cudaEntry());
    const { profile, usableMemoryGb } = selectMiniMaxH3MemoryProfile({ model, totalMemoryGb: 96 });
    expect(profile.id).toBe('bf16');
    expect(usableMemoryGb).toBe(96 - MINIMAX_H3_HOST_RESERVE_GB);
  });

  it('gates on TOTAL memory, so the machine the entry was written for still qualifies', () => {
    // The floors were hoisted from `memoryGb`, which has always been a total-RAM
    // claim. Netting the reserve off before the comparison would silently move
    // the 128 GB model onto a 144 GB box and 400 every render on a 128 GB Mac.
    const model = decorated(mlxEntry());
    expect(selectMiniMaxH3MemoryProfile({ model, totalMemoryGb: 128 }).profile.id).toBe('unified-8bit');
    expect(selectMiniMaxH3MemoryProfile({ model, totalMemoryGb: 127 }).profile).toBeNull();
  });

  it('enforces the shipped Ref2VA 128 GB floor', () => {
    const model = decorated(ref2vaEntry());
    expect(selectMiniMaxH3MemoryProfile({ model, totalMemoryGb: 128 }).profile.id).toBe('unified-8bit');
    expect(selectMiniMaxH3MemoryProfile({ model, totalMemoryGb: 96 }).profile).toBeNull();
  });

  it('defers to the runner when the host was not measured', () => {
    // "Probe returned nothing" is not "this box has no memory" — an unmeasured
    // host gets the best profile unjudged rather than a refusal.
    const model = decorated(cudaEntry());
    const result = selectMiniMaxH3MemoryProfile({ model, totalMemoryGb: null });
    expect(result.usableMemoryGb).toBeNull();
    expect(result.profile.id).toBe('bf16');
  });
});

describe('miniMaxH3MemoryDeclineReason', () => {
  it('refuses a measured box below every declared floor, naming what it would take', () => {
    const reason = miniMaxH3MemoryDeclineReason({
      model: decorated(mlxEntry({ name: 'MiniMax H3 MLX 8-bit' })),
      totalMemoryGb: 64,
    });
    expect(reason.code).toBe('MINIMAX_H3_MEMORY_INSUFFICIENT');
    expect(reason.message).toContain('128 GB');
    expect(reason.message).toContain('64 GB');
  });

  it('refuses Ref2VA before spawn when the measured host is below its floor', () => {
    const reason = miniMaxH3MemoryDeclineReason({
      model: decorated(ref2vaEntry({ name: 'MiniMax H3 Ref2VA MLX 8-bit' })),
      totalMemoryGb: 96,
    });
    expect(reason).toMatchObject({ code: 'MINIMAX_H3_MEMORY_INSUFFICIENT' });
    expect(reason.message).toContain('128 GB');
  });

  it('stays null for a box that fits, an unmeasured host, and a model with no table', () => {
    const model = decorated(cudaEntry());
    expect(miniMaxH3MemoryDeclineReason({ model, totalMemoryGb: 256 })).toBeNull();
    expect(miniMaxH3MemoryDeclineReason({ model, totalMemoryGb: null })).toBeNull();
    expect(miniMaxH3MemoryDeclineReason({ model: { id: 'ltx_video' }, totalMemoryGb: 8 })).toBeNull();
  });
});

describe('validateMiniMaxH3MemoryProfileTable / sanitize', () => {
  const problemFor = (memoryProfiles) => validateMiniMaxH3MemoryProfileTable([{ id: 'x', memoryProfiles }])[0];

  it('accepts the shipped table and absent/null keys', () => {
    expect(validateMiniMaxH3MemoryProfileTable(
      applyMiniMaxH3MemoryProfiles([mlxEntry(), ref2vaEntry(), cudaEntry()]),
    )).toEqual([]);
    expect(validateMiniMaxH3MemoryProfileTable([{ id: 'x' }, { id: 'y', memoryProfiles: null }])).toEqual([]);
  });

  it('rejects a NaN floor, which would otherwise refuse every render silently', () => {
    expect(problemFor([{ id: 'a', minMemoryGb: 'lots' }]).reason).toMatch(/minMemoryGb/);
  });

  it('rejects a duplicate id, the reserved auto id, and a mis-ordered table', () => {
    expect(problemFor([{ id: 'a', minMemoryGb: 96 }, { id: 'a', minMemoryGb: 96 }]).reason).toMatch(/duplicate/);
    expect(problemFor([{ id: 'auto', minMemoryGb: 96 }]).reason).toMatch(/reserved/);
    // Selection takes the FIRST profile that fits, so a table ordered
    // lean-first would hand a large box the smallest recipe.
    expect(problemFor([{ id: 'a', minMemoryGb: 24 }, { id: 'b', minMemoryGb: 96 }]).reason).toMatch(/best-first/);
  });

  it('strips a bad table at load rather than crashing boot', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const list = sanitizeMiniMaxH3MemoryProfiles([
      { id: 'bad', memoryProfiles: [{ id: 'a', minMemoryGb: 0 }] },
      { id: 'good', memoryProfiles: [{ id: 'a', minMemoryGb: 96 }] },
    ]);
    expect(list[0]).not.toHaveProperty('memoryProfiles');
    expect(list[1].memoryProfiles).toHaveLength(1);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});

const repoFile = (...parts) => readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', ...parts),
  'utf8',
);

// Two constants are hand-synced out of this module — one across a language
// boundary, one across the client boundary. Both are read as TEXT rather than
// imported: the Python one cannot be imported at all, and importing the client
// module into a server suite drags client-only deps into CI (they are separate
// workspaces). This is the same shape MINIMAX_H3_CUDA_OFFLOAD_PROFILES already
// has in runtimes.test.js.
describe('hand-synced mirrors', () => {
  it('CUDA VRAM floors match PROFILE_MIN_VRAM_GB in the Python runner', () => {
    // The runner re-selects a recipe from the device's VRAM, which the server
    // cannot see; that only stays honest while the two tables agree.
    const declared = repoFile('scripts', 'generate_minimax_h3_cuda.py')
      .match(/^PROFILE_MIN_VRAM_GB = \((.*)\)$/m);
    expect(declared).not.toBeNull();
    const fromPython = [...declared[1].matchAll(/\("([^"]+)",\s*(\d+)\)/g)]
      .map(([, id, floor]) => ({ id, minVramGb: Number(floor) }));
    expect(fromPython).toEqual(CUDA_SPEC.profiles.map(({ id, minVramGb }) => ({ id, minVramGb })));
  });

  it('the host reserve matches VIDEO_MEMORY_RESERVE_GB in the client', () => {
    // The client states how much of the box a render may claim. A drift here
    // would have the disclosure promise a budget the runner never applies.
    const declared = repoFile('client', 'src', 'lib', 'videoGenParams.js')
      .match(/^export const VIDEO_MEMORY_RESERVE_GB = (\d+);$/m);
    expect(declared).not.toBeNull();
    expect(Number(declared[1])).toBe(MINIMAX_H3_HOST_RESERVE_GB);
  });
});
