/**
 * Docker containment profile for untrusted install/build/test runs (#12844).
 *
 * Pure: no filesystem, process, docker or settings access. The executor
 * (`services/dockerContainment.js`) resolves realpaths, picks the engine and
 * runs the argv built here; `docs/CONTAINMENT.md` compares this profile with
 * the bubblewrap and Seatbelt ones.
 *
 * Boundary for one run over a repository worktree:
 *   - a throwaway Linux container from a digest-pinned official Node image,
 *     `--pull never`, non-root, no capabilities, no privilege escalation,
 *     read-only root, CPU/memory/PID/file-size limits;
 *   - the worktree is mounted READ-ONLY at /src and copied into a per-worktree
 *     work volume at /work, so node_modules, build output and anything a
 *     lifecycle script plants never reach the host checkout. Results return
 *     through /out (a unified diff of tracked files) and the container log;
 *   - an environment built from nothing — no host variable, PortOS token or
 *     provider key;
 *   - the Docker socket, the PortOS data directory and the host user's
 *     credential stores can never be mounted (`assertDockerMountSource`);
 *   - validate phase: `--network none`. Install phase: only a per-run internal
 *     network whose sole member is a PortOS egress proxy allowing HTTPS
 *     CONNECT to an allowlist of registry hosts (`dockerEgressProxy.js`).
 */
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { AUTOFIX_VERIFY_PROTECTED_HOME_PATHS } from './autofixVerifyContainment.js';

/** Bump when the boundary below changes meaning. */
export const DOCKER_CONTAINMENT_POLICY_VERSION = 1;

export const DOCKER_CONTAINMENT_FEATURE_ID = 'docker-containment';
export const DOCKER_CONTAINMENT_SETTINGS_KEY = 'dockerContainment';
export const DOCKER_CONTAINMENT_PHASES = Object.freeze(['install', 'validate']);

/** Every container, volume and network a run creates carries this label (value: the run id). */
export const DOCKER_CONTAINMENT_LABEL = 'org.portos.containment.run';
/** Work volumes also carry the worktree key and their creation time, for reuse and the TTL sweep. */
export const DOCKER_CONTAINMENT_WORKTREE_LABEL = 'org.portos.containment.worktree';
export const DOCKER_CONTAINMENT_CREATED_LABEL = 'org.portos.containment.created';
/** The shared bridge the per-run egress proxy reaches registries through. */
export const DOCKER_CONTAINMENT_EGRESS_NETWORK = 'portos-contained-egress';
export const DOCKER_CONTAINMENT_PROXY_ALIAS = 'portos-egress-proxy';
export const DOCKER_CONTAINMENT_PROXY_PORT = 3128;
/** A work volume older than this is swept; an install followed by validate reuses it well within. */
export const DOCKER_CONTAINMENT_VOLUME_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Official `node:<major>-bookworm-slim` images pinned by multi-arch index
 * digest. Runs use `--pull never`; pulling is an explicit operator action.
 * Refresh: `docker buildx imagetools inspect node:<major>-bookworm-slim`.
 */
export const DOCKER_CONTAINMENT_NODE_IMAGES = Object.freeze({
  22: 'node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d',
  24: 'node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205',
  26: 'node:26-bookworm-slim@sha256:28147155d47dc31abe0a46e0d12b59b2fb3d0a2dcc5dc65fce76a074180b16fe',
});
/** Used when a repository declares no Node version. */
export const DOCKER_CONTAINMENT_DEFAULT_NODE_MAJOR = 24;

/** Registry hosts the install phase may always reach; settings and the repo's `.npmrc` add more. */
export const DOCKER_CONTAINMENT_DEFAULT_EGRESS_HOSTS = Object.freeze(['registry.npmjs.org', 'registry.yarnpkg.com']);

export const DOCKER_CONTAINMENT_DEFAULT_LIMITS = Object.freeze({
  cpus: 2,
  memoryMb: 4096,
  pids: 1024,
  tmpfsMb: 1024,
  maxFileBytes: 2 * 1024 * 1024 * 1024,
  installTimeoutMs: 20 * 60_000,
  validateTimeoutMs: 30 * 60_000,
  maxLogBytes: 512 * 1024,
  maxPatchBytes: 2 * 1024 * 1024,
});

