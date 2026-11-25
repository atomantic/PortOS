import { readFile, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename, dirname } from 'path';
import { discoverEcosystemConfig, planEcosystemPortEdits } from '../lib/ecosystemPortEdits.js';
import { listProcessesStrict } from './pm2.js';
import { safeJSONParse, tryReadFile, atomicWrite } from '../lib/fileUtils.js';
import { parseEnvContents } from '../lib/portosEnv.js';
import { detectAppIcon } from './appIconDetect.js';
import { NON_PM2_TYPES, usesPm2, DESKTOP_TYPES, isDesktopType } from './appProcessTypes.js';
export { NON_PM2_TYPES, usesPm2, DESKTOP_TYPES, isDesktopType };

/**
 * Language markers, checked FIRST: a repo's LANGUAGE beats its packaging, so a
 * Python service that also ships a `Dockerfile` classifies as `python` (the
 * common case) rather than as a Docker stack.
 */
const LANGUAGE_MARKERS = [
  ['python', ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile']],
  ['go', ['go.mod']]
];

/** Compose/Dockerfile markers — only reached when no language marker matched. */
const DOCKER_MARKERS = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml', 'Dockerfile'];

/**
 * Node entry points meaning "a process runs here". Checked BEFORE the docker
 * and static rules, and mapped to *no* classification rather than to a type: a
 * package-less repo shipping `server.mjs` is a Node app someone containerized
 * (or that also serves a page), and classifying it `docker`/`static` would
 * withdraw standardization from an app that genuinely wants it — the exact
 * false negative this predicate exists to avoid.
 *
 * The basename list is deliberately just `server`, the one name that can only
 * mean a server. `index`, `app`, and `main` are all at least as common as
 * browser scripts loaded by an `index.html`, and treating those as evidence
 * would leave real static sites unclassified (and still offered the Node
 * standardizer) — trading this rule's false negative for the very false
 * positive the issue was filed about.
 */
const SERVER_ENTRY_BASENAMES = ['server'];
const SERVER_ENTRY_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts'];

const hasNodeServerEntry = (present) =>
  // ECOSYSTEM_CONFIG_FILENAMES (below) is the one list of PM2 config names — a
  // repo carrying one is unambiguously a PM2-managed process app.
  ECOSYSTEM_CONFIG_FILENAMES.some(name => present.has(name)) ||
  SERVER_ENTRY_BASENAMES.some(base => SERVER_ENTRY_EXTENSIONS.some(ext => present.has(`${base}${ext}`)));

/** The non-Node app types `classifyNonNodeType` can emit. */
export const NON_NODE_TYPES = new Set([...LANGUAGE_MARKERS.map(([type]) => type), 'docker', 'static']);

/**
 * Classify a repo's runtime from its top-level filenames, for repos that
 * carried no Node or Apple signal. Returns `null` when nothing matched — the
 * caller keeps `unknown` rather than guessing.
 *
 * @param {string[]} files Top-level entry names (from `readdir`).
 * @returns {'python'|'go'|'docker'|'static'|null}
 */
export function classifyNonNodeType(files) {
  const present = new Set(files || []);
  for (const [type, markers] of LANGUAGE_MARKERS) {
    if (markers.some(marker => present.has(marker))) return type;
  }
  if (hasNodeServerEntry(present)) return null;
  if (DOCKER_MARKERS.some(marker => present.has(marker))) return 'docker';
  if (present.has('index.html')) return 'static';
  return null;
}

/**
 * App types the PM2 standardizer must REFUSE: the Apple types (never PM2 at
 * all) plus the non-Node runtimes above. The standardizer's prompt opens with
 * "You are analyzing a Node.js application" — on a Python/Go/Docker/static repo
 * it doesn't fail, it confidently writes a Node ecosystem config into someone
 * else's project. That is what this predicate exists to stop.
 *
 * It is a DENY list rather than an allowlist of Node types because `type` is a
 * free-form string (`appSchema` in `server/lib/appValidation.js` defaults it to
 * `express` and accepts any value) PERSISTED on the app record. Installs
 * upgrade on their own schedule, so app records in the wild carry values this
 * file has never heard of — `unknown` from before this classification existed,
 * `node`/`react`/`web` from older detection, whatever a user typed. An
 * allowlist would silently withdraw standardization from every one of them.
 * Only a type we have positively identified as non-Node is refused; anything
 * unrecognized degrades to the previous behavior (offer it, and let the user
 * decide) instead of a button that quietly disappears on upgrade.
 */
export const NON_STANDARDIZABLE_TYPES = new Set([...NON_PM2_TYPES, ...NON_NODE_TYPES]);

/** Whether the PM2 standardizer (which writes a NODE ecosystem config) applies. */
export const isStandardizable = (type) => !NON_STANDARDIZABLE_TYPES.has(type);

/**
 * Detect an optional native Godot launch target alongside the repo's normal
 * web-process configuration.
 *
 * Mixed repos keep their ecosystem/Vite ports as the standard browser Launch,
 * while this target opens the game through a separate autorestart-off process.
 */
export function detectGodotNativeLaunch(dirPath) {
  const launcherPath = join(dirPath, 'scripts', 'game');
  const hasLauncher = existsSync(launcherPath);
  let projectPath = null;
  if (existsSync(join(dirPath, 'project.godot'))) {
    projectPath = 'project.godot';
  } else if (hasLauncher && existsSync(join(dirPath, 'game', 'project.godot'))) {
    projectPath = join('game', 'project.godot');
  }
  if (!projectPath) return null;

  const projectDir = dirname(projectPath);
  const slug = basename(dirPath)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  return {
    label: 'Godot',
    command: hasLauncher
      ? './scripts/game run'
      : `godot --path ${projectDir === '.' ? '.' : projectDir}`,
    processName: `${slug || 'godot'}-game`
  };
}

/**
 * Ecosystem config filenames in the order they're resolved. The READER
 * (parseEcosystemFromPath) and the WRITER (writeEcosystemPorts) must agree on
 * this order: if a repo has both, the writer has to rewrite the same file the
 * reader derives ports from, or a port edit lands in a file detection ignores
 * and silently reverts on the next refresh.
 */
const ECOSYSTEM_CONFIG_FILENAMES = ['ecosystem.config.js', 'ecosystem.config.cjs'];

/**
 * Parse ecosystem.config.js/cjs to extract all processes with their ports.
 * One non-executing AST parse serves discovery and the writers' editability
 * verdict; see `discoverEcosystemConfig`.
 * @returns {{ processes: Array, pm2Home: string|null, portsEditable: boolean }}
 */
export function parseEcosystemConfig(content) {
  return discoverEcosystemConfig(content);
}

/**
 * Extract port from vite.config.js/ts content
 */
function extractVitePort(content) {
  const portMatch = content.match(/port\s*:\s*(\d+)/);
  return portMatch ? parseInt(portMatch[1], 10) : null;
}

/** vite config filenames probed inside a PM2 process's `cwd`, in probe order. */
const VITE_CONFIG_FILENAMES = ['vite.config.ts', 'vite.config.js'];

/**
 * Resolve the dev-server port for a single parsed PM2 process by reading the
 * vite config in its `cwd`, relative to the app root `dirPath`.
 *
 * Only applies to a process that runs Vite and carries no port of its own — any
 * other process resolves to `null` so callers can assign unconditionally. The
 * first config file that yields a port wins; an unreadable file is treated as
 * empty (no port) and the next candidate is probed.
 *
 * @param {string} dirPath - app root the process's `cwd` is relative to
 * @param {{ usesVite?: boolean, port?: number|null, cwd?: string }} proc
 * @returns {Promise<number|null>} the resolved port, or null when none applies
 */
export async function resolveViteConfigPortForProcess(dirPath, proc) {
  if (!proc?.usesVite || proc.port || !proc.cwd) return null;
  const cwdPath = join(dirPath, proc.cwd);
  for (const viteConfig of VITE_CONFIG_FILENAMES) {
    const viteConfigPath = join(cwdPath, viteConfig);
    if (!existsSync(viteConfigPath)) continue;
    const viteContent = await readFile(viteConfigPath, 'utf-8').catch(() => '');
    const port = extractVitePort(viteContent);
    if (port) return port;
  }
  return null;
}

/**
 * Parse ecosystem config from a directory path (non-streaming, for refresh)
 * Also checks vite.config files in subdirectories for processes that use Vite
 * @returns {{ processes: Array, pm2Home: string|null }}
 */
export async function parseEcosystemFromPath(dirPath) {
  for (const ecosystemFile of ECOSYSTEM_CONFIG_FILENAMES) {
    const ecosystemPath = join(dirPath, ecosystemFile);
    if (existsSync(ecosystemPath)) {
      const content = await readFile(ecosystemPath, 'utf-8');
      const { processes, pm2Home, portsEditable } = parseEcosystemConfig(content);

      // For processes that use vite and don't have a port, check their cwd for vite.config
      for (const proc of processes) {
        const vitePort = await resolveViteConfigPortForProcess(dirPath, proc);
        if (vitePort) proc.port = vitePort;
        // Clean up internal properties before returning
        delete proc.cwd;
        delete proc.usesVite;
      }

      return { processes, pm2Home, portsEditable };
    }
  }
  return { processes: [], pm2Home: null };
}

export async function writeEcosystemPorts(repoPath, remap) {
  const { file, changed } = await writeEcosystemPortEdits(repoPath, remap, []);
  return { file, changed };
}

/** Plan every requested process/label against one original snapshot, then write once. */
export async function writeEcosystemPortEdits(repoPath, remap, edits) {
  for (const name of ECOSYSTEM_CONFIG_FILENAMES) {
    const filePath = join(repoPath, name);
    if (!existsSync(filePath)) continue;
    const content = await readFile(filePath, 'utf-8');
    const { content: updated, ...result } = planEcosystemPortEdits(content, remap, edits);
    const changed = updated !== content;
    if (changed) await atomicWrite(filePath, updated);
    return { file: name, changed, ...result };
  }
  return { file: null, changed: false, remapApplied: false, applied: [], unapplied: edits || [] };
}

// Each detection step mutates the shared `result` and emits its own `detect:step`
// frames. A step returning `false` means the stream must stop (validate only).

async function validateStep(socket, dirPath, result, emit) {
  emit('validate', 'running', { message: 'Validating directory path...' });

  const fail = (message) => {
    emit('validate', 'error', { message });
    socket.emit('detect:complete', { success: false, error: message });
    return false;
  };

  if (!existsSync(dirPath)) return fail('Directory does not exist');
  const stats = await stat(dirPath);
  if (!stats.isDirectory()) return fail('Path is not a directory');

  emit('validate', 'done', { message: 'Valid directory' });
  result.name = basename(dirPath);
  return true;
}

/** XcodeGen `project.yml`: name, platform-derived type, and build command. */
async function applyXcodeGenProject(dirPath, result) {
  const ymlContent = await readFile(join(dirPath, 'project.yml'), 'utf-8').catch(() => '');
  const nameMatch = ymlContent.match(/^name:\s*(.+)$/m);
  if (nameMatch) result.name = nameMatch[1].trim();

  const platformMatch = ymlContent.match(/platform:\s*\[?([^\]\n]+)/);
  const platforms = platformMatch ? platformMatch[1].toLowerCase() : '';
  if (platforms.includes('ios') && !platforms.includes('macos')) result.type = 'ios-native';
  else if (platforms.includes('macos') && !platforms.includes('ios')) result.type = 'macos-native';
  else result.type = 'xcode';

  result.buildCommand = 'xcodebuild -scheme ' + result.name + ' build';
}

/** Swift/Xcode projects are recognized from directory contents alone. */
async function detectSwiftProject(dirPath, files, result) {
  const hasXcodeproj = files.some(f => f.endsWith('.xcodeproj') || f.endsWith('.xcworkspace'));
  const hasProjectYml = files.includes('project.yml');
  const hasPackageSwift = files.includes('Package.swift');
  if (!hasXcodeproj && !hasProjectYml && !hasPackageSwift) return;

  if (hasProjectYml) {
    await applyXcodeGenProject(dirPath, result);
  } else if (hasPackageSwift) {
    result.type = 'swift';
    result.buildCommand = 'swift build';
  } else {
    // .xcodeproj without project.yml
    const xcodeprojDir = files.find(f => f.endsWith('.xcodeproj'));
    const schemeName = xcodeprojDir?.replace('.xcodeproj', '') || result.name;
    result.type = 'xcode';
    result.buildCommand = 'xcodebuild -scheme ' + schemeName + ' build';
  }

  result.startCommands = [];
  result.pm2ProcessNames = [];
  result.editorCommand = process.platform === 'darwin' ? 'xed .' : 'code .';
}

/** Returns the directory entry names so later steps can reuse them. */
async function filesStep(dirPath, result, emit) {
  emit('files', 'running', { message: 'Scanning directory...' });
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
  const files = entries.map(e => e.name);
  emit('files', 'done', { message: `Found ${files.length} files`, files: files.slice(0, 20) });
  await detectSwiftProject(dirPath, files, result);
  return files;
}

function applyPackageJson(pkg, result) {
  result.name = pkg.name || result.name;
  result.description = pkg.description || '';

  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps.vite && deps.express) result.type = 'vite+express';
  else if (deps.vite || deps.react || deps.vue) result.type = 'vite';
  else if (deps.express || deps.fastify || deps.koa) result.type = 'single-node-server';
  else if (deps.next) result.type = 'nextjs';

  const scripts = pkg.scripts || {};
  if (scripts.dev) result.startCommands.push('npm run dev');
  if (scripts.start && !scripts.dev) result.startCommands.push('npm start');
  if (scripts.build) result.buildCommand = 'npm run build';
}

