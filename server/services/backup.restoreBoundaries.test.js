/** Backup service suite: restoreSnapshot snapshotId validation, rsync filter flags and the live-store restore ownership boundaries. Shared mocks and helpers live in backup.test.fixture.js (#16215). */
import { testDataRoot, reconcileMediaAssets, clearRestoredMediaTombstones, snapshotCutSeam, machineHost, fakeProc, flush, scheduleStoreBoundary } from './backup.test.fixture.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'fs';
import { spawn } from '../lib/childProcess.js';
import { join, resolve } from 'path';
import { PATHS } from '../lib/fileUtils.js';
import * as fs from 'fs/promises';
import { reloadSettings, withLiveSettingsRestore } from './settings.js';
import { invalidateAllCaches as invalidateBrainCaches } from './brainStorage.js';
import { restoreSnapshot } from './backup.js';
import { withLiveCosRestore } from './cos/cosState.js';
import { RECORDING_STAGE_RSYNC_GLOB } from './cos/recordingStages.js';
import { withLiveMediaModelsRestore } from '../lib/mediaModels.js';
import { withLiveTaskScheduleRestore, updateSchedule } from './taskScheduleStore.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { _healthRestoreDrainingForTests, ingestHealthData, withLiveHealthRestore } from './appleHealthIngest.js';
import { meatspaceEvents } from './meatspace/meatspaceEvents.js';

const machineLocalCredentialRestoreExcludes = [
  '--exclude=/[cC][aA][lL][eE][nN][dD][aA][rR]/[gG][oO][oO][gG][lL][eE]-[aA][uU][tT][hH]',
  '--exclude=/[sS][pP][oO][tT][iI][fF][yY]/[cC][rR][eE][dD][eE][nN][tT][iI][aA][lL][sS].[jJ][sS][oO][nN]',
  '--exclude=/[sS][pP][oO][tT][iI][fF][yY]/[tT][oO][kK][eE][nN][sS].[jJ][sS][oO][nN]',
  '--exclude=/[sS][pP][oO][tT][iI][fF][yY]/[cC][aA][cC][hH][eE]',
  '--exclude=/[oO][pP][eE][nN][cC][lL][aA][wW]',
  '--exclude=/[jJ][iI][rR][aA].[jJ][sS][oO][nN]',
  '--exclude=/[dD][aA][tT][aA][dD][oO][gG].[jJ][sS][oO][nN]',
  '--exclude=/[aA][uU][tT][hH]-[sS][eE][sS][sS][iI][oO][nN][sS].[jJ][sS][oO][nN]',
];

