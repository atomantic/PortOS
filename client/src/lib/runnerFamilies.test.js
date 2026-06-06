import { describe, it, expect } from 'vitest';
import { RUNNER_FAMILIES, flux2VariantFromModel, loraCompatKey, composeCompatKey } from './runnerFamilies';

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
});
