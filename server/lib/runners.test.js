import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { RUNNER_FAMILIES, VIDEO_LORA_FAMILIES, MINIMAX_H3_RUNTIMES, LTX2_FAMILY_RUNTIMES, AUDIO_TO_VIDEO_RUNTIMES, videoLoraFamily, isMiniMaxH3Runtime, isLtx2FamilyRuntime, isAudioToVideoRuntime, isMlxVideoLtxLoraCapable, loraFamilyOf, isMflux, isFlux2, isZImage, isErnie, isHiDream, isQwen, flux2VariantFromModel, loraCompatKey, composeCompatKey } from './runners.js';

const __dirname_self = dirname(fileURLToPath(import.meta.url));
const CLIENT_MIRROR_PATH = join(__dirname_self, '..', '..', 'client', 'src', 'lib', 'runnerFamilies.js');

describe('RUNNER_FAMILIES', () => {
  it('exports the canonical runner ids', () => {
    expect(RUNNER_FAMILIES.MFLUX).toBe('mflux');
    expect(RUNNER_FAMILIES.FLUX2).toBe('flux2');
    expect(RUNNER_FAMILIES.Z_IMAGE).toBe('z-image');
    expect(RUNNER_FAMILIES.ERNIE).toBe('ernie');
    expect(RUNNER_FAMILIES.HIDREAM).toBe('hidream');
    expect(RUNNER_FAMILIES.QWEN).toBe('qwen');
  });

  it('is frozen so callers can\'t mutate the canonical strings at runtime', () => {
    expect(Object.isFrozen(RUNNER_FAMILIES)).toBe(true);
  });

  it('client mirror at client/src/lib/runnerFamilies.js carries the same ids', () => {
    // The mirror is plain JS (not importable from a Vitest server suite —
    // Vite's fs.allow doesn't cross), so we string-grep the file. Any
    // change to a canonical id has to be reflected in both places, or this
    // test fails.
    const text = readFileSync(CLIENT_MIRROR_PATH, 'utf-8');
    expect(text).toMatch(/MFLUX:\s*'mflux'/);
    expect(text).toMatch(/FLUX2:\s*'flux2'/);
    expect(text).toMatch(/Z_IMAGE:\s*'z-image'/);
    expect(text).toMatch(/ERNIE:\s*'ernie'/);
    expect(text).toMatch(/HIDREAM:\s*'hidream'/);
    expect(text).toMatch(/QWEN:\s*'qwen'/);
  });

  it('predicate helpers match on the canonical runner ids', () => {
    expect(isMflux({ runner: 'mflux' })).toBe(true);
    expect(isFlux2({ runner: 'flux2' })).toBe(true);
    expect(isZImage({ runner: 'z-image' })).toBe(true);
    expect(isErnie({ runner: 'ernie' })).toBe(true);
    expect(isHiDream({ runner: 'hidream' })).toBe(true);
    expect(isQwen({ runner: 'qwen' })).toBe(true);
    expect(isFlux2({ runner: 'mflux' })).toBe(false);
    expect(isFlux2(null)).toBe(false);
    expect(isFlux2(undefined)).toBe(false);
  });
});

