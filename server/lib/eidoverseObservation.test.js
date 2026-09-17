import { describe, expect, it } from 'vitest';
import { buildEidoverseObservation } from './eidoverseObservation.js';
import { eidoversePeerId } from './eidoverseWorldSignals.js';

const OBSERVED_AT = '2026-09-16T12:00:00.000Z';

// Two invented instance ids. Never a value observed on a live install — these
// only need to be stable and obviously fake.
const PEER_ALPHA = 'instance-alpha-0000';
const PEER_BETA = 'instance-beta-0000';

const peerSignal = (instanceId, overrides = {}) => ({
  id: eidoversePeerId({ instanceId }),
  label: 'Federated peer',
  status: 'active',
  enabled: true,
  fullSync: true,
  travelAvailable: true,
  ...overrides,
});

const inheritedFoundation = (id, sourceInstanceId, overrides = {}) => ({
  id,
  kind: 'affordance',
  title: 'Lantern relight loop',
  layer: 'baseline',
  updatedAt: OBSERVED_AT,
  inheritance: {
    type: 'inherited-from',
    originInstanceId: sourceInstanceId,
    sourceInstanceId,
    foundationId: 'origin-foundation',
    fingerprint: 'a'.repeat(64),
    packagedAt: OBSERVED_AT,
    inheritedAt: OBSERVED_AT,
  },
  ...overrides,
});

const observe = (args) => buildEidoverseObservation({ observedAt: OBSERVED_AT, ...args });

