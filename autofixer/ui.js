import express from 'express';
import { spawn } from 'child_process';
import { waitForChild } from './childProcess.js';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createTailscaleServers, watchCertReload } from '../lib/tailscale-https.js';
import { certPaths } from '../lib/certPaths.js';
import { createSidecarAuthGate } from '../lib/sidecarAuthGate.js';
import { isPm2ProcessName } from '../lib/pm2ProcessName.js';
import { createStagedFixStore } from './stagedFixes.js';
import { PM2_BIN, execPm2, listProcessesStrict, DATA_DIR, AUTOFIXER_DIR, INDEX_FILE, loadApps } from './shared.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5560;

// UI markup lives in a sibling template file so this module stays mostly logic.
// The served document is fully static, so load it once at startup.
const UI_TEMPLATE_FILE = join(__dirname, 'ui.template.html');
const UI_HTML = await readFile(UI_TEMPLATE_FILE, 'utf8');

const stagedFixes = createStagedFixStore({ root: AUTOFIXER_DIR, loadApps, execPm2 });

async function loadHistory() {
  const data = await readFile(INDEX_FILE, 'utf8').catch(() => '[]');
  return stagedFixes.decorateHistory(JSON.parse(data));
}

// Reads honour the optional instance password. Process mutations additionally
// require an operator session, or a genuine local connection without a password.
// Reachability on the private network does not grant host-control authority.
// `/` serves the static shell, which renders its own login overlay driven by
// GET /api/auth/status — it carries no data, so it stays publicly reachable.
const auth = createSidecarAuthGate({
  dataDir: DATA_DIR,
  cookieName: 'portos_autofixer_auth',
  publicPaths: ['/'],
});

// The gate is mounted BEFORE the auth routes so its cross-origin (CSRF) check
// covers them too — `publicPaths` is what lets them through, not route order.
app.use(express.json({ limit: '16kb' }));
app.use(auth.gate);
app.get('/api/auth/status', auth.handleStatus);
app.post('/api/auth/login', auth.handleLogin);
app.post('/api/auth/logout', auth.handleLogout);

// API: Get registered apps and their processes
app.get('/api/apps', async (req, res) => {
  const apps = await loadApps();
  res.json(apps);
});

// API: Get autofixer history
app.get('/api/history', async (req, res) => {
  const history = await loadHistory();
  res.json(history);
});

// Staged patches are data on reads; applying/discarding requires host authority.
app.get('/api/fixes/:session', async (req, res) => {
  const result = await stagedFixes.read(req.params.session);
  res.status(result.status || 200).json(result);
});
for (const action of ['apply', 'discard']) {
  app.post(`/api/fixes/:session/${action}`, auth.requireHostControl, async (req, res) => {
    const result = await stagedFixes.mutate(req.params.session, action);
    res.status(result.status || 200).json(result);
  });
}

// API: Get PM2 status
//
// `listProcessesStrict()` returns `null` when the read itself FAILED (vs `[]`
// for a successful read with no processes) — the absent-vs-empty contract
// from issue #968, shared with `server/services/pm2.js` (#8164). A failed
// read answers 503 rather than an empty array, so the dashboard doesn't
// render "no processes" when PM2 was simply unreachable; the client handles
// this status without breaking on `.forEach`.
app.get('/api/status', async (req, res) => {
  const processes = await listProcessesStrict();

  if (processes === null) {
    return res.status(503).json({ error: 'PM2 process read failed', code: 'PM2_UNAVAILABLE' });
  }

  res.json(processes.map(p => ({
    name: p.name,
    status: p.pm2_env?.status,
    pid: p.pid,
    restarts: p.pm2_env?.restart_time,
    uptime: p.pm2_env?.pm_uptime,
    memory: p.monit?.memory,
    cpu: p.monit?.cpu
  })));
});

// Validate process name against registered apps to prevent command injection
async function isRegisteredProcess(processName) {
  const apps = await loadApps();
  return apps.some(app => (app.pm2ProcessNames || []).includes(processName));
}

// API: Restart a PM2 process
app.post('/api/restart/:process', auth.requireHostControl, async (req, res) => {
  const processName = req.params.process;
  if (!(await isRegisteredProcess(processName))) {
    return res.status(400).json({ success: false, error: 'Unknown process' });
  }
  console.log(`🔄 [Autofixer UI] Restarting process: ${processName}`);
  const { stdout, stderr } = await execPm2(['restart', processName]).catch(err => ({
    stdout: '',
    stderr: err.message
  }));
  if (stderr && !stdout) {
    console.error(`❌ [Autofixer UI] Restart failed for ${processName}: ${stderr}`);
    return res.status(500).json({ success: false, error: stderr });
  }
  console.log(`✅ [Autofixer UI] Restarted ${processName}`);
  res.json({ success: true });
});

