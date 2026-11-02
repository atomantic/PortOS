import { Router } from 'express';
import { existsSync, realpathSync } from 'fs';
import { readFile, stat } from 'fs/promises';
import { join, resolve } from 'path';
import { exec } from '../lib/childProcess.js';
import { promisify } from 'util';
import { getListeningPorts, platform } from '../lib/platform.js';
import { listProcessesStrict } from '../services/pm2.js';
import { detectAppWithAi } from '../services/aiDetect.js';
import { requestHasHostControl } from '../services/authGate.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest, detectRepoBodySchema, detectPortBodySchema, detectPm2BodySchema, detectAiBodySchema } from '../lib/validation.js';
import { safeJSONParse, tryReadFile } from '../lib/fileUtils.js';
import { isWithinAllowedRoots, outsideAllowedRootsMessage, WORKSPACE_ROOTS_CONFIGURED } from '../lib/workspaceRoots.js';

const execAsync = promisify(exec);
const router = Router();

async function readListeningPortOutput(port, targetPlatform) {
  try {
    if (targetPlatform === 'win32') {
      const [ipv4, ipv6] = await Promise.all([
        execAsync('netstat -ano -p tcp'),
        execAsync('netstat -ano -p tcpv6')
      ]);
      return `${ipv4.stdout}\n${ipv6.stdout}`;
    }

    const command = targetPlatform === 'darwin'
      ? `lsof -iTCP:${port} -sTCP:LISTEN -n -P`
      : 'ss -lntp';
    return (await execAsync(command)).stdout;
  } catch (error) {
    // lsof reports exit code 1 without diagnostics when it finds no match.
    if (targetPlatform === 'darwin' && error.code === 1 && !String(error.stdout || '').trim() && !String(error.stderr || '').trim()) {
      return '';
    }
    throw new ServerError('Port listener discovery failed', { status: 503, code: 'PORT_DISCOVERY_FAILED', cause: error });
  }
}

// Optional confinement, shared by every handler here that takes a caller-supplied
// path (POST /repo and POST /ai): enforced only when the operator has configured
// PORTOS_WORKSPACE_ROOTS. realpath() first so a symlink can't smuggle a path past
// the containment check. realpathSync can throw on a permission/TOCTOU edge (the
// path deleted between an earlier stat and here) — reported as a refusal rather
// than leaking a 500. This is the sanctioned fs-edge-case exception to the
// no-try/catch rule (see commands.js).
//
// Returns { ok: true } or { ok: false, error, code } so each caller shapes the
// refusal its own way: /repo answers with its valid:false verdict (deciding
// "is this a usable repo?" is that route's whole product), while /ai — which has
// no such field, and where {success:false} could not be told apart from
// "provider unavailable" — throws a 400. The resolved path stays out of both,
// appearing only in the redacted server-side diagnostic.
const checkWorkspacePathAllowed = (path) => {
  if (!WORKSPACE_ROOTS_CONFIGURED) return { ok: true };

  let realPath;
  try {
    realPath = realpathSync(resolve(path));
  } catch {
    return { ok: false, error: 'Path is not accessible', code: 'PATH_NOT_ACCESSIBLE' };
  }

  if (!isWithinAllowedRoots(realPath)) {
    console.error(`❌ ${outsideAllowedRootsMessage(realPath)}`);
    return {
      ok: false,
      error: 'Path is outside the configured workspace roots (PORTOS_WORKSPACE_ROOTS)',
      code: 'PATH_OUTSIDE_WORKSPACE_ROOTS'
    };
  }

  return { ok: true };
};

