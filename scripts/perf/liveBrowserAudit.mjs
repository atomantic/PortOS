#!/usr/bin/env node
/**
 * Live-install browser traffic audit (#13101). Separate from the synthetic
 * fixture audit: it measures the running install through a disposable browser
 * context authorized only by the delegated agent session. See README.md
 * "Live install audit" for the transport, redaction and exit-code contract.
 */
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { createTrafficAccumulator, idleBytesPerMinute } from './collectionTraffic.js';
import {
  NEXT_STEPS, createEndpointRedactor, installLiveTransport, liveFindings, parseLiveAuditArgs,
  phaseTotals, preflightLiveTransport, resolveLiveOrigin, sameOrigin,
} from './liveTraffic.js';
import { requestApi, resolveCredentials } from '../portos-api.js';
import { isDirectlyInvoked } from '../lib/directInvocation.js';

const EVENTS = ['requestWillBeSent', 'responseReceived', 'dataReceived', 'loadingFinished', 'loadingFailed',
  'webSocketCreated', 'webSocketClosed', 'webSocketFrameSent', 'webSocketFrameReceived'];
const STAGE_TIMEOUT_MS = 30000;
const OBSERVATION_TAIL_MS = 2000;
// Completed-data state: the shell is mounted and no loading skeleton
// (PageSkeleton / Skeleton render role=status aria-busy=true) remains.
const settled = () => document.getElementById('main-content') !== null
  && document.querySelector('[role="status"][aria-busy="true"]') === null;

// Useful content also requires no HTTP request still in flight (route chunks,
// API reads, media): right after an in-app navigation the previous page's
// settled DOM is still mounted, so the DOM check alone would pass early.
async function waitForUsefulContent(page, traffic, signal) {
  const deadline = performance.now() + STAGE_TIMEOUT_MS;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  for (;;) {
    if (traffic.pending() === 0 && await page.evaluate(settled)) return;
    if (performance.now() > deadline) throw new Error('useful content not reached');
    await delay(50, undefined, { signal });
  }
}

// Prefer a real in-app link (what a user clicks); otherwise drive the data
// router through history so the shell is not reloaded.
async function navigateInApp(page, path) {
  const link = page.locator(`a[href="${path}"]`).filter({ visible: true }).first();
  if (await link.count()) {
    await link.click();
    return 'link';
  }
  await page.evaluate(target => {
    history.pushState({ usr: null, key: 'live-audit', idx: (history.state?.idx ?? 0) + 1 }, '', target);
    dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  }, path);
  return 'history';
}

