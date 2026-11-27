import {
  endlessChunkedRes,
  pushFromPairedPeer,
  tmp,
  acceptsPush,
  CURRENT_PORTOS_META,
  enableMusicVideoPeer,
  sampleOutline,
  installPeerSyncHooks,
} from './peerSync.test.fixture.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { PATHS } from '../../lib/fileUtils.js';
import { RECORD_KIND_SCHEMA_CATEGORIES, PORTOS_SCHEMA_VERSIONS, NON_RECORD_SCHEMA_CATEGORIES } from '../../lib/schemaVersions.js';
import {
  PEER_SUBSCRIBABLE_KINDS,
  subscribePeer,
  pushRecordToPeer,
  buildMediaLibraryManifest,
  syncMediaLibraryWithAllPeers,
} from './peerSync.js';
import { findPeerSubscription } from './peerSubscriptions.js';
import { libraryKindsExcludedByPatterns, syncMediaLibraryFromPeer } from './peerMediaLibrarySync.js';
import { buildPushPayload } from './peerSyncPush.js';
import { ENVELOPE_EXTENSIONS, ENVELOPE_PENDING_KEYS } from './peerSyncShared.js';
import { getPeers } from '../instances.js';
import { getUniverse, mergeUniversesFromSync } from '../universeBuilder.js';
import { getSeries, mergeSeriesFromSync } from '../pipeline/series.js';
import { listIssuesForSeries, mergeIssuesFromSync } from '../pipeline/issues.js';
import { getReview, mergeReviewFromSync } from '../pipeline/manuscriptReview.js';
import { getStoredOutline, mergeOutlineFromSync } from '../pipeline/reverseOutline.js';
import { getCollection, mergeMediaCollectionsFromSync } from '../mediaCollections.js';
import { getArtist, mergeArtistsFromSync } from '../artists/index.js';
import { getAlbum, mergeAlbumsFromSync } from '../albums/index.js';
import { getTrack, mergeTracksFromSync } from '../tracks/index.js';
import { getProject as getMusicVideoProject, mergeProjectsFromSync as mergeMusicVideoProjectsFromSync } from '../musicVideo/projects.js';
import { getAuthor, mergeAuthorsFromSync } from '../authors/index.js';
import {
  getProject as getCreativeDirectorProject,
  mergeProjectsFromSync as mergeCreativeDirectorProjectsFromSync,
} from '../creativeDirector/local.js';
import { getBoard, mergeBoardsFromSync } from '../moodBoard/index.js';
import { getLoom, mergeLoomsFromSync } from '../fableLoom/records.js';
import {
  getWorkForSync,
  mergeWorksFromSync,
  getFolderForSync,
  mergeFoldersFromSync,
  getExerciseForSync,
  mergeExercisesFromSync,
} from '../writersRoom/sync.js';
import { diffWorkBibleManifest } from '../writersRoom/bibleSync.js';
import { getCommissionFeedbackForSync, mergeCommissionFeedbackFromSync } from '../creativeCommissions/feedbackStore.js';
import { getCommissionForSync, mergeCommissionsFromSync } from '../creativeCommissions/store.js';
import { getDeckForSync, mergeDecksFromSync } from '../decks.js';
import { getStoryboardForSync, mergeStoryboardsFromSync } from '../storyboards/index.js';
import { peerFetch } from '../../lib/peerHttpClient.js';
import { reconcileMediaAssets } from '../mediaAssetIndex/index.js';
import { getBackendName } from '../memoryBackend.js';
import { getCatalogBundleForRef } from '../catalog/catalogDB.js';
import { applyRemoteChanges as applyCatalogRemoteChanges } from '../catalog/catalogSync.js';

installPeerSyncHooks();

// A receiver whose strict schema predates `key`: the 400 Zod emits for an
// unrecognized envelope key.
const legacyRejectsKey = (key) => {
  const rejection = { ok: false, status: 400, json: async () => ({
    code: 'VALIDATION_ERROR',
    message: 'Validation failed',
    context: { details: [{ path: '', message: `Unrecognized key(s) in object: '${key}'` }] },
  }) };
  rejection.clone = () => rejection;
  return rejection;
};

// A legacy peer for `key`: rejects every push carrying it, accepts the
// stripped retry.
const mockPeerRejecting = (key) => {
  vi.mocked(peerFetch).mockImplementation(async (_url, init) => (
    key in JSON.parse(init.body) ? legacyRejectsKey(key) : acceptsPush()
  ));
};

