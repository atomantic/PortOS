import { spawn } from '../../lib/childProcess.js';
import { closeSync, existsSync, openSync, opendirSync, readSync, statfsSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { killWithEscalation } from '../../lib/killWithEscalation.js';

// These owned browsers render on explicit seek(t), not wall/display time.
// Chromium's display scheduler must not pace a song-length offline capture.
// Background flags match Playwright's standard Chromium launch posture.
// --mute-audio: compositions embed audio, and an unmuted test browser plays it
// through the developer's real speakers.
export function _testChromeCaptureArgs(profile) {
  return [
    '--headless=new', '--mute-audio', '--no-sandbox', '--no-first-run', '--disable-background-networking',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--disable-frame-rate-limit',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ];
}

// First existing candidate wins, as before, but the winner's source is an enum
// that startup diagnostics can report without printing any path.
export function _selectTestChrome(candidates) {
  return candidates.find(({ path }) => path && existsSync(path));
}

// Failure-only Linux observations of this owned child and its current worker.
// Never read cmdline, environ, links, stacks, or arbitrary process output.
// At most 40 prefixes of 4096 bytes (160 KiB), 17 directory entries and one
// statfs call. These count/byte caps do not guarantee elapsed time. Samples
// are non-atomic: wait categories and resource pressure do not prove a cause.
function readProcPrefix(path) {
  const fd = openSync(path, 'r');
  try {
    const bytes = Buffer.alloc(4096);
    return bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, 0)).toString();
  } finally { closeSync(fd); }
}

function readThreadIds(path) {
  const dir = opendirSync(path);
  const ids = [];
  try {
    let entry;
    for (let entries = 0; entries < 17 && (entry = dir.readSync()); entries++) {
      if (/^[1-9]\d*$/.test(entry.name)) ids.push(entry.name);
    }
  } finally { dir.closeSync(); }
  return ids;
}

const PROCESS_STATES = { R: 'runnable', S: 'sleeping', D: 'uninterruptible', Z: 'zombie', T: 'stopped', t: 'traced', X: 'dead', I: 'idle' };
const WAIT_CATEGORIES = new Map([
  ['none', ['0']],
  ['futex', ['futex_wait_queue', 'futex_wait_queue_me', 'futex_wait']],
  ['poll', ['ep_poll', 'do_epoll_wait', 'do_poll', 'poll_schedule_timeout', 'poll_schedule_timeout.constprop.0']],
  ['pipe', ['pipe_read']],
  ['child', ['do_wait', 'kernel_wait4']],
  ['io', ['io_schedule', 'io_schedule_timeout', 'wait_on_page_bit_common']],
  ['page', ['folio_wait_bit_common']],
  ['completion', ['wait_for_common', 'do_wait_for_common', 'wait_for_completion']],
  ['lock', ['rwsem_down_read_slowpath', 'rwsem_down_write_slowpath', '__mutex_lock', '__mutex_lock_slowpath']],
].flatMap(([category, names]) => names.map(name => [name, category])));
const safeInteger = value => Number.isSafeInteger(value) && value >= 0 ? value : 'unavailable';
const attemptObservation = fn => { try { return fn(); } catch { return 'unavailable'; } };

// Native Linux x86-64 syscall numbers, from arch/x86/entry/syscalls/syscall_64.tbl.
// This is a diagnostic for the native 64-bit CI browser, not a decoder for
// compatibility ABIs. Report unknown numbers as other; never keep arguments,
// stack/program counters, file descriptors or paths from /proc/*/syscall.
const X64_SYSCALL_CATEGORIES = new Map([
  ['read', [0, 17, 19]], ['write', [1, 18, 20]], ['open', [2, 257, 437]],
  ['metadata', [4, 5, 6, 21, 262, 332]], ['memory', [9, 10, 11, 12, 25, 28]],
  ['futex', [202, 449]], ['poll', [7, 23, 232, 270, 271, 281, 441]],
  ['process', [56, 57, 58, 59, 61, 247, 322, 435]], ['entropy', [318]], ['device', [16]],
].flatMap(([category, numbers]) => numbers.map(number => [String(number), category])));

