/** Check observable local survivors without claiming historical output succeeded. */
import { join, posix } from 'node:path';
import { snapshotMaintenanceProcesses } from '../lib/detachedSpawn.js';
import { escapeRegExp } from '../lib/textUtils.js';

export { snapshotMaintenanceProcesses };

export function findObservedReservationProcesses(processes, operations, installRoot, selfPid = process.pid) {
  const identities = operations
    .filter(op => ['agent', 'runner', 'media', 'music-video', 'api-run', 'cli-run', 'tui-run', 'backup'].includes(op.kind))
    .map(op => op.resource)
    .filter(value => typeof value === 'string' && /^(?:agent-[a-z0-9-]+|mv-[a-f0-9-]{20,}|[a-f0-9-]{30,}|\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d(?:-[a-f0-9-]+)?)$/i.test(value));
  const normalize = value => value.replaceAll('\\', '/').toLowerCase();
  const data = normalize(join(installRoot, 'data')).replace(/\/$/, '');
  const dataArgument = new RegExp(`(?:^|[\\s"'=])${escapeRegExp(data)}(?:/|(?=$|[\\s"']))`);
  return processes.filter(proc => {
    if (proc.pid === selfPid || String(proc.state ?? '').startsWith('Z')) return false;
    const command = String(proc.command ?? '');
    if (identities.some(id => normalize(command).includes(id.toLowerCase()))) return true;
    // Some legacy encoders were given only a scratch/output path, not a job ID.
    const match = /^(?:"([^"]+)"|(\S+))/.exec(command.trim());
    const executable = posix.basename(normalize(match?.[1] ?? match?.[2] ?? ''));
    const normalized = normalize(command);
    const restoreSource = operations.some(op => op.kind === 'backup' && op.resource.startsWith('restore:')
      && op.resource.length > 'restore:'.length && normalized.includes(op.resource.slice('restore:'.length).toLowerCase()));
    return (/^(?:ffmpeg|ffprobe|rsync|pg_dump|tar)(?:\.exe)?$/i.test(executable) && dataArgument.test(normalized))
      || (restoreSource && dataArgument.test(normalized))
      || (operations.some(op => op.kind === 'backup' && /^(?:restore-db|restore-recovery):/.test(op.resource))
        && /^psql(?:\.exe)?$/i.test(executable) && /(?:^|\/)portos-restore-[a-z0-9]+\/dump\.sql(?:\.replay)?(?:$|[\s"'])/i.test(normalized));
  });
}

export async function assertNoObservedReservationProcesses(operations, installRoot, snapshot = snapshotMaintenanceProcesses) {
  const processes = await snapshot();
  if (findObservedReservationProcesses(processes, operations, installRoot).length)
    throw Object.assign(new Error('A process associated with an inspected reservation is still running.'), { code: 'MAINTENANCE_STALE' });
}
