/**
 * Apple Health live-restore admission (#10899) against XML flushes and health
 * archival. Real synthetic day files in a temp data root; each restore's
 * transfer replaces destination bytes exactly as rsync does at its process
 * boundary. The JSON ingest crossing is covered end to end through
 * restoreSnapshot in backup.test.js.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, readdir, rm, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { execFileSync } from '../lib/childProcess.js';
import { createTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

const controls = vi.hoisted(() => ({ readFile: null, rm: null, tar: null }));
vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return makePathsProxy(actual, { dataRoot: () => root });
});
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readFile: (...args) => controls.readFile ? controls.readFile(...args) : actual.readFile(...args),
    rm: (...args) => controls.rm ? controls.rm(...args) : actual.rm(...args),
  };
});
vi.mock('../lib/childProcess.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execFile: (command, args, options, callback) => (controls.tar
    ? controls.tar(command, args, options, callback)
    : actual.execFile(command, args, options, callback)) };
});

const root = createTempDataRoot('portos-health-restore-');
const { archiveCategory } = await import('./dataManager.js');
const { mergeIntoDay, withLiveHealthRestore } = await import('./appleHealthIngest.js');
const { importAppleHealthXml } = await import('./appleHealthXml.js');

const health = join(root, 'health');
const day = '2024-01-01';
const liveDay = () => join(health, `${day}.json`);
const point = (hour, qty) => ({ date: `${day} ${hour}:00:00 +0000`, qty });
const original = point('08', 60);
const recovered = point('10', 80);
const dayBytes = (...points) => JSON.stringify({ date: day, metrics: { heart_rate: points } });
const quantities = async () => JSON.parse(await readFile(liveDay(), 'utf8')).metrics.heart_rate.map(p => p.qty).sort();
const archived = (result) => JSON.parse(execFileSync('tar', ['-xOzf', resolve(result.archivePath), `${day}.json`], { encoding: 'utf8' }));
const tick = () => new Promise(done => setImmediate(done));
// The faithful transfer: install the snapshot day that still holds `recovered`.
const restoreDay = () => {
  const transfer = vi.fn(() => writeFile(liveDay(), dayBytes(original, recovered)));
  return { transfer, restore: withLiveHealthRestore(transfer) };
};
const holdOnce = (install) => {
  const reached = Promise.withResolvers();
  const release = Promise.withResolvers();
  let held = false;
  install(async () => {
    if (held) return;
    held = true;
    reached.resolve();
    await release.promise;
  });
  return { reached: reached.promise, release: () => release.resolve() };
};
const holdDayRead = (path = liveDay()) => holdOnce(pause => {
  controls.readFile = async (target, ...args) => {
    const actual = await vi.importActual('fs/promises');
    const bytes = await actual.readFile(target, ...args);
    if (target === path) await pause();
    return bytes;
  };
});

beforeEach(async () => {
  await rm(root, { recursive: true, force: true });
  await mkdir(health, { recursive: true });
  await writeFile(liveDay(), dayBytes(original));
  Object.assign(controls, { readFile: null, rm: null, tar: null });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-08T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe('Apple Health restore admission (#10899)', () => {
  it('settles an XML flush holding its pre-image before transfer; a later flush keeps restored points', async () => {
    const xml = async (hour, value) => {
      const xmlPath = join(root, `export-${hour}.xml`);
      const date = `${day} ${hour}:00:00 +0000`;
      await writeFile(xmlPath, `<HealthData><Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" startDate="${date}" endDate="${date}" value="${value}"/></HealthData>`);
      return importAppleHealthXml(xmlPath);
    };
    const read = holdDayRead();
    const stale = xml('09', 72);
    let restore;
    try {
      await read.reached;
      const restoring = restoreDay();
      restore = restoring.restore;
      await tick();
      expect(restoring.transfer).not.toHaveBeenCalled();
      const later = xml('11', 90);
      read.release();
      await Promise.all([stale, restore, later]);
    } finally {
      read.release();
      await restore?.catch(() => {});
    }
    expect(await quantities()).toEqual([60, 80, 90]);
  });

  it('keeps restored bytes when archive removal had already compared the old day', async () => {
    const removal = holdOnce(pause => {
      controls.rm = async (path, ...args) => {
        if (path === liveDay()) await pause();
        const actual = await vi.importActual('fs/promises');
        return actual.rm(path, ...args);
      };
    });
    const archive = archiveCategory('health');
    let restore;
    try {
      await removal.reached;
      const restoring = restoreDay();
      restore = restoring.restore;
      await tick();
      expect(restoring.transfer).not.toHaveBeenCalled();
      removal.release();
      const [result] = await Promise.all([archive, restore]);
      expect(result).toMatchObject({ archived: 1, removed: 1 });
      expect(archived(result).metrics.heart_rate).toEqual([original]);
    } finally {
      removal.release();
      await restore?.catch(() => {});
    }
    // Without admission the hash-matched removal deletes the restored day.
    expect(await quantities()).toEqual([60, 80]);
  });

  it('admits a restore while tar runs and retains the restored day instead of removing it', async () => {
    const actual = await vi.importActual('../lib/childProcess.js');
    const tar = holdOnce(pause => {
      controls.tar = (command, args, options, callback) => actual.execFile(command, args, options, (...outcome) => {
        pause().then(() => callback(...outcome));
      });
    });
    const archive = archiveCategory('health');
    try {
      await tar.reached;
      await restoreDay().restore;
    } finally {
      tar.release();
    }
    const result = await archive;
    expect(result).toMatchObject({ archived: 1, removed: 0, retained: 1 });
    expect(archived(result).metrics.heart_rate).toEqual([original]);
    expect(await quantities()).toEqual([60, 80]);
  });

  it('reopens admission after a failed transfer so queued writers read the partial restore', async () => {
    const transfer = vi.fn(async () => {
      await writeFile(liveDay(), dayBytes(original, recovered));
      throw Object.assign(new Error('synthetic rsync failure'), { code: 'BACKUP_RSYNC_FAILED' });
    });
    const restore = withLiveHealthRestore(transfer);
    const later = mergeIntoDay(day, 'heart_rate', [point('11', 90)]);
    await expect(restore).rejects.toMatchObject({ code: 'BACKUP_RSYNC_FAILED' });
    await later;
    expect(await quantities()).toEqual([60, 80, 90]);
  });

  it('keeps distinct days concurrent outside a restore', async () => {
    const otherDay = '2024-01-02';
    const read = holdDayRead();
    const held = mergeIntoDay(day, 'heart_rate', [point('09', 72)]);
    try {
      await read.reached;
      await expect(mergeIntoDay(otherDay, 'heart_rate', [{ date: `${otherDay} 09:00:00 +0000`, qty: 70 }]))
        .resolves.toMatchObject({ added: 1 });
    } finally {
      read.release();
    }
    await held;
    expect(await readdir(health)).toEqual([`${day}.json`, `${otherDay}.json`]);
  });
});