function syscallFacts(pid, ids, { read, arch }) {
  if (arch !== 'x64') return '; syscalls: table=unsupported';
  const category = path => attemptObservation(() => {
    const text = read(path).slice(0, 4096).trim();
    if (text === 'running') return 'running';
    // Read only the first token. Everything after it is private register data.
    const number = text.match(/^(-1|0|[1-9]\d*)(?:\s|$)/)?.[1];
    if (!number) return 'unavailable';
    if (number === '-1') return 'outside';
    return X64_SYSCALL_CATEGORIES.get(number) ?? 'other';
  });
  const counts = Object.fromEntries(['running', 'outside', ...new Set(X64_SYSCALL_CATEGORIES.values()), 'other', 'unavailable'].map(name => [name, 0]));
  const lead = category(`/proc/${pid}/syscall`);
  for (const id of ids?.slice(0, 16) ?? []) counts[category(`/proc/${pid}/task/${id}/syscall`)]++;
  return `; syscalls: table=x64-native lead=${lead} threads=${ids ? Object.entries(counts).map(([name, count]) => `${name}:${count}`).join(',') : 'unavailable'}`;
}

function resourceFacts(child, { read, cpus, usage, disk }) {
  const worker = attemptObservation(usage);
  const fs = attemptObservation(disk);
  const pressure = kind => attemptObservation(() => {
    const text = read(`/proc/pressure/${kind}`).slice(0, 4096);
    const value = Number(text.match(/(?:^|\n)some avg10=(\d+(?:\.\d+)?)(?: |$)/)?.[1]);
    return Number.isFinite(value) && value >= 0 && value <= 100 ? value : 'unavailable';
  });
  const memory = attemptObservation(() => safeInteger(Number(
    read('/proc/meminfo').slice(0, 4096).match(/(?:^|\n)MemAvailable:\s+(\d+) kB(?:\n|$)/)?.[1],
  )));
  const freeBytes = Number.isSafeInteger(fs?.bavail) && fs.bavail >= 0 && Number.isSafeInteger(fs?.bsize) && fs.bsize > 0
    ? safeInteger(fs.bavail * fs.bsize) : 'unavailable';
  return `cpus=${attemptObservation(() => safeInteger(cpus()))} workerUserMicros=${safeInteger(worker?.userCPUTime)}`
    + ` workerSystemMicros=${safeInteger(worker?.systemCPUTime)} workerMaxRssKiB=${safeInteger(worker?.maxRSS)} childCpuTicks=${child?.cpuTicks ?? 'unavailable'}`
    + ` cpuAvg10=${pressure('cpu')} memoryAvg10=${pressure('memory')} ioAvg10=${pressure('io')}`
    + ` memAvailableKiB=${memory} tmpFreeBytes=${freeBytes} tmpFreeInodes=${safeInteger(fs?.ffree)}`;
}

