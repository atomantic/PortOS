/**
 * issueSync.test.js
 *
 * Soft-delete tombstones and peer-sync merge/GC. Split from issues.test.js (#16214); shared mocks and state live in
 * issues.testFixtures.js.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockNoPeerSync, mockNoPeers } from '../../lib/mockPathsDataRoot.js';

// vi.mock factories are hoisted above imports; the shared fixtures module is
// loaded the same way.
const h = await vi.hoisted(() => import('./issues.testFixtures.js'));

vi.mock('../../lib/fileUtils.js', () => h.fileUtilsFactory());
vi.mock('../../lib/conflictJournal.js', (importOriginal) => h.conflictJournalFactory(importOriginal));
vi.mock('crypto', () => h.cryptoFactory());
vi.mock('../instances.js', () => mockNoPeers());
vi.mock('../sharing/peerSync.js', () => mockNoPeerSync());
vi.mock('./seriesCoverImage.js', () => h.coverRefresh);

const { writeCounter, baseHashEvictionSequence } = h;
const svc = await import('./issues.js');
const cj = await import('../../lib/conflictJournal.js');
const { recordEvents } = await import('../sharing/recordEvents.js');

// Keep the real journal/store operation, but let a second public mutation
// start while the first one is suspended at a known persistence boundary.
function pauseNextCall(target, method) {
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  const original = target[method];
  vi.spyOn(target, method).mockImplementationOnce(async (...args) => {
    entered.resolve();
    await released.promise;
    return original(...args);
  });
  return { entered: entered.promise, release: released.resolve };
}

describe('pipeline issues service', () => {
  beforeEach(() => {
    h.resetFixtures(cj);
  });

  describe('soft-delete (tombstones for peer sync)', () => {
    it('deleteIssue soft-deletes (record stays on disk with deleted=true)', async () => {
      const i = await svc.createIssue({ seriesId: 'ser-1', title: 'First' });
      await svc.deleteIssue(i.id);
      expect((await svc.listIssues({ seriesId: 'ser-1' })).map((x) => x.id)).not.toContain(i.id);
      const all = await svc.listIssues({ seriesId: 'ser-1', includeDeleted: true });
      const tomb = all.find((x) => x.id === i.id);
      expect(tomb).toMatchObject({ deleted: true });
      expect(tomb.deletedAt).toBeTruthy();
    });

    it('getIssue 404s for tombstoned; includeDeleted exposes it', async () => {
      const i = await svc.createIssue({ seriesId: 'ser-1', title: 'Hidden' });
      await svc.deleteIssue(i.id);
      await expect(svc.getIssue(i.id)).rejects.toMatchObject({ code: svc.ERR_NOT_FOUND });
      const tomb = await svc.getIssue(i.id, { includeDeleted: true });
      expect(tomb).toMatchObject({ id: i.id, deleted: true });
    });

    it('updateIssue 404s on a tombstone (no zombie edits)', async () => {
      const i = await svc.createIssue({ seriesId: 'ser-1', title: 'Locked' });
      await svc.deleteIssue(i.id);
      await expect(svc.updateIssue(i.id, { title: 'Zombie' })).rejects.toMatchObject({
        code: svc.ERR_NOT_FOUND,
      });
    });

    it('insertIssueWithId overwrites a tombstoned record (re-import undeletes)', async () => {
      const id = 'iss-550e8400-e29b-41d4-a716-44665544abce';
      await svc.insertIssueWithId({ id, seriesId: 'ser-1', title: 'First' });
      await svc.deleteIssue(id);
      const restored = await svc.insertIssueWithId({ id, seriesId: 'ser-1', title: 'Restored' });
      expect(restored).toMatchObject({ id, title: 'Restored', deleted: false });
    });

    it('insertIssueWithId resurrection fires emitRecordUpdated on the parent series', async () => {
      const id = 'iss-550e8400-e29b-41d4-a716-44665544abcd';
      await svc.insertIssueWithId({ id, seriesId: 'ser-resurrect', title: 'ToResurrect' });
      await svc.deleteIssue(id);

      const emitSpy = vi.spyOn(recordEvents, 'emit');

      await svc.insertIssueWithId({ id, seriesId: 'ser-resurrect', title: 'Resurrected' });

      expect(emitSpy).toHaveBeenCalledWith('updated', { recordKind: 'series', recordId: 'ser-resurrect' });
      emitSpy.mockRestore();
    });

    it('insertIssueWithId fresh insert does NOT fire emitRecordUpdated', async () => {
      const id = 'iss-550e8400-e29b-41d4-a716-44665544abe0';
      const emitSpy = vi.spyOn(recordEvents, 'emit');

      await svc.insertIssueWithId({ id, seriesId: 'ser-fresh', title: 'Brand New' });

      // insertIssueWithId (unlike createIssue) does not fire emitRecordUpdated
      // on a fresh insert — only on tombstone resurrection.
      expect(emitSpy).not.toHaveBeenCalledWith('updated', { recordKind: 'series', recordId: 'ser-fresh' });
      emitSpy.mockRestore();
    });

    it('insertIssueWithId still rejects DUPLICATE on a LIVE record', async () => {
      const id = 'iss-550e8400-e29b-41d4-a716-44665544abcf';
      await svc.insertIssueWithId({ id, seriesId: 'ser-1', title: 'First' });
      await expect(svc.insertIssueWithId({ id, seriesId: 'ser-1', title: 'Second' }))
        .rejects.toMatchObject({ code: svc.ERR_DUPLICATE });
    });

    it('renumberInline skips tombstones — surviving issues stay contiguous', async () => {
      const _a = await svc.createIssue({ seriesId: 'ser-renum', title: 'A' });
      const b = await svc.createIssue({ seriesId: 'ser-renum', title: 'B' });
      const _c = await svc.createIssue({ seriesId: 'ser-renum', title: 'C' });
      await svc.deleteIssue(b.id);
      const live = await svc.listIssues({ seriesId: 'ser-renum' });
      expect(live.map((i) => i.title)).toEqual(['A', 'C']);
      expect(live.map((i) => i.number)).toEqual([1, 2]);
      // Tombstone keeps its old number but is hidden from listIssues.
      const all = await svc.listIssues({ seriesId: 'ser-renum', includeDeleted: true });
      expect(all.find((i) => i.id === b.id).deleted).toBe(true);
      // Adding a new issue picks up after the live tail (3), not 4 from the tombstone.
      const d = await svc.createIssue({ seriesId: 'ser-renum', title: 'D' });
      expect(d.number).toBe(3);
    });

    describe('mergeIssuesFromSync', () => {
      it.each([
        ['equal precision variants', '2026-11-05T12:00:00.000Z', '2026-11-05T12:00:00Z', false],
        ['newer fractional second', '2026-11-05T12:00:00Z', '2026-11-05T12:00:00.500Z', true],
        ['equal timezone offsets', '2026-11-05T12:00:00Z', '2026-11-05T13:00:00+01:00', false],
        ['invalid remote timestamp', '2026-11-05T12:00:00Z', 'not-a-date', false],
        ['invalid local timestamp', 'not-a-date', '2026-11-05T12:00:00Z', true],
      ])('LWW compares instants for %s', async (_case, localTs, remoteTs, remoteWins) => {
        const local = { id: 'iss-lww', seriesId: 'ser-1', title: 'Local', createdAt: '2026-01-01T00:00:00Z', updatedAt: localTs };
        await svc.mergeIssuesFromSync([local]);

        const result = await svc.mergeIssuesFromSync([{ ...local, title: 'Remote', updatedAt: remoteTs }]);

        expect(result).toEqual({ applied: remoteWins, count: remoteWins ? 1 : 0 });
        expect(await svc.getIssue(local.id)).toMatchObject({ title: remoteWins ? 'Remote' : 'Local', updatedAt: remoteWins ? remoteTs : localTs });
      });

      it.each([
        { name: 'a lean stage', senderVersion: 7, history: undefined, expectedRunId: 'local-old', expectedOutput: 'local earlier draft' },
        { name: 'empty legacy history', senderVersion: 6, history: [], expectedRunId: 'local-old', expectedOutput: 'local earlier draft' },
        { name: 'legacy history entries', senderVersion: 6, history: [{ runId: 'remote-old', output: 'remote earlier draft' }], expectedRunId: 'remote-old', expectedOutput: 'remote earlier draft' },
      ])('merges current stage text and keeps the correct undo trail with $name', async ({ senderVersion, history, expectedRunId, expectedOutput }) => {
        const local = {
          id: 'iss-history', seriesId: 'ser-1', title: 'History', updatedAt: '2026-05-17T10:00:00Z',
          stages: { prose: { output: 'local draft', runHistory: [{ runId: 'local-old', output: 'local earlier draft' }] } },
        };
        await svc.mergeIssuesFromSync([local]);
        const stage = { status: 'edited', input: 'remote input', output: 'remote draft' };
        if (history !== undefined) stage.runHistory = history;
        const result = await svc.mergeIssuesFromSync([{
          ...local, updatedAt: '2026-05-17T11:00:00Z', stages: { prose: stage },
        }], { senderSchemaVersions: { pipelineIssues: senderVersion } });

        expect(result).toEqual({ applied: true, count: 1 });
        const saved = (await svc.getIssue(local.id)).stages.prose;
        expect(saved).toMatchObject({ status: 'edited', input: 'remote input', output: 'remote draft' });
        expect(saved.runHistory).toEqual([{ runId: expectedRunId, createdAt: null, input: '', output: expectedOutput }]);
      });

      it('applies an inbound soft-delete from a peer', async () => {
        const i = await svc.createIssue({ seriesId: 'ser-1', title: 'Synced' });
        const ts = new Date(Date.now() + 60_000).toISOString();
        const r = await svc.mergeIssuesFromSync([{
          ...i,
          deleted: true,
          deletedAt: ts,
          updatedAt: ts,
        }]);
        expect(r).toEqual({ applied: true, count: 1 });
        await expect(svc.getIssue(i.id)).rejects.toMatchObject({ code: svc.ERR_NOT_FOUND });
      });

      it('LWW: an inbound edit with later updatedAt resurrects over a local tombstone', async () => {
        const i = await svc.createIssue({ seriesId: 'ser-1', title: 'Original' });
        await svc.deleteIssue(i.id);
        const editTs = new Date(Date.now() + 60_000).toISOString();
        const r = await svc.mergeIssuesFromSync([{
          ...i,
          title: 'Edited After Delete',
          deleted: false,
          deletedAt: null,
          updatedAt: editTs,
        }]);
        expect(r.applied).toBe(true);
        const live = await svc.getIssue(i.id);
        expect(live).toMatchObject({ title: 'Edited After Delete', deleted: false });
      });

      it.each([
        ['strips the unknown role', undefined],
        ['overwrites it with a legacy role', 'finale'],
      ])('preserves a local climax role when a pre-v3 sender %s', async (_case, remoteArcRole) => {
        const local = await svc.createIssue({ seriesId: 'ser-1', title: 'Decisive Choice' });
        const withClimax = await svc.updateIssue(local.id, { arcRole: 'climax' });
        const updatedAt = new Date(Date.now() + 60_000).toISOString();

        await svc.mergeIssuesFromSync([{
          ...withClimax,
          title: 'Older Peer Edit',
          arcRole: remoteArcRole,
          updatedAt,
        }], { senderSchemaVersions: { pipelineIssues: 2 } });

        expect(await svc.getIssue(local.id)).toMatchObject({
          title: 'Older Peer Edit',
          arcRole: 'climax',
        });
      });

      it.each([null, { pipelineIssues: 3 }])('retains generation ownership only for unchanged stage revisions from legacy schema %j', async (senderSchemaVersions) => {
        const created = await svc.createIssue({ seriesId: 'ser-1', title: 'Local work' });
        const generation = { id: 'generation-one', instanceId: 'local-instance' };
        const { issue: local } = await svc.updateStage(created.id, 'prose', { status: 'generating', generation });
        const { generation: omitted, ...legacyStage } = local.stages.prose;
        expect(omitted).toEqual(generation);
        await svc.mergeIssuesFromSync([{ ...local, title: 'Peer title edit', updatedAt: '2099-01-01T00:00:00.000Z',
          stages: { ...local.stages, prose: legacyStage },
        }], { senderSchemaVersions });
        const retained = await svc.getIssue(local.id);
        expect(retained.title).toBe('Peer title edit');
        expect(retained.stages.prose.generation).toEqual(generation);

        // The peer starts different work without an owner-aware schema. Keeping
        // the previous marker here would falsely authorize local boot recovery.
        await svc.mergeIssuesFromSync([{ ...retained, updatedAt: '2099-01-02T00:00:00.000Z',
          stages: { ...retained.stages, prose: { ...legacyStage, updatedAt: '2099-01-02T00:00:00.000Z' } },
        }], { senderSchemaVersions });
        expect((await svc.getIssue(local.id)).stages.prose).toMatchObject({ status: 'generating', generation: null });
      });

      it('allows a v3 sender to intentionally replace climax', async () => {
        const local = await svc.createIssue({ seriesId: 'ser-1', title: 'Decisive Choice' });
        const withClimax = await svc.updateIssue(local.id, { arcRole: 'climax' });
        const updatedAt = new Date(Date.now() + 60_000).toISOString();

        await svc.mergeIssuesFromSync([{
          ...withClimax,
          arcRole: 'finale',
          updatedAt,
        }], { senderSchemaVersions: { pipelineIssues: 3 } });

        expect((await svc.getIssue(local.id)).arcRole).toBe('finale');
      });

      it('synced RESURRECTION compacts collisions — issue restored mid-series gets a unique number', async () => {
        // Regression: local delete already compacts numbering (A=1, C=2 after
        // deleting B). When B's tombstone is overridden by a later remote edit
        // (B comes back to life), B re-enters with its OLD number (2) and
        // collides with C. mergeIssuesFromSync must trigger a renumber on
        // both delete-transitions AND resurrection-transitions.
        const a = await svc.createIssue({ seriesId: 'ser-resurrect', title: 'A' });
        const b = await svc.createIssue({ seriesId: 'ser-resurrect', title: 'B' });
        const c = await svc.createIssue({ seriesId: 'ser-resurrect', title: 'C' });
        expect([a.number, b.number, c.number]).toEqual([1, 2, 3]);
        await svc.deleteIssue(b.id);
        // Local compacts to A=1, C=2.
        const afterDelete = await svc.listIssues({ seriesId: 'ser-resurrect' });
        expect(afterDelete.map((i) => i.number)).toEqual([1, 2]);
        // Remote sends B with a later updatedAt — resurrection.
        const editTs = new Date(Date.now() + 60_000).toISOString();
        await svc.mergeIssuesFromSync([{
          ...b,
          deleted: false,
          deletedAt: null,
          updatedAt: editTs,
        }]);
        const live = await svc.listIssues({ seriesId: 'ser-resurrect' });
        // All three live, contiguous numbering, no duplicates.
        expect(live.map((i) => i.title).sort()).toEqual(['A', 'B', 'C']);
        const numbers = live.map((i) => i.number).sort((x, y) => x - y);
        expect(numbers).toEqual([1, 2, 3]);
        expect(new Set(numbers).size).toBe(3);
      });

      it('synced delete-transition compacts surviving issues for that series', async () => {
        const a = await svc.createIssue({ seriesId: 'ser-sync-renum', title: 'A' });
        const b = await svc.createIssue({ seriesId: 'ser-sync-renum', title: 'B' });
        const c = await svc.createIssue({ seriesId: 'ser-sync-renum', title: 'C' });
        expect([a.number, b.number, c.number]).toEqual([1, 2, 3]);
        const ts = new Date(Date.now() + 60_000).toISOString();
        await svc.mergeIssuesFromSync([{
          ...b,
          deleted: true,
          deletedAt: ts,
          updatedAt: ts,
        }]);
        const live = await svc.listIssues({ seriesId: 'ser-sync-renum' });
        expect(live.map((i) => i.title)).toEqual(['A', 'C']);
        expect(live.map((i) => i.number)).toEqual([1, 2]);
      });

      describe('conflict journaling', () => {
        beforeEach(() => cj.__resetBaseHashCacheForTests());

        it('seeds a base hash for an issue inserted via sync (so a future divergence is detectable)', async () => {
          const t0 = '2026-05-01T00:00:00Z';
          const rec = { id: 'iss-seed-1', seriesId: 'ser-seed', title: 'Seeded', number: 1, status: 'draft', stages: {}, createdAt: t0, updatedAt: t0 };
          const r = await svc.mergeIssuesFromSync([rec]);
          expect(r).toEqual({ applied: true, count: 1 });
          const stored = await svc.getIssue('iss-seed-1');
          expect(await cj.getSyncBaseHash('issue', 'iss-seed-1')).toBe(cj.contentHashForRecord('issue', stored));
          // No overwrite happened → nothing journaled.
          expect(await cj.conflictJournalStore().loadAll()).toHaveLength(0);
        });

        it('archives the losing local issue on a true 3-way divergence before the LWW overwrite', async () => {
          const t0 = '2026-05-01T00:00:00Z';
          // Insert a base record from sync — seeds base = H(base).
          const base = { id: 'iss-conf-1', seriesId: 'ser-conf', title: 'Base', number: 1, status: 'draft', stages: {}, createdAt: t0, updatedAt: t0 };
          await svc.mergeIssuesFromSync([base]);
          // Local diverges from base (title edit bumps updatedAt to ~now).
          await svc.updateIssue('iss-conf-1', { title: 'LOCAL edit' });
          // Remote also diverges AND is newer → overwrite wins; the divergence
          // is a true 3-way conflict → the local edit is archived.
          const remoteTs = new Date(Date.now() + 60_000).toISOString();
          const r = await svc.mergeIssuesFromSync([{ ...base, title: 'REMOTE edit', updatedAt: remoteTs }], { source: { via: 'peer-push', peerId: 'peer-A' } });
          expect(r.applied).toBe(true);
          expect((await svc.getIssue('iss-conf-1')).title).toBe('REMOTE edit');
          const entries = await cj.conflictJournalStore().loadAll();
          expect(entries).toHaveLength(1);
          expect(entries[0]).toMatchObject({ recordKind: 'issue', recordId: 'iss-conf-1', status: 'pending' });
          expect(entries[0].localSnapshot.title).toBe('LOCAL edit');
          expect(entries[0].source).toMatchObject({ via: 'peer-push', peerId: 'peer-A' });
        });

        it('does NOT journal a clean sequential sync update (local matches the base)', async () => {
          const t0 = '2026-05-01T00:00:00Z';
          const base = { id: 'iss-clean-1', seriesId: 'ser-clean', title: 'Base', number: 1, status: 'draft', stages: {}, createdAt: t0, updatedAt: t0 };
          await svc.mergeIssuesFromSync([base]);
          // Local untouched since base; remote is just a newer edit → clean LWW.
          const remoteTs = new Date(Date.now() + 60_000).toISOString();
          await svc.mergeIssuesFromSync([{ ...base, title: 'Remote-only edit', updatedAt: remoteTs }]);
          expect(await cj.conflictJournalStore().loadAll()).toHaveLength(0);
        });
      });
    });

    describe('mergeIssuesFromSync — changed-only persistence and multi-series correctness', () => {
      it('keeps a newer local stage and its undo entry when sync waits behind that save', async () => {
        const original = { id: 'iss-overlap', seriesId: 'ser-1', title: 'Draft', updatedAt: '2020-01-01T00:00:00Z',
          stages: { prose: { output: 'original', lastRunId: 'run-original' } } };
        await svc.mergeIssuesFromSync([original]);
        const writing = pauseNextCall(svc.issueStore(), 'saveOneNow');
        const local = svc.updateStage(original.id, 'prose', { output: 'local draft', lastRunId: 'run-local' });
        await writing.entered;
        const merge = svc.mergeIssuesFromSync([{ ...original, updatedAt: '2020-01-02T00:00:00Z',
          stages: { prose: { output: 'peer draft' } } }]);
        try {
          // A different inbound batch can finish while this series' write is held.
          await svc.mergeIssuesFromSync([{ ...original, id: 'iss-independent', seriesId: 'ser-other' }]);
        } finally {
          writing.release();
        }
        await local;
        expect(await merge).toEqual({ applied: false, count: 0 });
        expect((await svc.getIssue(original.id)).stages.prose).toMatchObject({
          output: 'local draft', runHistory: [{ runId: 'run-original', output: 'original' }],
        });
      });

      it('leaves the issue untouched when private parent membership cannot be read', async () => {
        const original = await svc.createIssue({ seriesId: 'ser-1', title: 'Original' });
        const series = await import('./series.js');
        vi.spyOn(series, 'listSeries').mockRejectedValueOnce(new Error('Series unavailable'));
        await expect(svc.mergeIssuesFromSync([{ ...original, title: 'Peer', updatedAt: '2099-01-01T00:00:00Z' }]))
          .rejects.toThrow('Series unavailable');
        expect((await svc.getIssue(original.id)).title).toBe('Original');
      });

      it('follows a peer move to the destination queue and snapshots the winning peer draft', async () => {
        const original = await svc.createIssue({ seriesId: 'ser-z', title: 'Original' });
        const neighbor = await svc.createIssue({ seriesId: 'ser-a', title: 'Destination' });
        const unrelated = await svc.createIssue({ seriesId: 'ser-other', title: 'Independent' });
        const journal = pauseNextCall(cj, 'maybeJournalBeforeOverwrite');
        const move = svc.mergeIssuesFromSync([{ ...original, seriesId: neighbor.seriesId,
          updatedAt: '2099-01-01T00:00:00Z', stages: { prose: { output: 'peer draft', lastRunId: 'run-peer' } } }]);
        await journal.entered;
        const order = [];
        const destinationWrite = svc.updateIssue(neighbor.id, async () => {
          await svc.updateStage(unrelated.id, 'idea', { output: 'independent edit' });
          order.push('destination');
          return { title: 'Updated neighbor' };
        });
        const local = svc.updateStageWithLatest(original.id, 'prose', () => {
          order.push('stage');
          return { output: 'local draft', lastRunId: 'run-local' };
        });
        try {
          await svc.updateStage(unrelated.id, 'prose', { output: 'independent' });
        } finally {
          journal.release();
        }
        const [merged, , saved] = await Promise.all([move, destinationWrite, local]);
        expect(merged).toEqual({ applied: true, count: 1 });
        expect(saved.issue.seriesId).toBe(neighbor.seriesId);
        expect(order).toEqual(['destination', 'stage']);
        expect((await svc.getIssue(original.id)).stages.prose).toMatchObject({
          output: 'local draft', runHistory: [{ runId: 'run-peer', output: 'peer draft' }],
        });
      });

      it('serializes a sibling stage save with a peer tombstone and its renumber', async () => {
        const removed = await svc.createIssue({ seriesId: 'ser-1', title: 'First' });
        const sibling = await svc.createIssue({ seriesId: 'ser-1', title: 'Second' });
        await svc.updateStage(sibling.id, 'prose', { output: 'original', lastRunId: 'run-original' });
        const journal = pauseNextCall(cj, 'maybeJournalBeforeOverwrite');
        const tombstone = svc.mergeIssuesFromSync([{ ...removed, deleted: true,
          deletedAt: '2099-01-01T00:00:00Z', updatedAt: '2099-01-01T00:00:00Z' }]);
        await journal.entered;
        const local = svc.updateStage(sibling.id, 'prose', { output: 'local draft', lastRunId: 'run-local' });
        journal.release();
        await Promise.all([tombstone, local]);
        expect(await svc.listIssues({ seriesId: sibling.seriesId })).toMatchObject([{
          id: sibling.id, number: 1, stages: { prose: {
            output: 'local draft', runHistory: [{ runId: 'run-original', output: 'original' }],
          } },
        }]);
      });

      it('merges issues from two different series correctly', async () => {
        const a = await svc.createIssue({ seriesId: 'ser-multi-1', title: 'A1' });
        const b = await svc.createIssue({ seriesId: 'ser-multi-2', title: 'B1' });

        const laterTs = new Date(Date.now() + 60_000).toISOString();
        const result = await svc.mergeIssuesFromSync([
          { ...a, title: 'A1 updated', updatedAt: laterTs },
          { ...b, title: 'B1 updated', updatedAt: laterTs },
        ]);

        expect(result).toEqual({ applied: true, count: 2 });
        const updatedA = await svc.getIssue(a.id);
        const updatedB = await svc.getIssue(b.id);
        expect(updatedA.title).toBe('A1 updated');
        expect(updatedB.title).toBe('B1 updated');
      });

      it('persists only changed issues — unchanged ones are not written', async () => {
        const changed = await svc.createIssue({ seriesId: 'ser-persist-check', title: 'Changed' });
        const unchanged = await svc.createIssue({ seriesId: 'ser-persist-check', title: 'Unchanged' });

        const { atomicWrite } = await import('../../lib/fileUtils.js');
        const writesBefore = atomicWrite.mock.calls.length;

        const laterTs = new Date(Date.now() + 60_000).toISOString();
        await svc.mergeIssuesFromSync([
          { ...changed, title: 'Changed - remote edit', updatedAt: laterTs },
          // unchanged issue: same updatedAt → LWW skips it
        ]);

        const issueWritesAfter = atomicWrite.mock.calls
          .slice(writesBefore)
          .map(([path]) => path)
          .filter((p) => p.includes('pipeline-issues'));

        // The changed issue must have been written.
        expect(issueWritesAfter.some((p) => p.includes(changed.id))).toBe(true);
        // The unchanged issue must NOT have been written (B8 fix: only changed subset).
        expect(issueWritesAfter.some((p) => p.includes(unchanged.id))).toBe(false);
        // Only 1 issue-record write (the changed one), not 2.
        expect(issueWritesAfter.length).toBe(1);
      });

      it('includes renumbered siblings in the persisted set after a delete-transition merge', async () => {
        const x = await svc.createIssue({ seriesId: 'ser-renum-persist', title: 'X' });
        const y = await svc.createIssue({ seriesId: 'ser-renum-persist', title: 'Y' });
        const z = await svc.createIssue({ seriesId: 'ser-renum-persist', title: 'Z' });
        expect([x.number, y.number, z.number]).toEqual([1, 2, 3]);

        const { atomicWrite } = await import('../../lib/fileUtils.js');
        const writesBefore = atomicWrite.mock.calls.length;

        const laterTs = new Date(Date.now() + 60_000).toISOString();
        // Delete Y via sync — should renumber Z from #3 to #2.
        await svc.mergeIssuesFromSync([{ ...y, deleted: true, deletedAt: laterTs, updatedAt: laterTs }]);

        const issueWritesAfter = atomicWrite.mock.calls
          .slice(writesBefore)
          .map(([path]) => path)
          .filter((p) => p.includes('pipeline-issues'));

        // Y (the changed issue) must be persisted.
        expect(issueWritesAfter.some((p) => p.includes(y.id))).toBe(true);
        // Z was renumbered from #3 to #2 — its record must also be persisted.
        expect(issueWritesAfter.some((p) => p.includes(z.id))).toBe(true);
        // X was not renumbered (number=1 doesn't change) — must NOT be written.
        expect(issueWritesAfter.some((p) => p.includes(x.id))).toBe(false);
        // Total issue-record writes: Y + Z = 2, not 3 (all issues).
        expect(issueWritesAfter.length).toBe(2);

        // Verify final state.
        const live = await svc.listIssues({ seriesId: 'ser-renum-persist' });
        expect(live.map((i) => i.title).sort()).toEqual(['X', 'Z']);
        expect(live.map((i) => i.number).sort((a, b) => a - b)).toEqual([1, 2]);
      });
    });

    describe('pruneTombstonedIssues', () => {
      it('removes tombstones older than the cutoff and leaves newer ones + live records', async () => {
        const live = await svc.createIssue({ seriesId: 'ser-prune', title: 'Live' });
        const oldT = await svc.createIssue({ seriesId: 'ser-prune', title: 'Old A' });
        const oldT2 = await svc.createIssue({ seriesId: 'ser-prune', title: 'Old B' });
        const newT = await svc.createIssue({ seriesId: 'ser-prune', title: 'New' });
        await svc.deleteIssue(oldT.id);
        await svc.deleteIssue(oldT2.id);
        await svc.deleteIssue(newT.id);
        // Back-date both old tombstones via merge so the GC sees them as 100s ago.
        const oldDeletedAt = new Date(Date.now() - 100_000).toISOString();
        const oldIssue = await svc.getIssue(oldT.id, { includeDeleted: true });
        const oldIssue2 = await svc.getIssue(oldT2.id, { includeDeleted: true });
        const mergeUpdatedAt = new Date(Date.now() + 10_000).toISOString();
        await svc.mergeIssuesFromSync([
          { ...oldIssue, deletedAt: oldDeletedAt, updatedAt: mergeUpdatedAt },
          { ...oldIssue2, deletedAt: oldDeletedAt, updatedAt: mergeUpdatedAt },
        ]);
        // Seed base hashes for both old (to-be-pruned) issues and the live issue
        // so we can confirm the two evictions share one side-store write.
        await cj.setSyncBaseHash('issue', oldT.id, 'hash-old');
        await cj.setSyncBaseHash('issue', oldT2.id, 'hash-old-2');
        await cj.setSyncBaseHash('issue', live.id, 'hash-live');
        await cj.flushBaseHashes();
        writeCounter.baseHash = 0;
        // Serialize the eviction calls without sleeping. Without the batch,
        // each call would finish its own side-store write before the next one.
        baseHashEvictionSequence.enabled = true;
        const cutoff = Date.now() - 50_000;
        const result = await svc.pruneTombstonedIssues(cutoff);
        expect(result.pruned).toBe(2);
        expect(writeCounter.baseHash).toBe(1);
        const remaining = await svc.listIssues({ seriesId: 'ser-prune', includeDeleted: true });
        const ids = remaining.map((i) => i.id);
        expect(ids).toContain(live.id);
        expect(ids).toContain(newT.id);
        expect(ids).not.toContain(oldT.id);
        expect(ids).not.toContain(oldT2.id);
        // Both pruned issues' conflict-journal base hashes are evicted; the
        // live issue's key is untouched.
        cj.__resetBaseHashCacheForTests();
        expect(await cj.getSyncBaseHash('issue', oldT.id)).toBeNull();
        expect(await cj.getSyncBaseHash('issue', oldT2.id)).toBeNull();
        expect(await cj.getSyncBaseHash('issue', live.id)).toBe('hash-live');
      });

      it('rechecks stale candidates before deleting or evicting their base hashes', async () => {
        const restored = await svc.createIssue({ seriesId: 'ser-first', title: 'Restored' });
        const tomb = await svc.createIssue({ seriesId: 'ser-second', title: 'Fresh tombstone' });
        const cutoff = Date.now() - 60_000;
        await svc.deleteIssue(tomb.id);
        await cj.setSyncBaseHash('issue', restored.id, 'restored-hash');
        const store = svc.issueStore();
        vi.spyOn(store, 'listTombstoneIdsBefore').mockResolvedValueOnce([restored.id, tomb.id]);
        const all = vi.spyOn(store, 'loadAll');
        expect(await svc.pruneTombstonedIssues(cutoff)).toEqual({ pruned: 0 });
        expect(all).not.toHaveBeenCalled();
        expect((await svc.getIssue(restored.id)).deleted).toBe(false);
        expect((await svc.getIssue(tomb.id, { includeDeleted: true })).deleted).toBe(true);
        expect(await cj.getSyncBaseHash('issue', restored.id)).toBe('restored-hash');
      });

      it('keeps tombstones with unparseable deletedAt (conservative — never silently delete)', async () => {
        const issue = await svc.createIssue({ seriesId: 'ser-corrupt', title: 'C' });
        await svc.deleteIssue(issue.id);
        const tomb = await svc.getIssue(issue.id, { includeDeleted: true });
        await svc.mergeIssuesFromSync([{
          ...tomb,
          deletedAt: 'not-a-date',
          updatedAt: new Date(Date.now() + 10_000).toISOString(),
        }]);
        const result = await svc.pruneTombstonedIssues(Date.now() + 60_000_000);
        expect(result.pruned).toBe(0);
      });

      it('returns { pruned: 0 } for a non-finite cutoff (defensive)', async () => {
        expect(await svc.pruneTombstonedIssues(NaN)).toEqual({ pruned: 0 });
        expect(await svc.pruneTombstonedIssues(Infinity)).toEqual({ pruned: 0 });
        expect(await svc.pruneTombstonedIssues('nope')).toEqual({ pruned: 0 });
      });
    });

    describe('listIssueIds', () => {
      it('returns live ids by default and includes deleted only when asked', async () => {
        const a = await svc.createIssue({ seriesId: 'ser-ids', title: 'A' });
        const b = await svc.createIssue({ seriesId: 'ser-ids', title: 'B' });
        await svc.deleteIssue(b.id);
        const live = await svc.listIssueIds();
        expect(live).toContain(a.id);
        expect(live).not.toContain(b.id);
        const all = await svc.listIssueIds({ includeDeleted: true });
        expect(all).toEqual(expect.arrayContaining([a.id, b.id]));
      });

      it('is uncapped — does not slice at ISSUES_PER_RESPONSE_MAX like listIssues', async () => {
        // Guard the conflict-journal orphan-sweep contract: listIssueIds must
        // return EVERY live id, or the sweep would treat a live issue beyond
        // the cap as orphaned and strip its base hash. Asserted structurally
        // here (cap math) since seeding 1000+ issues is too slow for a unit
        // test: listIssues caps with `.slice(0, ISSUES_PER_RESPONSE_MAX)`,
        // listIssueIds has no slice. We at least confirm a small set round-trips
        // 1:1 (no accidental pagination/limit wired in).
        const ids = [];
        for (let i = 0; i < 5; i++) ids.push((await svc.createIssue({ seriesId: 'ser-uncapped', title: `E${i}` })).id);
        const got = await svc.listIssueIds();
        for (const id of ids) expect(got).toContain(id);
        expect(got.filter((id) => ids.includes(id))).toHaveLength(5);
      });
    });

    describe('listAllIssues', () => {
      it('returns full live records, includes deleted only when asked, strips history on request', async () => {
        const a = await svc.createIssue({ seriesId: 'ser-all', title: 'A' });
        const b = await svc.createIssue({ seriesId: 'ser-all', title: 'B' });
        await svc.deleteIssue(b.id);
        const live = await svc.listAllIssues();
        expect(live.map((i) => i.id)).toContain(a.id);
        expect(live.map((i) => i.id)).not.toContain(b.id);
        // Full records, not ids — the canon-usage tally needs stages/seriesId.
        const rec = live.find((i) => i.id === a.id);
        expect(rec.seriesId).toBe('ser-all');
        const all = await svc.listAllIssues({ includeDeleted: true });
        expect(all.map((i) => i.id)).toEqual(expect.arrayContaining([a.id, b.id]));
        const lean = await svc.listAllIssues({ withHistory: false });
        const leanRec = lean.find((i) => i.id === a.id);
        expect(leanRec).toBeTruthy();
      });

      it('scopes an uncapped read to several series without including others', async () => {
        const a = await svc.createIssue({ seriesId: 'ser-scope-a', title: 'A' });
        const b = await svc.createIssue({ seriesId: 'ser-scope-b', title: 'B' });
        await svc.createIssue({ seriesId: 'ser-scope-other', title: 'Other' });
        const scoped = await svc.listAllIssues({
          seriesIds: ['ser-scope-a', 'ser-scope-b', 'ser-scope-a'],
          withHistory: false,
        });
        expect(scoped.map((i) => i.id).sort()).toEqual([a.id, b.id].sort());
        expect(await svc.listAllIssues({ seriesIds: [] })).toEqual([]);
      });
    });

    describe('listIssuesForSeries (#1469)', () => {
      it('returns only the named series, sorted by number, live by default', async () => {
        await svc.createIssue({ seriesId: 'ser-x', title: 'X1' });
        await svc.createIssue({ seriesId: 'ser-y', title: 'Y1' });
        const x2 = await svc.createIssue({ seriesId: 'ser-x', title: 'X2' });
        await svc.deleteIssue(x2.id);
        const got = await svc.listIssuesForSeries('ser-x');
        expect(got.every((i) => i.seriesId === 'ser-x')).toBe(true);
        expect(got.map((i) => i.id)).not.toContain(x2.id); // tombstoned excluded
        // Sorted ascending by issue number.
        const nums = got.map((i) => i.number);
        expect(nums).toEqual([...nums].sort((a, b) => a - b));
      });

      it('includes deleted only when asked, strips history on request', async () => {
        const a = await svc.createIssue({ seriesId: 'ser-fs', title: 'A' });
        await svc.updateStage(a.id, 'idea', { status: 'ready', output: 'v1', lastRunId: 'r1' });
        await svc.updateStage(a.id, 'idea', { status: 'ready', output: 'v2', lastRunId: 'r2' });
        const b = await svc.createIssue({ seriesId: 'ser-fs', title: 'B' });
        await svc.deleteIssue(b.id);
        expect((await svc.listIssuesForSeries('ser-fs')).map((i) => i.id)).not.toContain(b.id);
        expect((await svc.listIssuesForSeries('ser-fs', { includeDeleted: true })).map((i) => i.id)).toContain(b.id);
        const lean = await svc.listIssuesForSeries('ser-fs', { withHistory: false });
        const leanRec = lean.find((i) => i.id === a.id);
        expect(leanRec.stages.idea.runHistory).toEqual([]);
        expect(leanRec.stages.idea.output).toBe('v2'); // active fields survive
      });

      it('is uncapped — does not slice at ISSUES_PER_RESPONSE_MAX like listIssues', async () => {
        // The editorial runner's storyboard / comic-lettering projections depend
        // on seeing EVERY issue in a series: listIssues caps at 1000, this must
        // not. Asserted structurally (cap math) rather than by seeding 1000+
        // records, which is too slow for a unit test — listIssues slices with
        // `.slice(0, ISSUES_PER_RESPONSE_MAX)`, listIssuesForSeries has no slice.
        // We confirm a small set round-trips 1:1 (no accidental limit wired in).
        const ids = [];
        for (let i = 0; i < 5; i++) ids.push((await svc.createIssue({ seriesId: 'ser-cap', title: `C${i}` })).id);
        const got = await svc.listIssuesForSeries('ser-cap');
        expect(got.map((i) => i.id).filter((id) => ids.includes(id))).toHaveLength(5);
      });
    });
  });
});