async function packageStep(dirPath, files, result, emit) {
  emit('package', 'running', { message: 'Reading package.json...' });
  const pkgPath = join(dirPath, 'package.json');

  if (!existsSync(pkgPath)) {
    // No package.json ⇒ nothing Node owns this repo, so fall back to marker-file
    // classification for the common non-Node runtimes. Without this, a Python
    // service / Go binary / Docker stack / static site all landed on `unknown`
    // and were offered Node PM2 standardization. Guarded on `unknown` so an
    // Apple type already resolved in the files step (a Swift repo that also ships a
    // Dockerfile) isn't overwritten.
    const nonNodeType = result.type === 'unknown' ? classifyNonNodeType(files) : null;
    if (nonNodeType) result.type = nonNodeType;
    emit('package', 'done', {
      message: nonNodeType ? `No package.json — detected ${nonNodeType} project` : 'No package.json found',
      type: result.type
    });
    return;
  }

  const content = await tryReadFile(pkgPath);
  if (!content) return;
  const pkg = safeJSONParse(content, null);
  if (!pkg) {
    emit('package', 'error', { message: 'Invalid package.json format' });
    return;
  }
  applyPackageJson(pkg, result);
  emit('package', 'done', {
    message: `Found: ${result.name}`,
    name: result.name,
    description: result.description,
    type: result.type,
    startCommands: result.startCommands
  });
}