describe('peerSync', () => {
  // -------------------------------------------------------------------------
  // SCHEMA-VERSION GATING — sender side (handle 409 / cooldown / clear)
  // + receiver side (reject when sender ahead / pass through legacy + behind)
  // -------------------------------------------------------------------------
  describe('schema-version gating', () => {
    beforeEach(() => {
      // Earlier tests in this file accumulate calls on the merge mocks (the
      // file's outer beforeEach does mockResolvedValue but not mockClear).
      // Clear history so `expect(...).not.toHaveBeenCalled()` reflects only
      // calls made in the current test.
      vi.mocked(mergeUniversesFromSync).mockClear();
      vi.mocked(mergeSeriesFromSync).mockClear();
      vi.mocked(mergeIssuesFromSync).mockClear();
      vi.mocked(mergeMediaCollectionsFromSync).mockClear();
      vi.mocked(mergeMusicVideoProjectsFromSync).mockClear();
      vi.mocked(mergeTracksFromSync).mockClear();
    });

    // Fixtures derive from the live table so a schema bump can't silently turn
    // an "ahead"/"equal" sender into a "behind" one and disarm the gate.
    const versionsAhead = (bumps) => ({
      ...PORTOS_SCHEMA_VERSIONS,
      ...Object.fromEntries(Object.entries(bumps).map(([cat, n]) => [cat, PORTOS_SCHEMA_VERSIONS[cat] + n])),
    });

    describe('receiver — applyIncomingPush', () => {
      describe('Music Video previz compatibility', () => {
        const push = (record, version) => pushFromPairedPeer({
          kind: 'musicVideoProject',
          record,
          assetManifest: [],
          sourceInstanceId: 'peer-a',
          ...(version === undefined ? {} : { portosMeta: { schemaVersions: { musicVideoProjects: version } } }),
        });
        const updatedAt = '2026-06-29T00:00:00Z';

        it.each([53, undefined])('rejects a later legacy project edit before it can replace migrated previz (sender v%s)', async (version) => {
          await expect(push({
            id: 'mv-1',
            name: 'Renamed on the old peer',
            updatedAt,
            previz: { night: { startClock: 900, lengthMin: 60, beats: [] } },
          }, version)).rejects.toMatchObject({
            code: 'PEER_SYNC_SCHEMA_VERSION_AHEAD',
            details: {
              ahead: [],
              behind: [{ category: 'musicVideoProjects', senderV: version ?? 0, receiverV: PORTOS_SCHEMA_VERSIONS.musicVideoProjects }],
            },
          });
          expect(mergeMusicVideoProjectsFromSync).not.toHaveBeenCalled();
        });

        it('merges a live project edit from the first timeline-capable sender', async () => {
          const project = {
            id: 'mv-1',
            name: 'Renamed on a compatible peer',
            updatedAt,
            concept: { subjects: [{ id: 'car', kind: 'object', name: 'Car' }] },
            previz: { timeline: { startClock: 480, lengthMin: 60, beats: [] }, vehicles: [{ subjectId: 'car', speedMetersPerMin: 300 }] },
          };

          await push(project, 54);

          expect(mergeMusicVideoProjectsFromSync).toHaveBeenCalledWith([project], {
            source: { via: 'peer-push', peerId: 'peer-a' },
            senderSchemaVersions: { musicVideoProjects: 54 },
          });
        });

        it.each([53, undefined, PORTOS_SCHEMA_VERSIONS.musicVideoProjects + 1])('merges and acknowledges a project tombstone (sender v%s)', async (version) => {
          const tombstone = { id: 'mv-1', deleted: true, deletedAt: updatedAt, updatedAt };

          const result = await push(tombstone, version);

          expect(mergeMusicVideoProjectsFromSync).toHaveBeenCalledWith([tombstone], expect.any(Object));
          expect(result.ackedDeletesUpTo).toBe(Date.parse(updatedAt));
        });
      });

      it('rejects when sender schemaVersions.universes is AHEAD of local code', async () => {
        // A push from a sender one universes version ahead of local code must NOT touch local state.
        const rejection = await pushFromPairedPeer({
          kind: 'universe',
          record: { id: 'u1', name: 'Foo' },
          assetManifest: [],
          sourceInstanceId: 'peer-a',
          portosMeta: { portosVersion: '99.0.0', schemaVersions: versionsAhead({ universes: 1 }) },
        }).catch((err) => err);
        expect(rejection.code).toBe('PEER_SYNC_SCHEMA_VERSION_AHEAD');
        expect(rejection.details.ahead).toEqual([{ category: 'universes', senderV: PORTOS_SCHEMA_VERSIONS.universes + 1, receiverV: PORTOS_SCHEMA_VERSIONS.universes }]);
        expect(rejection.details.senderPortosVersion).toBe('99.0.0');
        // Receiver MUST stamp its OWN PortOS version so the sender can show
        // the user "peer X is on PortOS vY" — without this, the sender would
        // fall back to its own version (the one it sent) and mislabel the
        // peer in the SchemaGapBadge.
        expect(typeof rejection.details.receiverPortosVersion).toBe('string');
        expect(rejection.details.receiverPortosVersion.length).toBeGreaterThan(0);
        // mergeUniversesFromSync MUST NOT have been called — the gate runs
        // before the merge dispatch.
        expect(mergeUniversesFromSync).not.toHaveBeenCalled();
      });

      it('passes through when sender schemaVersions are EQUAL to local', async () => {
        await pushFromPairedPeer({
          kind: 'universe',
          record: { id: 'u1', name: 'Foo' },
          assetManifest: [],
          sourceInstanceId: 'peer-a',
          portosMeta: { portosVersion: '2.7.0', schemaVersions: { ...PORTOS_SCHEMA_VERSIONS } },
        });
        expect(mergeUniversesFromSync).toHaveBeenCalledWith(
          [expect.objectContaining({ id: 'u1' })],
          { source: { via: 'peer-push', peerId: 'peer-a' }, senderSchemaVersions: { ...PORTOS_SCHEMA_VERSIONS } },
        );
      });

      it('passes through when sender is BEHIND local (sanitizer handles the backfill)', async () => {
        // Older peer pushes a v4-shape universe. Receiver is on v6 but the
        // record-shape sanitizer can backfill, so we apply rather than reject.
        await pushFromPairedPeer({
          kind: 'universe',
          record: { id: 'u1', name: 'Foo' },
          assetManifest: [],
          sourceInstanceId: 'peer-a',
          portosMeta: { portosVersion: '2.6.0', schemaVersions: { universes: 4, musicVideoProjects: 53 } },
        });
        expect(mergeUniversesFromSync).toHaveBeenCalledWith(
          [expect.objectContaining({ id: 'u1' })],
          { source: { via: 'peer-push', peerId: 'peer-a' }, senderSchemaVersions: { universes: 4, musicVideoProjects: 53 } },
        );
      });

      it('passes through legacy peers that send NO portosMeta at all', async () => {
        // Backwards compat — pre-this-PR peers don't know to include the
        // envelope. The comparator treats absent sender versions as 0, which
        // either matches (receiver also 0 for the category) or surfaces as
        // "behind" (which we DON'T gate on).
        await pushFromPairedPeer({
          kind: 'universe',
          record: { id: 'u1', name: 'Foo' },
          assetManifest: [],
          sourceInstanceId: 'peer-a',
        });
        expect(mergeUniversesFromSync).toHaveBeenCalled();
      });

      // ---- per-category gate: cross-key isolation -------------------------
      // The sender stamps its full schemaVersions map. A push must only be
      // gated on the categories THIS record actually writes.
      it('does NOT reject a universe push when the sender is ahead on mediaCollections only', async () => {
        // universes is equal; the sender bumped an unrelated category. The old
        // whole-payload gate would have rejected this universe push.
        await pushFromPairedPeer({
          kind: 'universe',
          record: { id: 'u1', name: 'Foo' },
          assetManifest: [],
          sourceInstanceId: 'peer-a',
          portosMeta: { portosVersion: '99.0.0', schemaVersions: versionsAhead({ mediaCollections: 1 }) },
        });
        expect(mergeUniversesFromSync).toHaveBeenCalledWith(
          [expect.objectContaining({ id: 'u1' })],
          { source: { via: 'peer-push', peerId: 'peer-a' }, senderSchemaVersions: versionsAhead({ mediaCollections: 1 }) },
        );
      });

      it('does NOT reject a series push with NO bundled issues when the sender is ahead on pipelineIssues only', async () => {
        // No issues ride along, so pipelineIssues is not a transferred category.
        await pushFromPairedPeer({
          kind: 'series',
          record: { id: 'ser-1', name: 'Foo' },
          assetManifest: [],
          sourceInstanceId: 'peer-a',
          portosMeta: { portosVersion: '99.0.0', schemaVersions: versionsAhead({ pipelineIssues: 1 }) },
        });
        expect(mergeSeriesFromSync).toHaveBeenCalled();
        expect(mergeIssuesFromSync).not.toHaveBeenCalled();
      });

      it('DOES reject a series push WITH bundled issues when the sender is ahead on pipelineIssues', async () => {
        // Issues are being transferred, so a pipelineIssues ahead-mismatch must
        // gate the push — otherwise the receiver merges issues it can't parse.
        const rejection = await pushFromPairedPeer({
          kind: 'series',
          record: { id: 'ser-1', name: 'Foo' },
          issues: [{ id: 'i1', seriesId: 'ser-1', deleted: false, deletedAt: null }],
          assetManifest: [],
          sourceInstanceId: 'peer-a',
          portosMeta: { portosVersion: '99.0.0', schemaVersions: versionsAhead({ pipelineIssues: 1 }) },
        }).catch((err) => err);
        expect(rejection.code).toBe('PEER_SYNC_SCHEMA_VERSION_AHEAD');
        expect(rejection.details.ahead).toEqual([{ category: 'pipelineIssues', senderV: PORTOS_SCHEMA_VERSIONS.pipelineIssues + 1, receiverV: PORTOS_SCHEMA_VERSIONS.pipelineIssues }]);
        expect(mergeSeriesFromSync).not.toHaveBeenCalled();
        expect(mergeIssuesFromSync).not.toHaveBeenCalled();
      });

      it('DOES reject a universe push WITH a bundled linkedCollection when the sender is ahead on mediaCollections', async () => {
        // The linked collection is a transferred category, so a mediaCollections
        // ahead-mismatch must gate even though universes is equal.
        const rejection = await pushFromPairedPeer({
          kind: 'universe',
          record: { id: 'u1', name: 'Foo' },
          linkedCollection: { id: 'col-1', name: 'Universe: U', items: [] },
          assetManifest: [],
          sourceInstanceId: 'peer-a',
          portosMeta: { portosVersion: '99.0.0', schemaVersions: versionsAhead({ mediaCollections: 1 }) },
        }).catch((err) => err);
        expect(rejection.code).toBe('PEER_SYNC_SCHEMA_VERSION_AHEAD');
        expect(rejection.details.ahead).toEqual([{ category: 'mediaCollections', senderV: PORTOS_SCHEMA_VERSIONS.mediaCollections + 1, receiverV: PORTOS_SCHEMA_VERSIONS.mediaCollections }]);
        expect(mergeUniversesFromSync).not.toHaveBeenCalled();
        expect(mergeMediaCollectionsFromSync).not.toHaveBeenCalled();
      });

      it('DOES reject a music-video push WITH a live linkedTrack when the sender is ahead on tracks', async () => {
        const rejection = await pushFromPairedPeer({
          kind: 'musicVideoProject',
          record: { id: 'mv-1', trackId: 'track-1', deleted: false, deletedAt: null },
          linkedTrack: { id: 'track-1', title: 'Linked', deleted: false, deletedAt: null },
          assetManifest: [],
          sourceInstanceId: 'peer-a',
          portosMeta: {
            portosVersion: '99.0.0',
            schemaVersions: { ...PORTOS_SCHEMA_VERSIONS, tracks: PORTOS_SCHEMA_VERSIONS.tracks + 1 },
          },
        }).catch((err) => err);
        expect(rejection.code).toBe('PEER_SYNC_SCHEMA_VERSION_AHEAD');
        expect(rejection.details.ahead).toEqual([
          { category: 'tracks', senderV: PORTOS_SCHEMA_VERSIONS.tracks + 1, receiverV: PORTOS_SCHEMA_VERSIONS.tracks },
        ]);
        expect(mergeMusicVideoProjectsFromSync).not.toHaveBeenCalled();
        expect(mergeTracksFromSync).not.toHaveBeenCalled();
      });

      it.each([
        ['is a tombstone', { id: 'track-1', deleted: true, deletedAt: '2026-06-29T00:00:00Z' }],
        ['does not match the project trackId', { id: 'other-track', title: 'Unbound', deleted: false, deletedAt: null }],
      ])('does NOT gate a bundled linkedTrack that %s when the sender is ahead on tracks', async (_label, linkedTrack) => {
        await pushFromPairedPeer({
          kind: 'musicVideoProject',
          record: { id: 'mv-1', trackId: 'track-1', deleted: false, deletedAt: null },
          linkedTrack,
          assetManifest: [],
          sourceInstanceId: 'peer-a',
          portosMeta: {
            portosVersion: '99.0.0',
            schemaVersions: { ...PORTOS_SCHEMA_VERSIONS, tracks: PORTOS_SCHEMA_VERSIONS.tracks + 1 },
          },
        });
        // Goes through the record-kind table (#6843), which passes
        // senderSchemaVersions uniformly (harmless for musicVideoProject —
        // ignored).
        expect(mergeMusicVideoProjectsFromSync).toHaveBeenCalledWith(
          [expect.objectContaining({ id: 'mv-1' })],
          expect.objectContaining({ source: { via: 'peer-push', peerId: 'peer-a' } }),
        );
      });

      // ---- tombstone-aware per-category scoping --------------------------
      it('does NOT reject a pure tombstone push even when the sender is ahead on that record kind (delete converges)', async () => {
        // A tombstone carries only id+deleted+deletedAt+updatedAt — safe at any
        // schema version. Gating it would strand federated deletes when one peer
        // upgrades ahead. The merge still runs (the delete must land).
        await pushFromPairedPeer({
          kind: 'universe',
          record: { id: 'u1', deleted: true, deletedAt: '2026-05-22T03:00:00Z' },
          assetManifest: [],
          sourceInstanceId: 'peer-a',
          portosMeta: { portosVersion: '99.0.0', schemaVersions: versionsAhead({ universes: 1 }) },
        });
        expect(mergeUniversesFromSync).toHaveBeenCalledWith(
          [expect.objectContaining({ id: 'u1', deleted: true })],
          { source: { via: 'peer-push', peerId: 'peer-a' }, senderSchemaVersions: versionsAhead({ universes: 1 }) },
        );
      });

      it('DOES reject a deleted-series push that bundles a LIVE issue when the sender is ahead on pipelineIssues', async () => {
        // deleteSeries does not cascade-tombstone child issues, and the push
        // bundles every child — so a deleted series can carry full-shape LIVE
        // issues. The series tombstone alone is safe, but the live issues are
        // NOT; gate pipelineIssues so they can't corrupt an older receiver.
        const rejection = await pushFromPairedPeer({
          kind: 'series',
          record: { id: 'ser-1', deleted: true, deletedAt: '2026-05-22T03:00:00Z' },
          issues: [{ id: 'i1', seriesId: 'ser-1', deleted: false, deletedAt: null }],
          assetManifest: [],
          sourceInstanceId: 'peer-a',
          portosMeta: { portosVersion: '99.0.0', schemaVersions: versionsAhead({ pipelineIssues: 1 }) },
        }).catch((err) => err);
        expect(rejection.code).toBe('PEER_SYNC_SCHEMA_VERSION_AHEAD');
        expect(rejection.details.ahead).toEqual([{ category: 'pipelineIssues', senderV: PORTOS_SCHEMA_VERSIONS.pipelineIssues + 1, receiverV: PORTOS_SCHEMA_VERSIONS.pipelineIssues }]);
        expect(mergeSeriesFromSync).not.toHaveBeenCalled();
        expect(mergeIssuesFromSync).not.toHaveBeenCalled();
      });

      it('does NOT reject a deleted-series push whose bundled issues are ALL tombstones (cascade delete converges)', async () => {
        // Series tombstone + issue tombstones only — no live record in any
        // category, so nothing gates and the whole delete cascade converges
        // even though the sender is ahead on both pipelineSeries and pipelineIssues.
        await pushFromPairedPeer({
          kind: 'series',
          record: { id: 'ser-1', deleted: true, deletedAt: '2026-05-22T03:00:00Z' },
          issues: [{ id: 'i1', seriesId: 'ser-1', deleted: true, deletedAt: '2026-05-22T03:00:00Z' }],
          assetManifest: [],
          sourceInstanceId: 'peer-a',
          portosMeta: { portosVersion: '99.0.0', schemaVersions: versionsAhead({ pipelineSeries: 1, pipelineIssues: 1 }) },
        });
        expect(mergeSeriesFromSync).toHaveBeenCalled();
        expect(mergeIssuesFromSync).toHaveBeenCalledWith(
          [expect.objectContaining({ id: 'i1', deleted: true })],
          {
            source: { via: 'peer-push', peerId: 'peer-a' },
            senderSchemaVersions: versionsAhead({ pipelineSeries: 1, pipelineIssues: 1 }),
          },
        );
      });
    });

    describe('gate-map completeness (fail-open guard)', () => {
      it('every PEER_SUBSCRIBABLE_KIND resolves to a schema-category mapping', () => {
        // A new push kind that writes a versioned layout must be added to
        // RECORD_KIND_SCHEMA_CATEGORIES, or its push would bypass the gate
        // entirely (silent cross-install corruption). `mediaCollection` maps
        // via the same key; series issues are unioned at the call site.
        for (const kind of PEER_SUBSCRIBABLE_KINDS) {
          expect(Array.isArray(RECORD_KIND_SCHEMA_CATEGORIES[kind])).toBe(true);
          expect(RECORD_KIND_SCHEMA_CATEGORIES[kind].length).toBeGreaterThan(0);
        }
      });

      it('every versioned PORTOS_SCHEMA_VERSIONS key is reachable from a record kind', () => {
        // So a newly-versioned category can't ship without being wired into the
        // per-category gate (which would leave its transfers ungated). The only
        // exemptions are categories explicitly declared as non-record (pull-gated
        // elsewhere) via NON_RECORD_SCHEMA_CATEGORIES — e.g. mediaLibrary (#1566).
        const covered = new Set(Object.values(RECORD_KIND_SCHEMA_CATEGORIES).flat());
        for (const key of Object.keys(PORTOS_SCHEMA_VERSIONS)) {
          if (NON_RECORD_SCHEMA_CATEGORIES.has(key)) continue;
          expect(covered.has(key)).toBe(true);
        }
      });

      it('keeps the Tribe graph + universe render-runs + activity timeline + operator-action ledger + feature usage intentionally OUT of the sync graph (#1724, #2150, #5594, #18523)', () => {
        // ADR 2026-06-26: tribe_* and universe_runs are deliberately machine-local.
        // - Tribe is relationship-graph data (mirrors the deliberate "memory_links
        //   are instance-local" policy in memorySync.js) and is coupled to
        //   machine-local calendar-account refs on touchpoints.
        // - universe_runs is a regenerable render cache under a 200-row GLOBAL cap
        //   that two producers would mutually evict; the durable universe record
        //   already federates.
        // - human_activity_events (#2150) is coupled to per-machine accounts and OS
        //   databases; only DERIVED summaries (Brain journals, digital-twin) federate,
        //   never the raw events. Same machine-local boundary per the ADR.
        // - user_action_events (#5594) is the operator-action ledger: what ONE human
        //   did on ONE machine, with task prompts and settings diffs attached. PII
        //   must not ride the federation layer at all (ADR
        //   2026-08-08-privacy-records-machine-local), and a peer has no use for a
        //   record of a button someone pressed on another install.
        // - feature_usage_days (#18523) counts which pages ONE human focused on ONE machine; the tiers
        //   derived from it describe that install only, so the counts never cross the wire.
        // This guard pins that decision: federating any of them later is a conscious
        // act — wire the kind AND update this assertion + the ADR together.
        const localOnlyKinds = ['tribe', 'tribePerson', 'tribeTouchpoint', 'tribeMemoryLink', 'tribeIdentity', 'universeRun', 'humanActivityEvent', 'userActionEvent', 'featureUsageDay'];
        for (const kind of localOnlyKinds) {
          expect(PEER_SUBSCRIBABLE_KINDS).not.toContain(kind);
          expect(RECORD_KIND_SCHEMA_CATEGORIES[kind]).toBeUndefined();
        }
        const localOnlyCategories = ['tribe', 'tribePeople', 'tribeTouchpoints', 'tribeMemoryLinks', 'tribeIdentities', 'universeRuns', 'humanActivityEvents', 'userActionEvents', 'featureUsage', 'featureUsageDays'];
        for (const category of localOnlyCategories) {
          expect(PORTOS_SCHEMA_VERSIONS[category]).toBeUndefined();
          expect(NON_RECORD_SCHEMA_CATEGORIES.has(category)).toBe(false);
        }
      });
    });

    describe('sender — pushRecordToPeer', () => {
      it('stamps portosMeta on the outbound push payload', async () => {
        vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
        vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({}) });
        await pushRecordToPeer({
          id: 's-meta', peerId: 'peer-a', recordKind: 'universe', recordId: 'u1',
        });
        const call = vi.mocked(peerFetch).mock.calls.at(-1);
        expect(call).toBeDefined();
        const body = JSON.parse(call[1].body);
        expect(body.portosMeta).toBeDefined();
        expect(body.portosMeta.schemaVersions.universes).toBe(22);
        expect(typeof body.portosMeta.portosVersion).toBe('string');
      });

      it('records a blockedBySchema marker on the subscription when the peer responds 409', async () => {
        vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
        // Receiver claims it's on universes:4 + PortOS 2.5.0; sender is at 5.
        // `receiverPortosVersion` is the rejecting peer's version — that's
        // the label the sender persists as `peerPortosVersion`.
        vi.mocked(peerFetch).mockResolvedValue({
          ok: false,
          status: 409,
          json: async () => ({
            error: 'sender schema is ahead',
            code: 'PEER_SYNC_SCHEMA_VERSION_AHEAD',
            context: {
              details: {
                ahead: [{ category: 'universes', senderV: 5, receiverV: 4 }],
                behind: [],
                senderPortosVersion: '3.0.0',
                receiverPortosVersion: '2.5.0',
                receiverSchemaVersions: { universes: 4 },
              },
            },
          }),
        });
        // Subscribe first so we have a sub record to assert against.
        const sub = await subscribePeer({
          peerId: 'peer-a', recordKind: 'universe', recordId: 'u1',
        }, { adoptedFromReverse: true });
        const result = await pushRecordToPeer(sub);
        expect(result.pushed).toBe(false);
        expect(result.reason).toBe('peer-schema-behind');
        expect(result.blockedBySchema).toBe(true);
        // Block persisted on the subscription.
        const after = await findPeerSubscription('peer-a', 'universe', 'u1');
        expect(after.blockedBySchema).toBeDefined();
        expect(after.blockedBySchema.ahead).toEqual([{ category: 'universes', senderV: 5, receiverV: 4 }]);
        expect(after.blockedBySchema.peerPortosVersion).toBe('2.5.0');
        expect(after.blockedBySchema.peerSchemaVersions).toEqual({ universes: 4 });
        expect(typeof after.blockedBySchema.detectedAt).toBe('string');
        // lastPushedHash must NOT have advanced — the record didn't land.
        expect(after.lastPushedHash).toBeFalsy();
      });

      it('points to the peer on a mixed refusal and preserves the behind diagnostic', async () => {
        vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
        vi.mocked(peerFetch).mockResolvedValue({
          ok: false,
          status: 409,
          json: async () => ({
            code: 'PEER_SYNC_SCHEMA_VERSION_AHEAD',
            context: {
              details: {
                ahead: [{ category: 'universes', senderV: 5, receiverV: 4 }],
                behind: [{ category: 'series', senderV: 2, receiverV: 3 }],
              },
            },
          }),
        });
        const sub = await subscribePeer({
          peerId: 'peer-a', recordKind: 'universe', recordId: 'u1',
        }, { adoptedFromReverse: true });
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
          expect(await pushRecordToPeer(sub)).toMatchObject({ reason: 'peer-schema-behind', blockedBySchema: true });
          expect(log).toHaveBeenCalledWith(expect.stringContaining('Update the peer’s PortOS to resume sync. sender ahead of receiver on universes'));
          expect(log).not.toHaveBeenCalledWith(expect.stringContaining('Update this PortOS'));
        } finally {
          log.mockRestore();
        }
        const after = await findPeerSubscription('peer-a', 'universe', 'u1');
        expect(after.blockedBySchema.behind).toEqual([{ category: 'series', senderV: 2, receiverV: 3 }]);
        expect(after.blockedBySchema.peerPortosVersion).toBeNull();
        expect(after.blockedBySchema.peerSchemaVersions).toBeNull();
      });

      it('points to this install when the peer refuses a universe push over a behind-only catalog gap', async () => {
        vi.mocked(getBackendName).mockReturnValue('postgres');
        vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
        vi.mocked(getCatalogBundleForRef).mockResolvedValue({
          ingredients: [{ id: 'example-object', type: 'object', payload: { name: 'Example' } }],
          refs: [],
        });
        const senderV = PORTOS_SCHEMA_VERSIONS.catalog;
        const receiverV = senderV + 1;
        const behind = [{ category: 'catalog', senderV, receiverV }];
        vi.mocked(peerFetch).mockResolvedValue({
          ok: false,
          status: 409,
          json: async () => ({
            code: 'PEER_SYNC_SCHEMA_VERSION_AHEAD',
            context: { details: { ahead: [], behind, receiverPortosVersion: '3.0.0' } },
          }),
        });
        const sub = await subscribePeer({
          peerId: 'peer-a', recordKind: 'universe', recordId: 'u1',
        }, { adoptedFromReverse: true });
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
          expect(await pushRecordToPeer(sub)).toEqual({
            pushed: false, reason: 'local-schema-behind', blockedBySchema: true,
          });
          expect(log).toHaveBeenCalledWith(expect.stringContaining(
            `Update this PortOS to resume sync. sender behind receiver on catalog (v${senderV} vs v${receiverV})`,
          ));
        } finally {
          log.mockRestore();
        }
        const payload = JSON.parse(vi.mocked(peerFetch).mock.calls[0][1].body);
        expect(payload.catalogBundle.ingredients).toHaveLength(1);
        const blocked = await findPeerSubscription('peer-a', 'universe', 'u1');
        expect(blocked.blockedBySchema).toMatchObject({ ahead: [], behind, peerPortosVersion: '3.0.0' });
        expect(blocked.lastPushedHash).toBeFalsy();
        expect(await pushRecordToPeer(blocked)).toEqual({
          pushed: false, reason: 'local-schema-behind-cooldown', blockedBySchema: true,
        });
        expect(peerFetch).toHaveBeenCalledTimes(1);
      });

      it('reports a 409 without the schema code as a plain http-409 (no schema block)', async () => {
        vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
        vi.mocked(peerFetch).mockResolvedValue({
          ok: false,
          status: 409,
          json: async () => ({ code: 'SOME_OTHER_CONFLICT', error: 'conflict' }),
        });
        const sub = await subscribePeer({
          peerId: 'peer-a', recordKind: 'universe', recordId: 'u1',
        }, { adoptedFromReverse: true });
        const result = await pushRecordToPeer(sub);
        expect(result).toEqual({ pushed: false, reason: 'http-409' });
        const after = await findPeerSubscription('peer-a', 'universe', 'u1');
        expect(after.blockedBySchema).toBeUndefined();
      });

      it('short-circuits subsequent pushes for blocked subs within the cooldown window', async () => {
        vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
        // First push gets the 409.
        vi.mocked(peerFetch).mockResolvedValue({
          ok: false,
          status: 409,
          json: async () => ({
            code: 'PEER_SYNC_SCHEMA_VERSION_AHEAD',
            context: {
              details: {
                ahead: [{ category: 'universes', senderV: 5, receiverV: 4 }],
                senderPortosVersion: '2.5.0',
              },
            },
          }),
        });
        const sub = await subscribePeer({
          peerId: 'peer-a', recordKind: 'universe', recordId: 'u1',
        }, { adoptedFromReverse: true });
        await pushRecordToPeer(sub);
        const fetchCallsAfterFirst = vi.mocked(peerFetch).mock.calls.length;
        // Re-load the sub with the persisted block, then push again with NO
        // bypass — should not hit the network.
        const blocked = await findPeerSubscription('peer-a', 'universe', 'u1');
        const result = await pushRecordToPeer(blocked);
        expect(result.pushed).toBe(false);
        expect(result.reason).toBe('peer-schema-behind-cooldown');
        expect(vi.mocked(peerFetch).mock.calls.length).toBe(fetchCallsAfterFirst);
      });

      it('bypasses the schema cooldown for tombstone pushes so deletes converge immediately', async () => {
        vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
        vi.mocked(peerFetch).mockResolvedValueOnce({
          ok: false,
          status: 409,
          json: async () => ({
            code: 'PEER_SYNC_SCHEMA_VERSION_AHEAD',
            context: {
              details: { ahead: [{ category: 'universes', senderV: 5, receiverV: 4 }] },
            },
          }),
        });
        const sub = await subscribePeer({
          peerId: 'peer-a', recordKind: 'universe', recordId: 'u1',
        }, { adoptedFromReverse: true });
        await pushRecordToPeer(sub);
        const blocked = await findPeerSubscription('peer-a', 'universe', 'u1');
        vi.mocked(getUniverse).mockResolvedValue({
          id: 'u1',
          name: 'Foo',
          deleted: true,
          deletedAt: '2026-05-23T00:00:00.000Z',
          updatedAt: '2026-05-23T00:00:00.000Z',
        });
        vi.mocked(peerFetch).mockResolvedValueOnce({ ok: true, json: async () => ({ missingAssets: [] }) });

        const result = await pushRecordToPeer(blocked);

        expect(result.pushed).toBe(true);
        const body = JSON.parse(vi.mocked(peerFetch).mock.calls.at(-1)[1].body);
        expect(body.record.deleted).toBe(true);
        expect(body.assetManifest).toEqual([]);
      });

      it('bypassSchemaCooldown=true re-probes regardless of recent block', async () => {
        // Simulates the peer:online path: retryPendingPushesForPeer passes
        // bypassSchemaCooldown so the next probe actually hits the wire even
        // if a recent 409 set the cooldown.
        vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
        vi.mocked(peerFetch).mockResolvedValue({
          ok: false, status: 409,
          json: async () => ({
            code: 'PEER_SYNC_SCHEMA_VERSION_AHEAD',
            context: { details: { ahead: [{ category: 'universes', senderV: 5, receiverV: 4 }] } },
          }),
        });
        const sub = await subscribePeer({
          peerId: 'peer-a', recordKind: 'universe', recordId: 'u1',
        }, { adoptedFromReverse: true });
        await pushRecordToPeer(sub);
        const callsAfterFirst = vi.mocked(peerFetch).mock.calls.length;
        const blocked = await findPeerSubscription('peer-a', 'universe', 'u1');
        await pushRecordToPeer(blocked, { bypassSchemaCooldown: true });
        expect(vi.mocked(peerFetch).mock.calls.length).toBe(callsAfterFirst + 1);
      });

      it('clears blockedBySchema once a subsequent push succeeds (peer upgraded)', async () => {
        vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
        // First push: 409.
        vi.mocked(peerFetch).mockResolvedValueOnce({
          ok: false, status: 409,
          json: async () => ({
            code: 'PEER_SYNC_SCHEMA_VERSION_AHEAD',
            context: { details: { ahead: [{ category: 'universes', senderV: 5, receiverV: 4 }], senderPortosVersion: '2.5.0' } },
          }),
        });
        // Second push: peer upgraded, accepts.
        vi.mocked(peerFetch).mockResolvedValueOnce({ ok: true, json: async () => ({}) });
        const sub = await subscribePeer({
          peerId: 'peer-a', recordKind: 'universe', recordId: 'u1',
        }, { adoptedFromReverse: true });
        await pushRecordToPeer(sub);
        expect((await findPeerSubscription('peer-a', 'universe', 'u1')).blockedBySchema).toBeDefined();
        // Bypass cooldown to simulate a peer:online retry.
        const blocked = await findPeerSubscription('peer-a', 'universe', 'u1');
        await pushRecordToPeer(blocked, { bypassSchemaCooldown: true });
        const cleared = await findPeerSubscription('peer-a', 'universe', 'u1');
        expect(cleared.blockedBySchema).toBeUndefined();
        expect(cleared.lastPushedHash).toBeTruthy(); // succeeded → hash recorded
      });

      // #3928 — the legacy-stripped water-mark. Withholding `lastPushedHash`
      // after a strip (pinned per row in 'envelope extensions (#6844)') is what
      // keeps the stripped key deliverable, but on its own it made EVERY
      // subsequent cycle re-run the 400 + stripped-retry pair forever.
      // `lastPushedLegacyHash` records the full payload hash we delivered in
      // stripped form so an unchanged record settles; these two cases cover
      // what moves it again.
      it('re-pushes when the bundled review actually changes after a stripped push (#3928)', async () => {
        vi.mocked(getSeries).mockResolvedValue({ id: 'ser-1', name: 'Series' });
        vi.mocked(listIssuesForSeries).mockResolvedValue([{ id: 'i1', seriesId: 'ser-1', number: 1 }]);
        vi.mocked(getReview).mockResolvedValue({
          schemaVersion: 1,
          comments: [{ id: 'mrc-1', problem: 'pacing', status: 'open', updatedAt: '2026-06-02T00:00:00Z' }],
        });
        mockPeerRejecting('manuscriptReview');
        const sub = await subscribePeer({
          peerId: 'peer-a', recordKind: 'series', recordId: 'ser-1',
        }, { adoptedFromReverse: true });
        const first = await pushRecordToPeer(sub);
        const callsAfterFirst = vi.mocked(peerFetch).mock.calls.length;
        // The user resolves the comment — the review content moved, so the
        // water-mark must NOT hold the push back.
        vi.mocked(getReview).mockResolvedValue({
          schemaVersion: 1,
          comments: [{ id: 'mrc-1', problem: 'pacing', status: 'resolved', updatedAt: '2026-06-03T00:00:00Z' }],
        });
        const second = await pushRecordToPeer(await findPeerSubscription('peer-a', 'series', 'ser-1'));
        expect(second.pushed).toBe(true);
        expect(second.hash).not.toBe(first.hash);
        expect(vi.mocked(peerFetch).mock.calls.length).toBe(callsAfterFirst + 2);
        const refreshed = await findPeerSubscription('peer-a', 'series', 'ser-1');
        expect(refreshed.lastPushedLegacyHash).toBe(second.hash);
      });

      it('re-attempts the full push on a peer:online re-probe even when the legacy hash matches (#3928)', async () => {
        vi.mocked(getSeries).mockResolvedValue({ id: 'ser-1', name: 'Series' });
        vi.mocked(listIssuesForSeries).mockResolvedValue([{ id: 'i1', seriesId: 'ser-1', number: 1 }]);
        vi.mocked(getReview).mockResolvedValue({
          schemaVersion: 1,
          comments: [{ id: 'mrc-1', problem: 'pacing', status: 'open', updatedAt: '2026-06-02T00:00:00Z' }],
        });
        mockPeerRejecting('manuscriptReview');
        const sub = await subscribePeer({
          peerId: 'peer-a', recordKind: 'series', recordId: 'ser-1',
        }, { adoptedFromReverse: true });
        await pushRecordToPeer(sub);
        // The peer upgraded and came back online — it now accepts the review.
        vi.mocked(peerFetch).mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({}) }));
        const upgraded = await pushRecordToPeer(
          await findPeerSubscription('peer-a', 'series', 'ser-1'),
          { bypassSchemaCooldown: true },
        );
        expect(upgraded.pushed).toBe(true);
        const payload = JSON.parse(vi.mocked(peerFetch).mock.calls.at(-1)[1].body);
        expect(payload.manuscriptReview).toBeDefined();
        // Fully delivered → the normal hash takes over and the legacy
        // water-mark clears.
        const refreshed = await findPeerSubscription('peer-a', 'series', 'ser-1');
        expect(refreshed.lastPushedHash).toBe(upgraded.hash);
        expect(refreshed.lastPushedLegacyHash).toBeFalsy();
      });

      it('does NOT retry on a 400 whose validation error is unrelated to portosMeta', async () => {
        // The retry is keyed on the `portosMeta` mention in the validation
        // details — any other 400 (oversized field, unknown record key, etc.)
        // is a genuine bug we want to surface, not silently retry.
        vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
        const errBody = { ok: false, status: 400, json: async () => ({
          code: 'VALIDATION_ERROR',
          message: 'Validation failed',
          context: { details: [{ path: 'record.name', message: 'String too long' }] },
        }) };
        errBody.clone = () => errBody;
        vi.mocked(peerFetch).mockResolvedValueOnce(errBody);
        const sub = await subscribePeer({
          peerId: 'peer-a', recordKind: 'universe', recordId: 'u1',
        }, { adoptedFromReverse: true });
        const result = await pushRecordToPeer(sub);
        expect(result.pushed).toBe(false);
        expect(result.reason).toBe('http-400');
        // Only ONE call — no retry.
        expect(vi.mocked(peerFetch).mock.calls.length).toBe(1);
      });

      it('records a peer-pre-feature blockedBySchema marker when a peer rejects an unknown record kind (400 invalid discriminator)', async () => {
        // A peer on an older PortOS whose `peerSyncPushSchema` discriminated
        // union has no arm for this record kind (authors / mediaCollection when
        // they first landed) rejects the push at Zod with a generic 400 whose
        // offending field is the `kind` discriminator — BEFORE its version gate
        // (the 409 path) ever runs. The sender must NOT treat this as a bare
        // http-400 (which churns silently); it routes the sub into an empty-gap
        // schema-version block so the SchemaGapBadge surfaces "peer needs to
        // update" and the edit-push cooldown engages, exactly like the 409 path.
        vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
        const errBody = { ok: false, status: 400, json: async () => ({
          code: 'VALIDATION_ERROR',
          message: 'Validation failed',
          context: { details: [{ path: 'kind', message: "Invalid discriminator value. Expected 'universe' | 'series'" }] },
        }) };
        errBody.clone = () => errBody;
        vi.mocked(peerFetch).mockResolvedValueOnce(errBody);
        const sub = await subscribePeer({
          peerId: 'peer-a', recordKind: 'universe', recordId: 'u1',
        }, { adoptedFromReverse: true });
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const result = await pushRecordToPeer(sub);
        // A peer that is merely behind is handled by the persisted block: stdout, not stderr.
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("doesn't recognize the 'universe' record kind"));
        expect(warnSpy).not.toHaveBeenCalled();
        logSpy.mockRestore();
        warnSpy.mockRestore();
        expect(result.pushed).toBe(false);
        expect(result.reason).toBe('peer-schema-behind');
        expect(result.blockedBySchema).toBe(true);
        // No retry — the kind itself is unrecognized, so re-sending changes nothing.
        expect(vi.mocked(peerFetch).mock.calls.length).toBe(1);
        // Block persisted with the pre-feature marker + an empty gap (the peer
        // 400'd before sending any schemaVersions to populate ahead/behind).
        const after = await findPeerSubscription('peer-a', 'universe', 'u1');
        expect(after.blockedBySchema).toBeDefined();
        expect(after.blockedBySchema.reason).toBe('peer-pre-feature');
        expect(after.blockedBySchema.ahead).toEqual([]);
        expect(after.blockedBySchema.behind).toEqual([]);
        expect(after.blockedBySchema.peerPortosVersion).toBeNull();
        expect(typeof after.blockedBySchema.detectedAt).toBe('string');
        // lastPushedHash must NOT have advanced — the record didn't land.
        expect(after.lastPushedHash).toBeFalsy();
      });

      it('engages the push cooldown after a pre-feature block so the next edit-push short-circuits', async () => {
        // The pre-feature block must behave like the 409 block: a subsequent
        // push (no bypass) short-circuits on the cooldown instead of re-probing
        // the peer on every local edit.
        vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
        const errBody = { ok: false, status: 400, json: async () => ({
          code: 'VALIDATION_ERROR',
          message: 'Validation failed',
          context: { details: [{ path: 'kind', message: 'Invalid discriminator value. Expected ...' }] },
        }) };
        errBody.clone = () => errBody;
        vi.mocked(peerFetch).mockResolvedValue(errBody);
        const sub = await subscribePeer({
          peerId: 'peer-a', recordKind: 'universe', recordId: 'u1',
        }, { adoptedFromReverse: true });
        await pushRecordToPeer(sub);
        const callsAfterFirst = vi.mocked(peerFetch).mock.calls.length;
        const blocked = await findPeerSubscription('peer-a', 'universe', 'u1');
        const result = await pushRecordToPeer(blocked);
        expect(result.reason).toBe('peer-schema-behind-cooldown');
        expect(vi.mocked(peerFetch).mock.calls.length).toBe(callsAfterFirst);
      });

      it('does NOT misclassify a non-discriminator field 400 as a pre-feature block', async () => {
        // Guard: only a `kind`-path discriminator/enum error is the unknown-kind
        // signal. A 400 on any other field (oversized record, etc.) stays a
        // genuine http-400 — not a silently-swallowed schema block.
        vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
        const errBody = { ok: false, status: 400, json: async () => ({
          code: 'VALIDATION_ERROR',
          message: 'Validation failed',
          context: { details: [{ path: 'record.name', message: 'String too long' }] },
        }) };
        errBody.clone = () => errBody;
        vi.mocked(peerFetch).mockResolvedValueOnce(errBody);
        const sub = await subscribePeer({
          peerId: 'peer-a', recordKind: 'universe', recordId: 'u1',
        }, { adoptedFromReverse: true });
        const result = await pushRecordToPeer(sub);
        expect(result.reason).toBe('http-400');
        const after = await findPeerSubscription('peer-a', 'universe', 'u1');
        expect(after.blockedBySchema).toBeUndefined();
      });
    });
  });

  // -------------------------------------------------------------------------
  // #6844 — the optional envelope keys share ONE strip / pending / withhold
  // lifecycle, declared once in ENVELOPE_EXTENSIONS. Every case below is driven
  // off that table so a row added later is exercised on both sides of the wire
  // without a hand-written twin of each flag.
  describe('envelope extensions (#6844)', () => {
    const SIDECARS = ENVELOPE_EXTENSIONS.filter((e) => e.pendingKey);
    const SELF_RECONCILING = ENVELOPE_EXTENSIONS.filter((e) => !e.pendingKey);
    const PENDING_KEYS = Object.values(ENVELOPE_PENDING_KEYS);

    const armSeries = () => {
      vi.mocked(getSeries).mockResolvedValue({ id: 'ser-1', name: 'Series' });
      vi.mocked(listIssuesForSeries).mockResolvedValue([{ id: 'i1', seriesId: 'ser-1', number: 1 }]);
    };
    // How the sender comes to carry each key on the wire. Every table row MUST
    // have a carrier (guarded below) — that is what makes this suite grow with
    // the table instead of silently skipping a new extension.
    const CARRIERS = {
      portosMeta: {
        recordKind: 'universe', recordId: 'u1',
        arm: async () => { vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' }); },
      },
      catalogBundle: {
        recordKind: 'universe', recordId: 'u1',
        arm: async () => {
          vi.mocked(getBackendName).mockReturnValue('postgres');
          vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
          vi.mocked(getCatalogBundleForRef).mockResolvedValue({
            ingredients: [{ id: 'cat-chr-1', type: 'character', name: 'Hero', updatedAt: '2026-01-02T00:00:00Z' }],
            refs: [{ ingredientId: 'cat-chr-1', refKind: 'universe', refId: 'u1', role: 'canon-character', createdAt: '2026-01-02T00:00:00Z' }],
          });
        },
      },
      manuscriptReview: {
        recordKind: 'series', recordId: 'ser-1',
        arm: async () => {
          armSeries();
          vi.mocked(getReview).mockResolvedValue({
            schemaVersion: 1,
            comments: [{ id: 'mrc-1', problem: 'pacing', status: 'open', updatedAt: '2026-06-02T00:00:00Z' }],
          });
        },
      },
      reverseOutline: {
        recordKind: 'series', recordId: 'ser-1',
        arm: async () => {
          armSeries();
          vi.mocked(getStoredOutline).mockResolvedValue({
            seriesId: 'ser-1', schemaVersion: 1, status: 'complete', generatedAt: '2026-06-02T00:00:00Z',
            plotlines: [{ id: 'a', label: 'A', kind: 'main', color: '#3b82f6' }],
            scenes: [{ id: 'scene-001', sequence: 0, summary: 'opening', plotlineId: 'a' }],
          });
        },
      },
      bibleManifest: {
        recordKind: 'writersRoomWork', recordId: 'wr-work-aaaa',
        arm: async () => {
          vi.mocked(getPeers).mockResolvedValue([{
            instanceId: 'peer-a', name: 'Peer A', address: '192.0.2.10', port: 5555,
            enabled: true, syncEnabled: true, directions: ['outbound', 'inbound'], syncCategories: { writersRoomWorks: true },
          }]);
          vi.mocked(getWorkForSync).mockResolvedValue({ id: 'wr-work-aaaa', title: 'Example work', drafts: [] });
          const dir = join(PATHS.data, 'writers-room', 'works', 'wr-work-aaaa');
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, 'characters.json'), JSON.stringify({ characters: [], updatedAt: '2026-06-02T00:00:00Z' }));
        },
      },
      linkedTrack: {
        recordKind: 'musicVideoProject', recordId: 'mv-1',
        arm: async () => {
          enableMusicVideoPeer();
          vi.mocked(getTrack).mockResolvedValue({
            id: 'track-1', title: 'Anthem', audioFilename: 'linked.mp3',
            updatedAt: '2026-06-28T00:00:00Z', deleted: false, deletedAt: null,
          });
          vi.mocked(getMusicVideoProject).mockResolvedValue({
            id: 'mv-1', name: 'Linked', mode: 'director', trackId: 'track-1',
            uploadedAudioFilename: null, scenes: [],
            updatedAt: '2026-06-28T00:00:00Z', deleted: false, deletedAt: null,
          });
        },
      },
    };
    const claim = ({ recordKind, recordId }) => subscribePeer(
      { peerId: 'peer-a', recordKind, recordId },
      { adoptedFromReverse: true },
    );
    const refresh = ({ recordKind, recordId }) => findPeerSubscription('peer-a', recordKind, recordId);
    const payloadOf = (call) => JSON.parse(call[1].body);

    it('re-pushes a bible-only edit even when the work record is unchanged', async () => {
      const carrier = CARRIERS.bibleManifest;
      await carrier.arm();
      vi.mocked(peerFetch).mockResolvedValue(acceptsPush());
      await pushRecordToPeer(await claim(carrier));
      vi.mocked(peerFetch).mockClear();
      const file = join(PATHS.data, 'writers-room', 'works', carrier.recordId, 'characters.json');
      await writeFile(file, JSON.stringify({ characters: [{ name: 'New cast member' }], updatedAt: '2026-06-03T00:00:00Z' }));
      expect((await pushRecordToPeer(await refresh(carrier))).pushed).toBe(true);
      expect(payloadOf(vi.mocked(peerFetch).mock.calls[0]).bibleManifest).toHaveLength(1);
      // A corrupt optional sibling must not hold the work and its prose hostage.
      vi.mocked(peerFetch).mockClear();
      await writeFile(file, '{');
      expect((await pushRecordToPeer(await refresh(carrier))).pushed).toBe(true);
      const withoutBible = payloadOf(vi.mocked(peerFetch).mock.calls[0]);
      expect(withoutBible.record.id).toBe(carrier.recordId);
      expect(withoutBible).not.toHaveProperty('bibleManifest');
    });

    it('pins the wire vocabulary older peers depend on', () => {
      // Older senders and receivers read exactly these names off the wire — a
      // rename here is a cross-version break, not a refactor.
      const byKey = (rows) => [...rows].sort((a, b) => a[0].localeCompare(b[0]));
      expect(byKey(ENVELOPE_EXTENSIONS.map(({ key, pendingKey }) => [key, pendingKey]))).toEqual(byKey([
        ['portosMeta', null],
        ['catalogBundle', null],
        ['manuscriptReview', 'reviewSyncPending'],
        ['reverseOutline', 'outlineSyncPending'],
        ['linkedTrack', 'trackSyncPending'],
        ['bibleManifest', 'bibleSyncPending'],
      ]));
    });

    it('has a sender-side carrier for every table row (a new extension must be exercised here)', () => {
      expect(Object.keys(CARRIERS).sort()).toEqual(ENVELOPE_EXTENSIONS.map((e) => e.key).sort());
    });

    describe.each(ENVELOPE_EXTENSIONS)('$key — strip', ({ key }) => {
      it('is dropped — and only it — on the one retry a legacy peer\'s strict-schema 400 earns', async () => {
        const carrier = CARRIERS[key];
        await carrier.arm();
        mockPeerRejecting(key);
        const result = await pushRecordToPeer(await claim(carrier));
        expect(result.pushed).toBe(true);
        const calls = vi.mocked(peerFetch).mock.calls;
        expect(calls).toHaveLength(2);
        const first = payloadOf(calls[0]);
        const retry = payloadOf(calls[1]);
        expect(first[key]).toBeDefined();
        // Surgical: the retry is the first push minus exactly this key — the
        // record, bundled issues, sourceInstanceId and every other extension
        // survive, so a peer that supports portosMeta but not this key keeps
        // its version-gate handshake.
        const rest = { ...first };
        delete rest[key];
        expect(retry).toEqual(rest);
      });
    });

    it('drops every key a single 400 names in one retry (Zod lists all unrecognized keys in one issue)', async () => {
      const carrier = CARRIERS.catalogBundle; // carries portosMeta AND catalogBundle
      await carrier.arm();
      const rejectsBoth = legacyRejectsKey('portosMeta');
      rejectsBoth.json = async () => ({
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        context: { details: [{ path: '', message: "Unrecognized key(s) in object: 'portosMeta', 'catalogBundle'" }] },
      });
      vi.mocked(peerFetch).mockResolvedValueOnce(rejectsBoth).mockResolvedValueOnce(acceptsPush());
      const result = await pushRecordToPeer(await claim(carrier));
      expect(result.pushed).toBe(true);
      const calls = vi.mocked(peerFetch).mock.calls;
      expect(calls).toHaveLength(2);
      const first = payloadOf(calls[0]);
      const retry = payloadOf(calls[1]);
      expect(first.portosMeta).toBeDefined();
      expect(first.catalogBundle).toBeDefined();
      expect(retry.portosMeta).toBeUndefined();
      expect(retry.catalogBundle).toBeUndefined();
      expect(retry.record.id).toBe(carrier.recordId);
    });

    describe.each(SIDECARS)('$key — no independent cycle ($pendingKey)', ({ key, pendingKey }) => {
      it('withholds lastPushedHash and water-marks lastPushedLegacyHash after a stripped push (#3928)', async () => {
        const carrier = CARRIERS[key];
        await carrier.arm();
        mockPeerRejecting(key);
        const result = await pushRecordToPeer(await claim(carrier));
        expect(result.pushed).toBe(true);
        const refreshed = await refresh(carrier);
        expect(refreshed.lastPushedHash).toBeFalsy();
        expect(refreshed.lastPushedLegacyHash).toBe(result.hash);
        // An unchanged record settles instead of re-running the 400 + retry pair.
        const second = await pushRecordToPeer(refreshed);
        expect(second.reason).toBe('unchanged-legacy-stripped');
        expect(vi.mocked(peerFetch).mock.calls).toHaveLength(2);
      });

      it('withholds the hash WITHOUT a legacy water-mark when the receiver reports it pending (transient merge failure)', async () => {
        const carrier = CARRIERS[key];
        await carrier.arm();
        vi.mocked(peerFetch).mockResolvedValue(acceptsPush({ [pendingKey]: true }));
        const result = await pushRecordToPeer(await claim(carrier));
        expect(result.pushed).toBe(true);
        expect(vi.mocked(peerFetch).mock.calls).toHaveLength(1);
        const refreshed = await refresh(carrier);
        expect(refreshed.lastPushedHash).toBeFalsy();
        expect(refreshed.lastPushedLegacyHash).toBeFalsy();
        // The next cycle must genuinely re-push, not short-circuit.
        vi.mocked(peerFetch).mockClear();
        vi.mocked(peerFetch).mockResolvedValue(acceptsPush());
        const second = await pushRecordToPeer(refreshed);
        expect(second.pushed).toBe(true);
        expect(vi.mocked(peerFetch).mock.calls).toHaveLength(1);
      });
    });

    describe.each(SELF_RECONCILING)('$key — own reconciliation cycle', ({ key }) => {
      it('saves lastPushedHash normally after a stripped push (nothing is owed through this hash)', async () => {
        const carrier = CARRIERS[key];
        await carrier.arm();
        mockPeerRejecting(key);
        const result = await pushRecordToPeer(await claim(carrier));
        expect(result.pushed).toBe(true);
        const refreshed = await refresh(carrier);
        expect(refreshed.lastPushedHash).toBe(result.hash);
        expect(refreshed.lastPushedLegacyHash).toBeFalsy();
        const second = await pushRecordToPeer(refreshed);
        expect(second.reason).toBe('unchanged');
      });
    });

    it('leaves the bundled-track GC floor unstamped when linkedTrack was stripped for a legacy peer (#1922)', async () => {
      // The project landed (its own confirmed floor advances) but the peer
      // never got the track, so the bundle-specific floor tombstoneGc's
      // `track` cutoff reads off musicVideoProject rows must stay unset.
      const carrier = CARRIERS.linkedTrack;
      await carrier.arm();
      mockPeerRejecting('linkedTrack');
      const sub = await claim(carrier);
      expect(sub.lastConfirmedTrackBundleAtMs).toBeNull();
      const result = await pushRecordToPeer(sub);
      expect(result.pushed).toBe(true);
      const refreshed = await refresh(carrier);
      expect(refreshed.lastConfirmedPushedAt).toBeTruthy();
      expect(refreshed.lastConfirmedTrackBundleAtMs).toBeNull();
    });

    describe('receiver — applyIncomingPush', () => {
      // How each sidecar reaches the receiver, and the merge that can throw.
      const RECEIVE_CARRIERS = {
        bibleManifest: {
          merge: diffWorkBibleManifest,
          payload: () => ({
            kind: 'writersRoomWork', record: { id: 'wr-work-aaaa', drafts: [] },
            bibleManifest: [{ workId: 'wr-work-aaaa', kind: 'character', sha256: 'a'.repeat(64), updatedAt: '2026-06-02T00:00:00Z' }],
            assetManifest: [], sourceInstanceId: 'peer-a',
          }),
        },
        manuscriptReview: {
          merge: mergeReviewFromSync,
          payload: () => ({
            kind: 'series',
            record: { id: 'ser-1', name: 'S', deleted: false, deletedAt: null },
            issues: [],
            manuscriptReview: { schemaVersion: 1, comments: [{ id: 'mrc-1', problem: 'x', status: 'open', updatedAt: '2026-06-02T00:00:00Z' }] },
            assetManifest: [],
            sourceInstanceId: 'peer-a',
          }),
        },
        reverseOutline: {
          merge: mergeOutlineFromSync,
          payload: () => ({
            kind: 'series',
            record: { id: 'ser-1', name: 'S', deleted: false, deletedAt: null },
            issues: [],
            reverseOutline: sampleOutline(),
            assetManifest: [],
            sourceInstanceId: 'peer-a',
          }),
        },
        linkedTrack: {
          merge: mergeTracksFromSync,
          payload: () => ({
            kind: 'musicVideoProject',
            record: { id: 'mv-9', trackId: 'track-9', deleted: false, deletedAt: null },
            portosMeta: CURRENT_PORTOS_META,
            linkedTrack: { id: 'track-9', audioFilename: 'linked.mp3' },
            assetManifest: [],
            sourceInstanceId: 'peer-a',
          }),
        },
      };

      it('scopes bible pulls to the pushed work and keeps pending pulls retryable', async () => {
        const payload = RECEIVE_CARRIERS.bibleManifest.payload();
        const own = payload.bibleManifest[0];
        payload.bibleManifest.push({ ...own, workId: 'wr-work-bbbb' });
        // The body is reported pending even when the peer fetch fails.
        vi.mocked(diffWorkBibleManifest).mockResolvedValueOnce([own]);
        const result = await pushFromPairedPeer(payload);
        expect(vi.mocked(diffWorkBibleManifest)).toHaveBeenLastCalledWith([own], expect.any(Object));
        expect(result.bibleSyncPending).toBe(true);
        payload.bibleManifest = undefined;
        await pushFromPairedPeer(payload);
        expect(vi.mocked(diffWorkBibleManifest)).toHaveBeenLastCalledWith([], expect.any(Object));
      });

      it('a tombstone writersRoomWork push diffs and pulls no draft bodies or bibles', async () => {
        const payload = RECEIVE_CARRIERS.bibleManifest.payload();
        payload.record = { id: 'wr-work-aaaa', deleted: true, deletedAt: '2026-06-02T00:00:00Z' };
        payload.draftBodyManifest = [{ workId: 'wr-work-aaaa', draftId: 'd1', sha256: 'b'.repeat(64), updatedAt: '2026-06-02T00:00:00Z' }];
        vi.mocked(diffWorkBibleManifest).mockClear();
        const result = await pushFromPairedPeer(payload);
        expect(diffWorkBibleManifest).not.toHaveBeenCalled();
        expect(result).not.toHaveProperty('missingDraftBodies');
        expect(result).not.toHaveProperty('bibleSyncPending');
      });

      it('a local-ephemeral universe push merges no bundle, reports no assets and creates no reverse subscription', async () => {
        vi.mocked(getBackendName).mockReturnValue('postgres');
        vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', ephemeral: true });
        vi.mocked(mergeMediaCollectionsFromSync).mockClear();
        const result = await pushFromPairedPeer({
          kind: 'universe',
          record: { id: 'u1', name: 'Foo', deleted: false, deletedAt: null },
          linkedCollection: { id: 'col-1', name: 'Universe: U', items: [{ kind: 'image', ref: 'private.png' }] },
          catalogBundle: { ingredients: [{ id: 'cat-chr-1', type: 'character', name: 'Hero', updatedAt: '2026-01-02T00:00:00Z' }], refs: [] },
          assetManifest: [{ kind: 'image', filename: 'private.png', size: 1, sha256: 'c'.repeat(64) }],
          sourceInstanceId: 'peer-a',
          portosMeta: { schemaVersions: { ...PORTOS_SCHEMA_VERSIONS } },
        });
        expect(mergeMediaCollectionsFromSync).not.toHaveBeenCalled();
        expect(applyCatalogRemoteChanges).not.toHaveBeenCalled();
        expect(result.missingAssets).toEqual([]);
        expect(result.reverseSubscriptionCreated).toBe(false);
      });

      it('has a receiver-side carrier for every sidecar row', () => {
        expect(Object.keys(RECEIVE_CARRIERS).sort()).toEqual(SIDECARS.map((e) => e.key).sort());
      });

      it.each(SIDECARS)('raises exactly $pendingKey when the bundled $key merge throws, and no flag when it succeeds', async ({ key, pendingKey }) => {
        const { merge, payload } = RECEIVE_CARRIERS[key];
        const clean = await pushFromPairedPeer(payload());
        for (const flag of PENDING_KEYS) expect(clean).not.toHaveProperty(flag);
        vi.mocked(merge).mockRejectedValueOnce(new Error('disk full'));
        const failed = await pushFromPairedPeer(payload());
        expect(failed[pendingKey]).toBe(true);
        for (const flag of PENDING_KEYS) {
          if (flag !== pendingKey) expect(failed).not.toHaveProperty(flag);
        }
      });
    });
  });
});