export function _testChromeProcessFacts(proc, {
  platform = process.platform, workerPid = process.pid, read = readProcPrefix, threads = readThreadIds,
  arch = process.arch,
  cpus = availableParallelism, usage = () => process.resourceUsage(), disk = () => statfsSync(tmpdir()),
} = {}) {
  if (platform !== 'linux') return 'os=unsupported';
  if (!Number.isSafeInteger(proc?.pid) || proc.pid <= 0) return 'os=linux child=unavailable';
  // Once Node has reaped it, the numeric PID may belong to somebody else.
  if (proc.exitCode != null || proc.signalCode != null) return 'os=linux child=settled';
  const stat = pid => {
    try {
      const text = read(`/proc/${pid}/stat`).slice(0, 4096);
      // comm is parenthesized and may contain spaces/parentheses; discard it.
      const end = text.lastIndexOf(')');
      if (end < 0) return null;
      const fields = text.slice(end + 2).trim().split(/\s+/);
      if (fields.length < 4 || !Object.hasOwn(PROCESS_STATES, fields[0]) || !fields.slice(1, 4).every(x => /^\d+$/.test(x))) return null;
      const cpuTicks = fields.slice(11, 13).length === 2 && fields.slice(11, 13).every(x => /^\d+$/.test(x))
        ? safeInteger(Number(fields[11]) + Number(fields[12])) : 'unavailable';
      return { state: PROCESS_STATES[fields[0]], parent: fields[1], group: fields[2], session: fields[3], cpuTicks };
    } catch { return null; }
  };
  const child = stat(proc.pid);
  const worker = stat(workerPid);
  const same = (a, b) => a && b ? (a === b ? 'worker' : 'other') : 'unavailable';
  const waitCategory = path => attemptObservation(() => {
    // Exact kernel names only; unfamiliar text never becomes log content.
    // Zero also occurs when the kernel hides a wait; it doesn't prove runnable.
    return WAIT_CATEGORIES.get(read(path).slice(0, 4096).trim()) ?? 'other';
  });
  const leadWait = waitCategory(`/proc/${proc.pid}/wchan`);
  const waits = { none: 0, futex: 0, poll: 0, pipe: 0, child: 0, io: 0, page: 0, completion: 0, lock: 0, other: 0, unavailable: 0 };
  let ids;
  try { ids = threads(`/proc/${proc.pid}/task`).slice(0, 17).filter(x => /^[1-9]\d*$/.test(x)); }
  catch { ids = null; }
  for (const id of ids?.slice(0, 16) ?? []) {
    waits[waitCategory(`/proc/${proc.pid}/task/${id}/wchan`)]++;
  }
  return `os=linux child=${child?.state ?? 'unavailable'} worker=${worker?.state ?? 'unavailable'}`
    + ` parent=${same(child?.parent, String(workerPid))} group=${same(child?.group, worker?.group)} session=${same(child?.session, worker?.session)}`
    + ` leadWait=${leadWait} threads=${ids ? Math.min(ids.length, 16) : 'unavailable'} threadLimit=${ids ? ids.length > 16 : 'unavailable'}`
    + ` waits=${Object.entries(waits).map(([name, count]) => `${name}:${count}`).join(',')}`
    + `; resources: ${resourceFacts(child, { read, cpus, usage, disk })}`
    + syscallFacts(proc.pid, ids, { read, arch });
}

function describeProcess(proc, observeProcess) {
  try { return observeProcess(proc); }
  catch { return 'os=unavailable'; } // Observation must never replace a lifecycle failure.
}

function executableKind(executable) {
  const name = basename(executable).toLowerCase();
  if (name.includes('headless_shell') || name.includes('headless-shell')) return 'headless-shell';
  if (name.includes('google chrome') || name.includes('google-chrome')) return 'google-chrome';
  if (name.includes('chromium')) return 'chromium';
  return name === 'chrome' ? 'chrome' : 'other';
}

