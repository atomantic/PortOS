import { delimiter, dirname, join } from 'path';
import { homedir, tmpdir } from 'os';
import { createHash } from 'crypto';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { ServerError } from '../lib/errorHandler.js';
import { bufferedSpawnOrThrow } from '../lib/bufferedSpawn.js';
import { commandExists } from '../lib/commandExists.js';
import { withoutServerSecretsEnv } from '../lib/processEnv.js';
import { execGit } from '../lib/execGit.js';
import { atomicWrite, ensureDir, pathExists, PATHS } from '../lib/fileUtils.js';
import { parseGitHubUrl } from '../lib/repoUrl.js';
import { cloneRepo } from './repoCloner.js';
import { createApp, getAllApps, notifyAppsChanged, updateApp } from './apps.js';
import { getAppStatusStrict } from './pm2.js';
import { EIDOVERSE_PORT, EIDOVERSE_PROCESS_NAME } from '../lib/eidoversePort.js';
import { eidoverseStartCommand } from '../lib/eidoverseStartCommand.js';

export const DEFAULT_EIDOVERSE_WORLDS_REPO = 'https://github.com/atomantic/eidoverse-worlds';
export const EIDOVERSE_VIDEO_REPO = 'https://github.com/anima-research/eidoverse-video';
export { EIDOVERSE_PORT, EIDOVERSE_PROCESS_NAME };
// The loaded world and asset runtime exceeds the generic command-app 500M cap.
export const EIDOVERSE_MAX_MEMORY_RESTART = '2G';

// Pinned Bun release; digests come from the official SHASUMS256.txt of this tag.
export const BUN_VERSION = '1.4.5';
export const BUN_RELEASE_TARGETS = Object.freeze({
  'darwin-arm64': { archive: 'bun-darwin-aarch64.zip', sha256: 'b5d6bc2e13caf14e57c89661e89efd073ff16165b41bfe43882616410609cd10' },
  'darwin-x64': { archive: 'bun-darwin-x64.zip', sha256: 'a4972e778cce4b6a194d7d289f326aa61576d71d80b7a53e9da2f3739566e5fd' },
  'linux-arm64': { archive: 'bun-linux-aarch64.zip', sha256: '18656a3bf0ea5641f5796ae4213b75255579a70a0fded2f337933785568cdf84' },
  'linux-x64': { archive: 'bun-linux-x64.zip', sha256: '94559b3b528995a49452f9f2404cec74f2efd7d06e0a000a8cd214b02c3666eb' },
  'win32-x64': { archive: 'bun-windows-x64.zip', sha256: '815ab45ec7f549abf87e6869584b506eab088e24225683957b7e150b47d6de30' },
});
const BUN_DOWNLOAD_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

export function getBunExecutable({
  platform = process.platform,
  home = homedir(),
  installRoot = process.env.BUN_INSTALL,
} = {}) {
  const root = typeof installRoot === 'string' && installRoot.trim()
    ? installRoot.trim()
    : join(home, '.bun');
  return join(root, 'bin', platform === 'win32' ? 'bun.exe' : 'bun');
}

export function getBunReleaseTarget(platform = process.platform, arch = process.arch) {
  return BUN_RELEASE_TARGETS[`${platform}-${arch}`] || null;
}

// bsdtar (macOS, Windows) reads zip; GNU tar on Linux does not, so use unzip there.
function bunExtractInvocation(platform, archivePath, directory) {
  return platform === 'linux'
    ? { command: 'unzip', args: ['-oq', archivePath, '-d', directory] }
    : { command: 'tar', args: ['-xf', archivePath, '-C', directory] };
}

/**
 * Download the pinned oven-sh/bun archive, verify its SHA-256, and only then
 * extract the binary into `<BUN_INSTALL>/bin`. Fails closed (nothing written,
 * nothing executed) on an unsupported platform, a failed download or a digest
 * mismatch.
 */
