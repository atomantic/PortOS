/**
 * The persisted half of observation-first discovery (#7457). What these pin is
 * the contract a mind tool depends on across a WAKE BOUNDARY, which is the one
 * thing the pure builder beside this cannot prove: the visit marker survives to
 * the next observation, the shapes this shell hands the builder are the ones it
 * actually documents, a section that failed to collect degrades instead of
 * failing the whole tour, and an unreadable marker file never silently reports
 * a settled world as brand new.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { eidoversePeerId } from '../lib/eidoverseWorldSignals.js';

const dataRoot = () => lazyTempDataRoot('portos-eidoverse-observation-');

vi.mock('../lib/fileUtils.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot }));

const collectSources = vi.fn();
const listFoundations = vi.fn();
const listControllers = vi.fn();
const readRecipe = vi.fn();
const listDestinations = vi.fn();

vi.mock('./eidoverseWorldSources.js', () => ({ collectEidoverseWorldSources: (...args) => collectSources(...args) }));
vi.mock('./eidoverseFoundationLedger.js', () => ({ listEidoverseFoundations: (...args) => listFoundations(...args) }));
vi.mock('./eidoverseControllerRuntime.js', () => ({ listEidoverseControllers: (...args) => listControllers(...args) }));
vi.mock('./eidoverseWorld.js', () => ({ readEidoverseWorldRecipe: (...args) => readRecipe(...args) }));
vi.mock('./eidoverseTravel.js', () => ({ listEidoverseDestinations: (...args) => listDestinations(...args) }));

const { observeEidoverseWorld } = await import('./eidoverseObservationLedger.js');

const PEER_ALPHA = 'instance-alpha-0000';
const ALPHA_ID = eidoversePeerId({ instanceId: PEER_ALPHA });

const markerFile = () => join(dataRoot(), 'eidoverse', 'observation.json');

const writeRawMarker = (contents) => {
  mkdirSync(dirname(markerFile()), { recursive: true });
  writeFileSync(markerFile(), contents);
};

const inherited = (id) => ({
  id,
  kind: 'affordance',
  title: 'Inherited build',
  layer: 'baseline',
  inheritance: {
    type: 'inherited-from',
    originInstanceId: PEER_ALPHA,
    sourceInstanceId: PEER_ALPHA,
    foundationId: 'origin-foundation',
    fingerprint: 'b'.repeat(64),
    packagedAt: '2026-09-16T11:00:00.000Z',
    inheritedAt: '2026-09-16T11:00:00.000Z',
  },
});

const peerSignal = () => ({
  id: ALPHA_ID, label: 'Federated peer', status: 'active', enabled: true, fullSync: true, travelAvailable: true,
});

beforeEach(() => {
  rmSync(dataRoot(), { recursive: true, force: true });
  collectSources.mockReset().mockResolvedValue({ peers: [peerSignal()], agents: [], tasks: [] });
  listFoundations.mockReset().mockResolvedValue({ counts: { vernacular: 0, baseline: 1, candidates: 0, inherited: 1 }, foundations: [inherited('peer:alpha:one')] });
  listControllers.mockReset().mockResolvedValue({ counts: { total: 0, armed: 0, delivering: 0 }, installs: [] });
  readRecipe.mockReset().mockResolvedValue(null);
  listDestinations.mockReset().mockResolvedValue({ destinations: [{ peerId: ALPHA_ID, label: 'Peer' }] });
});

afterAll(cleanupTempDataRoots);

describe('the Eidoverse observation marker', () => {
  it('carries what is new across the wake boundary the marker exists for', async () => {
    const first = await observeEidoverseWorld({ now: () => '2026-09-16T12:00:00.000Z' });
    expect(first.changes.firstObservation).toBe(true);

    listFoundations.mockResolvedValue({
      counts: { vernacular: 0, baseline: 2, candidates: 0, inherited: 2 },
      foundations: [inherited('peer:alpha:one'), inherited('peer:alpha:two')],
    });

    // A different process would re-read the file; the point is that the second
    // observation's diff comes from DISK, not from anything held in memory.
    const second = await observeEidoverseWorld({ now: () => '2026-09-16T13:00:00.000Z' });
    expect(second.changes.firstObservation).toBe(false);
    expect(second.changes.since).toBe('2026-09-16T12:00:00.000Z');
    expect(second.changes.newFoundations).toEqual(['peer:alpha:two']);
  });

  it('leaves the marker untouched when asked to look without stamping', async () => {
    await observeEidoverseWorld({ now: () => '2026-09-16T12:00:00.000Z' });
    listFoundations.mockResolvedValue({
      counts: { vernacular: 0, baseline: 2, candidates: 0, inherited: 2 },
      foundations: [inherited('peer:alpha:one'), inherited('peer:alpha:two')],
    });

    const peek = await observeEidoverseWorld({ commit: false, now: () => '2026-09-16T13:00:00.000Z' });
    expect(peek.changes.newFoundations).toEqual(['peer:alpha:two']);

    // Still new on the next real observation, because the peek never stamped.
    const after = await observeEidoverseWorld({ now: () => '2026-09-16T14:00:00.000Z' });
    expect(after.changes.since).toBe('2026-09-16T12:00:00.000Z');
    expect(after.changes.newFoundations).toEqual(['peer:alpha:two']);
  });

  it('refuses to treat an unreadable marker file as never-observed', async () => {
    writeRawMarker('{ this is not json');
    // Reading it as "never observed" would be the destructive failure: the very
    // next write would replace a real marker with a fresh one and every
    // foundation on the install would report as new exactly once.
    await expect(observeEidoverseWorld()).rejects.toThrow();
  });

  it('degrades a marker written by a newer PortOS to one honest first observation', async () => {
    writeRawMarker(JSON.stringify({
      schemaVersion: 99,
      marker: { schemaVersion: 99, observedAt: '2026-09-16T10:00:00.000Z', foundationIds: ['peer:alpha:one'], peerIds: [ALPHA_ID], placeStatus: {}, attentionControllerIds: [] },
    }));

    const observed = await observeEidoverseWorld({ now: () => '2026-09-16T12:00:00.000Z' });
    expect(observed.changes.firstObservation).toBe(true);
    // And it converges: the rewritten marker is one this build can diff.
    const next = await observeEidoverseWorld({ now: () => '2026-09-16T13:00:00.000Z' });
    expect(next.changes.firstObservation).toBe(false);
    expect(next.changes.since).toBe('2026-09-16T12:00:00.000Z');
  });

  it('still tours the world when a single collection fails', async () => {
    listControllers.mockRejectedValue(new Error('controller runtime unavailable'));
    listFoundations.mockRejectedValue(new Error('ledger unavailable'));

    const observed = await observeEidoverseWorld({ now: () => '2026-09-16T12:00:00.000Z' });

    // A mind that cannot read its controllers should still get its districts.
    expect(observed.controllers.counts).toBeNull();
    expect(observed.foundations.counts).toBeNull();
    expect(observed.places).toHaveLength(8);
    expect(observed.peers.map((peer) => peer.peerId)).toEqual([ALPHA_ID]);
  });

  it('serializes concurrent observations so one marker write cannot lose the other', async () => {
    const observations = await Promise.all([
      observeEidoverseWorld({ now: () => '2026-09-16T12:00:00.000Z' }),
      observeEidoverseWorld({ now: () => '2026-09-16T12:00:01.000Z' }),
    ]);

    // Whichever ran second must have SEEN the first, not raced past it.
    expect(observations.filter((entry) => entry.changes.firstObservation)).toHaveLength(1);
    expect(observations.filter((entry) => !entry.changes.firstObservation)).toHaveLength(1);
  });
});

describe('the shapes the observation shell hands the report builder', () => {
  it('summarizes a RAW controller record before reporting its health', async () => {
    // `listEidoverseControllers()` returns raw records, whose tick outcome lives
    // in `lastOutcome`. The builder reads the FLATTENED `lastTickOk`, so handing
    // it a raw record would report every controller as never-ticked and
    // silently disable the failed-tick filter the Maintain playbook relies on.
    listControllers.mockResolvedValue({
      counts: { total: 2, armed: 1, delivering: 0 },
      installs: [
        {
          id: 'just-failed',
          controllerId: 'lanternKeeper',
          armed: true,
          consecutiveFailures: 0,
          lastOutcome: { at: '2026-09-16T11:59:00.000Z', tick: 4, ok: false, reason: 'entity missing' },
        },
        {
          id: 'never-ticked',
          controllerId: 'ambientBeacon',
          armed: true,
          consecutiveFailures: 0,
        },
      ],
    });

    const observed = await observeEidoverseWorld({ now: () => '2026-09-16T12:00:00.000Z' });

    expect(observed.controllers.needsAttention).toEqual([expect.objectContaining({
      id: 'just-failed',
      lastTickOk: false,
      lastTickReason: 'entity missing',
    })]);
    // Never ticked is not an alarm, and must stay distinguishable from failed.
    expect(observed.controllers.needsAttention.map((entry) => entry.id)).not.toContain('never-ticked');
  });

  it('names the districts the install\'s own recipe renders', async () => {
    const observed = await observeEidoverseWorld({ now: () => '2026-09-16T12:00:00.000Z' });
    const labels = observed.places.map((place) => place.label);

    // Resolved from the stored recipe, so this is the shipped V3 design rather
    // than the retired V2 names the world stopped rendering.
    expect(labels).toContain('Federation Terminal');
    expect(labels).not.toContain('Federation Harbor');
  });

  it('does not re-probe peer capabilities that the source collection already resolved', async () => {
    await observeEidoverseWorld({ now: () => '2026-09-16T12:00:00.000Z' });

    // `collectEidoverseWorldSources` already calls it and folds the answer into
    // `peers[].travelAvailable`; asking again costs one outbound /capabilities
    // request per online peer for information already in hand.
    expect(listDestinations).not.toHaveBeenCalled();
  });
});
