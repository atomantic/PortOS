import { Router } from 'express';
import { existsSync, realpathSync } from 'fs';
import { readFile, stat } from 'fs/promises';
import { join, resolve } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { execPm2 } from '../services/pm2.js';
import { detectAppWithAi } from '../services/aiDetect.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { safeJSONParse, tryReadFile } from '../lib/fileUtils.js';
import { isWithinAllowedRoots, WORKSPACE_ROOTS_CONFIGURED } from '../lib/workspaceRoots.js';

const execAsync = promisify(exec);
const router = Router();

// POST /api/detect/repo - Validate repo path and detect project type
//
// TRUST MODEL: This endpoint accepts an arbitrary, caller-supplied filesystem
// path and reads a small set of well-known project files under it (package.json
// scripts + name, project.yml, vite.config, and PORT/VITE_PORT lines from .env),
// returning their values verbatim. This is INTENTIONAL: PortOS is a single-user
// app on a private Tailscale network (see CLAUDE.md "Security Model"), where the
// sole operator legitimately points the "import a repo" flow at any directory on
// their own machine — there is no second user to read data from, so no path
// confinement is required for safety.
//
// Operators who still want to confine detection to specific directories can set
// PORTOS_WORKSPACE_ROOTS="/path1:/path2" (the same allow-list `routes/commands.js`
// uses to scope command execution). When that env var is set, this route enforces
// the allow-list too — a path outside the configured roots returns valid:false
// rather than reading its files. When it is unset (the default), detection is
// unrestricted, matching the pre-existing behavior.
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

  // Optional confinement: only when the operator has configured workspace roots.
  // realpath() first so a symlink can't smuggle a path past the containment check.
  // realpathSync can throw on a permission/TOCTOU edge (path deleted between the
  // stat above and here) — convert that to the same valid:false shape the rest of
  // this route returns for unusable paths, rather than leaking a 500. This is the
  // sanctioned fs-edge-case exception to the no-try/catch rule (see commands.js).
  if (WORKSPACE_ROOTS_CONFIGURED) {
    let realPath;
    try {
      realPath = realpathSync(resolve(path));
    } catch {
      return res.json({ valid: false, error: 'Path is not accessible' });
    }
    if (!isWithinAllowedRoots(realPath)) {
      return res.json({
        valid: false,
        error: 'Path is outside the configured workspace roots (PORTOS_WORKSPACE_ROOTS)'
      });
    }
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
    const content = await tryReadFile(packageJsonPath);
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

  // Check for iOS project (XcodeGen project.yml or .xcodeproj)
  if (existsSync(join(path, 'project.yml'))) {
    const ymlContent = await readFile(join(path, 'project.yml'), 'utf-8').catch(() => '');
    if (ymlContent.includes('platform: iOS') || ymlContent.includes("deploymentTarget:")) {
      result.type = 'ios-native';
      result.startCommands = ['open *.xcodeproj'];
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
  const safePort = parseInt(port, 10);
  if (!Number.isInteger(safePort) || safePort < 1 || safePort > 65535) {
    throw new ServerError(`Invalid port number: ${port}`, { status: 400 });
  }
  const command = process.platform === 'darwin'
    ? `lsof -i :${safePort} -P -n | grep LISTEN`
    : `ss -lntp | grep :${safePort}`;

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