async function installPinnedBun(command, env, { platform = process.platform, arch = process.arch } = {}) {
  const target = getBunReleaseTarget(platform, arch);
  if (!target) {
    throw new ServerError(`Bun has no pinned release for ${platform}-${arch}; install Bun manually.`, {
      status: 500,
      code: 'EIDOVERSE_BUN_UNSUPPORTED_PLATFORM',
    });
  }
  const url = `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${target.archive}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(BUN_DOWNLOAD_TIMEOUT_MS) }).catch(() => null);
  if (!response?.ok) {
    throw new ServerError('Bun download failed; check network access and retry.', {
      status: 502,
      code: 'EIDOVERSE_BUN_DOWNLOAD_FAILED',
    });
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== target.sha256) {
    throw new ServerError('Bun download failed SHA-256 verification and was discarded.', {
      status: 502,
      code: 'EIDOVERSE_BUN_DIGEST_MISMATCH',
    });
  }

  const work = await mkdtemp(join(tmpdir(), 'portos-bun-'));
  try {
    const archivePath = join(work, target.archive);
    const extractDir = join(work, 'extract');
    await mkdir(extractDir);
    await writeFile(archivePath, bytes);
    const extractor = bunExtractInvocation(platform, archivePath, extractDir);
    await bufferedSpawnOrThrow(extractor.command, extractor.args, {
      env,
      timeoutMs: INSTALL_TIMEOUT_MS,
      timeoutLabel: 'Bun extraction',
    });
    const binaryName = platform === 'win32' ? 'bun.exe' : 'bun';
    await mkdir(dirname(command), { recursive: true });
    await copyFile(join(extractDir, target.archive.replace(/\.zip$/, ''), binaryName), command);
    if (platform !== 'win32') await chmod(command, 0o755);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export function normalizeEidoverseWorldsRepo(worldsRepoUrl) {
  const parsed = parseGitHubUrl(worldsRepoUrl);
  if (!parsed) {
    throw new ServerError('Choose a valid GitHub repository for Eidoverse Worlds.', {
      status: 400,
      code: 'EIDOVERSE_REPO_INVALID',
    });
  }
  return /^git@github\.com:/i.test(String(worldsRepoUrl).trim())
    ? `git@github.com:${parsed.owner}/${parsed.repo}.git`
    : `https://github.com/${parsed.owner}/${parsed.repo}`;
}

export function getEidoversePaths(worldsRepoUrl = DEFAULT_EIDOVERSE_WORLDS_REPO) {
  const normalizedRepoUrl = normalizeEidoverseWorldsRepo(worldsRepoUrl);
  const { owner, repo } = parseGitHubUrl(normalizedRepoUrl);
  const worlds = join(PATHS.repos, owner, repo);
  return Object.freeze({
    worlds,
    video: join(PATHS.repos, 'anima-research', 'eidoverse-video'),
    worldData: join(PATHS.data, 'eidoverse', 'worlds'),
    envFile: join(worlds, '.env.portos'),
  });
}

const managedAppFields = (paths, bunCommand) => ({
  name: 'Eidoverse Worlds',
  description: 'Private 3D world for a PortOS human and their agents. Installed separately under its own AGPL-3.0 license.',
  repoPath: paths.worlds,
  companionRepoPaths: [paths.video],
  type: 'bun',
  uiPort: EIDOVERSE_PORT,
  apiPort: EIDOVERSE_PORT,
  startCommands: [eidoverseStartCommand(bunCommand)],
  pm2ProcessNames: [EIDOVERSE_PROCESS_NAME],
  envFile: '.env.portos',
  workTracker: 'auto',
  archived: false,
});

const envFileContents = (paths) => [
  '# Generated by PortOS. Machine-local runtime paths; do not commit this file.',
  `PORT=${EIDOVERSE_PORT}`,
  `EIDOVERSE_DIR=${JSON.stringify(paths.video)}`,
  `WORLDS_DIR=${JSON.stringify(paths.worldData)}`,
  '',
].join('\n');

const isManagedEidoverseApp = (app) => Boolean(app?.pm2ProcessNames?.includes(EIDOVERSE_PROCESS_NAME));

