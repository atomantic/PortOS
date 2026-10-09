// Test-only observer: retain phase facts before owned-page cleanup without
// copying document source, URLs, error messages or console arguments.
import { availableParallelism, loadavg, platform } from 'node:os';

const LIMIT = 1000;
const DOCUMENT_PROBE_MS = 250;
// Browser-process probe: one CDP round trip plus two CPU samples this far
// apart, all inside its own deadline. It runs beside the renderer probe, so a
// failure costs at most PROCESS_PROBE_MS before the caller's owned cleanup.
const PROCESS_SAMPLE_MS = 250;
const PROCESS_PROBE_MS = 1000;
const DEADLINE = Symbol('deadline');
const SAMPLED_PROCESS_TYPES = new Set(['browser', 'renderer', 'GPU']);
const count = value => Number.isInteger(value) && value >= 0 ? Math.min(value, LIMIT) : 'unavailable';
const flag = value => typeof value === 'boolean' ? value : 'unavailable';
const percent = value => Number.isFinite(value) ? Math.min(Math.max(Math.round(value), 0), 10 * LIMIT) : 'unavailable';

// Promise.race owns a late rejection after the deadline wins.
function withDeadline(start, ms) {
  let timer;
  return Promise.race([
    Promise.resolve().then(start),
    new Promise(resolve => { timer = setTimeout(() => resolve(DEADLINE), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// Keep only allowlisted process types and numeric CPU seconds; process ids
// are compared inside this module and never leave it.
function cpuByProcess(result) {
  const cpu = new Map();
  const processes = Array.isArray(result?.processInfo) ? result.processInfo.slice(0, LIMIT) : [];
  for (const entry of processes) {
    if (SAMPLED_PROCESS_TYPES.has(entry?.type) && Number.isFinite(entry.cpuTime)) cpu.set(entry.id, { type: entry.type, cpuTime: entry.cpuTime });
  }
  return cpu;
}

// Distinguishes CDP delivery to the browser process from renderer execution:
// a fast round trip with a pegged renderer points at page work; an idle
// renderer and slow/absent round trip point at delivery or host pressure.
async function sampleBrowserProcesses(browser) {
  const session = await browser.newBrowserCDPSession();
  try {
    const sent = Date.now();
    // The reply carries version/user-agent strings; only the latency is kept.
    await session.send('Browser.getVersion');
    const browserRoundTripMs = Date.now() - sent;
    const before = cpuByProcess(await session.send('SystemInfo.getProcessInfo'));
    const windowStart = Date.now();
    await new Promise(resolve => setTimeout(resolve, PROCESS_SAMPLE_MS));
    const after = cpuByProcess(await session.send('SystemInfo.getProcessInfo'));
    const windowMs = Math.max(Date.now() - windowStart, 1);
    const busiest = { browser: 0, renderer: 0, GPU: 0 };
    let rendererProcesses = 0;
    for (const [id, { type, cpuTime }] of after) {
      if (type === 'renderer') rendererProcesses++;
      const previous = before.get(id);
      if (previous?.type !== type) continue;
      busiest[type] = Math.max(busiest[type], (cpuTime - previous.cpuTime) * 1000 / windowMs * 100);
    }
    return { browserRoundTripMs: count(browserRoundTripMs), rendererProcesses: count(rendererProcesses),
      busiestRendererCpuPct: percent(busiest.renderer), gpuCpuPct: percent(busiest.GPU), browserCpuPct: percent(busiest.browser) };
  } finally {
    session.detach().catch(() => {});
  }
}

async function probeDocument(page) {
  const documentFacts = await withDeadline(() => page.evaluate(() => {
    let moduleCount = 0, externalScriptCount = 0;
    for (let i = 0; i < Math.min(document.scripts.length, 1000); i++) {
      const script = document.scripts[i];
      if (script.type === 'module') moduleCount++;
      if (script.hasAttribute('src')) externalScriptCount++;
    }
    return { readyState: document.readyState,
      compositionReady: typeof window.portosComposition?.seek === 'function',
      scriptCount: document.scripts.length, moduleCount, externalScriptCount };
  }), DOCUMENT_PROBE_MS).catch(() => null);
  // Treat page evaluation as untrusted even in a synthetic proof. Only
  // these scalars can leave the page; never stringify the returned object.
  if (documentFacts === null) return { documentProbe: 'unavailable' };
  if (documentFacts === DEADLINE) return { documentProbe: 'deadline' };
  return { documentProbe: 'captured',
    readyState: ['loading', 'interactive', 'complete'].includes(documentFacts?.readyState) ? documentFacts.readyState : 'unavailable',
    compositionReady: flag(documentFacts?.compositionReady),
    scriptCount: count(documentFacts?.scriptCount),
    moduleCount: count(documentFacts?.moduleCount),
    externalScriptCount: count(documentFacts?.externalScriptCount) };
}

async function probeProcesses(page) {
  const facts = await withDeadline(() => sampleBrowserProcesses(page.context().browser()), PROCESS_PROBE_MS).catch(() => null);
  if (facts === null) return { processProbe: 'unavailable' };
  if (facts === DEADLINE) return { processProbe: 'deadline' };
  return { processProbe: 'captured', ...facts };
}

function hostLoadPerCpu() {
  // Windows reports a constant zero load average.
  if (platform() === 'win32') return 'unavailable';
  const perCpu = loadavg()[0] / availableParallelism();
  return Number.isFinite(perCpu) ? Math.min(Math.round(perCpu * 100) / 100, LIMIT) : 'unavailable';
}

export async function _withTestPreviewLoadDiagnostics(page, load) {
  const started = Date.now();
  const facts = { domContentLoaded: false, load: false, crashed: false, closed: false,
    scriptRequested: 0, scriptFinished: 0, scriptFailed: 0,
    consoleWarning: 0, consoleError: 0, typeError: 0, syntaxError: 0, otherError: 0 };
  const increment = key => { facts[key] = Math.min(LIMIT, facts[key] + 1); };
  const events = {
    domcontentloaded: () => { facts.domContentLoaded = true; },
    load: () => { facts.load = true; },
    crash: () => { facts.crashed = true; },
    close: () => { facts.closed = true; },
    request: request => { if (request.resourceType() === 'script') increment('scriptRequested'); },
    requestfinished: request => { if (request.resourceType() === 'script') increment('scriptFinished'); },
    requestfailed: request => { if (request.resourceType() === 'script') increment('scriptFailed'); },
    console: message => {
      if (message.type() === 'warning') increment('consoleWarning');
      if (message.type() === 'error') increment('consoleError');
    },
    pageerror: error => increment(error.name === 'TypeError' ? 'typeError' : error.name === 'SyntaxError' ? 'syntaxError' : 'otherError'),
  };
  for (const [event, listener] of Object.entries(events)) page.on(event, listener);
  let phase = 'load';
  try {
    // The caller keeps its existing Playwright load and semantic deadlines.
    // Observations never replace load with a weaker lifecycle event.
    await load(() => { phase = 'composition-readiness'; });
  } catch (error) {
    const failure = { phase, elapsedMs: Math.min(Date.now() - started, 3600000), ...facts,
      pageClosed: page.isClosed(), browserConnected: page.context().browser()?.isConnected() ?? false,
      hostLoadPerCpu: hostLoadPerCpu() };
    const [documentFacts, processFacts] = await Promise.all([probeDocument(page), probeProcesses(page)]);
    Object.assign(failure, documentFacts, processFacts);
    // Attach to the original failure so reporters retain these facts even if
    // cleanup subsequently fails. No console/error body enters the snapshot.
    error.message += `; preview lifecycle: ${JSON.stringify(failure)}`;
    throw error;
  } finally {
    for (const [event, listener] of Object.entries(events)) page.off(event, listener);
  }
}
