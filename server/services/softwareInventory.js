/**
 * One read-only inventory of the additional software PortOS manages, for
 * Settings › Software. Every row reuses the status service that the component's
 * own page already uses, so this page and that home cannot disagree, and every
 * update action is one of those homes' existing endpoints (the client maps
 * `action.kind` to it). A slow or failing probe degrades only its own rows.
 */
import { readFile } from 'node:fs/promises';
import { PORTOS_APP_ID } from '../lib/appIdentity.js';
import { resolveCondaEnvPython } from '../lib/condaEnv.js';
import { compareHarnessVersions } from '../lib/harnessOutput.js';

const PROBE_TIMEOUT_MS = 20_000;
const UPDATE_HOME = { path: `/apps/${PORTOS_APP_ID}/update`, label: 'PortOS update' };
const HOMES = Object.freeze({
  update: UPDATE_HOME,
  browser: { path: '/browser', label: 'Browser' },
  harnesses: { path: '/ai/harnesses', label: 'Harnesses' },
  localLlm: { path: '/models/llms-runtimes', label: 'Model runtimes' },
  ytdlp: { path: '/devtools/video-download', label: 'Video download' },
  codeAnimation: { path: '/code-animation/production', label: 'Code animation' },
  music: { path: '/music', label: 'Music' },
  models3d: { path: '/models/3d', label: '3D models' },
});

const SOFTWARE_GROUPS = Object.freeze([
  'Runtime', 'Browser', 'Agent harnesses', 'Local AI', 'Media tools', 'Environments',
]);


const entry = (fields) => ({
  installed: null, version: null, latest: null, summary: null, action: null, busy: null, home: null, ...fields,
});

const unknownRow = (id, name, group, home, error) => entry({
  id, name, group, home, state: 'unknown', summary: `Status could not be read${error ? `: ${error}` : '.'}`,
});

const withTimeout = (promise, ms) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms); }),
  ]).finally(() => clearTimeout(timer));
};

function nodeRows(runtime) {
  const { node, nvm, pm2, releases } = runtime;
  // One Node/pm2 job runs at a time; while it does, neither row offers an action.
  const busy = runtime.job ? `${runtime.job.kind === 'pm2-update' ? 'pm2' : 'Node'} update running` : null;
  const offer = releases?.offers?.[0] || null;
  const security = node.securityBaseline?.compliant === false || releases?.securityUpdate === true;
  const nodeState = !releases ? 'unknown'
    : security ? 'security'
      : node.inSupportedRange === false ? 'attention'
        : releases.latestInLine && compareHarnessVersions(node.version.replace(/^v/, ''), releases.latestInLine.version.replace(/^v/, '')) === -1 ? 'update'
          : 'current';
  const nodeRow = entry({
    id: 'node', name: 'Node.js', group: 'Runtime', home: HOMES.update, installed: true,
    version: node.version, latest: releases?.latestInLine?.version || null, state: nodeState,
    summary: !releases ? runtime.releasesError
      : node.inSupportedRange === false ? `Outside the supported range ${node.supportedRange}.`
        : security ? 'A security release is available for this Node line.'
          : node.pinned ? 'PortOS is pinned to this Node.' : null,
    busy,
    action: !busy && runtime.canUpdate && offer && nodeState !== 'current'
      ? { kind: 'node-update', label: `Update to ${offer.version}`, version: offer.version, restarts: true }
      : null,
  });

  const nvmRow = entry({
    id: 'nvm', name: 'nvm', group: 'Runtime', home: HOMES.update,
    installed: Boolean(nvm), state: nvm ? 'current' : 'missing',
    version: nvm?.defaultVersion ? `default ${nvm.defaultVersion}` : null,
    summary: nvm ? `${nvm.installed?.length || 0} Node versions installed.` : runtime.blockedReason,
  });

  const pm2Behind = Boolean(pm2.cliBehind || pm2.daemonStale);
  const pm2Row = entry({
    id: 'pm2', name: 'pm2', group: 'Runtime', home: HOMES.update, installed: Boolean(pm2.daemon || pm2.cli),
    version: pm2.daemon?.pm2Version || pm2.cli || null, latest: pm2.shipped || null,
    state: pm2Behind ? 'attention' : !pm2.shipped || !pm2.daemon?.pm2Version ? 'unknown' : 'current',
    summary: [
      pm2.shipped && `PortOS ships ${pm2.shipped}`,
      `terminal ${pm2.cli || 'not installed'}`,
      `daemon ${pm2.daemon?.pm2Version || 'unknown'}`,
      pm2.latest && pm2.shipped && compareHarnessVersions(pm2.shipped, pm2.latest) === -1 && `npm has ${pm2.latest}; it arrives with a PortOS release`,
    ].filter(Boolean).join(', ') + '.',
    busy,
    action: !busy && pm2Behind
      ? { kind: 'pm2-sync', label: pm2.daemonStale ? 'Sync pm2 (restarts PortOS)' : 'Sync terminal pm2', restarts: Boolean(pm2.daemonStale) }
      : null,
  });
  return [nodeRow, nvmRow, pm2Row];
}

