/**
 * MIDI transcription against a backup cut (#9982). The sidecar writes its
 * output outside admission; the copy into the destination directory, the row
 * `onComplete` commits to name it, and the discard unlink are one workflow, so
 * a cut can never copy the directory without the file that a dumped row names.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../lib/databaseMaintenanceJournal.js', () => ({ assertDatabaseAdmission: () => {} }));
vi.mock('../lib/pythonSetup.js', async (importOriginal) => ({
  ...(await importOriginal()),
  isMuscriptorRuntimeReady: vi.fn(async () => true),
  resolveMuscriptorPython: vi.fn(() => 'python3'),
}));
vi.mock('./hfToken.js', () => ({ hfChildEnv: vi.fn(async () => ({})) }));
vi.mock('../lib/sidecarProcess.js', () => ({
  runSidecarProcess: vi.fn(async ({ args }) => {
    await writeFile(args[args.indexOf('--output') + 1], 'synthetic midi');
    return { ok: true, stdout: 'RESULT' };
  }),
  parseSidecarResult: vi.fn(() => ({ notes: 1 })),
}));

const { startMidiTranscription } = await import('./audioMidiTranscription.js');
const { acquireBackupSnapshotCut } = await import('../lib/backupSnapshotBoundary.js');

const dirs = [];
afterAll(() => Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))));

const settleSeveral = () => new Promise(resolve => setTimeout(resolve, 100));

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'portos-midi-admission-'));
  dirs.push(dir);
  const audioPath = join(dir, 'song.wav');
  await writeFile(audioPath, 'synthetic audio');
  const destDir = join(dir, 'dest');
  return { audioPath, destDir };
}

describe('MIDI transcription backup admission', () => {
  it('copies the .mid and commits its row only after a cut is released', async () => {
    const { audioPath, destDir } = await scratch();
    const onComplete = vi.fn(async () => ({}));
    const release = await acquireBackupSnapshotCut();
    try {
      await startMidiTranscription({ audioPath, destDir, onComplete });
      await settleSeveral();
      expect(onComplete).not.toHaveBeenCalled();
      expect(existsSync(destDir) ? await readdir(destDir) : []).toEqual([]);
      release();
      await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
      expect(await readdir(destDir)).toHaveLength(1);
    } finally {
      release();
    }
  });

  it('drains a cut behind a transcription that is committing its row, then removes a declined file inside the lease', async () => {
    const { audioPath, destDir } = await scratch();
    let enteredRow;
    const entered = new Promise(resolve => { enteredRow = resolve; });
    let finishRow;
    const rowDone = new Promise(resolve => { finishRow = resolve; });
    await startMidiTranscription({
      audioPath,
      destDir,
      onComplete: async () => { enteredRow(); await rowDone; return { discarded: true, reason: 'audio source changed' }; },
    });
    await entered;
    let cutReady = false;
    const cut = acquireBackupSnapshotCut().then(release => { cutReady = true; return release; });
    try {
      await settleSeveral();
      expect(cutReady, 'cut acquired while the .mid row was still committing').toBe(false);
      finishRow();
      const release = await cut;
      // The declined file was unlinked inside the lease, so the cut sees neither it nor a row.
      expect(await readdir(destDir)).toEqual([]);
      release();
    } finally {
      finishRow();
      (await cut)();
    }
  });
});
