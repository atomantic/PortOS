import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

import {
  SGLANG_QWEN_IMAGE,
  buildSglangQwenRecipe,
  mambaFullMemoryRatio,
  sglangCellForGpu,
  sglangComposeYaml,
  sglangHardwareCell,
  sglangUnsupportedReason,
  SGLANG_HARDWARE_IDS,
} from './sglangQwenRecipe.js';
import { PORTS } from './ports.js';
import { parserFlagsFor, qwenAgentParsersFor } from './qwenAgentParsers.js';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

describe('mambaFullMemoryRatio', () => {
  // The one number the cookbook says actually matters. Pinned arithmetic, not a
  // range: a silent change here re-sizes the GDN state pool on every host.
  it('derives the CoS operating point (L=20000, spec off, fp32 SSM, fp8 KV)', () => {
    // (5 slots + 0 verify) × 153.9 MB × 1024 KB/MB ÷ (20000 × 32.8 KB) = 1.201…
    expect(mambaFullMemoryRatio()).toEqual({ ratio: 1.201, stateSlots: 5, verifySlots: 0 });
  });

  it('is above the cookbook default of 0.9 at CoS prompt lengths', () => {
    // This is the whole reason the flag is derived rather than defaulted: 0.9
    // under-sizes the state pool here and silently clamps max_running_requests.
    expect(mambaFullMemoryRatio().ratio).toBeGreaterThan(0.9);
  });

  it('roughly halves with a bf16 SSM state, and again with a bf16 KV cache', () => {
    // Neither is exactly half — 78.4/153.9 and 32.8/65.5 are the checkpoint's
    // real geometry, not round numbers — so the values are pinned, not derived.
    expect(mambaFullMemoryRatio({ ssmDtype: 'bfloat16' }).ratio).toBe(0.612);
    expect(mambaFullMemoryRatio({ kvCacheDtype: 'bfloat16' }).ratio).toBe(0.602);
  });

  it('scales down as the sized request length grows', () => {
    expect(mambaFullMemoryRatio({ contextLength: 40_000 }).ratio)
      .toBeCloseTo(mambaFullMemoryRatio({ contextLength: 20_000 }).ratio / 2, 3);
  });

  it('adds the speculative verify slots for an MTP overlay', () => {
    expect(mambaFullMemoryRatio({ spec: 'eagle' })).toMatchObject({ stateSlots: 5, verifySlots: 4 });
    expect(mambaFullMemoryRatio({ spec: 'eagle' }).ratio)
      .toBeCloseTo(mambaFullMemoryRatio().ratio * 9 / 5, 3);
  });

  it('takes fewer state slots when the radix cache is off or lazy', () => {
    expect(mambaFullMemoryRatio({ radixStrategy: 'off' }).stateSlots).toBe(1);
    expect(mambaFullMemoryRatio({ radixStrategy: 'extra_buffer_lazy' }).stateSlots).toBe(4);
  });

  it('throws rather than guessing on an unknown dtype, strategy, or length', () => {
    expect(() => mambaFullMemoryRatio({ ssmDtype: 'fp16' })).toThrow(/SSM dtype/);
    expect(() => mambaFullMemoryRatio({ kvCacheDtype: 'int4' })).toThrow(/KV cache dtype/);
    expect(() => mambaFullMemoryRatio({ radixStrategy: 'lru' })).toThrow(/radix strategy/);
    expect(() => mambaFullMemoryRatio({ spec: 'medusa' })).toThrow(/speculative algorithm/);
    expect(() => mambaFullMemoryRatio({ contextLength: 0 })).toThrow(/positive number/);
  });
});

describe('buildSglangQwenRecipe — the verified H200 cell', () => {
  // Transcribed from the cookbook cell. An incorrect flag can let the container
  // start while silently dropping tool calls.
  it('pins the whole launch line', () => {
    expect(buildSglangQwenRecipe({ hw: 'h200' })).toMatchObject({
      image: 'lmsysorg/sglang:qwen38-27b',
      modelName: 'qwen3.8-27b',
      modelPath: 'Qwen/Qwen3.8-27B-FP8',
      mambaRatio: 1.201,
      flags: [
        '--trust-remote-code',
        '--model-path', 'Qwen/Qwen3.8-27B-FP8',
        '--kv-cache-dtype', 'fp8_e4m3',
        '--mem-fraction-static', '0.85',
        '--attention-backend', 'flashinfer',
        '--chunked-prefill-size', '32768',
        '--max-prefill-tokens', '32768',
        // Read from the shared table rather than retyped — the spellings live
        // in exactly one file, and its own guard test enforces that.
        ...parserFlagsFor('sglang'),
        '--mamba-radix-cache-strategy', 'extra_buffer',
        '--mamba-ssm-dtype', 'float32',
        '--mamba-full-memory-ratio', '1.201',
        '--host', '127.0.0.1',
        '--port', '18021',
      ],
    });
  });

  it('binds loopback on the PortOS port, not the cookbook 0.0.0.0:30000', () => {
    const { flags } = buildSglangQwenRecipe();
    expect(flags[flags.indexOf('--host') + 1]).toBe('127.0.0.1');
    expect(flags[flags.indexOf('--port') + 1]).toBe(String(PORTS.SGLANG_QWEN));
  });

  it('never defaults a speculative overlay', () => {
    expect(buildSglangQwenRecipe().flags).not.toContain('--speculative-algorithm');
  });
});

