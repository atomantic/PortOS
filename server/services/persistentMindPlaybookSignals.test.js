/**
 * The live half of the continuous-play phase picker.
 *
 * These run the REAL `eidoverseObservationLedger` against a temp data root
 * (only the leaf service reads are mocked) because the contract that matters
 * here cannot be proved with a mocked ledger: the picker must read the visit
 * marker WITHOUT advancing it (#7630). Advancing it would consume the "what
 * arrived since I last looked" trail that the mind's own `eidoverse.observe`
 * — and the very `coordinate` phase this resolves — depends on, so every wake
 * would erase the evidence for the next one.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { eidoversePeerId } from '../lib/eidoverseWorldSignals.js';

const dataRoot = () => lazyTempDataRoot('portos-playbook-phase-');

vi.mock('../lib/fileUtils.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot }));

const collectSources = vi.fn();
const listFoundations = vi.fn();
const listControllers = vi.fn();

vi.mock('./eidoverseWorldSources.js', () => ({ collectEidoverseWorldSources: (...args) => collectSources(...args) }));
vi.mock('./eidoverseFoundationLedger.js', () => ({ listEidoverseFoundations: (...args) => listFoundations(...args) }));
vi.mock('./eidoverseControllerRuntime.js', () => ({ listEidoverseControllers: (...args) => listControllers(...args) }));
vi.mock('./eidoverseWorld.js', () => ({ readEidoverseWorldRecipe: vi.fn().mockResolvedValue(null) }));
vi.mock('./eidoverseTravel.js', () => ({ listEidoverseDestinations: vi.fn().mockResolvedValue({ destinations: [] }) }));

const { resolvePersistentMindPlaybookPhase } = await import('./persistentMindPlaybookSignals.js');
const { observeEidoverseWorld } = await import('./eidoverseObservationLedger.js');

const PEER_INSTANCE = 'fixture-peer-instance';
const PEER_ID = eidoversePeerId({ instanceId: PEER_INSTANCE });
const markerFile = () => join(dataRoot(), 'eidoverse', 'observation.json');

const authored = (id) => ({ id, kind: 'affordance', title: 'Local build', layer: 'vernacular' });
const inheritedFrom = (id) => ({
  id,
  kind: 'affordance',
  title: 'Inherited build',
  layer: 'baseline',
  inheritance: { type: 'inherited-from', originInstanceId: PEER_INSTANCE, sourceInstanceId: PEER_INSTANCE, inheritedAt: '2026-09-17T10:00:00.000Z' },
});

const setFoundations = (foundations) => listFoundations.mockResolvedValue({
  counts: {
    vernacular: foundations.filter((entry) => entry.layer === 'vernacular').length,
    baseline: foundations.filter((entry) => entry.layer === 'baseline').length,
    candidates: 0,
    inherited: foundations.filter((entry) => entry.inheritance).length,
  },
  foundations,
});

const denseWorld = () => ({
  apps: [1, 2, 3, 4].map((n) => ({ id: `app-${n}` })),
  agents: [{ id: 'agent-1' }, { id: 'agent-2' }],
  tasks: [1, 2, 3].map((n) => ({ id: `task-${n}` })),
  peers: [{ id: PEER_ID, label: 'Federated peer', status: 'active', enabled: true, fullSync: true, travelAvailable: true }],
  goals: [{ id: 'goal-1' }],
  memory: [{ id: 'fact' }],
  // Install-constant scaffolding the density signal must ignore.
  features: Array.from({ length: 15 }, (_, index) => ({ id: `feature-${index}`, enabled: index % 2 === 0 })),
  storage: [{ id: 'database' }, { id: 'filesystem' }],
  operations: [{ id: 'overview' }],
  activity: [{ id: 'activity' }],
  productivity: [{ succeededToday: 8, failedToday: 0 }],
});

beforeEach(() => {
  vi.clearAllMocks();
  collectSources.mockResolvedValue(denseWorld());
  setFoundations([]);
  listControllers.mockResolvedValue({ counts: { total: 0, armed: 0, delivering: 0 }, installs: [] });
});

afterAll(cleanupTempDataRoots);

describe('resolvePersistentMindPlaybookPhase', () => {
  it('collects the world projection once and hands it to the observation', async () => {
    // `collectEidoverseWorldSources()` fans out across ~20 service reads;
    // collecting it again inside the observation would double that per wake.
    await resolvePersistentMindPlaybookPhase();
    expect(collectSources).toHaveBeenCalledTimes(1);
  });

  it('never advances the visit marker the mind\'s own observation depends on', async () => {
    setFoundations([authored('f-1')]);
    // Seed a real marker the way a mind's own `eidoverse.observe` would.
    await observeEidoverseWorld({ now: () => '2026-09-18T08:00:00.000Z' });
    const before = readFileSync(markerFile(), 'utf8');

    await resolvePersistentMindPlaybookPhase();
    expect(readFileSync(markerFile(), 'utf8')).toBe(before);
  });

  it('reports a fresh install as explore rather than a mature Commons', async () => {
    collectSources.mockResolvedValue({
      apps: [], agents: [], tasks: [], peers: [], goals: [], memory: [], jira: [],
      features: Array.from({ length: 15 }, (_, index) => ({ id: `feature-${index}`, enabled: false })),
      storage: [{ id: 'database' }, { id: 'filesystem' }],
      operations: [{ id: 'overview' }],
      activity: [{ id: 'activity' }],
      productivity: [{ succeededToday: 0, failedToday: 0 }],
    });
    const result = await resolvePersistentMindPlaybookPhase();
    expect(result).toMatchObject({ phase: 'explore' });
    expect(result.signals.districtCount).toBe(0);
  });

  it('coordinates only when a foundation arrived from a reachable peer since the last look', async () => {
    setFoundations([authored('f-1'), authored('f-2'), authored('f-3'), authored('f-4')]);
    await observeEidoverseWorld({ now: () => '2026-09-18T08:00:00.000Z' });

    // Reachable peer, nothing new: the old picker called this "peers waiting".
    const quiet = await resolvePersistentMindPlaybookPhase();
    expect(quiet.signals.peersReachable).toBe(1);
    expect(quiet.signals.peerContributionsUnread).toBe(0);
    expect(quiet.phase).toBe('maintain');

    setFoundations([authored('f-1'), authored('f-2'), authored('f-3'), authored('f-4'), inheritedFrom('peer:alpha:one')]);
    const arrived = await resolvePersistentMindPlaybookPhase();
    expect(arrived.signals.peerContributionsUnread).toBe(1);
    expect(arrived.phase).toBe('coordinate');
  });

  it('degrades to the safe explore default when the signal read fails', async () => {
    collectSources.mockRejectedValue(new Error('world source unavailable'));
    listFoundations.mockRejectedValue(new Error('ledger unavailable'));
    listControllers.mockRejectedValue(new Error('controllers unavailable'));
    const result = await resolvePersistentMindPlaybookPhase();
    expect(result.phase).toBe('explore');
    expect(result.signals).toMatchObject({ districtCount: null, failureRate: null, peersReachable: null });
  });

  it('propagates an abort rather than swallowing it as a signal failure', async () => {
    const controller = new AbortController();
    controller.abort(new Error('turn interrupted'));
    collectSources.mockRejectedValue(new Error('turn interrupted'));
    await expect(resolvePersistentMindPlaybookPhase({ signal: controller.signal })).rejects.toThrow('turn interrupted');
  });
});