async function applyEnvPorts(dirPath, result, configFiles) {
  const envPath = join(dirPath, '.env');
  if (!existsSync(envPath)) return;
  const content = await readFile(envPath, 'utf-8').catch(() => '');
  const env = parseEnvContents(content);
  const readTcpPort = (key) => {
    const value = env.get(key);
    if (value === undefined || !/^\d+$/.test(value)) return null;
    const port = Number(value);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
  };
  const apiPort = readTcpPort('PORT');
  if (apiPort !== null) result.apiPort = apiPort;
  const devUiPort = readTcpPort('VITE_PORT');
  if (devUiPort !== null) result.devUiPort = devUiPort;
  configFiles.push('.env');
}

async function applyViteConfigPorts(dirPath, result, configFiles) {
  for (const viteConfig of ['vite.config.js', 'vite.config.ts']) {
    const configPath = join(dirPath, viteConfig);
    if (!existsSync(configPath)) continue;
    const content = await readFile(configPath, 'utf-8').catch(() => '');
    const portMatch = content.match(/port\s*:\s*(\d+)/);
    if (portMatch) result.devUiPort = parseInt(portMatch[1], 10);
    configFiles.push(viteConfig);
  }
}

/** Fold the parsed ecosystem processes into `result`, deriving any unset ports. */
async function applyParsedProcesses(dirPath, parsedProcesses, result) {
  // For processes that use vite and don't have a port, check their cwd for vite.config
  for (const proc of parsedProcesses) {
    const vitePort = await resolveViteConfigPortForProcess(dirPath, proc);
    if (vitePort) proc.port = vitePort;
    // Clean up internal properties
    delete proc.cwd;
    delete proc.usesVite;
  }

  result.processes = parsedProcesses;
  result.pm2ProcessNames = parsedProcesses.map(p => p.name);

  const apiProc = parsedProcesses.find(p => p.ports?.api);
  if (apiProc && !result.apiPort) result.apiPort = apiProc.ports.api;
  const uiProc = parsedProcesses.find(p => p.ports?.ui);
  if (uiProc && !result.uiPort) result.uiPort = uiProc.ports.ui;
  const devUiProc = parsedProcesses.find(p => p.ports?.devUi);
  if (devUiProc && !result.devUiPort) result.devUiPort = devUiProc.ports.devUi;
  // When app has API + Vite dev but no dedicated UI port,
  // the prod UI is served by the API server
  if (!result.uiPort && result.apiPort && result.devUiPort) result.uiPort = result.apiPort;
}