// A synchronous execFile timeout still waits for exit after sending its signal.
// A SIGTERM-resistant version wrapper must not block the original child's
// diagnosis or teardown. Only this probe's handle is killed; an uninterruptible
// probe is unref'd and its pipe closed so its exit cannot hold up the failure.
function probeChromeVersion(executable, spawnVersion) {
  return new Promise(resolve => {
    let proc;
    let timer;
    let settled = false;
    let output = Buffer.alloc(0);
    const finish = (version, terminate = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc?.stdout?.removeListener('data', onData);
      if (terminate) {
        attemptObservation(() => {
          if (proc?.pid && proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
        });
        attemptObservation(() => proc?.stdout?.destroy());
        attemptObservation(() => proc?.unref());
      }
      resolve(version);
    };
    const onData = bytes => {
      // Keep at most the first 8192 bytes, regardless of output chunk size.
      if (output.length < 8192) output = Buffer.concat([output, bytes.subarray(0, 8192 - output.length)]);
    };
    const onError = () => finish('unavailable', true);
    const onClose = code => {
      proc.removeListener('error', onError);
      proc.removeListener('close', onClose);
      finish(code === 0 ? output.toString().match(/\b\d+(?:\.\d+){1,3}\b/)?.[0] ?? 'unrecognized' : 'unavailable');
    };
    try {
      proc = spawnVersion(executable, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
      // Retain the error handler until close: kill may emit an error after the
      // deadline has already resolved. Late output/errors cannot change it.
      proc.on('error', onError);
      proc.once('close', onClose);
      proc.stdout.on('data', onData);
      timer = setTimeout(() => finish('unavailable', true), 3000);
    } catch { finish('unavailable', true); }
  });
}

// Redacted startup snapshot: enums, booleans and a dotted version only. Capture
// child/profile state before the asynchronous probe can change the observation.
export async function _describeTestChromeStartup(proc, { source = 'unknown', executable, profile } = {}, { spawnVersion = spawn } = {}) {
  const state = proc.exitCode !== null ? 'exited' : proc.signalCode !== null ? 'signaled' : 'running';
  const port = profile ? existsSync(join(profile, 'DevToolsActivePort')) : 'unknown';
  const profileState = profile ? (existsSync(profile) ? 'created' : 'missing') : 'unknown';
  const spawned = proc.spawnedSeen ? 'yes' : 'no';
  const pid = proc.pid ? 'yes' : 'no';
  const version = executable ? await probeChromeVersion(executable, spawnVersion) : 'unavailable';
  return `source=${source} kind=${executable ? executableKind(executable) : 'unknown'} version=${version}`
    + ` spawned=${spawned} pid=${pid} state=${state}`
    + ` profile=${profileState} devToolsActivePort=${port}`;
}

// A test process that exits without its suite's cleanup (a crash, a worker
// torn down mid-test) takes its browser with it instead of orphaning it (#10840).
// One exit hook for the module; the browsers themselves get no extra listeners.
const startedBrowsers = new Set();
let exitHooked = false;
const settled = child => child.exitCode !== null || child.signalCode !== null;
function killWithTestProcess(proc) {
  if (!exitHooked) {
    exitHooked = true;
    process.once('exit', () => {
      for (const child of startedBrowsers) {
        if (!settled(child)) try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    });
  }
  for (const child of startedBrowsers) if (settled(child)) startedBrowsers.delete(child);
  startedBrowsers.add(proc);
}

// Chrome writes its CDP address to stderr. Keep only a bounded tail and report
// known failure categories: raw stderr can contain the user's profile path.
export function _waitForTestChrome(proc, timeoutMs = 20000, startup, { observeProcess = _testChromeProcessFacts, spawnVersion = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    let timer;
    let spawned = false;
    let settled = false;
    const onSpawn = () => { spawned = true; };
    const diagnostic = async () => {
      const categories = [
        ['sandbox', /sandbox/i],
        ['profile in use', /profile.*(?:in use|lock)|ProcessSingleton/i],
        ['permission denied', /permission denied|EACCES/i],
        ['missing file or library', /not found|ENOENT|shared librar/i],
        ['disk full', /no space left|ENOSPC/i],
        ['crashpad', /crashpad/i],
      ].filter(([, pattern]) => pattern.test(stderr)).map(([name]) => name);
      const base = categories.length ? `; stderr: ${categories.join(', ')}` : stderr ? '; Chrome emitted stderr' : '; no stderr';
      const processFacts = `; process: ${describeProcess(proc, observeProcess)}`;
      if (!startup) return base + processFacts;
      proc.spawnedSeen = spawned;
      return `${base}; startup: ${await _describeTestChromeStartup(proc, startup, { spawnVersion })}${processFacts}`;
    };
    const cleanup = () => {
      clearTimeout(timer);
      proc.removeListener('spawn', onSpawn);
      proc.removeListener('exit', onExit);
      proc.stderr.removeListener('data', onData);
    };
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        const rejectWithFacts = facts => {
          proc.removeListener('error', onError);
          reject(error(facts));
        };
        diagnostic().then(rejectWithFacts, () => rejectWithFacts('; diagnostic unavailable'));
      } else {
        proc.removeListener('error', onError);
        killWithTestProcess(proc);
        resolve(value);
      }
    };
    const onData = bytes => {
      stderr = (stderr + bytes.toString()).slice(-8192);
      // Wait for the terminating newline: a stream chunk can end mid-URL.
      const match = stderr.match(/(?:^|\n)DevTools listening on (ws:\/\/[^\r\n]+)\r?\n/);
      if (match) finish(match[1]);
    };
    const onError = error => {
      const code = /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : 'spawn error';
      finish(null, facts => new Error(`Test Chrome failed to spawn (${code}${facts})`));
    };
    const onExit = (code, signal) => finish(null, facts => new Error(
      `Test Chrome exited before startup (code ${Number.isInteger(code) ? code : 'none'}, signal ${/^[A-Z0-9]{1,32}$/.test(signal) ? signal : 'none'}${facts})`,
    ));
    proc.once('spawn', onSpawn);
    proc.on('error', onError);
    proc.once('exit', onExit);
    proc.stderr.on('data', onData);
    timer = setTimeout(() => finish(null, facts => new Error(`Test Chrome did not start within ${timeoutMs}ms${facts}`)), timeoutMs);
    if (proc.exitCode !== null || proc.signalCode !== null) onExit(proc.exitCode, proc.signalCode);
  });
}

