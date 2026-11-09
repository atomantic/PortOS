import { describe, it, expect } from 'vitest';
import { omitDerivedRenderFields, renderTimingFields } from './renderTiming.js';
import { stripMachineLocalFields } from '../services/peerSyncEventBus.js';
import { stripImageSidecarLocalFields } from './assetHash.js';

// The absent-vs-zero contract is the whole point of this helper: videoGen/eta.js
// calibrates every future render estimate from persisted `renderMs` samples, so
// a defaulted `renderMs: 0` for an unmeasured render would drag every estimate
// toward "instant", and the gallery card would claim a render took no time.
describe('renderTimingFields', () => {
  it('reports the measured span', () => {
    const start = Date.parse('2026-09-02T00:00:00.000Z');
    expect(renderTimingFields(start, start + 90_000)).toEqual({
      renderMs: 90_000,
      renderStartedAt: '2026-09-02T00:00:00.000Z',
      renderCompletedAt: '2026-09-02T00:01:30.000Z',
    });
  });

  it('returns no fields at all when the start instant is missing or unusable', () => {
    for (const bad of [undefined, null, '', 'not-a-date', NaN, 0, -1]) {
      expect(renderTimingFields(bad, Date.now())).toEqual({});
    }
  });

  // A caller that hands over a junk completion instant gets "unknown", not a
  // NaN `renderMs` persisted onto the record and fed to the ETA cost model.
  it('reports nothing when the completion instant is unusable', () => {
    expect(renderTimingFields(Date.parse('2026-09-02T00:00:00.000Z'), NaN)).toEqual({});
  });

  it('reports nothing rather than a negative span when the clock moved backwards', () => {
    const start = Date.parse('2026-09-02T00:01:00.000Z');
    expect(renderTimingFields(start, start - 5_000)).toEqual({});
  });

  it('keeps a genuine zero-length measurement distinguishable from an absent one', () => {
    const start = Date.parse('2026-09-02T00:00:00.000Z');
    expect(renderTimingFields(start, start).renderMs).toBe(0);
  });
});

// A derived clip (upscale, trim, cut) must not claim its source's provider request: the details
// pane would offer to delete the SOURCE's hosted copy from the derived record.
describe('omitDerivedRenderFields on a derived record', () => {
  it('drops the source render timing and provider request ids but keeps the rest', () => {
    const source = {
      id: 's', prompt: 'p', codexSessionId: 'c', renderMs: 5, runwayTaskId: 't', runwayDeletedAt: 'd', falRequestId: 'f', falDeletedAt: 'd', topazRequestId: 'z', geminiChatUrl: 'u',
    };
    expect(omitDerivedRenderFields(source)).toEqual({ id: 's', prompt: 'p', codexSessionId: 'c' });
  });
});

// Whether THIS machine deleted the provider-hosted copy depends on its own provider account, so the
// stamp must not federate: a peer's row would otherwise carry a contradictory state it can never merge.
describe('hosted-deleted stamps are machine-local', () => {
  it('never leave on a federated video row or image sidecar', () => {
    const row = { id: 'v', runwayTaskId: 't', runwayDeletedAt: 'd', falDeletedAt: 'd', hidden: true };
    expect(stripMachineLocalFields(row)).toEqual({ id: 'v', runwayTaskId: 't' });
    expect(stripImageSidecarLocalFields({ prompt: 'p', falRequestId: 'r', falDeletedAt: 'd' })).toEqual({ prompt: 'p', falRequestId: 'r' });
  });
});