describe('VIDEO_LORA_FAMILIES / videoLoraFamily', () => {
  it('exports the canonical video family ids, frozen', () => {
    expect(VIDEO_LORA_FAMILIES.LTX_VIDEO).toBe('ltx-video');
    expect(VIDEO_LORA_FAMILIES.MINIMAX_H3).toBe('minimax-h3');
    expect(Object.isFrozen(VIDEO_LORA_FAMILIES)).toBe(true);
  });

  // H3's quantized DiT can only take LoRAs if the INSTALLED runner applies them
  // at runtime, which no model field can express — listVideoModels() decorates
  // the probe result as `runtimeLoraCapable` and this reads it. Anything short of
  // a literal `true` must read as not capable so the gate fails closed.
  it('maps minimax_h3 to a family only when the runtime probe proved it capable', () => {
    expect(videoLoraFamily({ runtime: 'minimax_h3', runtimeLoraCapable: true })).toBe('minimax-h3');
    expect(videoLoraFamily({ runtime: 'minimax_h3', runtimeLoraCapable: false })).toBe(null);
    // undecorated payload (older peer, unprobed cache) → closed
    expect(videoLoraFamily({ runtime: 'minimax_h3' })).toBe(null);
    // truthy-but-not-true must not open the gate
    expect(videoLoraFamily({ runtime: 'minimax_h3', runtimeLoraCapable: 'yes' })).toBe(null);
    // the flag alone never grants a family to a runtime with no LoRA path
    expect(videoLoraFamily({ runtime: 'wan22', runtimeLoraCapable: true })).toBe(null);
  });

  it('maps the ltx2 runtime + non-quantized LTX-2.x mlx_video models to a LoRA family', () => {
    expect(videoLoraFamily({ runtime: 'ltx2' })).toBe('ltx-video');
    // bare mlx_video (no LTX-2.x identity) stays null
    expect(videoLoraFamily({ runtime: 'mlx_video' })).toBe(null);
    // the bf16 Unified Beta — now LoRA-capable
    expect(videoLoraFamily({ runtime: 'mlx_video', id: 'ltx23_unified', repo: 'notapalindrome/ltx23-mlx-av', name: 'LTX-2.3 Unified Beta' })).toBe('ltx-video');
    expect(videoLoraFamily({ runtime: 'mlx_video', id: 'ltx2_unified', name: 'LTX-2 Unified' })).toBe('ltx-video');
    // quantized variants are out of scope → null
    expect(videoLoraFamily({ runtime: 'mlx_video', id: 'ltx23_distilled_q4', repo: 'notapalindrome/ltx23-mlx-av-q4', name: 'LTX-2.3 Distilled Q4' })).toBe(null);
    expect(videoLoraFamily({ runtime: 'wan22' })).toBe(null);
    expect(videoLoraFamily({ runtime: 'fastvideo' })).toBe(null);
    expect(videoLoraFamily({})).toBe(null);
    expect(videoLoraFamily(null)).toBe(null);
  });

  it('isMlxVideoLtxLoraCapable gates on runtime + LTX-2.x + non-quantized', () => {
    // capable: bf16 LTX-2.x mlx_video
    expect(isMlxVideoLtxLoraCapable({ runtime: 'mlx_video', name: 'LTX-2.3 Unified Beta' })).toBe(true);
    expect(isMlxVideoLtxLoraCapable({ runtime: 'mlx_video', repo: 'notapalindrome/ltx2-mlx-av' })).toBe(true);
    // not capable: quantized (q4/q8 marker bounded so it doesn't match mid-token)
    expect(isMlxVideoLtxLoraCapable({ runtime: 'mlx_video', name: 'LTX-2.3 Distilled Q4 (~22 GB)' })).toBe(false);
    expect(isMlxVideoLtxLoraCapable({ runtime: 'mlx_video', repo: 'notapalindrome/ltx23-mlx-av-q8' })).toBe(false);
    // not capable: undelimited quant suffix (community quant naming) — q4bit/q8gguf
    expect(isMlxVideoLtxLoraCapable({ runtime: 'mlx_video', repo: 'someone/ltx2.3-q4bit' })).toBe(false);
    expect(isMlxVideoLtxLoraCapable({ runtime: 'mlx_video', name: 'LTX-2.3 q8gguf' })).toBe(false);
    // still capable: a digit-suffixed non-quant token must NOT trip the q-marker (e.g. q40 is not q4)
    expect(isMlxVideoLtxLoraCapable({ runtime: 'mlx_video', name: 'LTX-2.3 build q40' })).toBe(true);
    // not capable: wrong runtime
    expect(isMlxVideoLtxLoraCapable({ runtime: 'ltx2', name: 'LTX-2.3 dgrauet Q4' })).toBe(false);
    // not capable: the Windows LTX-Video 0.9.5 model (no LTX-2.x marker)
    expect(isMlxVideoLtxLoraCapable({ runtime: 'mlx_video', id: 'ltx_video', name: 'LTX-Video 0.9.5' })).toBe(false);
    // not capable: non-LTX mlx_video
    expect(isMlxVideoLtxLoraCapable({ runtime: 'mlx_video' })).toBe(false);
    expect(isMlxVideoLtxLoraCapable(null)).toBe(false);
  });

  it('loraFamilyOf prefers the refined compat key over the legacy coarse field', () => {
    expect(loraFamilyOf({ loraCompatKey: 'flux2-9b', runnerFamily: 'flux2' })).toBe('flux2-9b');
    // pre-sidecar install: only the coarse field survives
    expect(loraFamilyOf({ runnerFamily: 'ltx-video' })).toBe('ltx-video');
    expect(loraFamilyOf({})).toBe(null);
    expect(loraFamilyOf(null)).toBe(null);
  });

  it('composeCompatKey leaves the ltx-video family bare (no variant)', () => {
    expect(composeCompatKey('ltx-video', null)).toBe('ltx-video');
    expect(composeCompatKey('ltx-video', '9b')).toBe('ltx-video');
  });

  it('client mirror carries the video family + helpers', () => {
    const text = readFileSync(CLIENT_MIRROR_PATH, 'utf-8');
    expect(text).toMatch(/LTX_VIDEO:\s*'ltx-video'/);
    expect(text).toMatch(/MINIMAX_H3:\s*'minimax-h3'/);
    expect(text).toMatch(/runtimeLoraCapable === true/);
    expect(text).toMatch(/export const videoLoraFamily/);
    expect(text).toMatch(/export const isMlxVideoLtxLoraCapable/);
    expect(text).toMatch(/export const loraFamilyOf/);
    expect(text).toMatch(/export const isMiniMaxH3Runtime/);
    expect(text).toMatch(/MINIMAX_H3_REF2VA_RUNTIME = 'minimax_h3_ref2va'/);
    expect(text).toMatch(/export const isLtx2FamilyRuntime/);
    expect(text).toMatch(/'ltx2', 'ltx25'/);
  });
});