// snapshotId validation + rsync filter construction + settings cache re-sync.
// restoreSnapshot writes over the user's live data/ directory, so each of these
// is a data-loss-adjacent contract, not a style nit (issue #3917).
describe('restoreSnapshot snapshotId, filter flags, and settings re-sync', () => {
  beforeEach(() => {
    spawn.mockReset();
    reloadSettings.mockClear();
    invalidateBrainCaches.mockClear();
    withLiveCosRestore.mockClear();
    withLiveMediaModelsRestore.mockClear();
    withLiveSettingsRestore.mockClear();
    withLiveTaskScheduleRestore.mockReset().mockImplementation(fn => fn());
  });

  // Drive a mocked rsync to a clean exit so restoreSnapshot resolves.
  async function runRestore(...args) {
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const pending = restoreSnapshot(...args);
    await flush();
    proc.emit('close', 0);
    return pending;
  }

  describe('snapshotId validation', () => {
    // Ids containing a separator fail the character allow-list outright...
    for (const bad of ['../../etc', '../escape', 'a/b', 'snap 1', 'snap;rm -rf', '']) {
      it(`rejects ${JSON.stringify(bad)} before spawning rsync`, async () => {
        await expect(restoreSnapshot('/dest', bad)).rejects.toThrow(/Invalid snapshotId/);
        expect(spawn).not.toHaveBeenCalled();
      });
    }

    // ...but `..` is made only of allow-listed characters, so it slips past the
    // regex and must be caught by the resolve()/relative() traversal check. This
    // is the bypass probe: delete that second guard and only this case fails.
    it('rejects a bare `..` that passes the character allow-list, via the traversal check', async () => {
      await expect(restoreSnapshot('/dest', '..')).rejects.toThrow(/Path traversal detected/);
      expect(spawn).not.toHaveBeenCalled();
    });

    it('accepts a timestamp-shaped id', async () => {
      await expect(runRestore('/dest', '2026-01-02T03:04:05.678Z')).resolves.toMatchObject({
        snapshotId: '2026-01-02T03:04:05.678Z',
      });
      expect(spawn).toHaveBeenCalledTimes(1);
    });
  });

  describe('restore log lines (#12979)', () => {
    it('logs start and completion for an executed restore, with the snapshot id and changed-file count', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await runRestore('/dest', '2026-01-02T03:04:05.678Z', { dryRun: false });
        expect(log).toHaveBeenCalledWith('💾 Restore starting: snapshot 2026-01-02T03:04:05.678Z');
        expect(log).toHaveBeenCalledWith('💾 Restore complete: snapshot 2026-01-02T03:04:05.678Z, 0 files changed');
      } finally {
        log.mockRestore();
      }
    });

    it('stays silent for a preview', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await runRestore('/dest', '2026-01-02T03:04:05.678Z');
        expect(log).not.toHaveBeenCalledWith(expect.stringContaining('Restore starting'));
        expect(log).not.toHaveBeenCalledWith(expect.stringContaining('Restore complete'));
      } finally {
        log.mockRestore();
      }
    });
  });

  describe('subdirFilter rsync flags', () => {

    const expectedExcludes = [
      '--exclude=.DS_Store',
      '--exclude=.localized',
      '--exclude=Thumbs.db',
      '--exclude=desktop.ini',
      '--exclude=._*',
      '--exclude=/[cC][eE][rR][tT][sS]',
      '--exclude=/[tT][aA][iI][lL][cC][aA][tT]-[sS][eE][rR][vV][eE].[jJ][sS][oO][nN]',
      '--exclude=/[tT][aA][iI][lL][cC][aA][tT]-[sS][eE][rR][vV][eE].[aA][dD][dD][rR]',
      '--exclude=/[tT][aA][iI][lL][cC][aA][tT]-[fF][oO][rR][wW][aA][rR][dD][sS].[jJ][sS][oO][nN]',
      ...machineLocalCredentialRestoreExcludes,
      '--exclude=/[dD][aA][tT][aA][bB][aA][sS][eE]-[aA][uU][tT][hH][oO][rR][iI][tT][yY].[jJ][sS][oO][nN]',
      '--exclude=/[dD][aA][tT][aA][bB][aA][sS][eE]-[rR][eE][sS][tT][oO][rR][eE]-[rR][eE][cC][oO][vV][eE][rR][yY].[jJ][sS][oO][nN]',
        '--exclude=/[dD][aA][tT][aA][bB][aA][sS][eE]-[mM][aA][iI][nN][tT][eE][nN][aA][nN][cC][eE]',
        '--exclude=/.[pP][eE][eE][rR]-[eE][xX][eE][cC][uU][tT][iI][oO][nN]-[aA][uU][tT][hH][oO][rR][iI][tT][yY]-[lL][oO][cC][kK]',
        '--exclude=/[mM][iI][gG][rR][aA][tT][iI][oO][nN][sS].[lL][oO][cC][kK]',
      '--exclude=/[pP][eE][eE][rR]-[aA][dD][mM][iI][nN]-[gG][rR][aA][nN][tT][sS].[jJ][sS][oO][nN]',
      '--exclude=/[pP][eE][eE][rR]-[eE][xX][eE][cC][uU][tT][iI][oO][nN]',
      '--exclude=/[pP][eE][eE][rR]-[eE][xX][eE][cC][uU][tT][iI][oO][nN]-[cC][aA][tT][aA][lL][oO][gG].[jJ][sS][oO][nN]',
      '--exclude=/[pP][eE][eE][rR]-[eE][xX][eE][cC][uU][tT][iI][oO][nN]-[gG][rR][aA][nN][tT][sS].[jJ][sS][oO][nN]',
      '--exclude=/[pP][eE][eE][rR]-[eE][xX][eE][cC][uU][tT][iI][oO][nN]-[aA][uU][tT][hH][oO][rR][iI][tT][yY].[jJ][sS][oO][nN]',
      '--exclude=/[pP][eE][eE][rR]-[eE][xX][eE][cC][uU][tT][iI][oO][nN]-[rR][eE][cC][oO][vV][eE][rR][yY].[jJ][sS][oO][nN][lL]',
      '--exclude=/[wW][oO][rR][kK][fF][lL][oO][wW]-[mM][aA][iI][nN][tT][eE][nN][aA][nN][cC][eE]',
      '--exclude=/[bB][aA][cC][kK][uU][pP]-[aA][dD][mM][iI][sS][sS][iI][oO][nN]',
      '--exclude=/[cC][oO][sS]/[aA][gG][eE][nN][tT][sS]/.[bB][rR][aA][nN][cC][hH]-[pP][oO][lL][iI][cC][yY]-[rR][eE][vV][iI][sS][iI][oO][nN]',
      `--exclude=${RECORDING_STAGE_RSYNC_GLOB}`,
      '--exclude=/[tT][aA][iI][lL][cC][aA][tT]-[sS][eE][rR][vV][eE].[jJ][sS][oO][nN].*.[tT][mM][pP]',
      '--exclude=/[tT][aA][iI][lL][cC][aA][tT]-[fF][oO][rR][wW][aA][rR][dD][sS].[jJ][sS][oO][nN].*.[tT][mM][pP]',
      '--exclude=/[pP][eE][eE][rR]-[aA][dD][mM][iI][nN]-[gG][rR][aA][nN][tT][sS].[jJ][sS][oO][nN].*.[tT][mM][pP]',
      '--exclude=/[pP][eE][eE][rR]-[eE][xX][eE][cC][uU][tT][iI][oO][nN]-[gG][rR][aA][nN][tT][sS].[jJ][sS][oO][nN].*.[tT][mM][pP]',
      '--exclude=/.[dD][aA][tT][aA][bB][aA][sS][eE]-[rR][eE][sS][tT][oO][rR][eE]-[rR][eE][cC][oO][vV][eE][rR][yY]-*.[pP][eE][nN][dD][iI][nN][gG]',
        '--exclude=/[dD][aA][tT][aA][bB][aA][sS][eE]-[aA][uU][tT][hH][oO][rR][iI][tT][yY]-*.[pP][eE][nN][dD][iI][nN][gG]',
        '--exclude=/.[pP][eE][eE][rR]-[eE][xX][eE][cC][uU][tT][iI][oO][nN]-[aA][uU][tT][hH][oO][rR][iI][tT][yY]-*.[pP][eE][nN][dD][iI][nN][gG]',
        '--exclude=/.[pP][eE][eE][rR]-[eE][xX][eE][cC][uU][tT][iI][oO][nN]-[aA][dD][oO][pP][tT][iI][oO][nN]-*.[pP][eE][nN][dD][iI][nN][gG]',
        '--exclude=/[mM][iI][gG][rR][aA][tT][iI][oO][nN][sS].[aA][pP][pP][lL][iI][eE][dD].[jJ][sS][oO][nN].[tT][mM][pP]-*',
      '--exclude=/[sS][eE][tT][tT][iI][nN][gG][sS].[jJ][sS][oO][nN]',
      '--exclude=/[mM][aA][nN][aA][gG][eE][dD]-[vV][iI][sS][iI][tT][oO][rR]-[cC][rR][eE][dD][eE][nN][tT][iI][aA][lL][sS].[jJ][sS][oO][nN]',
      '--exclude=/[pP][rR][iI][vV][aA][tT][eE]/[aA][pP][iI]-[kK][eE][yY][sS].[jJ][sS][oO][nN]',
      '--exclude=/[pP][rR][oO][vV][iI][dD][eE][rR][sS].[jJ][sS][oO][nN]',
      // Federation identity uses the private credential writer (#19845).
      '--exclude=/[iI][nN][sS][tT][aA][nN][cC][eE][sS].[jJ][sS][oO][nN]',
    ];
    it('reads a legacy flat snapshot when that source is explicitly selected', async () => {
      await runRestore('/dest', 'legacy-snapshot', { source: '@legacy', dryRun: true });

      expect(spawn.mock.calls[0][1]).toEqual(expect.arrayContaining([
        `${resolve('/dest', 'snapshots', 'legacy-snapshot', 'data')}/`,
        PATHS.data,
      ]));
    });

    it('builds the exact include/exclude chain for a valid subdirFilter', async () => {
      await runRestore('/dest', 'snap-1', { dryRun: true, subdirFilter: 'brain' });

      const srcDir = resolve('/dest', 'snapshots', machineHost, 'snap-1', 'data');
      // Asserted as an exact array (not arrayContaining): the ORDER matters to
      // rsync — `--exclude=*` must come last, after both includes, or the
      // targeted restore silently degrades into a full-tree restore.
      // Itemize legitimately appears twice: runRsync always prepends the long
      // `--itemize-changes`, and restoreSnapshot adds the SHORT `-ii` so rsync
      // also reports files its `--checksum` digest found unchanged (#7299) —
      // without those lines a big unchanged tree is silent long enough to trip
      // the idle watchdog. The short form is load-bearing: macOS's openrsync
      // does not stack a repeated long `--itemize-changes`. Pinned here so a
      // future de-dup is a deliberate change.
      expect(spawn.mock.calls[0][1]).toEqual([
        '--archive',
        '--itemize-changes',
        '--progress',
        '-ii',
        '--checksum',
        // These excludes must precede the includes because rsync uses the first matching rule.
        ...expectedExcludes,
        '--exclude=/[pP][rR][iI][vV][aA][tT][eE]',
        '--dry-run',
        // Leading `/` is load-bearing: rsync matches an unanchored pattern
        // against the end of every path, so `brain/***` would also restore
        // `data/<anything>/brain/**` — outside the scope the preflight verified.
        '--include=/brain',
        '--include=/brain/***',
        '--include=*/',
        '--exclude=*',
        `${srcDir}/`,
        PATHS.data,
      ]);
    });

    it('emits no scope include/exclude flags when no subdirFilter is given', async () => {
      await runRestore('/dest', 'snap-1', { dryRun: true });

      const args = spawn.mock.calls[0][1];
      // The OS-metadata excludes always ride along (they mirror what the
      // integrity inventory skips); nothing else scopes an unfiltered restore.
      expect(args.filter(a => a.startsWith('--include='))).toEqual([]);
      expect(args.filter(a => a.startsWith('--exclude='))).toEqual(expectedExcludes);
    });

    it('passes machine-local OAuth and OpenClaw exclusions to rsync restores', async () => {
      await runRestore('/dest', 'snap-1', { dryRun: true });

      const args = spawn.mock.calls[0][1];
      expect(args).toEqual(expect.arrayContaining(machineLocalCredentialRestoreExcludes));
    });

    it('echoes the subdirFilter back in the result', async () => {
      await expect(runRestore('/dest', 'snap-1', { dryRun: true, subdirFilter: 'brain' }))
        .resolves.toMatchObject({ subdirFilter: 'brain' });
    });
  });

  describe('schedule restore ownership boundary', () => {
    it.each([
      [undefined, 0], ['cos', 0], ['cos/', 0], ['cos/task-schedule.json', 0],
      ['./cos//task-schedule.json/', 0], ['cos/task-schedule.json', 1]
    ])('drains schedule writes before CoS and preserves restored values for scope %s, exit %s', async (subdirFilter, exitCode) => {
      withLiveTaskScheduleRestore.mockImplementation(scheduleStoreBoundary.restore);
      const stateQueue = createFileWriteQueue();
      const consultedState = vi.fn();
      if (!subdirFilter || subdirFilter.replace(/\/$/, '') === 'cos') {
        withLiveCosRestore.mockImplementationOnce(fn => stateQueue(fn));
      }
      const admitted = Promise.withResolvers();
      const finishWrite = Promise.withResolvers();
      const writing = updateSchedule(async schedule => {
        admitted.resolve();
        await finishWrite.promise;
        await stateQueue(consultedState);
        schedule.tasks.security.enabled = true;
        return { changed: true };
      });
      await admitted.promise;
      const proc = fakeProc();
      spawn.mockReturnValue(proc);
      const pending = restoreSnapshot('/dest', 'snap-1', { dryRun: false, subdirFilter });
      await vi.waitFor(() => expect(withLiveTaskScheduleRestore).toHaveBeenCalledTimes(1));
      expect(withLiveCosRestore).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      finishWrite.resolve();
      await flush();
      expect(consultedState).toHaveBeenCalledTimes(1);
      const restored = {
        version: 2, tasks: { security: { enabled: false, prompt: 'Restored custom prompt' } },
        templates: [{ id: 'restored-template', prompt: 'Example template' }], executions: {}
      };
      // Synthetic rsync boundary only: replace bytes in the isolated test root.
      writeFileSync(join(PATHS.cos, 'task-schedule.json'), JSON.stringify(restored));
      const later = vi.fn(schedule => {
        schedule.executions['task:security'] = { count: 7 };
        return { changed: true };
      });
      const waitingWrite = updateSchedule(later);
      expect(later).not.toHaveBeenCalled();
      proc.emit('close', exitCode);
      if (exitCode) await expect(pending).rejects.toThrow(/Some files may already have been overwritten/);
      else await pending;
      await Promise.all([writing, waitingWrite]);
      const persisted = JSON.parse(readFileSync(join(PATHS.cos, 'task-schedule.json'), 'utf8'));
      expect(persisted.tasks.security).toMatchObject({ enabled: false, prompt: 'Restored custom prompt' });
      expect(persisted.templates).toEqual(restored.templates);
      expect(persisted.executions['task:security']).toEqual({ count: 7 });
    });

    it.each([{ dryRun: true }, { dryRun: true, subdirFilter: 'cos/task-schedule.json' }, { dryRun: false, subdirFilter: 'cos/state.json' }, { dryRun: false, subdirFilter: 'images' }])('does not acquire schedule ownership for %j', async options => {
      await runRestore('/dest', 'snap-1', options);
      expect(withLiveTaskScheduleRestore).not.toHaveBeenCalled();
    });
  });

  describe('CoS restore ownership boundary', () => {
    it.each([undefined, 'cos', 'cos/', 'cos/config.json', 'cos/state.json', 'cos/agents', 'cos/agents/', 'cos/agents/index.json'])('holds the boundary for affected live scope %s', async subdirFilter => {
      await runRestore('/dest', 'snap-1', { dryRun: false, subdirFilter });
      expect(withLiveCosRestore).toHaveBeenCalledTimes(1);
    });
    it.each([{ dryRun: true }, { dryRun: false, subdirFilter: 'images' }, { dryRun: true, subdirFilter: 'cos/agents' }])('leaves unaffected scope alone: %j', async options => {
      await runRestore('/dest', 'snap-1', options);
      expect(withLiveCosRestore).not.toHaveBeenCalled();
    });
    it('refuses unsafe CoS restore before rsync', async () => {
      withLiveCosRestore.mockRejectedValueOnce(new Error('Stop CoS before restoring'));
      await expect(restoreSnapshot('/dest', 'snap-1', { dryRun: false, subdirFilter: 'cos' })).rejects.toThrow('Stop CoS');
      expect(spawn).not.toHaveBeenCalled();
    });
  });

  describe('live file restore publication boundary', () => {
    afterEach(() => { snapshotCutSeam.wrap = null; });

    it.each([false, true])('drains file publications before domain queues and holds reconciliation (bypass=%s)', async bypass => {
      const { withBackupAssetPublication } = await import('../lib/backupSnapshotBoundary.js');
      const marker = join(testDataRoot(), 'restore-publication.txt');
      const admitted = Promise.withResolvers();
      const finishPublication = Promise.withResolvers();
      const requested = Promise.withResolvers();
      const transferring = Promise.withResolvers();
      const reconciling = Promise.withResolvers();
      const finishReconciliation = Promise.withResolvers();
      snapshotCutSeam.wrap = acquire => {
        requested.resolve();
        return bypass ? () => {} : acquire();
      };
      const publication = withBackupAssetPublication(async () => {
        await fs.writeFile(marker, 'old publication started');
        admitted.resolve();
        await finishPublication.promise;
        await fs.writeFile(marker, 'old publication committed');
      });
      await admitted.promise;
      const proc = fakeProc();
      spawn.mockImplementationOnce(() => {
        // Real destination bytes at the rsync process boundary, no live data.
        writeFileSync(marker, 'restored snapshot');
        transferring.resolve();
        setImmediate(() => proc.emit('close', 0));
        return proc;
      });
      reloadSettings.mockImplementationOnce(async () => {
        reconciling.resolve();
        await finishReconciliation.promise;
      });
      const restore = restoreSnapshot('/dest', 'snap-1', { dryRun: false });
      let later;
      try {
        await requested.promise;
        if (bypass) {
          await transferring.promise;
          expect(withLiveSettingsRestore).toHaveBeenCalledTimes(1);
        } else {
          await new Promise(resolve => setImmediate(resolve));
          expect(withLiveSettingsRestore).not.toHaveBeenCalled();
          expect(withLiveCosRestore).not.toHaveBeenCalled();
          expect(spawn).not.toHaveBeenCalled();
        }
        finishPublication.resolve();
        await publication;
        await reconciling.promise;
        // Without the outer cut, the older in-flight write overwrites restored
        // bytes. With it, rsync starts only after that publication is durable.
        expect(await fs.readFile(marker, 'utf8')).toBe(bypass ? 'old publication committed' : 'restored snapshot');
        let laterRan = false;
        later = withBackupAssetPublication(async () => {
          laterRan = true;
          await fs.writeFile(marker, 'later publication');
        });
        await new Promise(resolve => setImmediate(resolve));
        expect(laterRan).toBe(bypass);
      } finally {
        finishPublication.resolve();
        finishReconciliation.resolve();
        await Promise.all([publication, restore, later]);
      }
      expect(await fs.readFile(marker, 'utf8')).toBe('later publication');
    });

    it('refuses an owned cut before domain queues or transfer, while preview remains available', async () => {
      const { acquireBackupSnapshotCut } = await import('../lib/backupSnapshotBoundary.js');
      const release = await acquireBackupSnapshotCut();
      try {
        await expect(restoreSnapshot('/dest', 'snap-1', { dryRun: false }))
          .rejects.toMatchObject({ code: 'BACKUP_SNAPSHOT_BUSY' });
        expect(withLiveSettingsRestore).not.toHaveBeenCalled();
        expect(withLiveCosRestore).not.toHaveBeenCalled();
        expect(spawn).not.toHaveBeenCalled();
        await expect(runRestore('/dest', 'snap-1', { dryRun: true })).resolves.toMatchObject({ dryRun: true });
        // A refused restore must not release the other owner's cut.
        await expect(acquireBackupSnapshotCut()).rejects.toMatchObject({ code: 'BACKUP_SNAPSHOT_BUSY' });
      } finally { release(); }
    });

    it.each(['domain refusal', 'transfer failure', 'reconciliation failure'])('releases its cut after %s', async failure => {
      const { acquireBackupSnapshotCut } = await import('../lib/backupSnapshotBoundary.js');
      if (failure === 'domain refusal') {
        withLiveCosRestore.mockRejectedValueOnce(new Error('restore refused'));
      } else {
        const proc = fakeProc();
        spawn.mockImplementationOnce(() => {
          setImmediate(() => proc.emit('close', failure === 'transfer failure' ? 1 : 0));
          return proc;
        });
        if (failure === 'reconciliation failure') reloadSettings.mockRejectedValueOnce(new Error('reload failed'));
      }
      await expect(restoreSnapshot('/dest', 'snap-1', { dryRun: false })).rejects.toThrow();
      const release = await acquireBackupSnapshotCut();
      release();
    });
  });

  describe('media registry restore ownership boundary', () => {
    it.each([undefined, 'media-models.json'])('holds the boundary for affected live scope %s', async subdirFilter => {
      await runRestore('/dest', 'snap-1', { dryRun: false, subdirFilter });
      expect(withLiveMediaModelsRestore).toHaveBeenCalledTimes(1);
    });

    it.each([{ dryRun: true }, { dryRun: true, subdirFilter: 'media-models.json' }, { dryRun: false, subdirFilter: 'images' }, { dryRun: false, subdirFilter: 'cos' }, { dryRun: false, subdirFilter: 'settings.json' }])('leaves unaffected scope alone: %j', async options => {
      await runRestore('/dest', 'snap-1', options);
      expect(withLiveMediaModelsRestore).not.toHaveBeenCalled();
    });

    it('acquires the registry after settings and CoS and releases it when the transfer fails', async () => {
      const order = [];
      withLiveSettingsRestore.mockImplementationOnce(async fn => { order.push('settings'); return fn(); });
      withLiveCosRestore.mockImplementationOnce(async fn => { order.push('cos'); return fn(); });
      withLiveMediaModelsRestore.mockImplementationOnce(async fn => {
        order.push('media');
        try { return await fn(); } finally { order.push('media:released'); }
      });
      const proc = fakeProc();
      spawn.mockReturnValue(proc);
      const pending = restoreSnapshot('/dest', 'snap-1', { dryRun: false });
      await flush();
      proc.emit('close', 1);
      await expect(pending).rejects.toThrow();
      expect(order).toEqual(['settings', 'cos', 'media', 'media:released']);
    });

    it('does not fence the registry when CoS refuses a full restore', async () => {
      withLiveCosRestore.mockRejectedValueOnce(Object.assign(new Error('Stop CoS before restoring'), { code: 'COS_RESTORE_BUSY' }));
      await expect(restoreSnapshot('/dest', 'snap-1', { dryRun: false })).rejects.toMatchObject({ code: 'COS_RESTORE_BUSY' });
      expect(withLiveMediaModelsRestore).not.toHaveBeenCalled();
    });
  });

  describe('Apple Health restore ownership boundary (#10899)', () => {
    const day = '2024-01-01';
    const dayPath = () => join(PATHS.health, `${day}.json`);
    const point = (hour, qty) => ({ date: `${day} ${hour}:00:00 +0000`, qty });
    const ingest = (...points) => ingestHealthData({ data: { metrics: [{ name: 'heart_rate', data: points }] } });
    const quantities = () => JSON.parse(readFileSync(dayPath(), 'utf8')).metrics.heart_rate.map(p => p.qty).sort();
    beforeEach(() => { withLiveHealthRestore.mockClear(); });

    it.each([undefined, 'health', 'health/', `health/${day}.json`])('holds health admission for affected live scope %s', async subdirFilter => {
      await runRestore('/dest', 'snap-1', { dryRun: false, subdirFilter });
      expect(withLiveHealthRestore).toHaveBeenCalledTimes(1);
    });

    it.each([{ dryRun: true }, { dryRun: true, subdirFilter: 'health' }, { dryRun: false, subdirFilter: 'meatspace' }, { dryRun: false, subdirFilter: 'cos' }])('leaves unaffected scope alone: %j', async options => {
      await runRestore('/dest', 'snap-1', options);
      expect(withLiveHealthRestore).not.toHaveBeenCalled();
    });

    it('acquires health admission last and skips it when CoS refuses', async () => {
      const order = [];
      withLiveMediaModelsRestore.mockImplementationOnce(async fn => { order.push('media'); return fn(); });
      withLiveHealthRestore.mockImplementationOnce(async fn => { order.push('health'); return fn(); });
      await runRestore('/dest', 'snap-1', { dryRun: false });
      expect(order).toEqual(['media', 'health']);
      withLiveCosRestore.mockRejectedValueOnce(Object.assign(new Error('Stop CoS before restoring'), { code: 'COS_RESTORE_BUSY' }));
      await expect(restoreSnapshot('/dest', 'snap-1', { dryRun: false })).rejects.toMatchObject({ code: 'COS_RESTORE_BUSY' });
      expect(withLiveHealthRestore).toHaveBeenCalledTimes(1);
    });

    it.each([0, 1])('drains an ingest holding a pre-image before rsync and keeps restored points (exit %s)', async exitCode => {
      const actual = await vi.importActual('fs/promises');
      const original = point('08', 60);
      const recovered = point('10', 80);
      await actual.mkdir(PATHS.health, { recursive: true });
      writeFileSync(dayPath(), JSON.stringify({ date: day, metrics: { heart_rate: [original] } }));
      const reading = Promise.withResolvers();
      const release = Promise.withResolvers();
      let held = false;
      fs.readFile.mockImplementation(async (path, ...args) => {
        const bytes = await actual.readFile(path, ...args);
        if (path === dayPath() && !held) {
          held = true;
          reading.resolve();
          await release.promise;
        }
        return bytes;
      });
      const invalidated = vi.fn();
      meatspaceEvents.on('changed', invalidated);
      const proc = fakeProc();
      spawn.mockImplementationOnce(() => {
        // Real destination bytes at the rsync process boundary: the snapshot
        // still holds a point the live day lost.
        writeFileSync(dayPath(), JSON.stringify({ date: day, metrics: { heart_rate: [original, recovered] } }));
        setImmediate(() => proc.emit('close', exitCode));
        return proc;
      });
      let restore;
      try {
        const stale = ingest(point('09', 72));
        await reading.promise;
        restore = restoreSnapshot('/dest', 'snap-1', { dryRun: false, subdirFilter: 'health' });
        await vi.waitFor(() => expect(withLiveHealthRestore).toHaveBeenCalledTimes(1));
        // Parked draining the held ingest, so rsync cannot have started.
        await vi.waitFor(() => expect(_healthRestoreDrainingForTests()).toBe(true), { interval: 5 });
        expect(spawn).not.toHaveBeenCalled();
        const later = ingest(point('11', 90));
        release.resolve();
        await stale;
        if (exitCode) await expect(restore).rejects.toThrow(/Some files may already have been overwritten/);
        else await restore;
        await later;
        // The admitted ingest settled before transfer; the queued one read the
        // restored day, so the recovered point survives both.
        expect(quantities()).toEqual([60, 80, 90]);
        expect(invalidated).toHaveBeenCalledWith({ resources: ['healthBody'] });
      } finally {
        release.resolve();
        await restore?.catch(() => {});
        meatspaceEvents.off('changed', invalidated);
        fs.readFile.mockImplementation(actual.readFile);
      }
    });
  });

  describe('settings restore ownership boundary', () => {
    it.each([undefined, 'settings.json', 'private', 'private/api-keys.json'])('holds the boundary for affected live scope %s', async subdirFilter => {
      const proc = fakeProc();
      const spawned = Promise.withResolvers();
      spawn.mockImplementation(() => { spawned.resolve(); return proc; });
      const reloading = Promise.withResolvers();
      const finishReload = Promise.withResolvers();
      reloadSettings.mockImplementationOnce(async () => {
        reloading.resolve();
        await finishReload.promise;
      });
      const pending = restoreSnapshot('/dest', 'snap-1', { dryRun: false, subdirFilter });
      let childClosed = false;
      let waitingWrite;
      try {
        // Real filesystem preflight can exceed waitFor's default one second on
        // loaded Windows runners. Synchronize with this restore's fake child,
        // while preserving an early restore failure instead of masking it.
        await Promise.race([spawned.promise, pending.then(() => {
          throw new Error('Restore completed before spawning its child');
        })]);
        expect(withLiveSettingsRestore).toHaveBeenCalledTimes(1);
        const later = vi.fn();
        waitingWrite = withLiveSettingsRestore(later);
        childClosed = true;
        proc.emit('close', 0);
        await reloading.promise;
        expect(later).not.toHaveBeenCalled();
        finishReload.resolve();
        await Promise.all([pending, waitingWrite]);
        expect(later).toHaveBeenCalledTimes(1);
      } finally {
        // An assertion failure must not leave the settings queue fenced.
        finishReload.resolve();
        if (!childClosed) proc.emit('close', 1);
        await pending.catch(() => {});
        await waitingWrite?.catch(() => {});
      }
    }, 10_000);

    it.each([{ dryRun: true }, { dryRun: true, subdirFilter: 'settings.json' }, { dryRun: false, subdirFilter: 'images' }, { dryRun: false, subdirFilter: 'cos' }])('leaves unaffected scope alone: %j', async options => {
      await runRestore('/dest', 'snap-1', options);
      expect(withLiveSettingsRestore).not.toHaveBeenCalled();
    });

    it('drains settings before acquiring CoS and holds them through CoS reconciliation', async () => {
      const admitted = Promise.withResolvers();
      const finishWrite = Promise.withResolvers();
      const writing = withLiveSettingsRestore(async () => {
        admitted.resolve();
        await finishWrite.promise;
      });
      await admitted.promise;
      const reconciled = Promise.withResolvers();
      const finishCosReload = Promise.withResolvers();
      withLiveCosRestore.mockImplementationOnce(async transfer => {
        const result = await transfer();
        reconciled.resolve();
        await finishCosReload.promise;
        return result;
      });
      const proc = fakeProc();
      spawn.mockReturnValue(proc);
      const pending = restoreSnapshot('/dest', 'snap-1', { dryRun: false });
      await vi.waitFor(() => expect(withLiveSettingsRestore).toHaveBeenCalledTimes(2));
      expect(withLiveCosRestore).not.toHaveBeenCalled();
      finishWrite.resolve();
      await flush();
      const later = vi.fn();
      const waitingWrite = withLiveSettingsRestore(later);
      proc.emit('close', 0);
      await reconciled.promise;
      expect(later).not.toHaveBeenCalled();
      finishCosReload.resolve();
      await Promise.all([writing, pending, waitingWrite]);
      expect(later).toHaveBeenCalledTimes(1);
    });

    it('preserves full-restore CoS busy refusal and releases settings admission', async () => {
      withLiveCosRestore.mockRejectedValueOnce(Object.assign(new Error('Stop CoS before restoring'), { code: 'COS_RESTORE_BUSY' }));
      await expect(restoreSnapshot('/dest', 'snap-1', { dryRun: false })).rejects.toMatchObject({ code: 'COS_RESTORE_BUSY' });
      expect(spawn).not.toHaveBeenCalled();
      await expect(withLiveSettingsRestore(() => 'released')).resolves.toBe('released');
    });

    it.each([0, 1])('releases settings after reconciliation failure with rsync exit %s', async exitCode => {
      reloadSettings.mockRejectedValueOnce(new Error('settings reload failed'));
      const proc = fakeProc();
      spawn.mockReturnValue(proc);
      const pending = restoreSnapshot('/dest', 'snap-1', { dryRun: false, subdirFilter: 'settings.json' });
      await flush();
      const later = vi.fn();
      const waitingWrite = withLiveSettingsRestore(later);
      proc.emit('close', exitCode);
      await expect(pending).rejects.toThrow(/settings reload failed/);
      await waitingWrite;
      expect(later).toHaveBeenCalledTimes(1);
    });
  });

  describe('settings cache re-sync', () => {
    it('reloads settings after a live restore', async () => {
      await runRestore('/dest', 'snap-1', { dryRun: false });

      expect(reloadSettings).toHaveBeenCalledTimes(1);
      expect(invalidateBrainCaches).toHaveBeenCalledTimes(1);
      expect(reconcileMediaAssets).toHaveBeenCalledWith({ rebuild: true });
      // A live restore must not pass --dry-run to rsync.
      expect(spawn.mock.calls[0][1]).not.toContain('--dry-run');
    });

    it('invalidates Brain projections after a nested selective live Brain restore', async () => {
      await runRestore('/dest', 'snap-1', { dryRun: false, subdirFilter: 'brain/inbox' });

      expect(invalidateBrainCaches).toHaveBeenCalledTimes(1);
      // Only a restore covering media re-checks restored media delete records (#14087).
      expect(clearRestoredMediaTombstones).not.toHaveBeenCalled();
    });

    it('keeps Brain projections after a selective live restore outside Brain', async () => {
      const { backupSnapshotCutPending } = await import('../lib/backupSnapshotBoundary.js');
      const cutHeld = [];
      const record = async (options) => {
        cutHeld.push([options?.images ?? true, backupSnapshotCutPending()]);
        return { videos: [], images: [] };
      };
      clearRestoredMediaTombstones.mockImplementationOnce(record).mockImplementationOnce(record);
      await runRestore('/dest', 'snap-1', { dryRun: false, subdirFilter: 'images' });

      expect(invalidateBrainCaches).not.toHaveBeenCalled();
      expect(reconcileMediaAssets).toHaveBeenCalledWith({ rebuild: true });
      // A restored item must shed the delete record of its earlier delete (#14087).
      // Images wait until the cut is released: their sidecar stamp takes the
      // asset-publication lease, which would wait on the cut (#14099).
      expect(cutHeld).toEqual([[false, true], [true, false]]);
    });

    it('does not reload settings for a dry run', async () => {
      await runRestore('/dest', 'snap-1', { dryRun: true });

      expect(reloadSettings).not.toHaveBeenCalled();
      expect(invalidateBrainCaches).not.toHaveBeenCalled();
      expect(spawn.mock.calls[0][1]).toContain('--dry-run');
      expect(reconcileMediaAssets).not.toHaveBeenCalled();
    });

    it('defaults to a dry run (no settings reload) when no options are given', async () => {
      await expect(runRestore('/dest', 'snap-1')).resolves.toMatchObject({ dryRun: true });

      expect(reloadSettings).not.toHaveBeenCalled();
    });

    it('leaves caches untouched when a dry-run rsync fails', async () => {
      const proc = fakeProc();
      spawn.mockReturnValue(proc);
      const pending = restoreSnapshot('/dest', 'snap-1', { dryRun: true });
      await flush();
      proc.stderr.emit('data', Buffer.from('preview failed'));
      proc.emit('close', 1);

      await expect(pending).rejects.toThrow(/^rsync exited with code 1/);
      expect(reloadSettings).not.toHaveBeenCalled();
      expect(invalidateBrainCaches).not.toHaveBeenCalled();
    });

    it('reconciles settings and Brain state when rsync fails a live restore', async () => {
      const proc = fakeProc();
      const spawned = Promise.withResolvers();
      spawn.mockImplementation(() => {
        spawned.resolve();
        return proc;
      });
      const pending = restoreSnapshot('/dest', 'snap-1', { dryRun: false });
      // Admission performs real journal I/O. Wait for the actual process boundary,
      // not vi.waitFor's one-second deadline (too short on a loaded Windows runner).
      // A pre-spawn failure must still surface instead of leaving the barrier pending.
      await Promise.race([spawned.promise, pending]);
      proc.stderr.emit('data', Buffer.from('boom'));
      proc.emit('close', 1);

      await expect(pending).rejects.toThrow(/rsync exited with code 1.*files may already have been overwritten/i);
      expect(reloadSettings).toHaveBeenCalledTimes(1);
      expect(invalidateBrainCaches).toHaveBeenCalledTimes(1);
    });

    it('reports reconciliation failures without hiding the primary rsync failure', async () => {
      invalidateBrainCaches.mockImplementationOnce(() => {
        throw new Error('Brain cache reset failed');
      });
      reloadSettings.mockRejectedValueOnce(new Error('settings reload failed'));
      const proc = fakeProc();
      spawn.mockReturnValue(proc);
      const pending = restoreSnapshot('/dest', 'snap-1', { dryRun: false });
      await flush();
      proc.stderr.emit('data', Buffer.from('transfer failed'));
      proc.emit('close', 1);

      await expect(pending).rejects.toMatchObject({
        message: expect.stringMatching(/rsync exited with code 1.*Live restore cache reconciliation failed.*Brain cache reset failed.*settings reload failed.*Restart PortOS/i),
        cause: expect.objectContaining({ message: expect.stringMatching(/rsync exited with code 1/) }),
      });
      expect(reloadSettings).toHaveBeenCalledTimes(1);
      expect(invalidateBrainCaches).toHaveBeenCalledTimes(1);
    });

    it('names the nested cause when the media index rebuild cannot reach Postgres', async () => {
      reconcileMediaAssets.mockRejectedValueOnce(
        new AggregateError([Object.assign(new Error(''), { code: 'ECONNREFUSED' })], ''),
      );
      const proc = fakeProc();
      spawn.mockReturnValue(proc);
      const pending = restoreSnapshot('/dest', 'snap-1', { dryRun: false });
      await flush();
      proc.emit('close', 0);

      await expect(pending).rejects.toThrow(/media index rebuild: ECONNREFUSED\)/);
    });
  });
});
