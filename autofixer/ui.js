import express from 'express';
import { spawn, exec as execCb } from 'child_process';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

const exec = promisify(execCb);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5560;

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
  const { stdout } = await exec('pm2 jlist').catch(() => ({ stdout: '[]' }));
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

// Serve main UI
app.get('/', async (req, res) => {
  const apps = await loadApps();
  const processes = [];

  // Build process options from registered apps
  for (const app of apps) {
    for (const proc of app.pm2ProcessNames || []) {
      processes.push({ name: proc, app: app.name });
    }
  }

  const processOptions = processes
    .map(p => `<option value="${p.name}">${p.name} (${p.app})</option>`)
    .join('\n');

  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PortOS Autofixer</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0f;
      color: #e0e0e0;
      min-height: 100vh;
    }

    /* Header — stacks vertically on mobile */
    header {
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      padding: 0.75rem 1rem;
      border-bottom: 1px solid #2a2a4a;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    h1 {
      font-size: 1.125rem;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    h1 span { font-size: 1.25rem; }

    .nav-links {
      display: flex;
      gap: 0.25rem;
    }

    .nav-links a {
      color: #888;
      text-decoration: none;
      font-size: 0.8125rem;
      padding: 0.5rem 0.75rem;
      border-radius: 0.5rem;
      transition: all 0.2s;
      min-height: 44px;
      display: flex;
      align-items: center;
    }

    .nav-links a:hover, .nav-links a.active {
      color: #fff;
      background: rgba(255,255,255,0.1);
    }

    /* Container — stacked on mobile, side-by-side on tablet+ */
    .container {
      display: flex;
      flex-direction: column;
      height: calc(100vh - 100px);
    }

    /* Sidebar — horizontal scrolling strip on mobile */
    .sidebar {
      background: #12121a;
      border-bottom: 1px solid #2a2a4a;
      padding: 0.75rem;
      overflow-x: auto;
      overflow-y: hidden;
      flex-shrink: 0;
    }

    .sidebar h2 {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: #666;
      margin-bottom: 0.5rem;
    }

    .process-list {
      display: flex;
      flex-direction: row;
      gap: 0.5rem;
    }

    .process-item {
      padding: 0.625rem 0.75rem;
      background: #1a1a2a;
      border-radius: 0.5rem;
      cursor: pointer;
      transition: all 0.2s;
      border: 1px solid transparent;
      min-height: 44px;
      min-width: 140px;
      flex-shrink: 0;
    }

    .process-item:hover {
      border-color: #3a3a5a;
    }

    .process-item.selected {
      border-color: #6366f1;
      background: #1e1e3a;
    }

    .process-name {
      font-weight: 500;
      font-size: 0.8125rem;
      white-space: nowrap;
    }

    .process-app {
      font-size: 0.6875rem;
      color: #666;
      margin-top: 0.125rem;
      white-space: nowrap;
    }

    .process-status {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 0.5rem;
    }

    .status-online { background: #22c55e; }
    .status-stopped { background: #6b7280; }
    .status-errored { background: #ef4444; }
    .status-unknown { background: #eab308; }

    .main-content {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
    }

    .toolbar {
      padding: 0.5rem 0.75rem;
      background: #12121a;
      border-bottom: 1px solid #2a2a4a;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.5rem;
    }

    .toolbar-left {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      min-width: 0;
    }

    .toolbar-title {
      font-weight: 500;
      font-size: 0.8125rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .toolbar-buttons {
      display: flex;
      gap: 0.375rem;
      flex-shrink: 0;
    }

    .toolbar button {
      padding: 0.5rem 0.75rem;
      background: #2a2a4a;
      color: #e0e0e0;
      border: none;
      border-radius: 0.375rem;
      cursor: pointer;
      font-size: 0.8125rem;
      transition: all 0.2s;
      min-height: 40px;
      min-width: 40px;
    }

    .toolbar button:hover {
      background: #3a3a5a;
    }

    .toolbar button.pause-active {
      background: #ef4444;
      color: white;
    }

    #logs {
      flex: 1;
      overflow-y: auto;
      padding: 0.75rem;
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 0.75rem;
      line-height: 1.5;
      background: #0a0a0f;
    }

    .log-line {
      padding: 0.125rem 0;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .log-line.error { color: #f87171; }
    .log-line.info { color: #a5f3fc; }

    .status-bar {
      padding: 0.5rem 0.75rem;
      background: #12121a;
      border-top: 1px solid #2a2a4a;
      font-size: 0.75rem;
      color: #666;
      display: flex;
      justify-content: space-between;
    }

    .status-indicator {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }

    .status-dot.connected { background: #22c55e; }
    .status-dot.disconnected { background: #ef4444; }

    .history-panel {
      display: none;
      overflow-y: auto;
      flex: 1;
      padding: 0.75rem;
    }

    .history-panel.active {
      display: block;
    }

    .history-item {
      padding: 0.75rem;
      background: #1a1a2a;
      border-radius: 0.5rem;
      margin-bottom: 0.5rem;
      cursor: pointer;
      transition: all 0.2s;
      min-height: 44px;
    }

    .history-item:hover {
      background: #1e1e3a;
    }

    .history-item .time {
      font-size: 0.75rem;
      color: #666;
    }

    .history-item .process {
      font-weight: 500;
      margin-top: 0.25rem;
      word-break: break-word;
    }

    .history-item .result {
      font-size: 0.75rem;
      margin-top: 0.25rem;
    }

    .history-item .result.success { color: #22c55e; }
    .history-item .result.failed { color: #ef4444; }

    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: #0a0a0f; }
    ::-webkit-scrollbar-thumb { background: #2a2a4a; border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: #3a3a5a; }

    /* Tablet and up (768px+) */
    @media (min-width: 768px) {
      header {
        flex-direction: row;
        justify-content: space-between;
        align-items: center;
        padding: 1rem 1.5rem;
      }

      h1 { font-size: 1.25rem; }
      h1 span { font-size: 1.5rem; }

      .nav-links { gap: 0.5rem; }

      .nav-links a {
        font-size: 0.875rem;
        padding: 0.5rem 1rem;
      }

      .container {
        flex-direction: row;
        height: calc(100vh - 60px);
      }

      .sidebar {
        width: 260px;
        border-right: 1px solid #2a2a4a;
        border-bottom: none;
        overflow-x: hidden;
        overflow-y: auto;
        padding: 1rem;
      }

      .process-list {
        flex-direction: column;
      }

      .process-item {
        min-width: unset;
      }

      .process-name {
        font-size: 0.875rem;
        white-space: normal;
      }

      .process-app {
        font-size: 0.75rem;
        white-space: normal;
      }

      .toolbar {
        padding: 0.75rem 1rem;
      }

      .toolbar-title { font-size: 0.875rem; }

      .toolbar button {
        padding: 0.5rem 1rem;
        font-size: 0.875rem;
      }

      #logs {
        padding: 1rem;
        font-size: 0.8125rem;
        line-height: 1.6;
      }

      .history-panel { padding: 1rem; }

      .history-item { padding: 1rem; }
    }

    /* Desktop (1024px+) */
    @media (min-width: 1024px) {
      .sidebar { width: 300px; }

      .nav-links { gap: 1rem; }
    }
  </style>
</head>
<body>
  <header>
    <h1><span>🔧</span> PortOS Autofixer</h1>
    <div class="nav-links">
      <a href="#" id="portosDashboardLink" target="_blank">PortOS Dashboard</a>
      <a href="#" class="active" id="logsTab">Logs</a>
      <a href="#" id="historyTab">History</a>
    </div>
  </header>

  <div class="container">
    <div class="sidebar">
      <h2>Processes</h2>
      <div class="process-list" id="processList">
        <!-- Populated by JS -->
      </div>
    </div>

    <div class="main-content">
      <div class="toolbar">
        <div class="toolbar-left">
          <span class="toolbar-title" id="currentProcess">Select a process</span>
        </div>
        <div class="toolbar-buttons">
          <button id="clearBtn">Clear</button>
          <button id="pauseBtn">Pause</button>
        </div>
      </div>

      <div id="logs"></div>

      <div id="historyPanel" class="history-panel">
        <!-- History items -->
      </div>

      <div class="status-bar">
        <div class="status-indicator">
          <div class="status-dot" id="statusDot"></div>
          <span id="statusText">Disconnected</span>
        </div>
        <span id="lineCount">0 lines</span>
      </div>
    </div>
  </div>

  <script>
    const processList = document.getElementById('processList');
    const logsContainer = document.getElementById('logs');
    const historyPanel = document.getElementById('historyPanel');
    const currentProcessEl = document.getElementById('currentProcess');
    const clearBtn = document.getElementById('clearBtn');
    const pauseBtn = document.getElementById('pauseBtn');
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const lineCount = document.getElementById('lineCount');
    const logsTab = document.getElementById('logsTab');
    const historyTab = document.getElementById('historyTab');

    let eventSource = null;
    let isPaused = false;
    let totalLines = 0;
    let autoScroll = true;
    let selectedProcess = null;
    let processStatuses = {};

    // Fetch PM2 status
    async function fetchStatus() {
      const res = await fetch('/api/status');
      const statuses = await res.json();
      processStatuses = {};
      statuses.forEach(s => { processStatuses[s.name] = s.status; });
      updateProcessList();
    }

    // Fetch apps and build process list
    async function fetchApps() {
      const res = await fetch('/api/apps');
      const apps = await res.json();

      const processes = [];
      apps.forEach(app => {
        (app.pm2ProcessNames || []).forEach(proc => {
          processes.push({ name: proc, app: app.name });
        });
      });

      window.processesList = processes;
      await fetchStatus();
    }

    function updateProcessList() {
      const processes = window.processesList || [];
      processList.innerHTML = processes.map(p => {
        const status = processStatuses[p.name] || 'unknown';
        const selected = selectedProcess === p.name ? 'selected' : '';
        return \`
          <div class="process-item \${selected}" data-name="\${p.name}">
            <div class="process-name">
              <span class="process-status status-\${status}"></span>
              \${p.name}
            </div>
            <div class="process-app">\${p.app}</div>
          </div>
        \`;
      }).join('');

      // Reattach click handlers
      document.querySelectorAll('.process-item').forEach(item => {
        item.addEventListener('click', () => {
          const name = item.dataset.name;
          selectProcess(name);
        });
      });
    }

    function selectProcess(name) {
      selectedProcess = name;
      currentProcessEl.textContent = name;
      logsContainer.innerHTML = '';
      totalLines = 0;
      lineCount.textContent = '0 lines';
      updateProcessList();
      connect();
    }

    function connect() {
      if (!selectedProcess) return;

      if (eventSource) {
        eventSource.close();
      }

      eventSource = new EventSource('/logs?process=' + selectedProcess);

      eventSource.onopen = () => {
        statusText.textContent = 'Connected';
        statusDot.className = 'status-dot connected';
      };

      eventSource.onmessage = (event) => {
        if (isPaused) return;

        const data = JSON.parse(event.data);

        if (data.type === 'log') {
          const logLine = document.createElement('div');
          logLine.className = 'log-line ' + (data.stream === 'err' ? 'error' : 'info');
          logLine.textContent = data.message;
          logsContainer.appendChild(logLine);

          totalLines++;
          lineCount.textContent = totalLines + ' lines';

          if (autoScroll) {
            logsContainer.scrollTop = logsContainer.scrollHeight;
          }

          while (logsContainer.children.length > 1000) {
            logsContainer.removeChild(logsContainer.firstChild);
          }
        }
      };

      eventSource.onerror = () => {
        statusText.textContent = 'Disconnected';
        statusDot.className = 'status-dot disconnected';
        eventSource.close();
        setTimeout(connect, 3000);
      };
    }

    async function fetchHistory() {
      const res = await fetch('/api/history');
      const history = await res.json();

      historyPanel.innerHTML = history.map(h => {
        const date = new Date(h.startTime).toLocaleString();
        const duration = Math.round(h.duration / 1000);
        return \`
          <div class="history-item">
            <div class="time">\${date} (\${duration}s)</div>
            <div class="process">\${h.processName} - \${h.appName || 'Unknown App'}</div>
            <div class="result \${h.success ? 'success' : 'failed'}">
              \${h.success ? 'Fixed successfully' : 'Fix failed'}
            </div>
          </div>
        \`;
      }).join('') || '<div style="padding:1rem;color:#666">No fix history yet</div>';
    }

    clearBtn.addEventListener('click', () => {
      logsContainer.innerHTML = '';
      totalLines = 0;
      lineCount.textContent = '0 lines';
    });

    pauseBtn.addEventListener('click', () => {
      isPaused = !isPaused;
      pauseBtn.textContent = isPaused ? 'Resume' : 'Pause';
      pauseBtn.classList.toggle('pause-active', isPaused);
    });

    logsContainer.addEventListener('scroll', () => {
      const isAtBottom = logsContainer.scrollHeight - logsContainer.scrollTop <= logsContainer.clientHeight + 50;
      autoScroll = isAtBottom;
    });

    logsTab.addEventListener('click', (e) => {
      e.preventDefault();
      logsTab.classList.add('active');
      historyTab.classList.remove('active');
      logsContainer.style.display = 'block';
      historyPanel.classList.remove('active');
    });

    historyTab.addEventListener('click', (e) => {
      e.preventDefault();
      historyTab.classList.add('active');
      logsTab.classList.remove('active');
      logsContainer.style.display = 'none';
      historyPanel.classList.add('active');
      fetchHistory();
    });

    // Set dynamic PortOS Dashboard link
    document.getElementById('portosDashboardLink').href =
      window.location.protocol + '//' + window.location.hostname + ':5555';

    // Initial load
    fetchApps();
    setInterval(fetchStatus, 10000);
  </script>
</body>
</html>
  `);
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

  // Get initial logs
  const initialLogsCmd = `pm2 logs ${processName} --lines 50 --nostream --raw`;

  exec(initialLogsCmd, (error, stdout) => {
    if (res.writableEnded) return;

    if (!error && stdout) {
      const lines = stdout.split('\n').filter(line => line.trim());
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

    // Stream new logs
    pm2Process = spawn('pm2', ['logs', processName, '--lines', '0', '--raw']);

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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Autofixer UI] Running on http://localhost:${PORT}`);
});

process.on('SIGINT', () => {
  console.log('\n[Autofixer UI] Shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[Autofixer UI] Shutting down...');
  process.exit(0);
});
