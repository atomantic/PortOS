import { describe, it, expect } from 'vitest';
import {
  RUNNER_FAMILIES, VIDEO_LORA_FAMILIES, flux2VariantFromModel, isVideoLoraFamily,
  loraCompatKey, composeCompatKey, loraFamilyOf, videoLoraFamily,
} from './runnerFamilies';

// This is the client mirror of server/lib/runners.js. The server suite greps
// this file for the helper *names*; these tests pin their *behavior* so the
// two copies can't silently diverge.
describe('runnerFamilies mirror', () => {
  it('exports the canonical ids', () => {
    expect(RUNNER_FAMILIES.FLUX2).toBe('flux2');
    expect(RUNNER_FAMILIES.MFLUX).toBe('mflux');
  });

  it('flux2VariantFromModel reads the size from id then repo', () => {
    expect(flux2VariantFromModel({ id: 'flux2-klein-4b' })).toBe('4b');
    expect(flux2VariantFromModel({ id: 'flux2-klein-9b-bf16' })).toBe('9b');
    expect(flux2VariantFromModel({ id: 'x', repo: 'Disty0/FLUX.2-klein-9B-SDNQ' })).toBe('9b');
    expect(flux2VariantFromModel({ id: 'flux2-klein' })).toBe(null);
    expect(flux2VariantFromModel(null)).toBe(null);
  });

  it('loraCompatKey refines flux2 and passes other families through', () => {
    expect(loraCompatKey({ runner: 'flux2', id: 'flux2-klein-4b' })).toBe('flux2-4b');
    expect(loraCompatKey({ runner: 'flux2', id: 'flux2-klein-9b' })).toBe('flux2-9b');
    expect(loraCompatKey({ runner: 'flux2', id: 'flux2-klein' })).toBe('flux2');
    expect(loraCompatKey({ runner: 'z-image', id: 'z-image-turbo-bf16' })).toBe('z-image');
    expect(loraCompatKey({ id: 'dev' })).toBe('mflux');
  });

  it('composeCompatKey encodes a flux2 variant and leaves other cases bare', () => {
    expect(composeCompatKey('flux2', '9b')).toBe('flux2-9b');
    expect(composeCompatKey('flux2', null)).toBe('flux2');
    expect(composeCompatKey('mflux', '4b')).toBe('mflux');
    expect(composeCompatKey(null, null)).toBe(null);
  });

  // The picker is driven entirely by this function, so a mirror drift here
  // shows the user a LoRA control the server would then 400 on.
  it('videoLoraFamily gates minimax_h3 on the server-decorated runtime capability', () => {
    expect(videoLoraFamily({ runtime: 'ltx2' })).toBe(VIDEO_LORA_FAMILIES.LTX_VIDEO);
    expect(videoLoraFamily({ runtime: 'minimax_h3', runtimeLoraCapable: true })).toBe(VIDEO_LORA_FAMILIES.MINIMAX_H3);
    expect(videoLoraFamily({ runtime: 'minimax_h3', runtimeLoraCapable: false })).toBe(null);
    // undecorated payload (server older than this client) must fail closed
    expect(videoLoraFamily({ runtime: 'minimax_h3' })).toBe(null);
    expect(videoLoraFamily({ runtime: 'wan22', runtimeLoraCapable: true })).toBe(null);
  });

  it('loraFamilyOf prefers the refined compat key over the legacy coarse field', () => {
    expect(loraFamilyOf({ loraCompatKey: 'flux2-9b', runnerFamily: 'flux2' })).toBe('flux2-9b');
    expect(loraFamilyOf({ runnerFamily: 'ltx-video' })).toBe('ltx-video');
    expect(loraFamilyOf({})).toBe(null);
    expect(loraFamilyOf(null)).toBe(null);
  });

  it('treats both video families as video, so an H3 LoRA deep-links to Video Gen', () => {
    expect(isVideoLoraFamily(VIDEO_LORA_FAMILIES.MINIMAX_H3)).toBe(true);
    expect(isVideoLoraFamily(VIDEO_LORA_FAMILIES.LTX_VIDEO)).toBe(true);
    expect(isVideoLoraFamily(RUNNER_FAMILIES.FLUX2)).toBe(false);
    expect(isVideoLoraFamily(null)).toBe(false);
  });
});
