// Built-ins only: a deferred update also runs while npm is being replaced.
import { execFile } from 'node:child_process';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { recordedMediaChildIds } from '../../server/lib/mediaRecoveryActivity.js';

const runFile = promisify(execFile);

export const observedDatabaseRestoreProcess = (rows, selfPid = process.pid) => rows.some(row =>
  row.pid !== selfPid && !String(row.state ?? '').startsWith('Z')
  && /(?:^|[\s"'/\\])psql(?:\.exe)?(?=$|[\s"'])/i.test(String(row.command ?? ''))
  && /(?:^|[/\\])portos-restore-[a-z0-9]+[/\\]dump\.sql(?:\.replay)?(?:$|[\s"'])/i.test(String(row.command ?? '')));

export async function observedLocalMediaProcesses(rows, jobs, data, { selfPid = process.pid,
  platform = process.platform, probeCwds = legacyProcessCwds } = {}) {
  const running = jobs.filter(job => job?.status === 'running');
  const grokIds = jobs.map(job => job?.id).filter(id => typeof id === 'string' && /^[a-z0-9-]{8,}$/i.test(id));
  if (!running.length && !grokIds.length) return { running: false, limitations: [] };
  const ids = [...running.flatMap(job => [job.id, job.params?.runId]), ...recordedMediaChildIds(jobs)]
    .filter(id => typeof id === 'string' && /^[a-z0-9-]{8,}$/i.test(id));
  const path = `${data.replaceAll('\\', '/').toLowerCase().replace(/\/$/, '')}/`;
  const candidates = rows.filter(row => row.pid !== selfPid && !String(row.state ?? '').startsWith('Z'));
  const direct = candidates.some(row => {
    if (row.pid === selfPid || String(row.state ?? '').startsWith('Z')) return false;
    const command = String(row.command ?? '').replaceAll('\\', '/').toLowerCase();
    return ids.some(id => command.includes(id.toLowerCase()))
      || (/(?:^|[\s"'/])(?:ffmpeg|ffprobe)(?:\.exe)?(?=$|[\s"'])/i.test(command) && command.includes(path));
  });
  if (direct) return { running: true, limitations: [] };
  const grok = candidates.filter(row => /(?:^|[\s"'/\\])grok(?:[\s./\\'"-]|$)/i.test(String(row.command ?? '')));
  const cwds = await probeCwds(grok.map(row => row.pid), platform).catch(() => new Map());
  const canonical = value => { try { return realpathSync(value); } catch { return resolve(value); } };
  const roots = grokIds.map(id => canonical(join(tmpdir(), `portos-grok-video-${id}`)));
  return { running: grok.some(row => cwds.has(row.pid) && roots.includes(canonical(cwds.get(row.pid)))),
    limitations: grok.some(row => !cwds.has(row.pid)) ? ['grok-cwd-unavailable'] : [] };
}

export async function snapshotLegacyProcesses(platform = process.platform) {
  if (platform === 'win32') {
    const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,@{Name="StartedAt";Expression={if ($_.CreationDate) {$_.CreationDate.ToUniversalTime().ToString("o")}}} | ConvertTo-Json -Compress'],
    { timeout: 15000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    const data = JSON.parse(stdout.replace(/^\uFEFF/, ''));
    return (Array.isArray(data) ? data : [data]).map(row => ({ pid: Number(row.ProcessId), ppid: Number(row.ParentProcessId),
      state: 'S', command: row.CommandLine ?? '', startedAt: row.StartedAt ? Date.parse(row.StartedAt) : null }));
  }
  const { stdout } = await runFile('ps', ['-A', '-ww', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'stat=', '-o', 'lstart=', '-o', 'command='],
    { timeout: 15000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
  return stdout.split('\n').filter(line => line.trim()).map(line => {
    const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3} \w{3}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s?(.*)$/.exec(line);
    if (!row || !Number.isFinite(Date.parse(row[5]))) throw new Error('Unreadable process table');
    return { pid: Number(row[1]), ppid: Number(row[2]), pgid: Number(row[3]), state: row[4], startedAt: Date.parse(row[5]), command: row[6] };
  });
}

export async function legacyProcessCwds(pids, platform = process.platform) {
  if (!pids.length) return new Map();
  if (platform === 'linux') {
    const entries = await Promise.all(pids.map(async pid => [pid, await readlink(`/proc/${pid}/cwd`).catch(() => null)]));
    return new Map(entries.filter(([, cwd]) => cwd));
  }
  if (platform !== 'darwin') return new Map();
  const output = await runFile('lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn'],
    { timeout: 10000, maxBuffer: 8 * 1024 * 1024 }).then(result => result.stdout, error => error.stdout || '');
  const result = new Map();
  let pid;
  for (const line of String(output).split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && Number.isSafeInteger(pid)) result.set(pid, line.slice(1));
  }
  return result;
}

export async function legacyLauncherGroups(data, control) {
  const directory = join(data, 'database-writers');
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const readRecord = async path => {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 65536) throw new Error('Invalid detached writer record');
    return JSON.parse(await readFile(path, 'utf8'));
  };
  const groups = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/i.test(entry.name)) continue;
    const dir = join(directory, entry.name);
    const reservation = await readRecord(join(dir, 'reservation.json')).catch(() => null);
    if (typeof reservation?.controlDir !== 'string' || resolve(reservation.controlDir) !== resolve(control)) continue;
    const launcher = await readRecord(join(dir, 'launcher.json')).catch(() => null);
    const launched = await readRecord(join(dir, 'launch.json')).catch(() => null);
    if (Number.isSafeInteger(launcher?.pid) && launcher.pid > 0) groups.push({ pgid: launcher.pid,
      controlDir: reservation.controlDir, jobPid: launched?.pid,
      createdAt: Date.parse(reservation.createdAt), launchedAt: Date.parse(launched?.launchedAt) });
  }
  return groups;
}

export async function observedLegacyUpdate({ root, priorPid = null, priorAt = null, groups = [], platform = process.platform, selfPid = process.pid,
  snapshot = snapshotLegacyProcesses, probeCwds = legacyProcessCwds } = {}) {
  const rows = await snapshot(platform);
  if (!rows.some(row => row.pid === selfPid)) throw new Error('Incomplete process table');
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const ancestors = new Set();
  let pid = selfPid;
  while (pid && !ancestors.has(pid)) { ancestors.add(pid); pid = byPid.get(pid)?.ppid; }
  const normalize = value => platform === 'win32' ? value.replaceAll('\\', '/').toLowerCase() : value;
  const canonical = value => { try { return realpathSync(value); } catch { return resolve(value); } };
  const install = normalize(canonical(root));
  const script = /(?:^|[\s"'=])((?:\.[\\/])?(?:scripts[\\/])?(?:deferred-update\.mjs|update\.(?:sh|ps1)))(?=$|[\s"'])/i;
  const child = /(?:^|[\s"'/\\])(?:git|npm|npx|pnpm|yarn|npm-cli\.js)(?:\.exe)?(?=$|[\s"'])|scripts[\\/](?:setup-[\w-]+|run-migrations|trusted-rebuilds|pm2-[\w-]+)\.js/i;
  const candidates = rows.filter(row => !ancestors.has(row.pid) && !String(row.state ?? '').startsWith('Z')
    && (script.test(String(row.command ?? '')) || child.test(String(row.command ?? ''))
      || /(?:update\.(?:sh|ps1)|deferred-update\.mjs)/i.test(String(row.command ?? ''))));
  const cwds = await probeCwds(candidates.map(row => row.pid), platform).catch(() => new Map());
  const escaped = install.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const absolute = new RegExp(`(?:^|[\\s"'=])${escaped}/(?:scripts/)?(?:deferred-update\\.mjs|update\\.(?:sh|ps1))(?=$|[\\s"'])`);
  const expectedPaths = new Set(['update.sh', 'update.ps1', 'scripts/deferred-update.mjs']
    .map(path => normalize(canonical(join(root, path)))));
  const inInstall = cwd => {
    const path = normalize(canonical(cwd));
    return path === install || path.startsWith(`${install}/`);
  };
  const modifyingChild = /(?:^|[\s"'/\\])(?:npm|pnpm|yarn|npm-cli\.js)(?:\.exe)?\s+(?:install|ci)(?=$|\s)|(?:^|[\s"'/\\])git(?:\.exe)?\s+(?:pull|fetch|checkout|merge|rebase|reset|submodule)(?=$|\s)/i;
  const isUpdater = row => {
    const command = normalize(String(row.command ?? ''));
    const relative = script.exec(command)?.[1];
    if (absolute.test(command) || (relative && cwds.has(row.pid)
      && expectedPaths.has(normalize(canonical(resolve(cwds.get(row.pid), relative)))))) return true;
    // Windows cannot inspect another process's cwd with the built-in probes.
    // An actually running relative PowerShell updater must finish first.
    if (platform === 'win32' && relative && /update\.ps1$/i.test(relative) && !cwds.has(row.pid)
      && /(?:^|[\s"'/\\])(?:powershell|pwsh)(?:\.exe)?(?=$|[\s"'])/i.test(command)) return true;
    return row.pid === priorPid && script.test(command) && !cwds.has(row.pid)
      && (!Number.isFinite(row.startedAt) || !Number.isFinite(priorAt) || row.startedAt <= priorAt + 2000);
  };
  const updaters = new Set(candidates.filter(isUpdater).map(row => row.pid));
  let groupAttributionUnavailable = false;
  const belongsToUpdater = row => {
    const visited = new Set();
    let parent = row.ppid;
    while (parent && !visited.has(parent)) {
      if (updaters.has(parent)) return true;
      visited.add(parent);
      parent = byPid.get(parent)?.ppid;
    }
    return groups.some(group => {
      if (row.pgid !== group.pgid) return false;
      const groupLeader = byPid.get(group.pgid);
      const inWindow = proc => Number.isFinite(proc?.startedAt) && Number.isFinite(group.createdAt)
        && Number.isFinite(group.launchedAt) && proc.startedAt >= group.createdAt - 2000
        && proc.startedAt <= group.launchedAt + 2000;
      const supervisor = rows.find(proc => proc.pgid === group.pgid && inWindow(proc)
        && String(proc.command ?? '').includes(group.controlDir));
      const job = byPid.get(group.jobPid);
      if ((groupLeader && inWindow(groupLeader)) || supervisor || (job?.pgid === group.pgid && inWindow(job))) return true;
      groupAttributionUnavailable = true;
      return false;
    });
  };
  const running = candidates.some(row => updaters.has(row.pid) || (child.test(String(row.command ?? ''))
    && (belongsToUpdater(row) || (modifyingChild.test(String(row.command ?? '')) && cwds.has(row.pid) && inInstall(cwds.get(row.pid))))));
  const limitations = candidates.some(row => script.test(String(row.command ?? '')) && !cwds.has(row.pid) && !updaters.has(row.pid))
    ? ['legacy-updater-cwd-unavailable'] : [];
  if (groupAttributionUnavailable) limitations.push('legacy-updater-group-unavailable');
  return { running: Boolean(running), limitations };
}