async function withinDeadline(action, timeoutMs, stage, facts = () => '') {
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Test Chrome ${stage} exceeded ${timeoutMs}ms deadline${facts()}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function terminateOwnedChrome(proc, observeProcess) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  let escalation;
  let exitObserved = false;
  let term = 'not-attempted';
  let kill = 'not-attempted';
  let signalError = 'none';
  const safeSignal = value => /^[A-Z0-9]{1,32}$/.test(value) ? value : 'none';
  const facts = () => `; teardown: stage=child-termination term=${term} kill=${kill}`
    + ` exitCode=${Number.isInteger(proc.exitCode) ? proc.exitCode : 'none'}`
    + ` signal=${safeSignal(proc.signalCode)} exitObserved=${exitObserved} signalError=${signalError}`;
  // Observe errors from kill() too: Node may emit an error rather than throw.
  // Only bounded codes are retained, never the raw message or child identity.
  const onError = error => { signalError = /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : 'unknown'; };
  let onExit;
  const exited = new Promise(resolve => {
    onExit = () => { exitObserved = true; resolve(); };
    proc.once('exit', onExit);
  });
  proc.on('error', onError);
  // Keep the shared escalation semantics; instrument only this owned test
  // process, without changing its handle or discarding kill's return value.
  const tracked = {
    get exitCode() { return proc.exitCode; },
    get signalCode() { return proc.signalCode; },
    kill(signal) {
      const record = value => { if (signal === 'SIGTERM') term = value; else kill = value; };
      record('attempted');
      try {
        const accepted = proc.kill(signal);
        record(accepted === true ? 'accepted' : accepted === false ? 'rejected' : 'unknown');
        return accepted;
      } catch {
        record('threw');
        throw new Error(`Test Chrome signal delivery failed${facts()}`);
      }
    },
  };
  try {
    await withinDeadline(() => {
      escalation = killWithEscalation(tracked, {
        label: 'HTML composition test Chrome',
        stillRunning: () => proc.exitCode === null && proc.signalCode === null,
        delayMs: 3000,
      });
      return exited;
    }, 10000, 'child termination', () => `${facts()}; process: ${describeProcess(proc, observeProcess)}`);
    if (signalError !== 'none') throw new Error(`Test Chrome signal delivery error${facts()}`);
  } finally {
    clearTimeout(escalation);
    proc.removeListener('exit', onExit);
    proc.removeListener('error', onError);
    const log = exitObserved && signalError === 'none' ? console.log : console.error;
    log(`🧹 Test Chrome termination${facts()}`);
  }
}