describe('flux2VariantFromModel', () => {
  it('reads the size from the model id across all four flux2 ids', () => {
    expect(flux2VariantFromModel({ id: 'flux2-klein-4b' })).toBe('4b');
    expect(flux2VariantFromModel({ id: 'flux2-klein-9b' })).toBe('9b');
    expect(flux2VariantFromModel({ id: 'flux2-klein-4b-int8' })).toBe('4b');
    expect(flux2VariantFromModel({ id: 'flux2-klein-9b-bf16' })).toBe('9b');
  });

  it('falls back to the repo string when the id is opaque', () => {
    expect(flux2VariantFromModel({ id: 'my-custom-model', repo: 'Disty0/FLUX.2-klein-9B-SDNQ-4bit' })).toBe('9b');
    expect(flux2VariantFromModel({ id: 'x', repo: 'aydin99/FLUX.2-klein-4B-int8' })).toBe('4b');
  });

  it('returns null when neither id nor repo encodes a size', () => {
    expect(flux2VariantFromModel({ id: 'flux2-klein', repo: 'foo/bar' })).toBe(null);
    expect(flux2VariantFromModel({})).toBe(null);
    expect(flux2VariantFromModel(null)).toBe(null);
  });

  it('does not mistake unrelated "4b"/"9b" substrings for the size token', () => {
    // No delimiter boundary around the digits → not a size token.
    expect(flux2VariantFromModel({ id: 'model94bit', repo: '' })).toBe(null);
  });
});

describe('loraCompatKey', () => {
  it('refines flux2 into size-specific keys', () => {
    expect(loraCompatKey({ runner: 'flux2', id: 'flux2-klein-4b' })).toBe('flux2-4b');
    expect(loraCompatKey({ runner: 'flux2', id: 'flux2-klein-9b-bf16' })).toBe('flux2-9b');
  });

  it('falls back to bare flux2 when the size is unknown', () => {
    expect(loraCompatKey({ runner: 'flux2', id: 'flux2-klein', repo: 'foo/bar' })).toBe('flux2');
  });

  it('passes other families through as their runner id', () => {
    expect(loraCompatKey({ runner: 'z-image', id: 'z-image-turbo-bf16' })).toBe('z-image');
    expect(loraCompatKey({ runner: 'mflux', id: 'dev' })).toBe('mflux');
  });

  it('defaults a runner-less model to mflux (matches the picker default)', () => {
    expect(loraCompatKey({ id: 'dev' })).toBe('mflux');
  });

  it('client mirror carries the same helpers', () => {
    const text = readFileSync(CLIENT_MIRROR_PATH, 'utf-8');
    expect(text).toMatch(/export const flux2VariantFromModel/);
    expect(text).toMatch(/export const loraCompatKey/);
    expect(text).toMatch(/export const composeCompatKey/);
  });
});

