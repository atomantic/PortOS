/**
 * Proves the preview worker cannot send UDP, HTTP, WebSocket, or navigation
 * traffic, including from a fresh srcdoc realm (#11157).
 *
 * Constructor presence is not the proof. A loopback collector has to receive
 * the negative control (no jail, no Chrome network flags) and receive nothing
 * from the OS jail with those flags also absent. DNS is not a port-53 bind:
 * on macOS, getaddrinfo must fail inside the profile for a name that resolves
 * outside it, because mDNSResponder would send that query from outside the
 * jail. The file is not a browser-suite gate: hosts without Chrome and
 * Seatbelt or bubblewrap skip the browser proof, and previews fail closed.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSocket } from 'node:dgram';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { browserExecutablePath } from '../../lib/browserConfig.js';
import { _previewSeatbeltProfile } from '../../lib/generatedPreviewSandbox.js';
import { launchCompositionBrowser } from './ownedBrowser.js';

const seatbelt = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');

function runNode(scriptArgs, { jailed = false } = {}) {
  const command = jailed ? '/usr/bin/sandbox-exec' : process.execPath;
  const args = jailed
    ? ['-p', _previewSeatbeltProfile(), process.execPath, ...scriptArgs]
    : scriptArgs;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin:/usr/local/bin', TMPDIR: tmpdir() },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`probe timed out: ${stderr.slice(-400)}`));
    }, 8000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

const LOOKUP_SCRIPT = `
import dns from 'node:dns/promises';
const lookup = dns.lookup('example.com');
const timer = new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), 5000));
try {
  const found = await Promise.race([lookup, timer]);
  console.log('dns:' + found.address);
} catch (error) {
  console.log('dns-error:' + (error.code || 'fail'));
}
`;

describe.skipIf(!seatbelt)('seatbelt resolver denial', () => {
  it('lets getaddrinfo succeed outside the profile and fail inside it, without IP sockets', async () => {
    const open = await runNode(['--input-type=module', '-e', LOOKUP_SCRIPT]);
    expect(open.code, open.stderr).toBe(0);
    expect(open.stdout, 'outside lookup did not resolve, so an inside failure would not prove the deny').toMatch(/^dns:(?!error)/);

    const sock = join(tmpdir(), `portos-seatbelt-${process.pid}.sock`);
    const jailed = await runNode(['--input-type=module', '-e', `
${LOOKUP_SCRIPT}
import dgram from 'node:dgram';
import net from 'node:net';
import fs from 'node:fs';
const udp = await new Promise((resolve) => {
  const socket = dgram.createSocket('udp4');
  socket.once('error', (error) => resolve('udp:' + error.code));
  socket.send(Buffer.from('x'), 9, '127.0.0.1', (error) => {
    try { socket.close(); } catch { /* already closed */ }
    resolve(error ? 'udp:' + error.code : 'udp:sent');
  });
});
const unix = await new Promise((resolve) => {
  const server = net.createServer();
  server.once('error', (error) => resolve('unix:' + error.code));
  server.listen(${JSON.stringify(sock)}, () => {
    server.close();
    try { fs.unlinkSync(${JSON.stringify(sock)}); } catch { /* already gone */ }
    resolve('unix:bound');
  });
});
console.log(udp);
console.log(unix);
`], { jailed: true });
    expect(jailed.code, jailed.stderr).toBe(0);
    expect(jailed.stdout).toContain('dns-error:');
    expect(jailed.stdout).not.toMatch(/^dns:\d|^dns:[0-9a-f:]/m);
    expect(jailed.stdout).toContain('udp:EPERM');
    expect(jailed.stdout).toContain('unix:bound');
  }, 20000);
});

const chromePath = browserExecutablePath(null);
const jailPath = process.platform === 'darwin' ? '/usr/bin/sandbox-exec' : process.platform === 'linux' ? '/usr/bin/bwrap' : '';
const available = Boolean(jailPath) && existsSync(chromePath) && existsSync(jailPath);

const listen = (server) => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

async function collectors() {
  const packets = [];
  const udp = createSocket('udp4');
  await new Promise((resolve) => udp.bind(0, '127.0.0.1', resolve));
  udp.on('message', (msg) => packets.push(msg));
  const httpHits = [];
  const httpServer = createServer((req, res) => {
    httpHits.push(req.url);
    res.writeHead(204);
    res.end();
  });
  const httpPort = await listen(httpServer);
  const wsHits = [];
  const ws = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => ws.on('listening', resolve));
  ws.on('connection', () => wsHits.push('open'));
  return {
    packets, httpHits, wsHits,
    stunPort: udp.address().port,
    httpPort,
    wsPort: ws.address().port,
    async close() {
      udp.close();
      for (const client of ws.clients) client.terminate();
      ws.close();
      // Chrome keep-alive from the negative control must not outlive the browser.
      httpServer.closeAllConnections?.();
      await new Promise((resolve) => httpServer.close(resolve));
    },
  };
}

function attackHtml({ stunPort, httpPort, wsPort }) {
  const inner = `<!doctype html><script>
    window.__nativeRtc = typeof RTCPeerConnection === 'function'
      && Function.prototype.toString.call(RTCPeerConnection).includes('native code');
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${stunPort}' }] });
    pc.createDataChannel('leak');
    pc.createOffer().then((offer) => pc.setLocalDescription(offer));
    fetch('http://127.0.0.1:${httpPort}/fetch').catch(() => {});
    try { new WebSocket('ws://127.0.0.1:${wsPort}/'); } catch { /* refused */ }
    const img = new Image();
    img.src = 'http://127.0.0.1:${httpPort}/img';
    setTimeout(() => { location.assign('http://127.0.0.1:${httpPort}/nav'); }, 500);
  </script>`;
  return `<!doctype html><iframe srcdoc="${inner.replace(/"/g, '&quot;')}"></iframe>`;
}

