import express from 'express';
import { spawn } from 'child_process';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { createTailscaleServers, watchCertReload } from '../lib/tailscale-https.js';
import { certPaths } from '../lib/certPaths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve PM2 binary to avoid pm2.cmd on Windows (creates visible CMD windows)
const require = createRequire(import.meta.url);
const PM2_BIN = join(dirname(require.resolve('pm2/package.json')), 'bin', 'pm2');

/** Execute a PM2 CLI command via node (bypasses pm2.cmd) */
function execPm2(pm2Args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PM2_BIN, ...pm2Args], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr || `pm2 exited with code ${code}`));
      resolve({ stdout, stderr });
    });
    child.on('error', reject);
  });
}

const app = express();
const PORT = process.env.PORT || 5560;

// UI markup lives in a sibling template file so this module stays mostly logic.
// The served document is fully static, so load it once at startup.
const UI_TEMPLATE_FILE = join(__dirname, 'ui.template.html');
const UI_HTML = await readFile(UI_TEMPLATE_FILE, 'utf8');

// Paths
const DATA_DIR = join(__dirname, '../data');
const APPS_FILE = join(DATA_DIR, 'apps.json');
const AUTOFIXER_DIR = join(DATA_DIR, 'autofixer');
const INDEX_FILE = join(AUTOFIXER_DIR, 'index.json');

// Load apps from PortOS
async function loadApps() {
  const data = await readFile(APPS_FILE, 'utf8').catch(() => '{"apps":{}}');
  const parsed = JSON.parse(data);
  return Object.entries(parsed.apps || {}).map(([id, app]) => ({ id, ...app }));
}

// Load autofixer history
async function loadHistory() {
  const data = await readFile(INDEX_FILE, 'utf8').catch(() => '[]');
  return JSON.parse(data);
}

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

// API: Get PM2 status
app.get('/api/status', async (req, res) => {
  const { stdout } = await execPm2(['jlist']).catch(() => ({ stdout: '[]' }));
  const stripped = stdout.replace(/\x1b\[[0-9;]*m/g, '');
  const jsonStart = stripped.indexOf('[');
  const jsonEnd = stripped.lastIndexOf(']');

  if (jsonStart < 0 || jsonEnd < 0) {
    return res.json([]);
  }

  const processes = JSON.parse(stripped.substring(jsonStart, jsonEnd + 1));
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

// Restrict sensitive mutation endpoints to localhost only
function requireLocalhost(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
    return next();
  }
  return res.status(403).json({ success: false, error: 'Forbidden: local access only' });
}

// API: Restart a PM2 process
app.post('/api/restart/:process', requireLocalhost, async (req, res) => {
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
app.post('/api/stop/:process', async (req, res) => {
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

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  res.write(`: connected\n\n`);

  let pm2Process = null;

  const cleanup = () => {
    if (pm2Process && !pm2Process.killed) {
      pm2Process.kill();
      pm2Process = null;
    }
  };

  req.on('close', cleanup);
  res.on('close', cleanup);

  // Get initial logs via node pm2/bin/pm2 (bypasses pm2.cmd on Windows)
  const initialChild = spawn(process.execPath, [PM2_BIN, 'logs', processName, '--lines', '50', '--nostream', '--raw'], { windowsHide: true });
  let initialStdout = '';
  initialChild.stdout.on('data', (d) => { initialStdout += d.toString(); });
  initialChild.on('close', () => {
    if (res.writableEnded) return;

    if (initialStdout) {
      const lines = initialStdout.split('\n').filter(line => line.trim());
      lines.forEach(line => {
        const event = {
          type: 'log',
          message: line,
          stream: 'out',
          timestamp: new Date().toISOString()
        };
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      });
    }

    // Stream new logs via node pm2/bin/pm2 (bypasses pm2.cmd on Windows)
    pm2Process = spawn(process.execPath, [PM2_BIN, 'logs', processName, '--lines', '0', '--raw'], { windowsHide: true });

    pm2Process.stdout.on('data', (data) => {
      if (res.writableEnded) {
        cleanup();
        return;
      }

      const lines = data.toString().split('\n').filter(line => line.trim());
      lines.forEach(line => {
        res.write(`data: ${JSON.stringify({
          type: 'log',
          message: line,
          stream: 'out',
          timestamp: new Date().toISOString()
        })}\n\n`);
      });
    });

    pm2Process.stderr.on('data', (data) => {
      if (res.writableEnded) {
        cleanup();
        return;
      }

      const lines = data.toString().split('\n').filter(line => line.trim());
      lines.forEach(line => {
        res.write(`data: ${JSON.stringify({
          type: 'log',
          message: line,
          stream: 'err',
          timestamp: new Date().toISOString()
        })}\n\n`);
      });
    });

    pm2Process.on('error', (error) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({
          type: 'log',
          message: `[ERROR] Failed to spawn pm2: ${error.message}`,
          stream: 'err',
          timestamp: new Date().toISOString()
        })}\n\n`);
      }
      cleanup();
    });

    pm2Process.on('exit', cleanup);
  });
});

// Serve HTTPS with the same Tailscale cert the main PortOS server uses when one
// is present, so the sidebar's `${window.location.protocol}//<host>:5560` link
// (which inherits https:// on a cert-enabled install) hits a matching listener.
// Falls back to plain HTTP when no cert is on disk.
const { dir: CERT_DIR } = certPaths(DATA_DIR);
const { server, httpsEnabled } = createTailscaleServers(app, { certDir: CERT_DIR, httpMirror: false });
const scheme = httpsEnabled ? 'https' : 'http';
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 [Autofixer UI] Running on ${scheme}://localhost:${PORT}`);
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