// POST /api/detect/repo - Validate repo path and detect project type
//
// TRUST MODEL: This endpoint accepts an arbitrary, caller-supplied filesystem
// path and reads a small set of well-known project files under it (package.json
// scripts + name, project.yml, vite.config, and PORT/VITE_PORT lines from .env),
// returning their values verbatim. This is INTENTIONAL: PortOS is a single-user
// app on a private Tailscale network (see AGENTS.md "Security Model"), where the
// sole operator legitimately points the "import a repo" flow at any directory on
// their own machine — there is no second user to read data from, so no path
// confinement is required for safety.
//
// Operators who still want to confine detection to specific directories can set
// PORTOS_WORKSPACE_ROOTS (see `.env.example` for the format — the same allow-list
// `routes/commands.js` uses to scope command execution). When that env var is set,
// this route enforces the allow-list too — a path outside the roots returns valid:false
// rather than reading its files. When it is unset (the default), detection is
// unrestricted, matching the pre-existing behavior. POST /ai enforces the same
// allow-list via the shared `checkWorkspacePathAllowed` helper above.
router.post('/repo', asyncHandler(async (req, res) => {
  const { path } = validateRequest(detectRepoBodySchema, req.body);

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

  const confinement = checkWorkspacePathAllowed(path);
  if (!confinement.ok) {
    return res.json({ valid: false, error: confinement.error });
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
  const { port: safePort } = validateRequest(detectPortBodySchema, req.body);

  const result = {
    port: safePort,
    inUse: false,
    process: null
  };

  const targetPlatform = platform;
  const stdout = await readListeningPortOutput(safePort, targetPlatform);
  const listeners = await getListeningPorts({
    platform: targetPlatform,
    exec: async () => ({ stdout: stdout || '' })
  });
  result.inUse = listeners.includes(safePort);

  if (result.inUse) {
    for (const line of stdout.split('\n')) {
      if (targetPlatform === 'darwin') {
        const parts = line.trim().split(/\s+/);
        const portMatch = line.match(new RegExp(`:${safePort}\\s+\\(LISTEN\\)`));
        const pid = Number(parts[1]);
        if (portMatch && parts.length >= 2 && Number.isInteger(pid)) {
          result.process = { command: parts[0], pid };
          break;
        }
      } else if (targetPlatform === 'linux') {
        const localAddress = line.trim().split(/\s+/)[3] || '';
        const portMatch = new RegExp(`(?:\\*|\\[[^\\]]+\\]|[^\\s:]+):${safePort}$`).test(localAddress);
        const processMatch = line.match(/users:\(\(\"([^\"]+)\",pid=(\d+)/);
        if (/^LISTEN\b/.test(line.trim()) && portMatch && processMatch) {
          result.process = { command: processMatch[1], pid: Number(processMatch[2]) };
          break;
        }
      } else {
        const match = line.match(new RegExp(`^\\s*TCP(?:v6)?\\s+\\S+:${safePort}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'i'));
        if (match) {
          result.process = { pid: Number(match[1]) };
          break;
        }
      }
    }
  }

  res.json(result);
}));

// POST /api/detect/pm2 - Check if a PM2 process exists with given name
router.post('/pm2', asyncHandler(async (req, res) => {
  const { name } = validateRequest(detectPm2BodySchema, req.body);

  // `listProcessesStrict()` returns `null` when the PM2 read itself FAILED (vs
  // `[]` for a successful read with no processes) — the absent-vs-empty
  // contract from issue #968, now the one non-test owner of raw `pm2 jlist`
  // execution/parsing alongside `autofixer/shared.js` (#8164). `exists: false`
  // is reserved for a successful empty/no-match read; a failed read is a 503,
  // never a confident "process not found."
  const processes = await listProcessesStrict();
  if (processes === null) {
    throw new ServerError('PM2 process read failed', { status: 503, code: 'PM2_UNAVAILABLE' });
  }
  const found = processes.find(p => p.name === name);

  res.json({
    name,
    exists: !!found,
    process: found ? {
      name: found.name,
      status: found.status,
      pid: found.pid,
      pm_id: found.pm_id
    } : null
  });
}));

// POST /api/detect/ai - AI-powered app detection
// Unlike /repo this reads package.json, config files, .env port lines and the
// README, then ships them to a configured AI provider (possibly a hosted API) and
// runs that provider's CLI with cwd set here — so the confinement check must run
// BEFORE detectAppWithAi, or a refused path has already left the machine.
// A provider that cannot run tool-free needs host control (#9008): a remote
// caller on a password-free install gets 403 HOST_CONTROL_FORBIDDEN instead.
router.post('/ai', asyncHandler(async (req, res) => {
  const { path, providerId } = validateRequest(detectAiBodySchema, req.body);

  const confinement = checkWorkspacePathAllowed(path);
  if (!confinement.ok) {
    throw new ServerError(confinement.error, { status: 400, code: confinement.code });
  }

  const result = await detectAppWithAi(path, providerId, { hasHostControl: requestHasHostControl(req) });

  res.json(result);
}));

export default router;
