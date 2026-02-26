import { Router } from 'express';
import { existsSync } from 'fs';
import { readFile, stat } from 'fs/promises';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { execPm2 } from '../services/pm2.js';
import { detectAppWithAi } from '../services/aiDetect.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { safeJSONParse } from '../lib/fileUtils.js';

const execAsync = promisify(exec);
const router = Router();

// POST /api/detect/repo - Validate repo path and detect project type
router.post('/repo', asyncHandler(async (req, res) => {
  const { path } = req.body;

  if (!path) {
    throw new ServerError('Path is required', { status: 400, code: 'MISSING_PATH' });
  }

  // Check if path exists
  if (!existsSync(path)) {
    return res.json({
      valid: false,
      error: 'Path does not exist'
    });
  }

  // Check if it's a directory
  const stats = await stat(path);
  if (!stats.isDirectory()) {
    return res.json({
      valid: false,
      error: 'Path is not a directory'
    });
  }

  // Detect project type
  const result = {
    valid: true,
    path,
    type: 'unknown',
    hasPackageJson: false,
    hasGit: false,
    packageJson: null,
    detectedPorts: {},
    startCommands: []
  };

  // Check for package.json
  const packageJsonPath = join(path, 'package.json');
  if (existsSync(packageJsonPath)) {
    result.hasPackageJson = true;
    const content = await readFile(packageJsonPath, 'utf-8').catch(() => null);
    if (content) {
      const pkg = safeJSONParse(content, null);
      if (!pkg) {
        result.packageJson = null;
      } else {
        result.packageJson = {
          name: pkg.name,
          scripts: pkg.scripts || {}
        };

        // Detect type from dependencies/scripts
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.vite && deps.express) {
          result.type = 'vite+express';
        } else if (deps.vite || deps.react || deps.vue) {
          result.type = 'vite';
        } else if (deps.express || deps.fastify || deps.koa) {
          result.type = 'single-node-server';
        } else if (deps.next) {
          result.type = 'nextjs';
        }

        // Suggest start commands from scripts
        const scripts = pkg.scripts || {};
        if (scripts.dev) result.startCommands.push('npm run dev');
        if (scripts.start) result.startCommands.push('npm start');
        if (scripts.serve) result.startCommands.push('npm run serve');
      }
    }
  }

  // Check for .git
  if (existsSync(join(path, '.git'))) {
    result.hasGit = true;
  }

  // Check for .env and extract port info
  const envPath = join(path, '.env');
  if (existsSync(envPath)) {
    const envContent = await readFile(envPath, 'utf-8').catch(() => '');
    const portMatch = envContent.match(/PORT\s*=\s*(\d+)/i);
    if (portMatch) {
      result.detectedPorts.main = parseInt(portMatch[1], 10);
    }
    const vitePortMatch = envContent.match(/VITE_PORT\s*=\s*(\d+)/i);
    if (vitePortMatch) {
      result.detectedPorts.vite = parseInt(vitePortMatch[1], 10);
    }
  }

  // Check vite.config for port
  for (const configFile of ['vite.config.js', 'vite.config.ts']) {
    const configPath = join(path, configFile);
    if (existsSync(configPath)) {
      const content = await readFile(configPath, 'utf-8').catch(() => '');
      const portMatch = content.match(/port\s*:\s*(\d+)/);
      if (portMatch) {
        result.detectedPorts.vite = parseInt(portMatch[1], 10);
      }
    }
  }

  res.json(result);
}));

// POST /api/detect/port - Detect what process is running on a port
router.post('/port', asyncHandler(async (req, res) => {
  const { port } = req.body;

  if (!port || isNaN(port)) {
    throw new ServerError('Valid port number is required', { status: 400, code: 'INVALID_PORT' });
  }

  const result = {
    port: parseInt(port, 10),
    inUse: false,
    process: null
  };

  // Use lsof on macOS/Linux to find process
  const command = process.platform === 'darwin'
    ? `lsof -i :${port} -P -n | grep LISTEN`
    : `ss -lntp | grep :${port}`;

  const { stdout } = await execAsync(command, { windowsHide: true }).catch(() => ({ stdout: '' }));

  if (stdout.trim()) {
    result.inUse = true;

    // Parse lsof output: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
    const lines = stdout.trim().split('\n');
    if (lines.length > 0) {
      const parts = lines[0].split(/\s+/);
      if (process.platform === 'darwin' && parts.length >= 2) {
        result.process = {
          command: parts[0],
          pid: parseInt(parts[1], 10)
        };
      }
    }
  }

  res.json(result);
}));

// POST /api/detect/pm2 - Check if a PM2 process exists with given name
router.post('/pm2', asyncHandler(async (req, res) => {
  const { name } = req.body;

  if (!name) {
    throw new ServerError('Process name is required', { status: 400, code: 'MISSING_NAME' });
  }

  const { stdout } = await execPm2(['jlist']).catch(() => ({ stdout: '[]' }));
  const processes = safeJSONParse(stdout, []);
  const found = processes.find(p => p.name === name);

  res.json({
    name,
    exists: !!found,
    process: found ? {
      name: found.name,
      status: found.pm2_env?.status,
      pid: found.pid,
      pm_id: found.pm_id
    } : null
  });
}));

// POST /api/detect/ai - AI-powered app detection
router.post('/ai', asyncHandler(async (req, res) => {
  const { path, providerId } = req.body;

  if (!path) {
    throw new ServerError('Path is required', { status: 400, code: 'MISSING_PATH' });
  }

  const result = await detectAppWithAi(path, providerId).catch(err => ({
    success: false,
    error: err.message
  }));

  res.json(result);
}));

export default router;