/** In-container paths. */
export const DOCKER_CONTAINMENT_PATHS = Object.freeze({
  src: '/src',
  work: '/work',
  input: '/in',
  output: '/out',
  cache: '/cache',
  tmp: '/tmp',
  home: '/tmp/home',
});

/** Container user when the host has no POSIX uid or runs as root (the image's `node` user). */
export const DOCKER_CONTAINMENT_FALLBACK_USER = '1000:1000';

/** Basenames the run's read-only `/in` directory holds. */
export const DOCKER_CONTAINMENT_TRACKED_LIST = 'tracked.lst';
export const DOCKER_CONTAINMENT_PATCH_FILE = 'changes.patch';

/** Data-directory subtrees that hold disposable worktrees and may be mounted. */
export const DOCKER_CONTAINMENT_DATA_WORKTREE_ROOTS = Object.freeze(['cos/worktrees', 'autofixer/worktrees']);

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DIGEST_IMAGE_RE = /^[a-z0-9][a-z0-9._/:-]{0,200}@sha256:[a-f0-9]{64}$/;
const HOSTNAME_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
const SOCKET_BASENAME_RE = /(?:docker|containerd|podman|buildkitd?)(?:[._-][a-z0-9]+)*\.sock$/i;

export const isDockerContainmentPhase = (phase) => DOCKER_CONTAINMENT_PHASES.includes(phase);
export const isEgressHostname = (host) => typeof host === 'string' && HOSTNAME_RE.test(host) && !/^\d+(\.\d+)*$/.test(host);
export const isDigestPinnedImage = (ref) => typeof ref === 'string' && DIGEST_IMAGE_RE.test(ref);

/** Stable short key for a worktree realpath; names its work volume. */
export const dockerContainmentWorktreeKey = (worktree) => createHash('sha256').update(String(worktree)).digest('hex').slice(0, 16);
export const dockerContainmentWorkVolume = (worktree) => `portos-contained-work-${dockerContainmentWorktreeKey(worktree)}`;
export const DOCKER_CONTAINMENT_CACHE_VOLUME = 'portos-contained-npm-cache';

/** The container user: the host's own non-root uid:gid so /out stays host-owned, else the image's `node` user. */
export function dockerContainmentUser({ uid, gid } = {}) {
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid === 0 || gid === 0) return DOCKER_CONTAINMENT_FALLBACK_USER;
  return `${uid}:${gid}`;
}

/** Merge operator overrides onto the defaults, clamped to sane bounds. */
export function resolveDockerContainmentLimits(overrides = {}) {
  const pick = (value, min, max, fallback) => (Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback);
  const d = DOCKER_CONTAINMENT_DEFAULT_LIMITS;
  const o = overrides && typeof overrides === 'object' ? overrides : {};
  return Object.freeze({
    ...d,
    cpus: pick(o.cpus, 0.5, 64, d.cpus),
    memoryMb: Math.round(pick(o.memoryMb, 512, 65_536, d.memoryMb)),
    pids: Math.round(pick(o.pids, 64, 32_768, d.pids)),
    installTimeoutMs: Number.isFinite(o.wallTimeoutMinutes) ? pick(o.wallTimeoutMinutes, 1, 240, 0) * 60_000 : d.installTimeoutMs,
    validateTimeoutMs: Number.isFinite(o.wallTimeoutMinutes) ? pick(o.wallTimeoutMinutes, 1, 240, 0) * 60_000 : d.validateTimeoutMs,
  });
}

/**
 * The Node major a repository asks for: `.nvmrc`, then `.node-version`, then
 * `package.json` `engines.node`. `supported` is false when no image is pinned
 * (or overridden) for it — the caller refuses rather than testing under a
 * different runtime.
 */