async function applyEcosystemConfig(dirPath, result, configFiles) {
  for (const ecosystemFile of ECOSYSTEM_CONFIG_FILENAMES) {
    const ecosystemPath = join(dirPath, ecosystemFile);
    if (!existsSync(ecosystemPath)) continue;
    const content = await readFile(ecosystemPath, 'utf-8').catch(() => '');
    if (!content) continue;

    const { processes: parsedProcesses, pm2Home } = parseEcosystemConfig(content);
    if (pm2Home) result.pm2Home = pm2Home;
    if (parsedProcesses.length > 0) await applyParsedProcesses(dirPath, parsedProcesses, result);

    // Extract UI port from CLIENT_URL (still needed as it's not in process configs)
    const clientUrlMatch = content.match(/CLIENT_URL\s*:\s*['"]https?:\/\/[^:]+:(\d+)/);
    if (clientUrlMatch && !result.uiPort) result.uiPort = parseInt(clientUrlMatch[1], 10);

    configFiles.push(ecosystemFile);
  }
}

async function configStep(dirPath, result, emit) {
  emit('config', 'running', { message: 'Checking configuration files...' });
  const configFiles = [];

  await applyEnvPorts(dirPath, result, configFiles);
  await applyViteConfigPorts(dirPath, result, configFiles);
  await applyEcosystemConfig(dirPath, result, configFiles);

  // When config-file heuristics found a Vite dev port but no dedicated uiPort,
  // derive uiPort: API serves prod UI if present, otherwise devUiPort is the only UI
  if (!result.uiPort && result.devUiPort) {
    result.uiPort = result.apiPort ?? result.devUiPort;
  }

  emit('config', 'done', {
    message: configFiles.length ? `Found: ${configFiles.join(', ')}` : 'No config files found',
    uiPort: result.uiPort,
    devUiPort: result.devUiPort,
    apiPort: result.apiPort,
    pm2ProcessNames: result.pm2ProcessNames.length > 0 ? result.pm2ProcessNames : undefined,
    processes: result.processes.length > 0 ? result.processes : undefined,
    configFiles
  });
}

/** Generate PM2 process names only when the ecosystem config supplied none. */
function defaultPm2ProcessNames(result) {
  const baseName = result.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
  return result.type === 'vite+express' ? [`${baseName}-ui`, `${baseName}-api`] : [baseName];
}

async function pm2Step(result, emit) {
  if (!usesPm2(result.type)) {
    emit('pm2', 'skipped', { message: `Not applicable for ${result.type} apps` });
    return;
  }

  emit('pm2', 'running', { message: 'Checking PM2 processes...' });
  // `listProcessesStrict()` returns `null` when the read itself FAILED (vs
  // `[]` for a successful read with no processes) — the absent-vs-empty
  // contract from issue #968, now the one non-test owner of raw `pm2 jlist`
  // execution/parsing alongside `autofixer/shared.js` (#8164). Use custom
  // PM2_HOME if detected from ecosystem config.
  const pm2Processes = await listProcessesStrict(result.pm2Home || null);

  if (pm2Processes === null) {
    // A failed read must not be reported as "no matching processes" — that
    // would silently drop the pm2ProcessNames the ecosystem config already
    // found. Leave result.pm2Status/pm2ProcessNames as already derived and
    // surface the read failure on its own stage.
    emit('pm2', 'error', { message: 'PM2 process read failed — status is unavailable' });
    return;
  }

  // Look for processes that might be this app
  const possibleNames = [
    result.name,
    result.name.toLowerCase(),
    result.name.toLowerCase().replace(/[^a-z0-9]/g, '-'),
    `${result.name}-ui`,
    `${result.name}-api`
  ];
  const matchingProcesses = pm2Processes.filter(p =>
    possibleNames.some(name => p.name.includes(name) || name.includes(p.name))
  );

  if (matchingProcesses.length === 0) {
    emit('pm2', 'done', { message: 'No matching PM2 processes found' });
    if (result.pm2ProcessNames.length === 0) result.pm2ProcessNames = defaultPm2ProcessNames(result);
    return;
  }

  result.pm2Status = matchingProcesses.map(p => ({ name: p.name, status: p.status, pid: p.pid }));
  // Use actual found PM2 process names
  result.pm2ProcessNames = matchingProcesses.map(p => p.name);
  emit('pm2', 'done', {
    message: `Found ${matchingProcesses.length} running process(es)`,
    pm2Status: result.pm2Status,
    pm2ProcessNames: result.pm2ProcessNames
  });
}

/** Fast, no-AI description: the first non-heading, non-image README line. */
async function readmeStep(dirPath, result, emit) {
  if (result.description) {
    emit('readme', 'skipped', { message: 'Description already found in package.json' });
    return;
  }

  emit('readme', 'running', { message: 'Reading README.md...' });
  for (const readmeFile of ['README.md', 'readme.md', 'Readme.md']) {
    const readmePath = join(dirPath, readmeFile);
    if (!existsSync(readmePath)) continue;
    const content = await readFile(readmePath, 'utf-8').catch(() => '');
    if (!content) continue;
    const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('!'));
    if (lines.length > 0) result.description = lines[0].trim().substring(0, 200);
    emit('readme', 'done', { message: `Found: ${readmeFile}`, description: result.description });
    return;
  }
  emit('readme', 'done', { message: 'No README found' });
}

async function iconStep(dirPath, result, emit) {
  emit('icon', 'running', { message: 'Looking for app icon...' });
  const detectedIcon = await detectAppIcon(dirPath, result.type);
  if (!detectedIcon) {
    emit('icon', 'done', { message: 'No app icon found' });
    return;
  }
  result.appIconPath = detectedIcon;
  emit('icon', 'done', { message: `Found: ${basename(detectedIcon)}`, appIconPath: detectedIcon });
}

/**
 * Stream detection results to a socket as each step completes
 */
export async function streamDetection(socket, dirPath) {
  const emit = (step, status, data = {}) => {
    socket.emit('detect:step', { step, status, data, timestamp: Date.now() });
  };

  const result = {
    name: '',
    description: '',
    uiPort: null,
    devUiPort: null,
    apiPort: null,
    buildCommand: null,
    startCommands: [],
    pm2ProcessNames: [],
    pm2Status: null,
    processes: [],
    pm2Home: null,
    type: 'unknown',
    nativeLaunch: null,
    appIconPath: null
  };

  if (!await validateStep(socket, dirPath, result, emit)) return;

  const files = await filesStep(dirPath, result, emit);
  const godotNativeLaunch = detectGodotNativeLaunch(dirPath);
  await packageStep(dirPath, files, result, emit);
  // Native game launch is additive: web ports/processes remain the standard
  // managed app while the game gets its own explicit action.
  if (godotNativeLaunch) result.nativeLaunch = godotNativeLaunch;

  await configStep(dirPath, result, emit);
  await pm2Step(result, emit);
  await readmeStep(dirPath, result, emit);
  await iconStep(dirPath, result, emit);

  socket.emit('detect:complete', { success: true, result });
}
