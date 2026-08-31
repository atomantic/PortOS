import { describe, expect, it } from 'vitest';
import {
  EIDOVERSE_RESET_ASSET_SLOTS,
  EIDOVERSE_SOURCE_KIND,
  eidoverseResetAssetSlotsForDistrict,
} from '../../client/src/lib/eidoverseWorldReset.js';
import { EIDOVERSE_ASSET_SLOTS_BY_DISTRICT } from './eidoverseWorldDesign.js';
import { EIDOVERSE_PROJECTION_KINDS } from '../services/eidoverseWorldProjection.js';

describe('Eidoverse reset client/server parity', () => {
  it('keeps district asset reset slots aligned with the server contract', () => {
    expect(EIDOVERSE_RESET_ASSET_SLOTS).toEqual(EIDOVERSE_ASSET_SLOTS_BY_DISTRICT);
  });

  it('keeps projection source kinds aligned with the server contract', () => {
    expect(EIDOVERSE_SOURCE_KIND).toEqual(Object.fromEntries(
      EIDOVERSE_PROJECTION_KINDS.map(({ source, kind }) => [source, kind]),
    ));
  });

  it('resets the generic landmark and source assets for a custom district', () => {
    expect(eidoverseResetAssetSlotsForDistrict('example-yard', ['apps', 'goals']))
      .toEqual(['district', 'app', 'goal']);
  });
});