describe('buildSglangQwenRecipe — every cell', () => {
  it.each(SGLANG_HARDWARE_IDS)('%s carries SGLang\'s parsers, never vLLM\'s', (hw) => {
    // The silent failure this table exists to prevent: the wrong (or a missing)
    // tool-call parser makes the server answer with raw markup and the agent
    // never edits a file. Both spellings are read from `qwenAgentParsers.js` —
    // retyping either here is what its own guard test fails on.
    const flags = buildSglangQwenRecipe({ hw }).flags;
    expect(flags.join(' ')).toContain(parserFlagsFor('sglang').join(' '));
    expect(flags).not.toContain(qwenAgentParsersFor('vllm').toolCallParser);
  });

  it.each(SGLANG_HARDWARE_IDS)('%s derives the mamba ratio rather than leaving 0.9', (hw) => {
    const { flags, mambaRatio } = buildSglangQwenRecipe({ hw });
    expect(flags[flags.indexOf('--mamba-full-memory-ratio') + 1]).toBe(String(mambaRatio));
    expect(mambaRatio).not.toBe(0.9);
  });

  it('does not hand a 32 GB 5090 the H200 cell\'s 32k prefill chunks', () => {
    const { flags } = buildSglangQwenRecipe({ hw: 'rtx5090' });
    expect(flags).not.toContain('--chunked-prefill-size');
    expect(flags).not.toContain('--max-prefill-tokens');
    // The 5090's binding constraint is the GDN state pool, so it serializes.
    expect(flags[flags.indexOf('--max-running-requests') + 1]).toBe('1');
  });

  it('marks only the H200 cell as cookbook-verified', () => {
    expect(sglangHardwareCell('h200').verified).toBe(true);
    expect(sglangHardwareCell('rtx5090').verified).toBe(false);
    expect(sglangHardwareCell('rtx6000').verified).toBe(false);
  });

  it('throws for a card class with no recipe', () => {
    expect(() => buildSglangQwenRecipe({ hw: 'rtx3090' })).toThrow(/No SGLang recipe/);
  });
});

describe('sglangCellForGpu', () => {
  it('routes SM90 Hopper to the H200 cell', () => {
    expect(sglangCellForGpu({ computeCap: '9.0', vramGb: 141 })).toBe('h200');
  });

  it('splits Blackwell by VRAM', () => {
    expect(sglangCellForGpu({ computeCap: '12.0', vramGb: 32 })).toBe('rtx5090');
    expect(sglangCellForGpu({ computeCap: '12.0', vramGb: 96 })).toBe('rtx6000');
  });

  it('refuses Ampere — the cookbook has no 3090 cell, and 24 GB stays on vLLM', () => {
    expect(sglangCellForGpu({ computeCap: '8.6', vramGb: 24 })).toBeNull();
  });

  it('returns null for an unreadable compute-cap column rather than guessing', () => {
    expect(sglangCellForGpu({ computeCap: null, vramGb: 141 })).toBeNull();
    expect(sglangCellForGpu(null)).toBeNull();
  });
});

describe('sglangUnsupportedReason', () => {
  it('points macOS at MTPLX / DSpark', () => {
    expect(sglangUnsupportedReason({ platform: 'darwin' })).toMatch(/MTPLX or llama\.cpp DSpark/);
  });

  it('says "could not read", never "no GPU", on an unknown probe', () => {
    const reason = sglangUnsupportedReason({ platform: 'linux', status: 'unknown' });
    expect(reason).toMatch(/could not read/i);
    expect(reason).not.toMatch(/^No NVIDIA GPU/);
  });

  it('names the vLLM path for a card the cookbook has no cell for', () => {
    const reason = sglangUnsupportedReason({
      platform: 'linux', status: 'available', gpus: [{ computeCap: '8.6', vramGb: 24 }],
    });
    expect(reason).toMatch(/qwen38-rtx3090/);
  });

  it('allows a supported card', () => {
    expect(sglangUnsupportedReason({
      platform: 'linux', status: 'available', gpus: [{ computeCap: '9.0', vramGb: 141 }],
    })).toBeNull();
  });

  it('refuses a host with no NVIDIA driver', () => {
    expect(sglangUnsupportedReason({ platform: 'linux', status: 'absent' })).toMatch(/No NVIDIA GPU/);
  });
});

describe('sglangComposeYaml', () => {
  const yaml = sglangComposeYaml(buildSglangQwenRecipe({ hw: 'h200' }));

  it('publishes the recipe\'s own port on loopback only', () => {
    expect(yaml).toContain(`- "127.0.0.1:${PORTS.SGLANG_QWEN}:${PORTS.SGLANG_QWEN}"`);
    expect(yaml).not.toContain('network_mode: host');
  });

  it('names the official image and never restarts on its own', () => {
    // `restart: "no"` is load-bearing: this container holds the whole GPU, and a
    // restart policy would bring it back on every docker/host reboot.
    expect(yaml).toContain(`image: ${SGLANG_QWEN_IMAGE}`);
    expect(yaml).toContain('restart: "no"');
  });

  it('refuses to render a recipe with no --port rather than emitting "undefined"', () => {
    expect(() => sglangComposeYaml({ ...buildSglangQwenRecipe(), flags: ['--trust-remote-code'] }))
      .toThrow(/no --port flag/);
  });

  it('matches the cookbook docker stanza for shm and IPC', () => {
    expect(yaml).toContain('ipc: host');
    expect(yaml).toContain('shm_size: "32g"');
    expect(yaml).toContain('driver: nvidia');
  });

  // One source of truth: the operator copies this file out of the feature doc,
  // so a launch-line change that never reaches the doc ships a compose file
  // missing the flag it was made for.
  it('is embedded verbatim in docs/features/sglang-qwen38.md', () => {
    const doc = readFileSync(join(repoRoot, 'docs/features/sglang-qwen38.md'), 'utf-8')
      .replace(/\r\n/g, '\n');
    const block = doc.match(/```yaml\n([\s\S]*?)```/)?.[1];
    expect(block).toBe(yaml);
  });
});