// A source switch keeps the existing checkout in place, so the configured
// owner/repo path may no longer match the managed-app path. The process name is
// the stable PortOS-owned identifier across that source change.
export const findManagedApp = (apps) => apps.find(isManagedEidoverseApp) || null;

async function resolveEidoverseInstallPaths(worldsRepoUrl) {
  const configuredPaths = getEidoversePaths(worldsRepoUrl);
  const registered = findManagedApp(await getAllApps());
  const existingWorldsPath = typeof registered?.repoPath === 'string' && registered.repoPath.trim()
    ? registered.repoPath
    : null;

  if (!existingWorldsPath
    || existingWorldsPath === configuredPaths.worlds
    || !await pathExists(join(existingWorldsPath, '.git'))) {
    return configuredPaths;
  }

  return Object.freeze({
    ...configuredPaths,
    worlds: existingWorldsPath,
    envFile: join(existingWorldsPath, '.env.portos'),
  });
}

async function registerManagedApp(paths, bunCommand) {
  const apps = await getAllApps();
  const existing = findManagedApp(apps);
  const fields = managedAppFields(paths, bunCommand);
  const app = existing
    ? await updateApp(existing.id, fields)
    : await createApp(fields);
  notifyAppsChanged(existing ? 'update' : 'create', app.id);
  return app;
}

const bunRuntimeEnv = (bunExecutable) => {
  const binDirectory = dirname(bunExecutable);
  const env = withoutServerSecretsEnv(process.env);
  const inheritedPath = env.PATH || env.Path || '';
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') delete env[key];
  }
  return {
    ...env,
    BUN_INSTALL: dirname(binDirectory),
    PATH: `${binDirectory}${delimiter}${inheritedPath}`,
  };
};

export async function resolveBunRuntime() {
  const ambientEnv = withoutServerSecretsEnv(process.env);
  if (await commandExists('bun', ['--version'], { env: ambientEnv })) return { command: 'bun', env: ambientEnv };

  const command = getBunExecutable();
  const env = bunRuntimeEnv(command);
  return await commandExists(command, ['--version'], { env }) ? { command, env } : null;
}

async function ensureBunRuntime() {
  const existing = await resolveBunRuntime();
  if (existing) return existing;

  const command = getBunExecutable();
  const env = bunRuntimeEnv(command);
  console.log(`📦 Installing Bun ${BUN_VERSION} for Eidoverse Worlds`);
  await installPinnedBun(command, env);

  if (!await commandExists(command, ['--version'], { env })) {
    throw new ServerError('Bun installation completed without a runnable Bun binary.', {
      status: 500,
      code: 'EIDOVERSE_BUN_INSTALL_FAILED',
    });
  }
  return { command, env };
}