// Test-only lifecycle boundary. Disconnect failure must not strand the owned
// child, and neither failure may prevent removal of temporary test data.
// A startup failure remains primary even if teardown also fails.
export async function _cleanupTestBrowser({ browser, proc, cleanup, startupError, observeProcess = _testChromeProcessFacts }) {
  const errors = startupError ? [startupError] : [];
  const cleanupFailure = (stage, error) => {
    const code = /^[A-Z0-9_]{1,32}$/.test(error?.code) ? error.code : 'unknown';
    errors.push(new Error(`Test Chrome ${stage} cleanup failed (${code})`));
  };
  try {
    await withinDeadline(() => browser?.close(), 5000, 'browser disconnect',
      () => `; process: ${describeProcess(proc, observeProcess)}`).catch(error => errors.push(error));
    await terminateOwnedChrome(proc, observeProcess).catch(error => errors.push(error));
  } finally {
    try { proc?.stderr?.destroy(); } catch (error) { cleanupFailure('stderr', error); }
    try { await cleanup(); } catch (error) { cleanupFailure('temporary data', error); }
  }
  if (startupError && errors.length === 1) throw startupError;
  if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('; '),
    startupError ? { cause: startupError } : undefined);
}

// Wrap the REAL encoder only in browser tests. Never print paths, page source,
// process stderr or job IDs: a bounded numeric snapshot suffices to separate
// steady capture from a stuck seek, screenshot, pipe write or encoder drain.
export function _withTestCaptureDiagnostics(encode, { logIntervalMs = 15000, stallMs = 30000, getTestSignal } = {}) {
  return async (page, contract, outputPath, options = {}) => {
    const started = Date.now();
    let phase = 'setup';
    let phaseStarted = started;
    let lastProgress = started;
    let lastLog = started;
    let frame = 0;
    const frames = Math.round(contract.durationSec * contract.fps);
    const timings = { setup: 0, seek: 0, capture: 0, encode: 0 };
    const controller = new AbortController();
    const signal = AbortSignal.any([options.signal, getTestSignal?.(), controller.signal].filter(Boolean));
    const enter = next => {
      const now = Date.now();
      timings[phase] += now - phaseStarted;
      phase = next;
      phaseStarted = now;
      lastProgress = now;
    };
    const snapshot = () => {
      const now = Date.now();
      const totals = { ...timings, [phase]: timings[phase] + now - phaseStarted };
      return `phase=${phase} frames=${frame}/${frames} elapsedMs=${now - started} idleMs=${now - lastProgress} `
        + Object.entries(totals).map(([name, ms]) => `${name}Ms=${ms}`).join(' ');
    };
    const timer = setInterval(() => {
      const now = Date.now();
      if (now - lastProgress >= stallMs) {
        const error = new Error(`Test Chrome capture stalled; ${snapshot()}`);
        console.error(`❌ ${error.message}`);
        // The encoder's existing abort/close boundary terminates only its own
        // ffmpeg child. Existing CDP deadlines settle pending browser commands.
        controller.abort(error);
        clearInterval(timer);
      } else if (now - lastLog >= logIntervalMs) {
        console.log(`🎞️ Test Chrome capture progress; ${snapshot()}`);
        lastLog = now;
      }
    }, Math.min(1000, logIntervalMs, stallMs));
    timer.unref?.();
    const roundTrip = async (next, action) => {
      signal.throwIfAborted();
      enter(next);
      const result = await action();
      // A late response after the test deadline must never start another
      // capture or launch an encoder with an already-aborted signal.
      signal.throwIfAborted();
      enter('encode');
      return result;
    };
    const tracedPage = {
      ...page,
      check() { signal.throwIfAborted(); page.check(); },
      evaluate(...args) {
        return roundTrip(String(args[0]).startsWith('globalThis.portosComposition.seek(') ? 'seek' : 'setup', () => page.evaluate(...args));
      },
      send(...args) {
        return roundTrip(args[0] === 'Page.captureScreenshot' ? 'capture' : 'setup', () => page.send(...args));
      },
    };
    try {
      const result = await encode(tracedPage, contract, outputPath, {
        ...options,
        signal,
        onProgress(fraction, detail) {
          frame = detail?.frame ?? Math.round(fraction * frames);
          lastProgress = Date.now();
          options.onProgress?.(fraction, detail);
        },
      });
      signal.throwIfAborted();
      console.log(`🎞️ Test Chrome capture complete; ${snapshot()}`);
      return result;
    } catch (error) {
      console.error(`❌ Test Chrome capture failed; ${snapshot()}`);
      throw error;
    } finally {
      clearInterval(timer);
    }
  };
}