describe('buildEidoverseObservation', () => {
  it('reports a first observation without declaring a settled world new', () => {
    const { report, marker } = observe({
      source: { peers: [peerSignal(PEER_ALPHA)], apps: [{ id: 'apps-active', status: 'active' }] },
      foundations: [inheritedFoundation('peer:alpha:one', PEER_ALPHA)],
    });

    expect(report.changes.firstObservation).toBe(true);
    expect(report.changes.since).toBeNull();
    // The load-bearing assertion: a mind waking into a months-old install must
    // not be handed its entire world as "new".
    expect(report.changes.newFoundations).toEqual([]);
    expect(report.changes.newPeers).toEqual([]);
    // The marker it leaves still records everything, so the NEXT observation
    // has a real baseline to diff against.
    expect(marker.foundationIds).toEqual(['peer:alpha:one']);
    expect(marker.peerIds).toEqual([eidoversePeerId({ instanceId: PEER_ALPHA })]);
  });

  it('reports only what arrived since the previous marker', () => {
    const first = observe({
      source: { peers: [peerSignal(PEER_ALPHA)] },
      foundations: [inheritedFoundation('peer:alpha:one', PEER_ALPHA)],
    });

    const { report } = observe({
      source: { peers: [peerSignal(PEER_ALPHA), peerSignal(PEER_BETA)] },
      foundations: [
        inheritedFoundation('peer:alpha:one', PEER_ALPHA),
        inheritedFoundation('peer:beta:two', PEER_BETA),
      ],
      marker: first.marker,
    });

    expect(report.changes.firstObservation).toBe(false);
    expect(report.changes.since).toBe(OBSERVED_AT);
    expect(report.changes.newFoundations).toEqual(['peer:beta:two']);
    expect(report.changes.newPeers).toEqual([eidoversePeerId({ instanceId: PEER_BETA })]);
    expect(report.changes.departedPeers).toEqual([]);
  });

  it('reports a peer that disappeared from the world since the last visit', () => {
    const first = observe({ source: { peers: [peerSignal(PEER_ALPHA), peerSignal(PEER_BETA)] } });
    const { report } = observe({ source: { peers: [peerSignal(PEER_ALPHA)] }, marker: first.marker });

    expect(report.changes.departedPeers).toEqual([eidoversePeerId({ instanceId: PEER_BETA })]);
    expect(report.changes.newPeers).toEqual([]);
  });

  it('links an inherited foundation to the peer chamber it arrived through', () => {
    const { report } = observe({
      source: { peers: [peerSignal(PEER_ALPHA), peerSignal(PEER_BETA)] },
      foundations: [
        inheritedFoundation('peer:alpha:one', PEER_ALPHA),
        inheritedFoundation('peer:alpha:two', PEER_ALPHA),
        inheritedFoundation('peer:beta:one', PEER_BETA),
      ],
    });

    // This is the acceptance criterion: a peer's contribution is discoverable
    // by touring the Commons, so the peer chamber has to carry the count.
    const alpha = report.peers.find((peer) => peer.peerId === eidoversePeerId({ instanceId: PEER_ALPHA }));
    const beta = report.peers.find((peer) => peer.peerId === eidoversePeerId({ instanceId: PEER_BETA }));
    expect(alpha.inheritedFoundations).toBe(2);
    expect(beta.inheritedFoundations).toBe(1);
    expect(report.foundations.inherited.map((entry) => entry.fromPeerId))
      .toEqual(expect.arrayContaining([alpha.peerId, beta.peerId]));
  });

  it('never leaks a raw instance identifier into a peer id', () => {
    const { report } = observe({
      source: { peers: [peerSignal(PEER_ALPHA)] },
      foundations: [inheritedFoundation('peer:alpha:one', PEER_ALPHA)],
    });

    expect(report.peers[0].peerId).not.toContain(PEER_ALPHA);
    expect(report.foundations.inherited[0].fromPeerId).not.toContain(PEER_ALPHA);
    expect(report.foundations.inherited[0].fromPeerId).toMatch(/^peer-[a-f0-9]{12}$/);
  });

  it('distinguishes an unreadable source from an empty one', () => {
    const { report } = observe({ source: { apps: null, agents: [], tasks: [] } });

    const apps = report.places.find((place) => place.id === 'apps');
    const agents = report.places.find((place) => place.id === 'agents');
    // An app list that failed to read must never render as an empty district —
    // that is the #7458 misreport, in a new surface.
    expect(apps.signalCount).toBeNull();
    expect(apps.status).toBe('unknown');
    expect(apps.unreadableSources).toEqual(['apps']);
    expect(agents.signalCount).toBe(0);
    expect(agents.status).toBe('quiet');
  });

  it('flags a district holding a signal that wants attention', () => {
    const { report } = observe({
      source: { agents: [{ id: 'agent-1', status: 'active' }, { id: 'agent-2', status: 'error' }], tasks: [] },
    });

    const agents = report.places.find((place) => place.id === 'agents');
    expect(agents.status).toBe('attention');
    expect(agents.signalCount).toBe(2);
  });

  it('diffs places on a status flip, not on routine signal churn', () => {
    const first = observe({ source: { agents: [{ id: 'a', status: 'active' }], tasks: [] } });
    const churned = observe({
      source: { agents: [{ id: 'a', status: 'active' }, { id: 'b', status: 'active' }], tasks: [] },
      marker: first.marker,
    });
    // Counts move every wake as agents and tasks come and go; diffing them
    // would make `changes` noise instead of signal.
    expect(churned.report.changes.placesChanged).toEqual([]);

    const emptied = observe({ source: { agents: [], tasks: [] }, marker: first.marker });
    expect(emptied.report.changes.placesChanged).toContainEqual({ id: 'agents', was: 'active', now: 'quiet' });
  });

  it('surfaces only controllers that are actually failing, and stops re-alarming on the same one', () => {
    const installs = [
      { id: 'never-ticked', controllerId: 'lanternKeeper', armed: true, lastTickOk: null, consecutiveFailures: 0 },
      { id: 'healthy', controllerId: 'ambientBeacon', armed: true, lastTickOk: true, consecutiveFailures: 0 },
      { id: 'broken', controllerId: 'lanternKeeper', armed: false, lastTickOk: false, consecutiveFailures: 3, disarmedReason: 'repeated failures' },
    ];
    const first = observe({ controllerInstalls: installs });

    // A controller one interval away from its first tick is normal, not an alarm.
    expect(first.report.controllers.needsAttention.map((entry) => entry.id)).toEqual(['broken']);
    expect(first.report.changes.controllersNeedingAttention).toEqual([]);

    const { report: second } = observe({ controllerInstalls: installs, marker: first.marker });
    // Already known to be broken last visit — reporting it again every wake
    // would drown the genuinely new failure below it.
    expect(second.changes.controllersNeedingAttention).toEqual([]);

    const { report: third } = observe({
      controllerInstalls: [...installs, { id: 'newly-broken', controllerId: 'ambientBeacon', armed: true, lastTickOk: false, consecutiveFailures: 1 }],
      marker: first.marker,
    });
    expect(third.changes.controllersNeedingAttention).toEqual(['newly-broken']);
  });

  it('bounds the inherited list and says when it truncated', () => {
    const many = Array.from({ length: 30 }, (_, index) => inheritedFoundation(`peer:alpha:${index}`, PEER_ALPHA));
    const { report } = observe({ source: { peers: [peerSignal(PEER_ALPHA)] }, foundations: many });

    expect(report.foundations.inherited).toHaveLength(20);
    expect(report.foundations.inheritedTruncated).toBe(true);
    // The chamber count stays honest even though the list was cut.
    expect(report.peers[0].inheritedFoundations).toBe(30);
  });

  it('reports peers as unavailable rather than empty when the peer source failed', () => {
    const { report } = observe({ source: { peers: null } });
    expect(report.peers).toBeNull();
  });

  it('ignores a locally authored foundation when counting what a peer contributed', () => {
    const { report, marker } = observe({
      source: { peers: [peerSignal(PEER_ALPHA)] },
      foundations: [
        inheritedFoundation('peer:alpha:one', PEER_ALPHA),
        { id: 'local-one', kind: 'schema', title: 'Local build', layer: 'vernacular', updatedAt: OBSERVED_AT },
      ],
    });

    expect(report.foundations.inherited.map((entry) => entry.id)).toEqual(['peer:alpha:one']);
    expect(report.peers[0].inheritedFoundations).toBe(1);
    // The marker still tracks the locally authored one, so it is not reported
    // as a peer contribution but IS counted as already seen.
    expect(marker.foundationIds).toEqual(['local-one', 'peer:alpha:one']);
  });
});

