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

const decorated = (entry) => applyMiniMaxH3MemoryProfiles([entry])[0];

describe('applyMiniMaxH3MemoryProfiles', () => {
  it('attaches the shipped table to a pinned entry without mutating it', () => {
    const entry = mlxEntry();
    const next = decorated(entry);
    expect(next).not.toBe(entry);
    expect(entry).not.toHaveProperty('memoryProfiles');
    expect(next.memoryProfiles).toEqual([...MLX_SPEC.profiles]);
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
  it('picks the richest CUDA profile the usable host memory can hold', () => {
    const model = decorated(cudaEntry());
    const { profile, usableMemoryGb } = selectMiniMaxH3MemoryProfile({
      model,
      totalMemoryGb: 96 + MINIMAX_H3_HOST_RESERVE_GB,
    });
    expect(profile.id).toBe('bf16');
    expect(usableMemoryGb).toBe(96);
  });

  it('subtracts the reserve, so a box sitting exactly on the headline floor does NOT fit', () => {
    // The whole point of the reserve: 128 GB nameplate against a 128 GB floor
    // used to read as a fit while a render would have claimed the whole machine.
    const model = decorated(mlxEntry());
    expect(selectMiniMaxH3MemoryProfile({ model, totalMemoryGb: 128 }).profile).toBeNull();
    expect(
      selectMiniMaxH3MemoryProfile({ model, totalMemoryGb: 128 + MINIMAX_H3_HOST_RESERVE_GB }).profile.id,
    ).toBe('unified-8bit');
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
    expect(reason.message).toContain(`${MINIMAX_H3_HOST_RESERVE_GB} GB reserve`);
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
    expect(validateMiniMaxH3MemoryProfileTable(applyMiniMaxH3MemoryProfiles([mlxEntry(), cudaEntry()]))).toEqual([]);
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

// The CUDA runner re-selects a recipe from the device's VRAM, which the server
// cannot see. That only stays honest while its floors agree with the ones this
// module declares and the UI renders — hand-synced across a language boundary,
// the same shape MINIMAX_H3_CUDA_OFFLOAD_PROFILES already has.
describe('CUDA VRAM floors', () => {
  it('match PROFILE_MIN_VRAM_GB in the Python runner', () => {
    const runner = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'generate_minimax_h3_cuda.py'),
      'utf8',
    );
    const declared = runner.match(/^PROFILE_MIN_VRAM_GB = \((.*)\)$/m);
    expect(declared).not.toBeNull();
    const fromPython = [...declared[1].matchAll(/\("([^"]+)",\s*(\d+)\)/g)]
      .map(([, id, floor]) => ({ id, minVramGb: Number(floor) }));
    expect(fromPython).toEqual(CUDA_SPEC.profiles.map(({ id, minVramGb }) => ({ id, minVramGb })));
  });
});