function cdp(transport) {
  let next = 1;
  const pending = new Map();
  transport.on('message', (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message || 'CDP error'));
    else waiter.resolve(message.result || {});
  });
  return (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = next;
    next += 1;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP ${method} timed out`));
    }, 15000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    transport.send(JSON.stringify(payload));
  });
}

async function runAttack(isolation) {
  const sink = await collectors();
  let owner;
  try {
    owner = await launchCompositionBrowser({ isolation, startupMs: 20000 });
    const send = cdp(owner.transport);
    const created = await send('Target.createTarget', { url: 'about:blank' });
    const attached = await send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
    const tree = await send('Page.getFrameTree', {}, attached.sessionId);
    await send('Page.setDocumentContent', {
      frameId: tree.frameTree.frame.id,
      html: attackHtml(sink),
    }, attached.sessionId);
    const deadline = Date.now() + 8000;
    let observed = { state: 'pending' };
    while (Date.now() < deadline) {
      const evaluated = await send('Runtime.evaluate', {
        expression: `(() => {
          const frame = document.querySelector('iframe');
          if (!frame) return { state: 'no-frame' };
          try {
            const win = frame.contentWindow;
            if (!win || win.__nativeRtc === undefined) return { state: 'pending' };
            return { state: 'ready', native: win.__nativeRtc === true };
          } catch (error) {
            return { state: 'blocked', name: error.name };
          }
        })()`,
        returnByValue: true,
      }, attached.sessionId);
      observed = evaluated.result?.value || { state: 'empty' };
      if (observed.state === 'ready' || observed.state === 'blocked') break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // STUN, fetch, and the navigation timer need time after the script starts.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return {
      native: observed.state === 'ready' && observed.native === true,
      observed,
      udp: sink.packets.length,
      http: sink.httpHits.length,
      ws: sink.wsHits.length,
    };
  } finally {
    // Stop the browser before the collectors. An open keep-alive would make
    // http.Server.close wait until the test timeout.
    await owner?.close().catch(() => {});
    await sink.close();
  }
}

describe.skipIf(!available)('generated preview egress', () => {
  it('receives nested-srcdoc traffic without the jail and none through the OS deny', async () => {
    const open = await runAttack('off');
    expect(open.native, `fresh realm did not run native WebRTC (${JSON.stringify(open.observed)})`).toBe(true);
    expect(open.udp + open.http + open.ws, 'negative control received nothing, so a silent jail would not prove isolation').toBeGreaterThan(0);

    const jailed = await runAttack('os');
    expect(jailed.native, `jailed fresh realm did not run native WebRTC (${JSON.stringify(jailed.observed)})`).toBe(true);
    expect(jailed).toMatchObject({ udp: 0, http: 0, ws: 0 });

    const shipped = await runAttack('required');
    expect(shipped).toMatchObject({ udp: 0, http: 0, ws: 0 });
  }, 120000);
});