export function selectDockerContainmentNodeMajor({ nvmrc, nodeVersion, enginesNode, images = DOCKER_CONTAINMENT_NODE_IMAGES } = {}) {
  const available = Object.keys(images).map(Number).filter(Number.isInteger).sort((a, b) => a - b);
  const result = (major, source) => ({ major, source, supported: available.includes(major), image: images[major] ?? null });
  for (const [text, source] of [[nvmrc, '.nvmrc'], [nodeVersion, '.node-version']]) {
    const value = String(text ?? '').trim().split(/\s+/)[0] ?? '';
    if (!value) continue;
    if (/^(node|current|latest)$/i.test(value)) return result(available.at(-1), source);
    if (/^lts\//i.test(value)) return result(DOCKER_CONTAINMENT_DEFAULT_NODE_MAJOR, source);
    const match = /^v?(\d+)/.exec(value);
    if (match) return result(Number(match[1]), source);
  }
  const range = String(enginesNode ?? '').trim();
  if (range) {
    const floors = [...range.matchAll(/>=?\s*v?(\d+)/g)].map((m) => Number(m[1]));
    const named = [...range.matchAll(/(?:^|[\s|^~=])v?(\d+)(?=[.\sx*|]|$)/g)].map((m) => Number(m[1]));
    const open = floors.length ? available.filter((major) => major >= Math.min(...floors)) : [];
    const candidates = [...new Set([...named, ...open])].filter((major) => available.includes(major));
    if (candidates.length) return result(Math.max(...candidates), 'engines.node');
    const declared = Math.max(...named, ...floors);
    if (Number.isFinite(declared)) return result(declared, 'engines.node');
  }
  return result(DOCKER_CONTAINMENT_DEFAULT_NODE_MAJOR, 'default');
}

/**
 * Registry host names from a repository `.npmrc`: `registry=` and
 * `@scope:registry=` lines only. Auth, proxy and every other line is ignored,
 * so a token there never becomes allowlist input.
 */
export function parseNpmrcRegistryHosts(text) {
  const hosts = new Set();
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const match = /^(?:@[a-z0-9._-]+:)?registry\s*=\s*["']?(https:\/\/[^\s"']+)/i.exec(line);
    if (!match) continue;
    let host = null;
    try { host = new URL(match[1]).hostname.toLowerCase(); } catch { host = null; }
    if (host && isEgressHostname(host)) hosts.add(host);
  }
  return [...hosts].sort();
}

/** The install phase's egress allowlist: defaults, operator extras, then repo registries. */
export function buildEgressAllowlist({ extraHosts = [], npmrcHosts = [] } = {}) {
  const all = [...DOCKER_CONTAINMENT_DEFAULT_EGRESS_HOSTS, ...extraHosts, ...npmrcHosts]
    .map((host) => String(host).trim().toLowerCase())
    .filter(isEgressHostname);
  return [...new Set(all)];
}

const isWithin = (child, parent) => child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);

/**
 * Throw unless `source` (a host realpath) may be bind-mounted into a contained
 * run. Refuses: anything docker's `--mount` syntax could misparse, `/`, run
 * directories and any container-engine socket, the host home itself or any
 * ancestor of it, a credential store or anything inside or above one, and the
 * PortOS data directory or anything above it. Inside the data directory only
 * the disposable worktree roots are allowed.
 */
