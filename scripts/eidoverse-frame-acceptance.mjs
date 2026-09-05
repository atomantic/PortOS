#!/usr/bin/env node
/**
 * Renderer-dependent acceptance for the Eidoverse frame contract V1.
 *
 *   node scripts/eidoverse-frame-acceptance.mjs
 *
 * Everything the producer and handshake unit tests cannot prove: that PortOS's
 * OWN bridge arms the external renderer's frame bridge, that a real browser
 * completes the handshake across two real origins, and that the messages a
 * real renderer emits survive PortOS's navigation validator.
 *
 * Deliberately not a Vitest suite and deliberately not in CI: it needs the
 * installed Worlds checkout, Bun, Playwright and a real Chrome, none of which a
 * CI runner has. The regression coverage that DOES belong in CI is in
 * `server/services/eidoverseHost.test.js` and `client/src/pages/Eidoverse.test.jsx`.
 *
 * The world it drives is disposable and synthetic — a child sequencer bound to
 * a per-run nonce, writing to a scratch directory. It never joins, reads or
 * writes the install's real world under `data/eidoverse/worlds`, and every
 * fixture entity below is invented.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createEidoverseHost } from '../server/services/eidoverseHost.js';
import {
  EIDOVERSE_FRAME_VERSION,
  eidoverseNavigationTarget,
  isEidoverseFrameMessage,
} from '../client/src/lib/eidoverseFrame.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORLDS = process.env.EIDOVERSE_WORLDS_DIR
  || join(REPO, 'data', 'repos', 'anima-research', 'eidoverse-worlds');
const VIDEO = process.env.EIDOVERSE_VIDEO_DIR
  || join(REPO, 'data', 'repos', 'anima-research', 'eidoverse-video');
const BUN = process.env.BUN_PATH || join(process.env.HOME || '', '.bun', 'bin', 'bun');
const CHROME = process.env.PORTOS_TEST_CHROME
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const JOIN_TOKEN = 'portos-frame-acceptance';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const until = async (want, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await want()) return true;
    await sleep(100);
  }
  return false;
};

// Invented fixtures. `pin` is the only one that may ever become a destination;
// the rest are the shapes a component could carry that must not.
const SEED = {
  pin: { label: { name: 'Example Goals', visibility: 'always' }, portos: { route: '/goals/list' } },
  url: { label: { name: 'Elsewhere', visibility: 'always' }, portos: { route: 'https://evil.example/goals/list' } },
  query: { label: { name: 'Queried', visibility: 'always' }, portos: { route: '/goals/list?steal=1' } },
  plain: { label: { name: 'Bench', visibility: 'always' } },
};
// The saved projection legend PortOS would hold for that world.
const LEGEND = [{ id: 'pin', route: '/goals/list' }];

const PARENT_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>PortOS</title></head>
<body style="margin:0">
<iframe id="f" title="Eidoverse Worlds" style="width:100vw;height:100vh;border:0"></iframe>
<script>
window.received = [];
addEventListener('message', (e) => { received.push({ origin: e.origin, data: e.data }); });
window.rendererOrigin = new URLSearchParams(location.search).get('renderer') || '';
window.mount = (src) => new Promise((done) => {
  const frame = document.getElementById('f');
  frame.addEventListener('load', () => done(true), { once: true });
  frame.src = src;
});
window.post = (msg) => document.getElementById('f').contentWindow.postMessage(msg, rendererOrigin);
window.readyFor = (nonce) => received.find((m) => m.data?.type === 'eidoverse:ready' && m.data.nonce === nonce) || null;
window.navigates = () => received.filter((m) => m.data?.type === 'eidoverse:navigate');
</script></body></html>`;

const shutdown = [];
const closeAll = async () => {
  for (const stop of shutdown.reverse()) await stop().catch(() => {});
};

async function spawnDisposableWorld() {
  const port = 8981 + Math.floor(Math.random() * 800);
  const scratch = mkdtempSync(join(tmpdir(), 'portos-eidoverse-acceptance-'));
  const nonce = randomUUID();
  const child = spawn(BUN, ['server/server.ts'], {
    cwd: WORLDS,
    env: {
      ...process.env,
      PORT: String(port),
      JOIN_TOKEN,
      WORLDS_DIR: scratch,
      EIDOVERSE_DIR: VIDEO,
      EIDO_BOOT_NONCE: nonce,
      // Left UNSET on purpose: proving PortOS's bridge is what arms the frame
      // bridge means the checkout must have no embedder of its own.
      EMBED_PARENT_ORIGIN: '',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  shutdown.push(async () => {
    child.kill('SIGTERM');
    rmSync(scratch, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${port}`;
  let version = null;
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`Eidoverse child exited ${child.exitCode}`);
    version = await fetch(`${origin}/version`).then((r) => r.json()).catch(() => null);
    return version?.nonce === nonce;
  }, 60000);
  if (version?.nonce !== nonce) throw new Error('the disposable Eidoverse world never proved it was ours');
  return { origin, version };
}

const serveParent = () => new Promise((ready) => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PARENT_PAGE);
  });
  shutdown.push(() => new Promise((done) => server.close(done)));
  server.listen(0, '127.0.0.1', () => ready(server.address().port));
});

async function main() {
  for (const [label, path] of [['Worlds checkout', WORLDS], ['Video checkout', VIDEO], ['Bun', BUN], ['Chrome', CHROME]]) {
    if (!existsSync(path)) throw new Error(`${label} not found at ${path}`);
  }
  // Playwright ships CommonJS, so the named export only exists on `default`
  // for some builds — take whichever half of the interop actually carries it.
  const playwright = await import(pathToFileURL(join(WORLDS, 'node_modules', 'playwright', 'index.js')).href);
  const chromium = playwright.chromium || playwright.default?.chromium;
  if (!chromium) throw new Error('Playwright resolved without a chromium launcher');

  const parentPort = await serveParent();
  // Read by the bridge when it answers /embed-config, so the derived parent
  // origin names this harness rather than the install's real PortOS port.
  process.env.PORT = String(parentPort);
  const parentOrigin = `http://127.0.0.1:${parentPort}`;

  const world = await spawnDisposableWorld();
  console.log(`\nRenderer build ${world.version.sha} (${world.version.commitTime}) — capabilities ${JSON.stringify(world.version.capabilities)}`);

  const bridge = createEidoverseHost({
    targetHost: '127.0.0.1',
    targetPort: Number(new URL(world.origin).port),
    listenHost: '127.0.0.1',
    listenPort: 0,
    certDir: null,
  });
  shutdown.push(() => bridge.close());
  const bridgeStatus = await bridge.start();
  const bridgeOrigin = `http://127.0.0.1:${bridgeStatus.port}`;

  console.log('\n— A. the renderer is armed by PortOS, not by its own environment —');
  const direct = await fetch(`${world.origin}/embed-config`).then((r) => r.json());
  check('the unconfigured checkout names no embedder of its own', direct.parentOrigin === null, JSON.stringify(direct));
  const bridged = await fetch(`${bridgeOrigin}/embed-config`).then((r) => r.json());
  check('the PortOS bridge names this page origin exactly',
    bridged.parentOrigin === parentOrigin, JSON.stringify(bridged));
  const refused = await fetch(`${bridgeOrigin}/embed-config`, { method: 'POST' });
  check('the embedding configuration is read-only', refused.status === 405, String(refused.status));

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--enable-unsafe-webgpu'] });
  shutdown.push(() => browser.close());
  // Narrow and touch-capable: every action below has to be reachable by thumb.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)),
    (byte) => byte.toString(16).padStart(2, '0')).join('');
  await page.goto(`${parentOrigin}/?renderer=${encodeURIComponent(bridgeOrigin)}`);
  await page.evaluate((src) => window.mount(src), `${bridgeOrigin}/?spectate&key=${JOIN_TOKEN}&world=acceptance`);

  console.log('\n— B. the handshake PortOS actually sends —');
  await page.evaluate(([version, session]) => window.post({
    type: 'portos:connect', version, nonce: session,
    capabilities: { portosNavigation: 1, labelPreferences: 1 }, labelVisibility: 'nearby',
  }), [EIDOVERSE_FRAME_VERSION, nonce]);
  await until(async () => Boolean(await page.evaluate((s) => window.readyFor(s), nonce)), 60000);
  const ready = await page.evaluate((s) => window.readyFor(s), nonce);
  check('eidoverse:ready arrives from the bridge origin, echoing version and nonce',
    Boolean(ready) && ready.origin === bridgeOrigin, JSON.stringify(ready));
  check('PortOS accepts it as a message of the current session',
    Boolean(ready) && isEidoverseFrameMessage(
      { data: ready.data, source: 'frame', origin: bridgeOrigin },
      { source: 'frame', origin: bridgeOrigin, nonce },
    ), JSON.stringify(ready?.data));
  check('ready advertises all three V1 capabilities as PortOS reads them',
    ['objectLabels', 'portosNavigation', 'labelPreferences'].every((key) => ready?.data?.capabilities?.[key] === 1),
    JSON.stringify(ready?.data?.capabilities));

  const renderer = () => {
    const frame = page.frames().find((entry) => entry.url().startsWith(bridgeOrigin));
    if (!frame) throw new Error('renderer frame is gone');
    return frame;
  };
  const panel = () => renderer().locator('details').filter({ hasText: 'Inspect objects' });
  await panel().waitFor({ timeout: 90000 });

  console.log('\n— C. a synthetic scene, and the one action it may offer —');
  await renderer().evaluate(async (seed) => {
    const [{ state, hydrate }, { entities }, { THREE, camera, scene }, { tickObjectLabels }] = await Promise.all([
      import('/lib/state.js'), import('/lib/world.js'), import('/lib/core.js'), import('/lib/objectlabels.js')]);
    camera.position.set(0, 2, 8); camera.lookAt(0, 1, 0); camera.updateMatrixWorld();
    const snapshot = structuredClone(state.st);
    snapshot.entities = {};
    for (const [id, comp] of Object.entries(seed)) {
      snapshot.entities[id] = { id, lib: 'missing.glb', pos: [0, 0, 0], comp };
    }
    hydrate(snapshot);
    let index = 0;
    for (const id of Object.keys(seed)) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1, 0.4), new THREE.MeshBasicMaterial());
      mesh.position.set((index - 1.5) * 0.5, 0, 0);
      index += 1;
      scene.add(mesh);
      mesh.updateMatrixWorld();
      entities.set(id, mesh);
    }
    tickObjectLabels(performance.now() + 1000);
    window.labelTick = tickObjectLabels;
    const send = WebSocket.prototype.send;
    window.sent = [];
    WebSocket.prototype.send = function record(data) { window.sent.push(String(data)); return send.call(this, data); };
  }, SEED);
  await panel().getByText('Inspect objects', { exact: true }).click();
  const open = panel().getByRole('button', { name: 'Open in PortOS' });
  const select = (id) => panel().getByLabel('Choose object to inspect').selectOption(id);
  await select('pin');
  check('a projected object offers Open in PortOS', await open.count() === 1);
  for (const id of ['url', 'query', 'plain']) {
    await select(id);
    check(`"${id}" offers no action — its component names no route PortOS knows`, await open.count() === 0);
  }

  console.log('\n— D. navigation is a user action, and PortOS validates what arrives —');
  await select('pin');
  await open.focus();
  await page.keyboard.press('Enter');
  await until(async () => (await page.evaluate(() => window.navigates().length)) === 1);
  const [navigate] = await page.evaluate(() => window.navigates());
  check('keyboard Enter emits eidoverse:navigate from the bridge origin',
    navigate?.origin === bridgeOrigin, JSON.stringify(navigate));
  check('PortOS resolves it to the legend route and nothing else',
    Boolean(navigate) && isEidoverseFrameMessage(
      { data: navigate.data, source: 'frame', origin: bridgeOrigin },
      { source: 'frame', origin: bridgeOrigin, nonce },
    ) && eidoverseNavigationTarget(navigate.data, LEGEND) === '/goals/list',
    JSON.stringify(navigate?.data));
  check('a stale session cannot navigate', Boolean(navigate) && !isEidoverseFrameMessage(
    { data: navigate.data, source: 'frame', origin: bridgeOrigin },
    { source: 'frame', origin: bridgeOrigin, nonce: 'retired-session' },
  ));
  check('an entity absent from the legend cannot navigate',
    Boolean(navigate) && eidoverseNavigationTarget({ ...navigate.data, entityId: 'unknown' }, LEGEND) === null);
  await open.tap();
  check('the same action is reachable by touch on a narrow viewport',
    await until(async () => (await page.evaluate(() => window.navigates().length)) === 2),
    String(await page.evaluate(() => window.navigates().length)));

  console.log('\n— E. label preference is browser-only, and rides the session —');
  const preference = () => panel().getByLabel('Object labels', { exact: true }).inputValue();
  const post = (message) => page.evaluate((value) => window.post(value), message);
  const plaques = () => renderer().evaluate(() => [...document.querySelectorAll('body > div > span')]
    .filter((element) => element.style.position === 'absolute' && element.style.display !== 'none').length);
  await renderer().evaluate(() => window.labelTick(performance.now() + 2000));
  check('nearby shows the authored plaques', await plaques() > 0, String(await plaques()));
  await post({ type: 'portos:label-preference', version: EIDOVERSE_FRAME_VERSION, nonce, labelVisibility: 'all-nearby' });
  check('all-nearby reaches the renderer', await until(async () => await preference() === 'all'), await preference());
  await post({ type: 'portos:label-preference', version: EIDOVERSE_FRAME_VERSION, nonce, labelVisibility: 'off' });
  const wentOff = await until(async () => await preference() === 'off');
  await renderer().evaluate(() => window.labelTick(performance.now() + 4000));
  check('off hides every floating plaque', wentOff && await plaques() === 0,
    `${await preference()} / ${await plaques()} plaques`);
  await select('pin');
  check('off still leaves selected-object details readable',
    /Entity: pin/.test(await panel().innerText()) && await open.count() === 1);

  console.log('\n— F. repeated refresh, and no world write —');
  await post({ type: 'portos:label-preference', version: EIDOVERSE_FRAME_VERSION, nonce, labelVisibility: 'nearby' });
  await until(async () => await preference() === 'nearby');
  await renderer().evaluate(() => window.labelTick(performance.now() + 6000));
  const before = await plaques();
  for (let round = 1; round <= 3; round += 1) {
    await renderer().evaluate((step) => window.labelTick(performance.now() + 6000 + step * 500), round);
  }
  const after = await plaques();
  check('a repeated refresh does not duplicate plaques', before > 0 && after === before, `${before} → ${after}`);
  const written = await renderer().evaluate(() => window.sent.slice());
  check('the whole exchange wrote no world verb',
    written.every((line) => !/"verb"/.test(line)), written.filter((line) => /"verb"/.test(line)).join(' | '));
  check('the browser reported no page error', pageErrors.length === 0, pageErrors.join(' | '));

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  return fail === 0 ? 0 : 1;
}

const code = await main().catch((error) => {
  console.error(`❌ acceptance run failed: ${error.message}`);
  return 1;
});
await closeAll();
process.exit(code);