async function measure({ browser, origin, token, args, catalog, report, signal }) {
  const redact = createEndpointRedactor({ origin, pages: [args.route, args.sibling], catalog });
  const collectionPattern = redact(origin + args.collectionEndpoint);
  const traffic = createTrafficAccumulator({ label: redact });
  const blocked = new Map();
  let phase = 'cold';
  const advance = name => { phase = name; traffic.setPhase(name); };
  const scenario = report.scenario = { usefulContentMs: null, siblingUsefulContentMs: null, siblingNavigation: null, idleMs: null };
  const findings = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  try {
    await installLiveTransport(context, {
      origin, token,
      onBlocked: (reason, url, method) => {
        const key = [phase, reason, redact(url, method)].join('\0');
        blocked.set(key, (blocked.get(key) || 0) + 1);
      },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(STAGE_TIMEOUT_MS);
    const cdp = await context.newCDPSession(page);
    for (const name of EVENTS) cdp.on('Network.' + name, event => traffic.event(name, event));
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    try {
      const started = performance.now();
      const collection = page.waitForResponse(response => response.request().method() === 'GET'
        && sameOrigin(response.url(), origin) && new URL(response.url()).pathname === args.collectionEndpoint,
      { timeout: STAGE_TIMEOUT_MS }).catch(() => null);
      await page.goto(origin + args.route, { waitUntil: 'domcontentloaded' });
      const response = await collection;
      if (new URL(page.url()).pathname === '/login') {
        report.status = 'unverified';
        report.unverified = { reason: 'login-redirect', nextStep: NEXT_STEPS['login-redirect'] };
        return;
      }
      if (!response) throw new Error('collection response not observed');
      if (!response.ok()) findings.push({ phase, endpoint: collectionPattern, reason: 'collection-http-status', count: response.status() });
      await response.finished();
      await waitForUsefulContent(page, traffic, signal);
      scenario.usefulContentMs = Math.round(performance.now() - started);
      // A fixed tail catches eager follow-up fetches; networkidle would hide
      // recurring requests behind its own timeout.
      await delay(OBSERVATION_TAIL_MS, undefined, { signal });

      advance('sibling');
      const siblingStarted = performance.now();
      scenario.siblingNavigation = await navigateInApp(page, args.sibling);
      await page.waitForFunction(target => location.pathname === target, args.sibling);
      await waitForUsefulContent(page, traffic, signal);
      scenario.siblingUsefulContentMs = Math.round(performance.now() - siblingStarted);
      await delay(OBSERVATION_TAIL_MS, undefined, { signal });

      advance('idle');
      const idleStarted = performance.now();
      await delay(args.idleMs, undefined, { signal });
      scenario.idleMs = Math.round(performance.now() - idleStarted);
      report.status = 'verified';
    } catch {
      // Playwright errors carry URLs, DOM text and paths: only the stage crosses.
      report.status = 'failed';
      findings.push({ phase, endpoint: 'browser', reason: 'browser-stage-' + phase, count: 1 });
    }
  } finally {
    scenario.phases = traffic.snapshot();
    scenario.totals = phaseTotals(scenario.phases);
    scenario.inFlight = traffic.pendingByEndpoint();
    scenario.blocked = [...blocked].map(([key, count]) => {
      const [blockedPhase, reason, endpoint] = key.split('\0');
      return { phase: blockedPhase, reason, endpoint, count };
    });
    if (scenario.idleMs) scenario.idleBytesPerMinute = idleBytesPerMinute(scenario.phases.idle, scenario.idleMs);
    report.findings.push(...findings, ...liveFindings({ phases: scenario.phases, inFlight: scenario.inFlight,
      blocked: scenario.blocked, collectionEndpoint: collectionPattern }));
    await context.close().catch(() => report.findings.push({ phase: 'end', endpoint: 'browser', reason: 'context-cleanup', count: 1 }));
  }
}

/**
 * Returns an aggregate report; never throws for an expected environment gap.
 * status: 'verified' (measured), 'failed' (a stage broke), 'unverified'
 * (no authorized transport; `unverified.nextStep` says what to do).
 */
export async function runLiveAudit({ args, env = process.env, chromium, catalog, request = requestApi, signal } = {}) {
  const report = {
    version: 1, kind: 'live-browser-audit', live: true, synthetic: false, status: 'unverified',
    route: args.route, sibling: args.sibling, collectionEndpoint: args.collectionEndpoint, idleTargetMs: args.idleMs,
    transport: null, scenario: null, findings: [],
  };
  const unverified = reason => {
    report.unverified = { reason, nextStep: NEXT_STEPS[reason] };
    return report;
  };
  const { url, token } = await resolveCredentials(env);
  let origin;
  try { origin = resolveLiveOrigin(url); } catch (error) { return unverified(error.reason || 'invalid-origin'); }
  const preflight = await preflightLiveTransport({ origin, token, request });
  if (!preflight.ok) return unverified(preflight.reason);
  const delegated = preflight.mode === 'delegated-session';
  report.transport = {
    mode: preflight.mode, origin: 'loopback-http',
    credentialSource: !delegated ? 'none' : env.PORTOS_API_TOKEN ? 'PORTOS_API_TOKEN' : 'agent-key-file',
  };
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(env.LIVE_AUDIT_BROWSER
      ? { executablePath: env.LIVE_AUDIT_BROWSER } : { channel: 'chrome' }) });
  } catch { return unverified('browser-unavailable'); }
  try {
    await measure({ browser, origin, token: delegated ? token : null, args, catalog, report, signal });
  } catch {
    report.status = 'failed';
    report.findings.push({ phase: 'setup', endpoint: 'browser', reason: 'browser-setup', count: 1 });
  } finally {
    await browser.close().catch(() => report.findings.push({ phase: 'end', endpoint: 'browser', reason: 'cleanup', count: 1 }));
  }
  return report;
}

/** 0 measured with no findings, 1 findings or a failed stage, 2 UNVERIFIED. */
export const exitCodeFor = report => report.status === 'unverified' ? 2
  : report.status === 'verified' && report.findings.length === 0 ? 0 : 1;

if (isDirectlyInvoked(import.meta.url)) {
  let args;
  try { args = parseLiveAuditArgs(process.argv.slice(2)); } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exit(1);
  }
  const { chromium } = createRequire(new URL('../../server/package.json', import.meta.url))('playwright-core');
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const report = await runLiveAudit({ args, chromium, signal: abort.signal });
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  report.passed = exitCodeFor(report) === 0;
  process.exitCode = exitCodeFor(report);
  const serialized = JSON.stringify(report, null, 2) + '\n';
  try {
    if (args.output) await writeFile(args.output, serialized, { flag: 'wx' });
    else process.stdout.write(serialized);
  } catch {
    console.error('❌ Could not write aggregate report; choose a new writable output file.');
    process.exitCode = 1;
  }
}