describe('the places a mind is told it is standing in', () => {
  it('names the districts the SHIPPED design renders, not a retired version', () => {
    const { report } = buildEidoverseObservation({ observedAt: OBSERVED_AT, source: {} });

    // V3 renamed five districts. A mind that reports "Federation Harbor" is
    // describing a sign the world stopped rendering two design versions ago.
    const labels = Object.fromEntries(report.places.map((place) => [place.id, place.label]));
    expect(labels).toMatchObject({
      apps: 'App Arcade',
      memory: 'Memory Library',
      data: 'Data Depot',
      federation: 'Federation Terminal',
      activity: 'Activity Exchange',
    });
  });

  it('honors the install\'s own district set over the shipped one', () => {
    const { report } = buildEidoverseObservation({
      observedAt: OBSERVED_AT,
      districts: [{ id: 'yard', label: 'The Yard', direction: 'North', landmark: 'gate', sources: ['apps'] }],
      includes: { apps: true },
      source: { apps: [{ id: 'a', status: 'active' }] },
    });

    expect(report.places).toHaveLength(1);
    expect(report.places[0]).toMatchObject({ id: 'yard', label: 'The Yard', signalCount: 1, status: 'active' });
  });

  it('reports a source the recipe disabled as disabled, never as an empty district', () => {
    const { report } = buildEidoverseObservation({
      observedAt: OBSERVED_AT,
      includes: { apps: false, agents: true, tasks: true },
      source: { apps: [{ id: 'a', status: 'active' }], agents: [], tasks: [] },
    });

    const apps = report.places.find((place) => place.id === 'apps');
    // The projection places nothing for a disabled source, so counting its
    // signals would show the mind density the world does not have.
    expect(apps.disabledSources).toEqual(['apps']);
    expect(apps.signalCount).toBeNull();
    expect(apps.status).toBe('unknown');
  });
});

describe('a section that could not be read', () => {
  const withPeer = () => observe({
    source: { peers: [peerSignal(PEER_ALPHA)] },
    foundations: [inheritedFoundation('peer:alpha:one', PEER_ALPHA)],
    controllerInstalls: [{ id: 'broken', controllerId: 'lanternKeeper', armed: false, lastTickOk: false, consecutiveFailures: 2, disarmedReason: 'repeated failures' }],
  });

  it('does not report every peer as departed when the peer source failed', () => {
    const first = withPeer();
    const { report } = observe({ source: { peers: null }, marker: first.marker });

    // A transient collection failure is not the whole federation leaving.
    expect(report.peers).toBeNull();
    expect(report.changes.departedPeers).toEqual([]);
    expect(report.changes.newPeers).toEqual([]);
  });

  it('carries the previous marker forward so the next observation does not re-report everything as new', () => {
    const first = withPeer();
    const blind = observe({ source: { peers: null }, foundations: null, controllerInstalls: null, marker: first.marker });

    // The failure must not erase the trail...
    expect(blind.marker.peerIds).toEqual(first.marker.peerIds);
    expect(blind.marker.foundationIds).toEqual(first.marker.foundationIds);
    expect(blind.marker.attentionControllerIds).toEqual(first.marker.attentionControllerIds);

    // ...so when collection recovers, nothing flaps back to "new".
    const recovered = observe({
      source: { peers: [peerSignal(PEER_ALPHA)] },
      foundations: [inheritedFoundation('peer:alpha:one', PEER_ALPHA)],
      controllerInstalls: [{ id: 'broken', controllerId: 'lanternKeeper', armed: false, lastTickOk: false, consecutiveFailures: 2, disarmedReason: 'repeated failures' }],
      marker: blind.marker,
    });
    expect(recovered.report.changes.newPeers).toEqual([]);
    expect(recovered.report.changes.newFoundations).toEqual([]);
    expect(recovered.report.changes.controllersNeedingAttention).toEqual([]);
  });

  it('separates an unavailable controller list from one that is genuinely empty', () => {
    expect(observe({ controllerInstalls: null }).report.controllers.needsAttention).toBeNull();
    expect(observe({ controllerInstalls: [] }).report.controllers.needsAttention).toEqual([]);
  });

  it('still counts a district whose other sources read cleanly', () => {
    const { report } = observe({
      districts: [{ id: 'mix', label: 'Mix', direction: 'North', landmark: 'x', sources: ['apps', 'health'] }],
      includes: { apps: true, health: true },
      source: { apps: null, health: { status: 'healthy' } },
    });

    // One unreadable source must not discard a sibling's real signal; the
    // district says which source it could not read instead.
    expect(report.places[0]).toMatchObject({ signalCount: 1, status: 'active', unreadableSources: ['apps'] });
  });
});