export function assertDockerMountSource(source, { dataDir = null, realHome = null } = {}) {
  if (typeof source !== 'string' || !source.startsWith('/')) throw new Error('mount source must be an absolute POSIX path');
  if (/[,\0-\x1f"]/.test(source)) throw new Error('mount source contains a character docker cannot mount');
  const path = posix.normalize(source).replace(/\/+$/, '') || '/';
  if (path === '/') throw new Error('refusing to mount the filesystem root');
  if (SOCKET_BASENAME_RE.test(posix.basename(path))) throw new Error('refusing to mount a container engine socket');
  for (const dir of ['/run', '/var/run', '/private/var/run', '/proc', '/sys', '/dev', '/etc']) {
    if (isWithin(path, dir) || isWithin(dir, path)) throw new Error(`refusing to mount ${dir} or a path that contains it`);
  }
  if (realHome) {
    const home = posix.normalize(realHome).replace(/\/+$/, '');
    if (isWithin(home, path)) throw new Error('refusing to mount the host home directory or a path that contains it');
    for (const rel of AUTOFIX_VERIFY_PROTECTED_HOME_PATHS) {
      const store = posix.join(home, rel);
      if (isWithin(path, store) || isWithin(store, path)) throw new Error(`refusing to mount a host credential store (~/${rel})`);
    }
  }
  if (dataDir) {
    const data = posix.normalize(dataDir).replace(/\/+$/, '');
    if (isWithin(data, path)) throw new Error('refusing to mount the PortOS data directory or a path that contains it');
    if (isWithin(path, data)) {
      const allowed = DOCKER_CONTAINMENT_DATA_WORKTREE_ROOTS.some((root) => {
        const base = posix.join(data, root);
        return path !== base && isWithin(path, base);
      });
      if (!allowed) throw new Error('refusing to mount PortOS data outside a disposable worktree root');
    }
  }
  return path;
}

/**
 * The container's complete environment (image `ENV` such as PATH still
 * applies; nothing comes from the host). The proxy variables exist only in
 * the install phase.
 */
export function buildDockerContainmentEnv({ phase, proxyUrl = null }) {
  const { home, tmp, cache } = DOCKER_CONTAINMENT_PATHS;
  const env = {
    CI: '1',
    HOME: home,
    TMPDIR: tmp,
    LANG: 'C.UTF-8',
    npm_config_cache: cache,
    npm_config_logs_dir: `${tmp}/npm-logs`,
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    NO_UPDATE_NOTIFIER: '1',
  };
  if (phase === 'install') {
    if (!proxyUrl) throw new Error('the install phase needs the egress proxy URL');
    Object.assign(env, {
      HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, https_proxy: proxyUrl, http_proxy: proxyUrl,
      npm_config_https_proxy: proxyUrl, npm_config_proxy: proxyUrl, NODE_USE_ENV_PROXY: '1',
    });
  } else {
    env.npm_config_offline = 'true';
  }
  return env;
}

/**
 * The trusted in-container driver. Copies the read-only source into the work
 * volume (install starts from an empty volume; validate refreshes sources over
 * the volume an install left, keeping its node_modules), runs the command,
 * then writes a unified diff of every tracked file that changed to /out. The
 * diff is advisory: the host bounds and checks it before anyone applies it.
 */
export const DOCKER_CONTAINMENT_DRIVER = `set -u
phase="$1"; command="$2"
mkdir -p "$HOME" "$TMPDIR/npm-logs"
cd ${DOCKER_CONTAINMENT_PATHS.work} || exit 125
tar -C ${DOCKER_CONTAINMENT_PATHS.src} --exclude=node_modules --exclude=.git -cf - . | tar -C ${DOCKER_CONTAINMENT_PATHS.work} -xf - || { echo "portos-contained: could not copy the source" >&2; exit 125; }
echo "portos-contained: $phase phase"
sh -c "$command"
status=$?
patch=${DOCKER_CONTAINMENT_PATHS.output}/${DOCKER_CONTAINMENT_PATCH_FILE}
: > "$patch"
if [ -f ${DOCKER_CONTAINMENT_PATHS.input}/${DOCKER_CONTAINMENT_TRACKED_LIST} ]; then
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if [ -e "${DOCKER_CONTAINMENT_PATHS.work}/$f" ]; then
      cmp -s "${DOCKER_CONTAINMENT_PATHS.src}/$f" "${DOCKER_CONTAINMENT_PATHS.work}/$f" || diff -u --label "a/$f" --label "b/$f" "${DOCKER_CONTAINMENT_PATHS.src}/$f" "${DOCKER_CONTAINMENT_PATHS.work}/$f" >> "$patch"
    elif [ -e "${DOCKER_CONTAINMENT_PATHS.src}/$f" ]; then
      diff -u --label "a/$f" --label /dev/null "${DOCKER_CONTAINMENT_PATHS.src}/$f" /dev/null >> "$patch"
    fi
  done < ${DOCKER_CONTAINMENT_PATHS.input}/${DOCKER_CONTAINMENT_TRACKED_LIST}
fi
exit $status
`;

function assertName(value, label) {
  if (!NAME_RE.test(String(value ?? ''))) throw new Error(`${label} must be a docker object name`);
}

function assertUser(user) {
  if (!/^\d+:\d+$/.test(String(user)) || /^0:|:0$/.test(String(user))) throw new Error('user must be a non-root uid:gid');
}

function assertImage(image) {
  if (!isDigestPinnedImage(image)) throw new Error('image must be pinned by sha256 digest');
}

/**
 * `docker run` argv for one contained run.
 *
 * @param {object} p
 * @param {'install'|'validate'} p.phase
 * @param {string} p.image - digest-pinned reference
 * @param {string} p.containerName
 * @param {string} p.runId
 * @param {string} p.worktree - host realpath, mounted read-only at /src
 * @param {string} p.inputDir - host realpath of the run's read-only input (tracked list)
 * @param {string} p.outputDir - host realpath of the run's only writable bind
 * @param {string} p.workVolume
 * @param {string} [p.cacheVolume]
 * @param {string} [p.network] - the install phase's per-run internal network
 * @param {string} p.command - shell command, run by the driver as `sh -c`
 * @param {string} [p.user]
 * @param {object} [p.limits]
 * @param {string|null} [p.dataDir]
 * @param {string|null} [p.realHome]
 */
export function buildDockerContainmentRunArgs({
  phase, image, containerName, runId, worktree, inputDir, outputDir, workVolume,
  cacheVolume = DOCKER_CONTAINMENT_CACHE_VOLUME, network = null, command,
  user = DOCKER_CONTAINMENT_FALLBACK_USER, limits = DOCKER_CONTAINMENT_DEFAULT_LIMITS,
  dataDir = null, realHome = null,
}) {
  if (!isDockerContainmentPhase(phase)) throw new Error('phase must be install or validate');
  assertImage(image);
  assertName(containerName, 'containerName');
  assertName(runId, 'runId');
  assertName(workVolume, 'workVolume');
  assertName(cacheVolume, 'cacheVolume');
  assertUser(user);
  if (typeof command !== 'string' || !command.trim() || command.includes('\0')) throw new Error('command is required');
  if (phase === 'install') assertName(network, 'network');
  const mounts = { worktree, inputDir, outputDir };
  for (const [label, path] of Object.entries(mounts)) mounts[label] = assertDockerMountSource(path, { dataDir, realHome });
  const { src, work, input, output, cache, tmp } = DOCKER_CONTAINMENT_PATHS;
  const env = buildDockerContainmentEnv({
    phase,
    proxyUrl: phase === 'install' ? `http://${DOCKER_CONTAINMENT_PROXY_ALIAS}:${DOCKER_CONTAINMENT_PROXY_PORT}` : null,
  });
  return [
    'run', '--rm', '--pull', 'never', '--init',
    '--name', containerName,
    '--label', `${DOCKER_CONTAINMENT_LABEL}=${runId}`,
    '--network', phase === 'install' ? network : 'none',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '--user', user,
    '--cpus', String(limits.cpus),
    '--memory', `${limits.memoryMb}m`,
    '--memory-swap', `${limits.memoryMb}m`,
    '--pids-limit', String(limits.pids),
    '--ulimit', `fsize=${limits.maxFileBytes}:${limits.maxFileBytes}`,
    '--ulimit', 'core=0:0',
    '--tmpfs', `${tmp}:rw,nosuid,nodev,exec,size=${limits.tmpfsMb}m,mode=1777`,
    ...Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    '--workdir', work,
    '--mount', `type=bind,source=${mounts.worktree},target=${src},readonly`,
    '--mount', `type=bind,source=${mounts.inputDir},target=${input},readonly`,
    '--mount', `type=bind,source=${mounts.outputDir},target=${output}`,
    // volume-nocopy: an empty volume would otherwise take the root ownership of
    // the image's (absent) mountpoint, undoing the init container's chown.
    '--mount', `type=volume,source=${workVolume},target=${work},volume-nocopy`,
    '--mount', `type=volume,source=${cacheVolume},target=${cache},volume-nocopy${phase === 'validate' ? ',readonly' : ''}`,
    '--entrypoint', '/bin/sh',
    image,
    '-c', DOCKER_CONTAINMENT_DRIVER, 'portos-contained', phase, command,
  ];
}

/** `docker volume create` argv for a labeled volume. */
export function buildDockerContainmentVolumeCreateArgs({ name, runId, worktreeKey = null, createdAtMs }) {
  assertName(name, 'volume name');
  assertName(runId, 'runId');
  return [
    'volume', 'create',
    '--label', `${DOCKER_CONTAINMENT_LABEL}=${runId}`,
    ...(worktreeKey ? ['--label', `${DOCKER_CONTAINMENT_WORKTREE_LABEL}=${worktreeKey}`] : []),
    '--label', `${DOCKER_CONTAINMENT_CREATED_LABEL}=${Math.trunc(createdAtMs)}`,
    name,
  ];
}

/**
 * A fresh named volume is root-owned; this fixed, trusted command hands it to
 * the run user. It is the only container that starts as root, holds only
 * CHOWN, has no network, and runs no repository code.
 */
export function buildDockerContainmentVolumeInitArgs({ image, containerName, runId, volumes, user }) {
  assertImage(image);
  assertName(containerName, 'containerName');
  assertName(runId, 'runId');
  assertUser(user);
  if (!Array.isArray(volumes) || volumes.length === 0) throw new Error('volumes are required');
  volumes.forEach((volume) => assertName(volume, 'volume'));
  return [
    'run', '--rm', '--pull', 'never',
    '--name', containerName,
    '--label', `${DOCKER_CONTAINMENT_LABEL}=${runId}`,
    '--network', 'none',
    '--cap-drop', 'ALL', '--cap-add', 'CHOWN',
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '--user', '0:0',
    '--memory', '64m', '--pids-limit', '16',
    ...volumes.flatMap((volume, index) => ['--mount', `type=volume,source=${volume},target=/v${index}`]),
    '--entrypoint', 'chown',
    image,
    user, ...volumes.map((_, index) => `/v${index}`),
  ];
}

/**
 * `docker create` argv for the install phase's egress proxy: the same
 * hardening, its own small limits, attached first to the run's internal
 * network under the alias the install container dials. The executor then
 * connects it to the egress bridge and starts it.
 */
export function buildDockerEgressProxyCreateArgs({ image, containerName, runId, network, allowlist, source, user = DOCKER_CONTAINMENT_FALLBACK_USER }) {
  assertImage(image);
  assertName(containerName, 'containerName');
  assertName(runId, 'runId');
  assertName(network, 'network');
  assertUser(user);
  const hosts = (allowlist ?? []).filter(isEgressHostname);
  if (hosts.length === 0) throw new Error('the egress allowlist is empty');
  if (typeof source !== 'string' || !source) throw new Error('proxy source is required');
  return [
    'create', '--rm', '--pull', 'never', '--init',
    '--name', containerName,
    '--label', `${DOCKER_CONTAINMENT_LABEL}=${runId}`,
    '--network', network,
    '--network-alias', DOCKER_CONTAINMENT_PROXY_ALIAS,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '--user', user,
    '--cpus', '0.5', '--memory', '128m', '--memory-swap', '128m', '--pids-limit', '64',
    '--env', `PORTOS_EGRESS_ALLOW=${hosts.join(',')}`,
    '--env', `PORTOS_EGRESS_PORT=${DOCKER_CONTAINMENT_PROXY_PORT}`,
    '--entrypoint', 'node',
    image,
    '-e', source,
  ];
}

/** `docker network create` argv for one run's internal (no-gateway) network. */
export function buildDockerContainmentNetworkArgs({ name, runId, internal = true }) {
  assertName(name, 'network name');
  assertName(runId, 'runId');
  return ['network', 'create', ...(internal ? ['--internal'] : []), '--label', `${DOCKER_CONTAINMENT_LABEL}=${runId}`, name];
}