const BROWSER_STATES = Object.freeze({
  current: ['current', null],
  'restart-required': ['update', 'An installed update needs a browser restart.'],
  'downgrade-risk': ['attention', 'The installed Chrome is older than the running browser.'],
  'configuration-mismatch': ['attention', 'The connected browser differs from the configured app.'],
  stopped: ['unknown', 'The browser supervisor is stopped.'],
  unsupported: ['unsupported', 'Update comparison is available for Google Chrome on macOS.'],
  checking: ['unknown', 'Checking Chrome…'],
});

function browserRow(status, arch = process.arch) {
  const [state, summary] = BROWSER_STATES[status?.state] || ['unknown', 'Chrome update status could not be verified.'];
  const published = status?.publishedVersions?.[arch === 'arm64' ? 'mac_arm64' : 'mac'] || null;
  return entry({
    id: 'browser', name: 'PortOS Browser (Chrome)', group: 'Browser', home: HOMES.browser,
    installed: status?.installedVersion ? true : null, version: status?.runningVersion || null,
    latest: published || status?.installedVersion || null, state, summary,
  });
}

function harnessRows(harnesses) {
  return harnesses.map((harness) => entry({
    id: `harness:${harness.id}`, name: harness.label, group: 'Agent harnesses', home: HOMES.harnesses,
    installed: harness.installed === true, version: harness.version || null, latest: harness.latestVersion || null,
    state: harness.installed !== true ? 'missing' : harness.updateAvailable ? 'update' : harness.version ? 'current' : 'unknown',
    summary: harness.package ? `npm ${harness.package}` : null,
  }));
}

function ytDlpRow(status) {
  return entry({
    id: 'yt-dlp', name: 'yt-dlp', group: 'Media tools', home: HOMES.ytdlp,
    installed: status.installed, version: status.version, latest: status.latestVersion,
    state: !status.installed ? 'missing' : status.updateAvailable ? 'update' : status.version ? 'current' : 'unknown',
    summary: status.installed ? (status.blockedReason || (status.methodLabel ? `Updates with ${status.methodLabel}.` : null)) : status.blockedReason,
    action: status.installed && status.updateAvailable && status.canUpdate
      ? { kind: 'ytdlp-update', label: `Update to ${status.latestVersion}`, restarts: false } : null,
  });
}

function localLlmRows(status) {
  const { ollama, lmstudio } = status;
  return [
    entry({
      id: 'ollama', name: 'Ollama', group: 'Local AI', home: HOMES.localLlm,
      installed: Boolean(ollama.installed), version: ollama.version, latest: ollama.latestVersion,
      state: !ollama.installed ? 'missing' : ollama.updateAvailable ? 'update' : ollama.version ? 'current' : 'unknown',
      summary: !ollama.installed ? null : ollama.available ? `${ollama.modelCount || 0} models.` : 'Installed but not running, so its version is unknown.',
      action: ollama.updateAvailable && ollama.canUpgrade
        ? { kind: 'ollama-upgrade', label: `Update to ${ollama.latestVersion}`, restarts: false } : null,
    }),
    entry({
      id: 'lmstudio', name: 'LM Studio', group: 'Local AI', home: HOMES.localLlm,
      installed: Boolean(lmstudio.installed), state: lmstudio.installed ? 'current' : 'missing',
      summary: lmstudio.installed ? `${lmstudio.available ? 'Server running' : 'Server stopped'}; LM Studio updates itself.` : null,
    }),
  ];
}