// API: Stop a PM2 process
app.post('/api/stop/:process', auth.requireHostControl, async (req, res) => {
  const processName = req.params.process;
  if (!(await isRegisteredProcess(processName))) {
    return res.status(400).json({ success: false, error: 'Unknown process' });
  }
  console.log(`⏹️ [Autofixer UI] Stopping process: ${processName}`);
  const { stdout, stderr } = await execPm2(['stop', processName]).catch(err => ({
    stdout: '',
    stderr: err.message
  }));
  if (stderr && !stdout) {
    console.error(`❌ [Autofixer UI] Stop failed for ${processName}: ${stderr}`);
    return res.status(500).json({ success: false, error: stderr });
  }
  console.log(`✅ [Autofixer UI] Stopped ${processName}`);
  res.json({ success: true });
});

// Serve main UI — the process list is populated client-side via /api/apps,
// so this route just returns the static document loaded at startup.
app.get('/', (req, res) => {
  res.send(UI_HTML);
});

// Server-Sent Events endpoint for streaming logs
app.get('/logs', async (req, res) => {
  const processName = req.query.process || 'portos-autofixer';
  if (!isPm2ProcessName(processName)) {
    return res.status(400).json({ error: 'Invalid process name', code: 'INVALID_PROCESS_NAME' });
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.write(`: connected\n\n`);

  const controller = new AbortController();
  const closed = () => controller.signal.aborted || req.aborted || res.destroyed || res.writableEnded;
  const cleanup = () => controller.abort();
  req.on('aborted', cleanup);
  res.on('close', cleanup);
  const send = (data, stream = 'out') => {
    if (closed()) return;
    try {
      for (const message of data.toString().split('\n').filter(line => line.trim())) {
        res.write(`data: ${JSON.stringify({ type: 'log', message, stream, timestamp: new Date().toISOString() })}\n\n`);
      }
    } catch (error) {
      console.error(`❌ [Autofixer UI] Log stream write failed: ${error.message}`);
      cleanup();
    }
  };
  let streamChild;
  let onStdout;
  let onStderr;
  try {
    if (closed()) return;
    const initialChild = spawn(process.execPath, [PM2_BIN, 'logs', processName, '--lines', '50', '--nostream', '--raw'], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const initial = await waitForChild(initialChild, { signal: controller.signal });
    if (closed()) return;
    if (initial.error || initial.timedOut || initial.code !== 0) {
      send(`[ERROR] Failed to read pm2 logs: ${initial.error?.message || (initial.timedOut ? 'command timed out' : initial.stderr || `exit ${initial.code}`)}`, 'err');
      return;
    }
    send(initial.stdout);
    if (closed()) return;
    streamChild = spawn(process.execPath, [PM2_BIN, 'logs', processName, '--lines', '0', '--raw'], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    onStdout = data => send(data);
    onStderr = data => send(data, 'err');
    streamChild.stdout.on('data', onStdout);
    streamChild.stderr.on('data', onStderr);
    const result = await waitForChild(streamChild, { signal: controller.signal, timeoutMs: null, capture: false });
    if (result.error) send(`[ERROR] Failed to spawn pm2: ${result.error.message}`, 'err');
  } catch (error) {
    send(`[ERROR] Failed to spawn pm2: ${error.message}`, 'err');
  } finally {
    if (streamChild) {
      streamChild.stdout.removeListener('data', onStdout);
      streamChild.stderr.removeListener('data', onStderr);
    }
    req.removeListener('aborted', cleanup);
    res.removeListener('close', cleanup);
    if (!closed()) res.end();
  }
});

// Registry failures reach every consumer (apps, process controls and staged
// fixes) through Express's error boundary, before any mutation can run.
app.use((error, req, res, next) => {
  if (error.code !== 'APPS_UNAVAILABLE') return next(error);
  console.error(`❌ [Autofixer UI] App registry unavailable`);
  res.status(503).json({ error: 'App registry unavailable', code: 'APPS_UNAVAILABLE' });
});

// Serve HTTPS with the same Tailscale cert the main PortOS server uses when one
// is present, so the sidebar's `${window.location.protocol}//<host>:5560` link
// (which inherits https:// on a cert-enabled install) hits a matching listener.
// Falls back to plain HTTP when no cert is on disk.
const { dir: CERT_DIR } = certPaths(DATA_DIR);
const { server, httpsEnabled } = createTailscaleServers(app, { certDir: CERT_DIR, httpMirror: false });
const scheme = httpsEnabled ? 'https' : 'http';
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`🚀 [Autofixer UI] Running on ${scheme}://localhost:${PORT}`);
  const gated = await auth.isEnabled().catch(() => true);
  console.log(`🔐 [Autofixer UI] Password gate ${gated ? 'ENABLED (PortOS password required)' : 'off (no PortOS password set)'}`);
});
if (httpsEnabled) watchCertReload(server, CERT_DIR);

process.on('SIGINT', () => {
  console.log(`\n🛑 [Autofixer UI] Shutting down...`);
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log(`\n🛑 [Autofixer UI] Shutting down...`);
  process.exit(0);
});
