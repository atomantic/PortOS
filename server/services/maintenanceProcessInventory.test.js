import { describe, expect, it } from 'vitest';
import { assertNoObservedReservationProcesses, findObservedReservationProcesses, snapshotMaintenanceProcesses } from './maintenanceProcessInventory.js';

describe('scoped process inventory for legacy reservations', () => {
  const operations = [{ kind: 'runner', resource: 'agent-12345678' },
    { kind: 'music-video', resource: 'mv-38fda50a-7d24-4744-aeb3-e13b8e8ee1c9' }];
  const rows = [
    { pid: 1, state: 'S', command: 'node /install/data/cos/worktrees/agent-12345678/server.js' },
    { pid: 2, state: 'S', command: '/usr/bin/ffmpeg -i /install/data/videos/input.mp4 out.mp4' },
    { pid: 3, state: 'Z', command: 'node agent-12345678' },
    { pid: 4, state: 'S', command: '/usr/bin/ffmpeg -i /other/input.mp4 /other/out.mp4' },
  ];
  it('identifies actual scoped survivors, without treating unrelated or zombie processes as active', () => {
    expect(findObservedReservationProcesses(rows, operations, '/install', 99).map(row => row.pid)).toEqual([1, 2]);
  });
  it('refuses disposition if a scoped survivor is observed or the process table cannot be read', async () => {
    await expect(assertNoObservedReservationProcesses(operations, '/install', async () => rows)).rejects.toMatchObject({ code: 'MAINTENANCE_STALE' });
    await expect(assertNoObservedReservationProcesses(operations, '/install', async () => { throw new Error('unavailable'); })).rejects.toThrow('unavailable');
    await expect(assertNoObservedReservationProcesses(operations, '/install', async () => [rows[3]])).resolves.toBeUndefined();
  });
  it('reads the Windows process inventory and rejects incomplete output', async () => {
    const run = async () => ({ stdout: JSON.stringify([{ ProcessId: 42, CommandLine: 'node worker.js' },
      { ProcessId: 43, CommandLine: 'node agent-12345678' }]) });
    const rows = await snapshotMaintenanceProcesses({ platform: 'win32', run, selfPid: 42 });
    expect(findObservedReservationProcesses(rows, operations, '/install', 42).map(row => row.pid)).toEqual([43]);
    await expect(snapshotMaintenanceProcesses({ platform: 'win32', run, selfPid: 99 })).rejects.toThrow('Incomplete process table');
  });
  it('detects a backup dump writing to an external snapshot', () => {
    const backup = [{ kind: 'backup', resource: '2026-11-03T00-43-40' }];
    const process = { pid: 9, state: 'S', command: '/usr/bin/pg_dump -f /Volumes/Backup/snapshots/host/2026-11-03T00-43-40/portos-db.sql' };
    expect(findObservedReservationProcesses([process], backup, '/install', 99)).toEqual([process]);
  });
  it('detects surviving file and database restore children', () => {
    const fileRestore = { pid: 10, state: 'S', command: '/usr/bin/rsync --archive /Volumes/backup/snap/data/ /install/data' };
    const dbRestore = { pid: 11, state: 'S', command: '/usr/bin/psql -f /tmp/portos-restore-ABC123/dump.sql' };
    const backup = [{ kind: 'backup', resource: 'restore:2026-11-03T00-00-00' },
      { kind: 'backup', resource: 'restore-db:2026-11-03T00-00-00' }];
    expect(findObservedReservationProcesses([fileRestore, dbRestore], backup, '/install', 99)).toEqual([fileRestore, dbRestore]);
    const custom = { pid: 13, state: 'S', command: '/opt/tools/rsync3 -a /Volumes/backup/2026-11-03T00-00-00/data/ /install/data' };
    expect(findObservedReservationProcesses([custom], backup, '/install', 99)).toEqual([custom]);
    const replay = { pid: 12, state: 'S', command: '/usr/bin/psql -f /tmp/portos-restore-ABC123/dump.sql.replay' };
    expect(findObservedReservationProcesses([replay], [{ kind: 'backup', resource: 'restore-recovery:example' }], '/install', 99)).toEqual([replay]);
  });
  it('recognizes a quoted Windows encoder path and Windows data arguments', () => {
    const proc = { pid: 5, state: 'S', command: '"C:\\Program Files\\ffmpeg\\ffmpeg.exe" -i "C:\\PortOS\\data\\videos\\clip.mp4"' };
    expect(findObservedReservationProcesses([proc], operations, 'C:\\PortOS', 99)).toEqual([proc]);
  });
});