describe('composeCompatKey', () => {
  it('encodes a flux2 size variant, leaves other cases as the bare family', () => {
    expect(composeCompatKey('flux2', '4b')).toBe('flux2-4b');
    expect(composeCompatKey('flux2', '9b')).toBe('flux2-9b');
    expect(composeCompatKey('flux2', null)).toBe('flux2');   // size unknown
    expect(composeCompatKey('mflux', '4b')).toBe('mflux');   // non-flux2 never carries a variant
    expect(composeCompatKey('z-image', null)).toBe('z-image');
    expect(composeCompatKey(null, null)).toBe(null);         // legacy LoRA, family unknown
  });

  it('is the single encoder behind both model-side and LoRA-side keys', () => {
    // loraCompatKey(model) must agree with composeCompatKey on the same pair.
    expect(loraCompatKey({ runner: 'flux2', id: 'flux2-klein-9b' }))
      .toBe(composeCompatKey('flux2', '9b'));
  });
});

// H3's controls (24 fps, joint A/V, no CFG, the 17n+5 grid) are facts about the
// checkpoint, so the gates that assert them must cover every H3 runtime. Naming
// one runtime in a gate is precisely how the CUDA path would silently escape
// a rule the MLX path enforces.
describe('isMiniMaxH3Runtime', () => {
  it('covers all H3 runtimes and nothing else', () => {
    expect(MINIMAX_H3_RUNTIMES).toEqual(['minimax_h3', 'minimax_h3_cuda', 'minimax_h3_ref2va']);
    expect(isMiniMaxH3Runtime('minimax_h3')).toBe(true);
    expect(isMiniMaxH3Runtime('minimax_h3_cuda')).toBe(true);
    expect(isMiniMaxH3Runtime('minimax_h3_ref2va')).toBe(true);
  });

  it.each(['mlx_video', 'ltx2', 'wan22', 'fastvideo', 'minimax', '', undefined, null])(
    'reports %s as not an H3 runtime',
    (runtime) => { expect(isMiniMaxH3Runtime(runtime)).toBe(false); },
  );

  it('does not grant the CUDA runtime a LoRA family — the diffusers path has no applicator', () => {
    expect(videoLoraFamily({ runtime: 'minimax_h3_cuda' })).toBe(null);
    // Not even when a stale/synced payload claims the MLX port's probe verdict.
    expect(videoLoraFamily({ runtime: 'minimax_h3_cuda', runtimeLoraCapable: true })).toBe(null);
  });
});

describe('isAudioToVideoRuntime', () => {
  it('covers both LTX pins plus MiniMax H3 Ref2VA', () => {
    expect(AUDIO_TO_VIDEO_RUNTIMES).toEqual(['ltx2', 'ltx25', 'minimax_h3_ref2va']);
    for (const runtime of AUDIO_TO_VIDEO_RUNTIMES) expect(isAudioToVideoRuntime(runtime)).toBe(true);
    expect(isAudioToVideoRuntime('minimax_h3')).toBe(false);
    expect(isAudioToVideoRuntime('mlx_video')).toBe(false);
  });
});

describe('isLtx2FamilyRuntime', () => {
  it('covers the 2.3 pin and the 2.5 fork, and nothing else', () => {
    expect(LTX2_FAMILY_RUNTIMES).toEqual(['ltx2', 'ltx25']);
    expect(isLtx2FamilyRuntime('ltx2')).toBe(true);
    expect(isLtx2FamilyRuntime('ltx25')).toBe(true);
    expect(videoLoraFamily({ runtime: 'ltx25' })).toBe(VIDEO_LORA_FAMILIES.LTX_VIDEO);
  });

  it.each(['mlx_video', 'wan22', 'fastvideo', 'minimax_h3', 'ltx', '', undefined, null])(
    'reports %s as not an LTX-2 family runtime',
    (runtime) => { expect(isLtx2FamilyRuntime(runtime)).toBe(false); },
  );
});
