#!/usr/bin/env node
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { startCollectionFixture } from './collectionFixture.js';
import { createTrafficAccumulator, endpointFor, inspectCollection, trafficFailures } from './collectionTraffic.js';

const { chromium } = createRequire(new URL('../../server/package.json', import.meta.url))('playwright-core');
const events = ['requestWillBeSent', 'responseReceived', 'dataReceived', 'loadingFinished', 'loadingFailed',
  'webSocketCreated', 'webSocketClosed', 'webSocketFrameSent', 'webSocketFrameReceived'];
const output = process.argv[2];
let browser;
let fixture;
const abort = new AbortController();
const stop = () => { abort.abort(); browser?.close().catch(() => {}); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
const report = { version: 1, synthetic: true, idleTargetMs: 60000, scenarios: [], failures: [] };

async function scenario(route) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const cdp = await context.newCDPSession(page);
  const traffic = createTrafficAccumulator();
  const inspections = new Set();
  const failures = [];
  let listResponses = 0;
  let returnedRows = 0;
  let details = 0;
  let phase = 'cold';
  const advance = name => { phase = name; traffic.setPhase(name); };
  const media = route === '/media/history';
  const listEndpoint = media ? '/api/image-gen/gallery' : '/api/messages/inbox';
  const rows = media ? page.locator('button[aria-label^="synthetic-"]') : page.getByRole('button', { name: /Example Sender.*Synthetic message/ });
  const result = { route, usefulContentMs: null, renderedRows: 0, listResponses: 0, returnedRows: 0, details: 0, phases: {} };
  try {
    for (const name of events) cdp.on('Network.' + name, event => traffic.event(name, event));
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.origin !== fixture.url) return;
      const endpoint = endpointFor(response.url());
      const responsePhase = phase;
      if (endpoint !== listEndpoint && !['/api/messages/:account/:message', '/api/video-gen/history/:record', '/api/image-gen/gallery/lookup'].includes(endpoint)) return;
      const inspect = (async () => {
        if (response.status() !== 200) {
          failures.push({ endpoint, reason: 'collection-http-status', count: response.status(), bytes: 0 }); return;
        }
        let timer;
        const body = await Promise.race([response.body(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Response inspection timed out')), 15000);
        })]).finally(() => clearTimeout(timer));
        const payload = JSON.parse(body.toString('utf8'));
        if (endpoint === listEndpoint) {
          listResponses++;
          const inspected = inspectCollection(endpoint, url.searchParams, payload, body.length, fixture.cardinalities);
          returnedRows += inspected.count;
          failures.push(...inspected.failures);
        } else {
          details++;
          if (responsePhase !== 'detail' || (media ? !((Array.isArray(payload) ? payload[0]?.prompt : payload.prompt)?.length >= fixture.cardinalities.detailCharacters) : payload.bodyText?.length !== fixture.cardinalities.detailCharacters)) {
            failures.push({ endpoint, reason: 'lazy-detail-contract', bytes: body.length });
          }
        }
      })().catch(() => failures.push({ endpoint, reason: 'response-inspection-failed', bytes: 0 }));
      inspections.add(inspect);
      inspect.finally(() => inspections.delete(inspect));
    });
    const started = performance.now();
    await page.goto(fixture.url + route, { waitUntil: 'domcontentloaded' });
    await rows.first().waitFor({ state: 'visible' });
    result.usefulContentMs = Math.round(performance.now() - started);
    // A fixed observation tail catches eager hydration after first paint; do
    // not use networkidle, which can hide recurring fetches behind a timeout.
    await delay(2000, undefined, { signal: abort.signal });
    await Promise.all([...inspections]);
    result.renderedRows = await rows.count();
    if (!listResponses || result.renderedRows < 1 || result.renderedRows > (media ? 60 : 50)
        || returnedRows > (media ? 60 : 50)) {
      failures.push({ endpoint: listEndpoint, reason: 'cold-page-bound', count: returnedRows, bytes: 0 });
    }
    // The fixture deliberately leaves unrelated security-status APIs unavailable.
    // Dismiss that check through the UI in this disposable browser only.
    const dismiss = page.getByRole('button', { name: 'Dismiss and don’t show again', exact: true });
    if (await dismiss.isVisible()) await dismiss.click();
    if (media) {
      advance('detail');
      await rows.first().click();
      await delay(1000, undefined, { signal: abort.signal });
      await Promise.all([...inspections]);
      if (details !== 1) failures.push({ endpoint: listEndpoint, reason: 'missing-lazy-media-detail', count: details, bytes: 0 });
    } else {
      advance('detail');
      await rows.first().click();
      await page.getByRole('button', { name: 'Back', exact: true }).waitFor({ state: 'visible' });
      await delay(500, undefined, { signal: abort.signal });
      await Promise.all([...inspections]);
      if (details !== 1) failures.push({ endpoint: '/api/messages/:account/:message', reason: 'detail-request-count', count: details, bytes: 0 });
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      advance('sibling');
      await page.getByRole('tab', { name: 'Contacts', exact: true }).click();
      await page.waitForURL('**/messages/contacts');
      await delay(2000, undefined, { signal: abort.signal });
      advance('idle');
      const idleStart = performance.now();
      await delay(60000, undefined, { signal: abort.signal });
      result.idleMs = Math.round(performance.now() - idleStart);
    }
  } catch {
    // Playwright errors include DOM text, URLs and filesystem paths. Only a
    // fixed stage identifier and aggregates may cross the report boundary.
    failures.push({ endpoint: listEndpoint, reason: 'browser-stage-' + phase, bytes: 0 });
  } finally {
    await Promise.all([...inspections]);
    result.phases = traffic.snapshot();
    result.pendingRequests = traffic.pending();
    result.listResponses = listResponses;
    result.returnedRows = returnedRows;
    result.details = details;
    if (result.idleMs) {
      const entries = Object.values(result.phases.idle || {});
      const total = key => entries.reduce((sum, value) => sum + value[key], 0);
      result.idleBytesPerMinute = {
        encoded: Math.round(total('encodedBytes') * 60000 / result.idleMs),
        decoded: Math.round(total('decodedBytes') * 60000 / result.idleMs),
        socketPayload: Math.round((total('socketSentBytes') + total('socketReceivedBytes')) * 60000 / result.idleMs),
      };
    }
    failures.push(...trafficFailures(result.phases));
    report.failures.push(...failures);
    report.scenarios.push(result);
    await context.close();
  }
}

try {
  fixture = await startCollectionFixture();
  report.cardinalities = fixture.cardinalities;
  browser = await chromium.launch({ headless: true, ...(process.env.COLLECTION_AUDIT_BROWSER
    ? { executablePath: process.env.COLLECTION_AUDIT_BROWSER } : { channel: 'chrome' }) });
  await scenario('/media/history');
  await scenario('/messages/inbox');
} catch {
  report.failures.push({ endpoint: 'fixture', reason: 'audit-startup-or-shutdown', bytes: 0 });
} finally {
  await browser?.close().catch(() => report.failures.push({ endpoint: 'browser', reason: 'cleanup', bytes: 0 }));
  await fixture?.close().catch(() => report.failures.push({ endpoint: 'fixture', reason: 'cleanup', bytes: 0 }));
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
report.passed = report.failures.length === 0;
const serialized = JSON.stringify(report, null, 2) + '\n';
if (output) await writeFile(output, serialized, { flag: 'wx' });
else process.stdout.write(serialized);
process.exitCode = report.passed ? 0 : 1;