/** Blender's own version, read from the app bundle or install directory without running it. */
async function readBlenderVersion(executable, { read = readFile } = {}) {
  if (!executable) return null;
  const bundle = executable.match(/^(.*?\.app)\/Contents\//);
  if (bundle) {
    const plist = await read(`${bundle[1]}/Contents/Info.plist`, 'utf8').catch(() => '');
    const version = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
    if (version) return version[1].trim();
  }
  return executable.match(/blender-(\d+\.\d+(?:\.\d+)?)/i)?.[1] || null;
}

async function blenderRow(execution, deps) {
  const blender = execution.tools?.blender || {};
  const lane = execution.lanes?.blender || {};
  return entry({
    id: 'blender', name: 'Blender', group: 'Media tools', home: HOMES.codeAnimation,
    installed: blender.executable ? true : null, version: await readBlenderVersion(blender.executable, deps),
    state: !blender.executable ? 'missing' : lane.ready ? 'current' : 'attention',
    summary: !blender.executable ? blender.problem : lane.ready ? `Renders in ${blender.executionMode} mode.` : lane.reason,
  });
}

const SUPERCOLLIDER_STATES = Object.freeze({
  ready: 'current', 'image-missing': 'missing', 'image-stale': 'update', 'docker-missing': 'missing',
  'docker-stopped': 'attention', 'docker-unsupported': 'unsupported', unverified: 'attention', 'smoke-failed': 'attention',
});

function superColliderRows(status) {
  const docker = status.docker || {};
  return [
    entry({
      id: 'supercollider', name: 'SuperCollider', group: 'Media tools', home: HOMES.music,
      installed: Boolean(status.image), version: status.image ? status.runtime?.supercollider : null,
      latest: status.runtime?.supercollider || null, state: SUPERCOLLIDER_STATES[status.state] || 'unknown',
      summary: status.message,
    }),
    entry({
      id: 'docker', name: 'Docker', group: 'Environments', installed: Boolean(docker.installed),
      version: docker.serverVersion || docker.clientVersion || null,
      state: !docker.installed ? 'missing' : docker.running ? 'current' : 'attention',
      summary: !docker.installed ? 'Used by contained renders. PortOS never installs Docker.' : docker.running ? null : 'Installed, but the engine is not running.',
    }),
  ];
}

const CONDA_ENVS = Object.freeze([
  { env: 'rigging', name: 'Rigging (bpy)', home: null, platforms: ['darwin', 'linux'] },
  { env: 'trellis2', name: 'TRELLIS.2 (CUDA)', home: HOMES.models3d, platforms: ['linux'] },
  { env: 'pixal3d', name: 'Pixal3D (CUDA)', home: HOMES.models3d, platforms: ['linux'] },
]);

function condaRows({ resolve = resolveCondaEnvPython, platform = process.platform } = {}) {
  return CONDA_ENVS.flatMap(({ env, name, home, platforms }) => {
    const python = resolve(env);
    if (!python && !platforms.includes(platform)) return [];
    return [entry({
      id: `conda:${env}`, name: `conda env: ${name}`, group: 'Environments', home,
      installed: Boolean(python), state: python ? 'current' : 'missing',
      summary: python ? `Environment "${env}" is present.` : `Environment "${env}" has not been created.`,
    })];
  });
}

const COLLECTORS = [
  { id: 'node', name: 'Node.js', group: 'Runtime', home: HOMES.update,
    read: async () => nodeRows(await (await import('./nodeRuntime.js')).getNodeRuntimeStatus()) },
  { id: 'browser', name: 'PortOS Browser (Chrome)', group: 'Browser', home: HOMES.browser,
    read: async () => [browserRow((await import('./runtimeUpdateReview.js')).getBrowserUpdateSnapshot())] },
  { id: 'harnesses', name: 'Agent harnesses', group: 'Agent harnesses', home: HOMES.harnesses,
    read: async ({ fresh }) => harnessRows(await (await import('./harnesses.js')).listHarnesses({ fresh })) },
  { id: 'local-llm', name: 'Ollama / LM Studio', group: 'Local AI', home: HOMES.localLlm,
    read: async () => localLlmRows(await (await import('./localLlm.js')).getStatus()) },
  { id: 'yt-dlp', name: 'yt-dlp', group: 'Media tools', home: HOMES.ytdlp,
    read: async () => [ytDlpRow(await (await import('./ytdlpUpdate.js')).getYtDlpUpdateStatus())] },
  { id: 'blender', name: 'Blender', group: 'Media tools', home: HOMES.codeAnimation,
    read: async () => [await blenderRow(await (await import('./codeAnimation/execution.js')).getCodeAnimationExecution())] },
  { id: 'supercollider', name: 'SuperCollider / Docker', group: 'Media tools', home: HOMES.music,
    read: async () => superColliderRows(await (await import('./superColliderRuntime.js')).getSuperColliderStatus()) },
  { id: 'conda', name: 'conda environments', group: 'Environments', home: null,
    read: async () => condaRows() },
];

/**
 * @param {{fresh?: boolean, collectors?: typeof COLLECTORS, timeoutMs?: number}} [options]
 * `fresh` bypasses the harness version cache (the page's Refresh button).
 */
export async function getSoftwareInventory({ fresh = false, collectors = COLLECTORS, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const results = await Promise.allSettled(collectors.map((collector) => withTimeout(Promise.resolve().then(() => collector.read({ fresh })), timeoutMs)));
  const components = results.flatMap((result, index) => {
    if (result.status === 'fulfilled') return result.value;
    const { id, name, group, home } = collectors[index];
    console.log(`⏭️ Software inventory: ${name} status unavailable: ${result.reason?.message || result.reason}`);
    return [unknownRow(id, name, group, home, result.reason?.message)];
  });
  return { components, groups: SOFTWARE_GROUPS, checkedAt: new Date().toISOString() };
}

export const __testing = { nodeRows, browserRow, ytDlpRow, readBlenderVersion, condaRows };