async function installDependencies(directory, bun) {
  await bufferedSpawnOrThrow(bun.command, ['install', '--frozen-lockfile'], {
    cwd: directory,
    env: bun.env,
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
}

let installInFlight = null;

async function performInstall(worldsRepoUrl, worldsBranch) {
  const bun = await ensureBunRuntime();

  const configuredPaths = getEidoversePaths(worldsRepoUrl);
  const paths = await resolveEidoverseInstallPaths(worldsRepoUrl);
  await Promise.all([
    paths.worlds === configuredPaths.worlds ? cloneRepo(worldsRepoUrl, { branch: worldsBranch }) : Promise.resolve(),
    cloneRepo(EIDOVERSE_VIDEO_REPO),
  ]);
  await applyWorldsSource(paths.worlds, worldsRepoUrl, worldsBranch || undefined);

  await Promise.all([
    installDependencies(paths.worlds, bun),
    installDependencies(join(paths.worlds, 'client'), bun),
  ]);

  await ensureDir(paths.worldData);
  await atomicWrite(paths.envFile, envFileContents(paths));
  await registerManagedApp(paths, bun.command);

  console.log('🌐 Eidoverse Worlds installed as a managed app');
  return getEidoverseStatus({ worldsRepoUrl });
}

/**
 * Install or resume the optional Eidoverse runtime. The two upstream projects
 * remain independent git checkouts; PortOS writes only an ignored env file and
 * a managed-app record. A process-local promise collapses double-clicks into
 * one clone/install operation.
 */
export async function installEidoverse({ worldsRepoUrl = DEFAULT_EIDOVERSE_WORLDS_REPO, worldsBranch = worldsRepoUrl === DEFAULT_EIDOVERSE_WORLDS_REPO ? 'portos' : '' } = {}) {
  const normalizedRepoUrl = normalizeEidoverseWorldsRepo(worldsRepoUrl);
  if (installInFlight) return installInFlight;
  installInFlight = performInstall(normalizedRepoUrl, worldsBranch.trim()).finally(() => {
    installInFlight = null;
  });
  return installInFlight;
}

/**
 * Read setup and runtime state without mutating either external repository.
 * `registryAvailable: false` is kept distinct from a confirmed unregistered
 * app so a damaged apps registry never invites a duplicate installation.
 */
export async function getEidoverseStatus({ worldsRepoUrl = DEFAULT_EIDOVERSE_WORLDS_REPO } = {}) {
  const normalizedRepoUrl = normalizeEidoverseWorldsRepo(worldsRepoUrl);
  const configuredPaths = getEidoversePaths(normalizedRepoUrl);
  const [bunRuntime, videoRepo, worldDataReady, registry] = await Promise.all([
    resolveBunRuntime(),
    pathExists(join(configuredPaths.video, '.git')),
    pathExists(configuredPaths.worldData),
    getAllApps().then(
      (apps) => ({ apps, error: null }),
      (error) => ({ apps: null, error: error.message }),
    ),
  ]);

  const app = registry.apps ? findManagedApp(registry.apps) : null;
  const worldsPath = typeof app?.repoPath === 'string' && app.repoPath.trim()
    ? app.repoPath
    : configuredPaths.worlds;
  const worldsEnvFile = join(worldsPath, '.env.portos');
  const [worldsRepo, rootDependencies, clientDependencies, configured] = await Promise.all([
    pathExists(join(worldsPath, '.git')),
    pathExists(join(worldsPath, 'node_modules')),
    pathExists(join(worldsPath, 'client', 'node_modules')),
    pathExists(worldsEnvFile),
  ]);

  const runtime = app
    ? await getAppStatusStrict(EIDOVERSE_PROCESS_NAME, app.pm2Home).catch(() => null)
    : null;
  const appRegistered = registry.apps === null ? null : Boolean(app);
  const installed = worldsRepo
    && videoRepo
    && rootDependencies
    && clientDependencies
    && configured
    && worldDataReady
    && appRegistered === true;

  return {
    worldsRepoUrl: normalizedRepoUrl,
    installed,
    partial: !installed && [worldsRepo, videoRepo, rootDependencies, clientDependencies, configured, worldDataReady, appRegistered].some(Boolean),
    bunAvailable: bunRuntime !== null,
    worldsRepo,
    videoRepo,
    rootDependencies,
    clientDependencies,
    configured,
    worldDataReady,
    registryAvailable: registry.apps !== null,
    registryError: registry.error ? 'Managed-app registry unavailable' : null,
    appRegistered,
    appId: app?.id || null,
    uiPort: EIDOVERSE_PORT,
    runtimeStatus: app
      ? (runtime === null ? 'unknown' : (runtime.status === 'not_found' ? 'not_started' : runtime.status))
      : 'not_registered',
  };
}

async function updateOriginAtPath(repoPath, worldsRepoUrl) {
  const result = await execGit(
    ['remote', 'set-url', 'origin', worldsRepoUrl],
    repoPath,
    { ignoreExitCode: true },
  );
  if (result.exitCode === 0) return;

  const added = await execGit(
    ['remote', 'add', 'origin', worldsRepoUrl],
    repoPath,
    { ignoreExitCode: true },
  );
  if (added.exitCode !== 0) {
    throw new ServerError('The Eidoverse Worlds checkout has no usable Git origin.', {
      status: 422,
      code: 'EIDOVERSE_ORIGIN_UPDATE_FAILED',
    });
  }
}

async function applyWorldsSource(repoPath, normalizedRepoUrl, worldsBranch) {
  if (worldsBranch !== undefined) {
    const branch = worldsBranch.trim();
    if (branch) {
      const valid = await execGit(['check-ref-format', '--branch', branch], repoPath, { ignoreExitCode: true });
      if (branch.startsWith('-') || branch.startsWith('@') || valid.exitCode !== 0) {
        throw new ServerError('Choose a valid branch name.', { status: 400, code: 'EIDOVERSE_BRANCH_INVALID' });
      }
      const dirty = await execGit(['status', '--porcelain'], repoPath);
      if (dirty.stdout.trim()) throw new ServerError('Commit or stash local changes before switching the runtime branch.', { status: 409, code: 'EIDOVERSE_CHECKOUT_DIRTY' });
      // Fetch from the proposed URL first so a missing branch cannot change origin.
      await execGit(['fetch', '--', normalizedRepoUrl, `refs/heads/${branch}`], repoPath);
      const local = await execGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repoPath, { ignoreExitCode: true });
      if (local.exitCode === 0) {
        const ancestor = await execGit(['merge-base', '--is-ancestor', `refs/heads/${branch}`, 'FETCH_HEAD'], repoPath, { ignoreExitCode: true });
        if (ancestor.exitCode !== 0) throw new ServerError('The target local branch has commits absent from the selected origin. Reconcile it before switching.', { status: 409, code: 'EIDOVERSE_BRANCH_DIVERGED' });
        await execGit(['switch', '--', branch], repoPath);
        await execGit(['merge', '--ff-only', 'FETCH_HEAD'], repoPath);
      } else {
        await execGit(['switch', '-c', branch, '--no-track', 'FETCH_HEAD'], repoPath);
      }
      await updateOriginAtPath(repoPath, normalizedRepoUrl);
      await execGit(['config', '--replace-all', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], repoPath);
      await execGit(['fetch', 'origin'], repoPath);
      await execGit(['config', `branch.${branch}.remote`, 'origin'], repoPath);
      await execGit(['config', `branch.${branch}.merge`, `refs/heads/${branch}`], repoPath);
    } else {
      await updateOriginAtPath(repoPath, normalizedRepoUrl);
    }
    await execGit(['config', 'portos.runtimeBranch', branch], repoPath);
  } else {
    await updateOriginAtPath(repoPath, normalizedRepoUrl);
  }
}

/**
 * Change the Worlds checkout's origin and optional runtime branch in place. This is intentionally separate from installation:
 * changing a remote must not silently clone a second copy or delete local work.
 */
export async function setEidoverseWorldsOrigin(worldsRepoUrl, worldsBranch) {
  const normalizedRepoUrl = normalizeEidoverseWorldsRepo(worldsRepoUrl);
  const apps = await getAllApps();
  const app = findManagedApp(apps);

  if (!app) {
    throw new ServerError('Install Eidoverse Worlds before changing its GitHub source.', {
      status: 409,
      code: 'EIDOVERSE_NOT_INSTALLED',
    });
  }

  const repoPath = typeof app.repoPath === 'string' && app.repoPath.trim() ? app.repoPath : null;
  if (!repoPath || !await pathExists(join(repoPath, '.git'))) {
    throw new ServerError('The registered Eidoverse Worlds checkout could not be found.', {
      status: 409,
      code: 'EIDOVERSE_CHECKOUT_MISSING',
    });
  }

  await applyWorldsSource(repoPath, normalizedRepoUrl, worldsBranch);

  notifyAppsChanged('update', app.id);
  return { appId: app.id, worldsRepoUrl: normalizedRepoUrl };
}

export async function assertEidoverseInstalled(options) {
  const status = await getEidoverseStatus(options);
  if (status.installed) return status;
  throw new ServerError('Install Eidoverse Worlds before enabling the feature.', {
    status: 409,
    code: 'EIDOVERSE_NOT_INSTALLED',
  });
}

export const __resetEidoverseInstallForTests = () => {
  installInFlight = null;
};