describe('media-library federation (#1566)', () => {
  let origAudio;
  let origVideos;

  beforeEach(async () => {
    // The suite beforeEach redirects PATHS.data/images/music to `tmp` and
    // restores videos in its afterEach; redirect videos + audio (not created
    // there) into the same per-test tmpdir so manifest builds see ONLY fixtures.
    origAudio = PATHS.audio;
    origVideos = PATHS.videos;
    PATHS.videos = join(tmp, 'videos');
    PATHS.audio = join(tmp, 'audio');
    await mkdir(PATHS.videos, { recursive: true });
    await mkdir(PATHS.audio, { recursive: true });
    vi.mocked(reconcileMediaAssets).mockClear();
  });

  afterEach(() => {
    PATHS.audio = origAudio;
    PATHS.videos = origVideos;
  });

  describe('libraryKindsExcludedByPatterns (honors backup excludes)', () => {
    it('flags a kind whose whole dir is excluded — anchored, trailing-slash, and glob forms', () => {
      expect([...libraryKindsExcludedByPatterns(['/music/'])]).toEqual(['music']);
      expect([...libraryKindsExcludedByPatterns(['/videos/**'])]).toEqual(['video']);
      expect([...libraryKindsExcludedByPatterns(['images'])]).toEqual(['image']);
      expect([...libraryKindsExcludedByPatterns(['/audio'])]).toEqual(['audio']);
    });

    it('ignores excludes that do not name a whole media dir', () => {
      expect(libraryKindsExcludedByPatterns(['/loras/*.safetensors', '/repos/']).size).toBe(0);
      expect(libraryKindsExcludedByPatterns([]).size).toBe(0);
      expect(libraryKindsExcludedByPatterns(undefined).size).toBe(0);
    });
  });

  describe('buildMediaLibraryManifest', () => {
    it('walks all media dirs, hashes files, skips image sidecars, and is deterministic', async () => {
      await writeFile(join(PATHS.images, 'a.png'), 'img-a');
      await writeFile(join(PATHS.images, 'a.png.metadata.json'), JSON.stringify({ prompt: 'x' }));
      await writeFile(join(PATHS.videos, 'v.mp4'), 'vid');
      await writeFile(join(PATHS.audio, 's.wav'), 'aud');
      await writeFile(join(PATHS.music, 'm.mp3'), 'mus');

      const m1 = await buildMediaLibraryManifest();
      const kinds = m1.assets.map((e) => `${e.kind}:${e.filename}`).sort();
      expect(kinds).toEqual(['audio:s.wav', 'image:a.png', 'music:m.mp3', 'video:v.mp4']);
      // sidecar json is metadata, not advertised as its own asset
      expect(m1.assets.find((e) => e.filename.endsWith('.json'))).toBeUndefined();
      // every entry carries a 64-hex sha256
      expect(m1.assets.every((e) => /^[a-f0-9]{64}$/.test(e.sha256))).toBe(true);
      expect(m1.schemaVersion).toBe(PORTOS_SCHEMA_VERSIONS.mediaLibrary);
      expect(/^[a-f0-9]{64}$/.test(m1.manifestHash)).toBe(true);
      // deterministic hash across rebuilds of the same library
      const m2 = await buildMediaLibraryManifest();
      expect(m2.manifestHash).toBe(m1.manifestHash);
    });

    it('changes manifestHash when the library changes', async () => {
      await writeFile(join(PATHS.audio, 's.wav'), 'aud');
      const before = (await buildMediaLibraryManifest()).manifestHash;
      await writeFile(join(PATHS.audio, 't.wav'), 'aud2');
      const after = (await buildMediaLibraryManifest()).manifestHash;
      expect(after).not.toBe(before);
    });

    it('returns an empty manifest when the library is empty', async () => {
      const m = await buildMediaLibraryManifest();
      expect(m.assets).toEqual([]);
    });

    it('re-hash cache invalidates when a flat asset changes in place (size differs)', async () => {
      const p = join(PATHS.audio, 's.wav');
      await writeFile(p, 'short');
      const first = (await buildMediaLibraryManifest()).assets.find((e) => e.filename === 's.wav').sha256;
      // Overwrite with different-length content → (mtime,size) cache key changes.
      await writeFile(p, 'a much longer payload than before');
      const second = (await buildMediaLibraryManifest()).assets.find((e) => e.filename === 's.wav').sha256;
      expect(second).not.toBe(first);
    });
  });

  describe('syncMediaLibraryFromPeer', () => {
    const mkPeer = (id, extra = {}) => ({
      instanceId: id, name: id, host: null, address: '10.0.0.9', port: 5555,
      enabled: true, fullSync: true, ...extra,
    });

    it('no-ops for a non-full-sync peer and never hits the network', async () => {
      const res = await syncMediaLibraryFromPeer(mkPeer('fs-nofs', { fullSync: false }));
      expect(res.skipped).toBe('not-fullsync');
      expect(peerFetch).not.toHaveBeenCalled();
    });

    it('gently skips a peer whose manifest schema is ahead of local (no pull, no reconcile)', async () => {
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({
        schemaVersion: PORTOS_SCHEMA_VERSIONS.mediaLibrary + 1,
        manifestHash: 'a'.repeat(64), assets: [],
      }) });
      const res = await syncMediaLibraryFromPeer(mkPeer('fs-ahead'));
      expect(res.skipped).toBe('schema-ahead');
      expect(reconcileMediaAssets).not.toHaveBeenCalled();
    });

    it('skips an unreachable peer and an invalid manifest', async () => {
      vi.mocked(peerFetch).mockResolvedValue({ ok: false });
      expect((await syncMediaLibraryFromPeer(mkPeer('fs-down'))).skipped).toBe('unreachable');
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({ bogus: true }) });
      expect((await syncMediaLibraryFromPeer(mkPeer('fs-bad'))).skipped).toBe('invalid');
    });

    it('pulls nothing when assets already exist locally, then short-circuits on unchanged hash', async () => {
      // The peer's manifest == our OWN library (write files, build manifest, feed
      // it back) so diffAssetManifestAgainstLocal finds everything present.
      await writeFile(join(PATHS.audio, 's.wav'), 'aud');
      await writeFile(join(PATHS.images, 'a.png'), 'img');
      const localManifest = await buildMediaLibraryManifest();
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => localManifest });

      const peer = mkPeer('fs-present');
      const res1 = await syncMediaLibraryFromPeer(peer);
      expect(res1.pulled).toBe(0);
      expect(res1.skipped).toBeUndefined();
      expect(reconcileMediaAssets).not.toHaveBeenCalled(); // nothing pulled → no reconcile

      const res2 = await syncMediaLibraryFromPeer(peer);
      expect(res2.skipped).toBe('unchanged');
    });

    it('does NOT record the manifestHash when a byte pull fails — the next tick retries', async () => {
      const peer = mkPeer('fs-diverge');
      // pullMissingAssetsFromPeer re-resolves the peer via getPeers — include it.
      vi.mocked(getPeers).mockResolvedValue([peer]);
      const manifest = {
        schemaVersion: PORTOS_SCHEMA_VERSIONS.mediaLibrary,
        manifestHash: 'b'.repeat(64),
        assets: [{ filename: 'remote.wav', kind: 'audio', sha256: 'c'.repeat(64) }],
      };
      vi.mocked(peerFetch).mockImplementation(async (url) => {
        if (String(url).endsWith('/library-manifest?models=1')) return { ok: true, json: async () => manifest };
        return { ok: false }; // byte pull fails → nothing lands on disk
      });
      const res = await syncMediaLibraryFromPeer(peer);
      // The asset URL was requested...
      const urls = vi.mocked(peerFetch).mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes('/data/audio/remote.wav'))).toBe(true);
      // ...but nothing landed (re-diff still sees it missing), so pulled=0,
      // no reconcile, and the hash is NOT recorded.
      expect(res.pulled).toBe(0);
      expect(res.missing).toBe(1);
      expect(reconcileMediaAssets).not.toHaveBeenCalled();
      // Second call must re-diff (NOT short-circuit on an 'unchanged' hash).
      const res2 = await syncMediaLibraryFromPeer(peer);
      expect(res2.skipped).not.toBe('unchanged');
    });

    it('skips a manifest whose Content-Length exceeds the cap (unbounded-body guard for HTTP peers)', async () => {
      vi.mocked(peerFetch).mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-length': String(64 * 1024 * 1024) }), // > 32MB cap
        json: async () => ({ schemaVersion: PORTOS_SCHEMA_VERSIONS.mediaLibrary, manifestHash: 'a'.repeat(64), assets: [] }),
      });
      const res = await syncMediaLibraryFromPeer(mkPeer('fs-huge'));
      expect(res.skipped).toBe('too-large');
    });

    it('skips a chunked manifest with no Content-Length that streams past the cap', async () => {
      vi.mocked(peerFetch).mockResolvedValue(endlessChunkedRes());
      const res = await syncMediaLibraryFromPeer(mkPeer('fs-chunked'));
      expect(res.skipped).toBe('too-large');
    });

    it('forces a re-diff after repeated unchanged ticks so a local file loss self-heals', async () => {
      const peer = mkPeer('fs-selfheal');
      vi.mocked(getPeers).mockResolvedValue([peer]);
      const bytes = Buffer.from('heal-bytes');
      const manifest = {
        schemaVersion: PORTOS_SCHEMA_VERSIONS.mediaLibrary,
        manifestHash: 'f0'.repeat(32),
        assets: [{ filename: 'heal.wav', kind: 'audio' }], // existence-only diff
      };
      vi.mocked(peerFetch).mockImplementation(async (url) => {
        if (String(url).endsWith('/library-manifest?models=1')) return { ok: true, json: async () => manifest };
        return {
          ok: true,
          headers: new Headers({ 'content-length': String(bytes.length) }),
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        };
      });
      // First sweep lands the file and records the manifestHash.
      expect((await syncMediaLibraryFromPeer(peer)).pulled).toBe(1);
      // Simulate local loss after the hash was recorded.
      await rm(join(PATHS.audio, 'heal.wav'), { force: true });
      // Unchanged ticks short-circuit until the periodic forced re-diff fires and
      // re-pulls the lost file (proves self-heal without a restart).
      let healed = false;
      for (let i = 0; i < 12; i++) {
        const r = await syncMediaLibraryFromPeer(peer);
        if (r.skipped !== 'unchanged') { healed = true; break; }
      }
      expect(healed).toBe(true);
    });

    it('records the manifestHash + reconciles once missing bytes actually land', async () => {
      const peer = mkPeer('fs-success');
      vi.mocked(getPeers).mockResolvedValue([peer]);
      // No sha256 on the entry → diff is existence-only, so once the byte pull
      // writes the file the re-diff sees it present (no hash to mismatch).
      const manifest = {
        schemaVersion: PORTOS_SCHEMA_VERSIONS.mediaLibrary,
        manifestHash: 'e'.repeat(64),
        assets: [{ filename: 'land.wav', kind: 'audio' }],
      };
      const bytes = Buffer.from('audio-bytes-that-landed');
      vi.mocked(peerFetch).mockImplementation(async (url) => {
        if (String(url).endsWith('/library-manifest?models=1')) return { ok: true, json: async () => manifest };
        // Asset byte fetch — a Response-like the cap-checker accepts.
        return {
          ok: true,
          headers: new Headers({ 'content-length': String(bytes.length) }),
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        };
      });
      const res1 = await syncMediaLibraryFromPeer(peer);
      expect(res1.pulled).toBe(1);
      expect(res1.missing).toBe(0);
      expect(reconcileMediaAssets).toHaveBeenCalled();
      // Hash recorded → second call short-circuits as unchanged.
      const res2 = await syncMediaLibraryFromPeer(peer);
      expect(res2.skipped).toBe('unchanged');
    });
  });

  describe('syncMediaLibraryWithAllPeers', () => {
    it('sweeps only full-sync, enabled peers that have an instanceId', async () => {
      vi.mocked(getPeers).mockResolvedValue([
        { instanceId: 'fs1', address: '10.0.0.4', port: 5555, enabled: true, fullSync: true },
        { instanceId: 'partial', address: '10.0.0.5', port: 5555, enabled: true, fullSync: false },
        { instanceId: 'disabled', address: '10.0.0.6', port: 5555, enabled: false, fullSync: true },
        { instanceId: null, address: '10.0.0.7', port: 5555, enabled: true, fullSync: true },
      ]);
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({
        schemaVersion: PORTOS_SCHEMA_VERSIONS.mediaLibrary, manifestHash: 'd'.repeat(64), assets: [],
      }) });
      await syncMediaLibraryWithAllPeers();
      const manifestUrls = vi.mocked(peerFetch).mock.calls
        .map((c) => String(c[0])).filter((u) => u.endsWith('/library-manifest?models=1'));
      expect(manifestUrls).toHaveLength(1);
      expect(manifestUrls[0]).toContain('10.0.0.4');
    });
  });

  // #6843 — the per-kind record-kind table (recordKinds.js) collapsed six
  // hand-mirrored kind === '...' ladders (isSubscriptionRecordTombstone,
  // buildPushPayload, classifyLocalRecord, applyIncomingPush's ephemeral
  // lookup + merge dispatch, refusedFromCutoffs) to one lookup each. Before
  // that table, only 4 of the 16 subscribable kinds were exercised through
  // buildPushPayload/applyIncomingPush by this file (universe, series,
  // musicVideoProject, mediaCollection) — the other 12 kinds' ladder arms
  // were untested, which is exactly the gap that let classifyLocalRecord ship
  // with no fableLoom arm (always 'missing', so an inbound fableLoom push
  // could never auto-create a reverse subscription) and applyIncomingPush
  // carry a dead musicVideoProject ephemeral probe. This suite drives EVERY
  // PEER_SUBSCRIBABLE_KINDS entry through both boundaries so a future kind
  // that's added to the table but wired wrong fails here instead of shipping
  // silently — the exact failure mode the issue documents.
  describe('all-kinds parity (#6843)', () => {
    // One row per PEER_SUBSCRIBABLE_KINDS entry: the (already-imported,
    // already-mocked) getter + merger this kind's descriptor wraps, and a
    // minimal record shape sanitizeRecordForWire accepts for it (id +
    // deleted/deletedAt is sufficient for every kind — see syncWire.js: the
    // only universal requirements are a plain object with a non-blank id and
    // not `ephemeral === true` while live).
    const ALL_KINDS_FIXTURES = {
      universe: { get: getUniverse, merge: mergeUniversesFromSync },
      series: { get: getSeries, merge: mergeSeriesFromSync },
      mediaCollection: { get: getCollection, merge: mergeMediaCollectionsFromSync },
      author: { get: getAuthor, merge: mergeAuthorsFromSync },
      artist: { get: getArtist, merge: mergeArtistsFromSync },
      album: { get: getAlbum, merge: mergeAlbumsFromSync },
      track: { get: getTrack, merge: mergeTracksFromSync },
      creativeDirectorProject: { get: getCreativeDirectorProject, merge: mergeCreativeDirectorProjectsFromSync },
      moodBoard: { get: getBoard, merge: mergeBoardsFromSync },
      fableLoom: { get: getLoom, merge: mergeLoomsFromSync },
      writersRoomWork: { get: getWorkForSync, merge: mergeWorksFromSync },
      writersRoomFolder: { get: getFolderForSync, merge: mergeFoldersFromSync },
      writersRoomExercise: { get: getExerciseForSync, merge: mergeExercisesFromSync },
      musicVideoProject: { get: getMusicVideoProject, merge: mergeMusicVideoProjectsFromSync },
      commissionFeedback: { get: getCommissionFeedbackForSync, merge: mergeCommissionFeedbackFromSync },
      creativeCommission: { get: getCommissionForSync, merge: mergeCommissionsFromSync },
      deck: { get: getDeckForSync, merge: mergeDecksFromSync },
      storyboard: { get: getStoryboardForSync, merge: mergeStoryboardsFromSync },
    };

    it('every PEER_SUBSCRIBABLE_KINDS entry has a test fixture (guards the parity suite itself against a silently-skipped kind)', () => {
      expect(Object.keys(ALL_KINDS_FIXTURES).sort()).toEqual([...PEER_SUBSCRIBABLE_KINDS].sort());
    });

    it.each(PEER_SUBSCRIBABLE_KINDS)('buildPushPayload(%s): a live record pushes a populated envelope, a tombstone pushes assetManifest:[]', async (kind) => {
      const { get } = ALL_KINDS_FIXTURES[kind];
      const liveRecord = { id: `ak-live-${kind}`, name: 'AK', title: 'AK', deleted: false, deletedAt: null };
      vi.mocked(get).mockResolvedValueOnce(liveRecord);
      const liveResult = await buildPushPayload({ recordKind: kind, recordId: liveRecord.id }, 'src-instance');
      expect(liveResult.kind).toBe(kind);
      expect(liveResult.record.id).toBe(liveRecord.id);
      expect(Array.isArray(liveResult.assetManifest)).toBe(true);

      const tombstone = { id: `ak-tomb-${kind}`, deleted: true, deletedAt: '2026-05-01T00:00:00Z' };
      vi.mocked(get).mockResolvedValueOnce(tombstone);
      const tombResult = await buildPushPayload({ recordKind: kind, recordId: tombstone.id }, 'src-instance');
      expect(tombResult.record.deleted).toBe(true);
      expect(tombResult.assetManifest).toEqual([]);
    });

    it.each(PEER_SUBSCRIBABLE_KINDS)('applyIncomingPush(%s): merges the incoming record through this kind\'s own merger with a { source } envelope', async (kind) => {
      const { get, merge } = ALL_KINDS_FIXTURES[kind];
      vi.mocked(merge).mockClear();
      const record = { id: `ak-merge-${kind}`, name: 'AK', deleted: false, deletedAt: null };
      // Satisfies universe/series' local-ephemeral lookup (the only two kinds
      // that read `desc.load` before merging) — a non-ephemeral local match.
      vi.mocked(get).mockResolvedValue(record);
      await pushFromPairedPeer({ kind, record, assetManifest: [], sourceInstanceId: 'peer-a', portosMeta: CURRENT_PORTOS_META });
      expect(merge).toHaveBeenCalledWith(
        [expect.objectContaining({ id: record.id })],
        expect.objectContaining({ source: { via: 'peer-push', peerId: 'peer-a' } }),
      );
    });

    it.each(PEER_SUBSCRIBABLE_KINDS)('applyIncomingPush(%s): reverse-subscribes when the local record is present, refuses when it is missing (classifyLocalRecord)', async (kind) => {
      const { get } = ALL_KINDS_FIXTURES[kind];

      const presentRecord = { id: `ak-present-${kind}`, name: 'AK', deleted: false, deletedAt: null };
      vi.mocked(get).mockResolvedValue(presentRecord);
      const presentResult = await pushFromPairedPeer({
        kind, record: presentRecord, assetManifest: [], sourceInstanceId: 'peer-a', portosMeta: CURRENT_PORTOS_META,
      });
      expect(presentResult.reverseSubscriptionCreated).toBe(true);

      const missingRecord = { id: `ak-missing-${kind}`, name: 'AK', deleted: false, deletedAt: null };
      vi.mocked(get).mockResolvedValue(undefined);
      const missingResult = await pushFromPairedPeer({
        kind, record: missingRecord, assetManifest: [], sourceInstanceId: 'peer-a', portosMeta: CURRENT_PORTOS_META,
      });
      expect(missingResult.reverseSubscriptionCreated).toBe(false);
    });
  });
});
