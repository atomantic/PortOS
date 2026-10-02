/**
 * The managed SuperCollider runtime contract (#9412, epic #9407) — pure: no
 * filesystem, no docker, no clock. `services/superColliderRuntime.js` does the
 * I/O; the render service and the Music Designer UI import the constants and
 * `evaluateSuperColliderStatus` from here so every surface agrees on what
 * "ready" means.
 *
 * Three things decide readiness, and each invalidates the next:
 *   1. a reachable Linux Docker engine on a supported architecture,
 *   2. the PortOS-built image, stamped with the runtime version and the hash of
 *      the checked-in recipe (`docker/supercollider/`) it was built from,
 *   3. passing synthetic-render evidence recorded against THAT image id, this
 *      runtime version and this containment policy.
 * A recipe edit, a runtime bump, a policy change or a rebuilt image therefore
 * voids older evidence instead of letting a stale "ready" stand.
 *
 * Generated SuperCollider source is untrusted: `sclang` can run shell commands
 * and load startup files. `buildSuperColliderRunArgs` is the ONE place the
 * container boundary is spelled out, so the readiness probe and real renders
 * run under the same policy.
 */

import { createHash } from 'crypto';

export const SUPERCOLLIDER_VERSION = '3.14.1';
/** Bump with any change to the recipe's pinned inputs (its test checks the Dockerfile agrees). */
export const SUPERCOLLIDER_RUNTIME_VERSION = `${SUPERCOLLIDER_VERSION}-portos.1`;
/** Bump when the containment policy or synthetic probe changes meaning; the fingerprint below also catches unbumped edits. */
export const SUPERCOLLIDER_POLICY_VERSION = 1;

export const SUPERCOLLIDER_IMAGE_REPOSITORY = 'portos-supercollider';
export const SUPERCOLLIDER_IMAGE = `${SUPERCOLLIDER_IMAGE_REPOSITORY}:${SUPERCOLLIDER_RUNTIME_VERSION}`;
/** Recipe directory, relative to the PortOS code root. */
export const SUPERCOLLIDER_RECIPE_DIR = 'docker/supercollider';
export const SUPERCOLLIDER_SETUP_COMMAND = 'npm run setup:supercollider -- --yes';

export const SUPERCOLLIDER_IMAGE_LABELS = Object.freeze({
  runtimeVersion: 'org.portos.supercollider.runtime-version',
  recipeHash: 'org.portos.supercollider.recipe-sha256',
});
/** Every render container carries this label, so an orphan sweep can find them. */
export const SUPERCOLLIDER_CONTAINER_LABEL = 'org.portos.supercollider.render';

/** Docker server architectures the recipe builds for; anything else is visibly unsupported. */
export const SUPERCOLLIDER_SUPPORTED_ARCHITECTURES = Object.freeze(['amd64', 'arm64']);

/** The fixed render format the trusted runner supplies (generated source never chooses it). */
export const SUPERCOLLIDER_RENDER_FORMAT = Object.freeze({ sampleRate: 48_000, channels: 2 });

export const SUPERCOLLIDER_CONTAINER_LIMITS = Object.freeze({
  cpus: '2',
  memory: '1g',
  pids: 64,
  tmpfsBytes: 64 * 1024 * 1024,
  // Per-file write ceiling (RLIMIT_FSIZE): a 120 s stereo 48 kHz float32 render is ~46 MB.
  maxFileBytes: 128 * 1024 * 1024,
  wallTimeoutMs: 180_000,
});

/** In-container paths: frozen source (read-only), job-private output, stock-only class library config. */
export const SUPERCOLLIDER_CONTAINER_PATHS = Object.freeze({
  input: '/in',
  output: '/out',
  libraryConfig: '/opt/portos/sclang_conf.yaml',
  home: '/tmp',
});

/** Container user when the host has no POSIX uid (Windows) or runs as root: `nobody`. */
export const SUPERCOLLIDER_FALLBACK_USER = '65534:65534';

const SCRIPT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.scd$/;
const CONTAINER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

// `--mount` is a comma-separated key=value list, so a comma (or a control
// character) in a host path would let the path inject mount options.
function assertMountablePath(path, label) {
  if (typeof path !== 'string' || !path) throw new Error(`${label} is required`);
  if (!/^(\/|[A-Za-z]:[\\/])/.test(path)) throw new Error(`${label} must be absolute`);
  if (/[,\0-\x1f"]/.test(path)) throw new Error(`${label} contains a character docker cannot mount`);
}

/**
 * The container user for a host process: its own uid:gid, so bind-mounted
 * output stays owned by the PortOS user, except root (never run generated code
 * as uid 0) and hosts without POSIX ids.
 */
export function superColliderContainerUser({ uid, gid } = {}) {
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid === 0) return SUPERCOLLIDER_FALLBACK_USER;
  return `${uid}:${gid}`;
}

/**
 * `docker run` argv for ONE contained `sclang` execution of `/in/<script>`.
 *
 * Boundary: no network, no capabilities, no privilege escalation, read-only
 * root, private tmpfs home/temp, CPU/memory/PID/file-size limits, a non-root
 * user, an environment of explicit values only (the docker CLI never forwards
 * the server's own variables), no Docker socket, the frozen input directory
 * read-only and only the job output directory writable. `--pull never` keeps a
 * missing local image from being fetched by name from a registry; `--init`
 * reaps the `scsynth` that `sclang` spawns; `--rm` plus the caller's
 * `docker rm -f <name>` remove the whole container — every descendant
 * included — on exit, timeout or cancel. `scriptArgs` reach the script as
 * `thisProcess.argv`; they are argv entries, never shell text.
 */
export function buildSuperColliderRunArgs({
  image = SUPERCOLLIDER_IMAGE,
  containerName,
  inputDir,
  outputDir,
  script = 'score.scd',
  scriptArgs = [],
  user = SUPERCOLLIDER_FALLBACK_USER,
  limits = SUPERCOLLIDER_CONTAINER_LIMITS,
}) {
  if (!CONTAINER_NAME_RE.test(String(containerName ?? ''))) throw new Error('containerName must be a docker container name');
  if (!SCRIPT_NAME_RE.test(String(script))) throw new Error('script must be a plain .scd file name');
  if (!/^\d+:\d+$/.test(String(user)) || String(user).startsWith('0:')) throw new Error('user must be a non-root uid:gid');
  assertMountablePath(inputDir, 'inputDir');
  assertMountablePath(outputDir, 'outputDir');
  const argv = scriptArgs.map((arg) => {
    const text = String(arg);
    if (text.includes('\0')) throw new Error('script arguments cannot contain NUL');
    return text;
  });
  const { home, input, output, libraryConfig } = SUPERCOLLIDER_CONTAINER_PATHS;
  return [
    'run', '--rm', '--pull', 'never', '--init',
    '--name', containerName,
    '--label', `${SUPERCOLLIDER_CONTAINER_LABEL}=1`,
    '--network', 'none',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '--user', user,
    '--cpus', limits.cpus,
    '--memory', limits.memory,
    '--memory-swap', limits.memory,
    '--pids-limit', String(limits.pids),
    '--ulimit', `fsize=${limits.maxFileBytes}:${limits.maxFileBytes}`,
    '--ulimit', 'core=0:0',
    '--tmpfs', `${home}:rw,nosuid,nodev,noexec,size=${limits.tmpfsBytes},mode=1777`,
    '--env', `HOME=${home}`,
    '--env', `XDG_CONFIG_HOME=${home}/.config`,
    '--env', `XDG_DATA_HOME=${home}/.local/share`,
    '--env', `XDG_CACHE_HOME=${home}/.cache`,
    '--env', 'LANG=C.UTF-8',
    '--workdir', home,
    '--mount', `type=bind,source=${inputDir},target=${input},readonly`,
    '--mount', `type=bind,source=${outputDir},target=${output}`,
    '--entrypoint', 'sclang',
    image,
    '-l', libraryConfig,
    `${input}/${script}`,
    ...argv,
  ];
}

/**
 * The shipped synthetic readiness probe: a stock-UGen SynthDef rendered
 * through a non-realtime Score at the runner-supplied path, duration and rate
 * (`thisProcess.argv`). It writes distinct tones per channel, so evidence shows
 * both channels carry audio. Any error exits non-zero instead of leaving
 * `sclang` idling until the wall-time limit.
 */
export const SUPERCOLLIDER_SMOKE_SOURCE = `var argv = thisProcess.argv;
var outPath = argv[0];
var duration = argv[1].asFloat;
var sampleRate = argv[2].asInteger;
{
	var def = SynthDef(\\portosSmoke, { |out = 0, freq = 220, amp = 0.25|
		var env = EnvGen.kr(Env.linen(0.05, duration - 0.3, 0.2, amp));
		Out.ar(out, SinOsc.ar([freq, freq * 1.5]) * env);
	});
	var options = ServerOptions.new.numOutputBusChannels_(2).numInputBusChannels_(0);
	Score([
		[0.0, ['/d_recv', def.asBytes]],
		[0.0, ['/s_new', \\portosSmoke, 1000, 0, 0, \\freq, 220]],
		[duration, ['/n_free', 1000]]
	]).recordNRT(nil, outPath, nil, sampleRate, "WAV", "int16", options, "", duration, { |exitCode| exitCode.exit });
}.try { |error| error.reportError; 1.exit };
`;

/** What the probe renders, and what its measured output must show. */
export const SUPERCOLLIDER_SMOKE = Object.freeze({
  script: 'smoke.scd',
  output: 'smoke.wav',
  durationSec: 2,
  timeoutMs: 120_000,
  // Duration tolerance covers NRT block rounding; -40 dBFS is unmistakably not silence.
  durationToleranceMs: 50,
  minPeak: 0.01,
});

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/**
 * Fingerprint of the containment policy plus the probe, recorded with each
 * smoke result. Evidence from a different fingerprint is stale even if someone
 * edited the run args without bumping SUPERCOLLIDER_POLICY_VERSION.
 */
export const SUPERCOLLIDER_POLICY_FINGERPRINT = sha256(JSON.stringify({
  version: SUPERCOLLIDER_POLICY_VERSION,
  args: buildSuperColliderRunArgs({ containerName: 'fingerprint', inputDir: '/in-host', outputDir: '/out-host' }),
  smoke: SUPERCOLLIDER_SMOKE_SOURCE,
  probe: SUPERCOLLIDER_SMOKE,
  format: SUPERCOLLIDER_RENDER_FORMAT,
}));

/**
 * SHA-256 over the recipe files, name-sorted with line endings normalized, so a
 * Windows CRLF checkout of the same recipe hashes the same.
 * @param {{name: string, content: string}[]} files
 */
export function hashSuperColliderRecipe(files) {
  const hash = createHash('sha256');
  for (const { name, content } of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(`${name}\0${String(content).replace(/\r\n?/g, '\n')}\0`);
  }
  return hash.digest('hex');
}

/**
 * `docker build` argv that stamps the runtime version and recipe hash on the
 * image. `noCache` is the repair path: rebuild every layer instead of reusing
 * a cached (possibly broken) one.
 */
export function buildSuperColliderBuildArgs({ recipeDir, recipeHash, noCache = false }) {
  return [
    'build',
    ...(noCache ? ['--no-cache'] : []),
    '--tag', SUPERCOLLIDER_IMAGE,
    '--label', `${SUPERCOLLIDER_IMAGE_LABELS.runtimeVersion}=${SUPERCOLLIDER_RUNTIME_VERSION}`,
    '--label', `${SUPERCOLLIDER_IMAGE_LABELS.recipeHash}=${recipeHash}`,
    recipeDir,
  ];
}

/** Parse `docker version --format '{{json .}}'` → `{ clientVersion, serverVersion, os, arch }` (nulls when absent). */
export function parseDockerVersion(stdout) {
  let parsed = null;
  try { parsed = JSON.parse(String(stdout || '').trim()); } catch { parsed = null; }
  return {
    clientVersion: parsed?.Client?.Version ?? null,
    serverVersion: parsed?.Server?.Version ?? null,
    os: parsed?.Server?.Os ?? null,
    arch: parsed?.Server?.Arch ?? null,
  };
}

/** Parse `docker image inspect --format '{{json .}}'` → the image fields status needs, or null. */
export function parseDockerImage(stdout) {
  let parsed = null;
  try { parsed = JSON.parse(String(stdout || '').trim()); } catch { return null; }
  if (Array.isArray(parsed)) parsed = parsed[0];
  if (!parsed?.Id) return null;
  const labels = parsed.Config?.Labels ?? {};
  return {
    id: parsed.Id,
    created: parsed.Created ?? null,
    sizeBytes: Number.isFinite(parsed.Size) ? parsed.Size : null,
    os: parsed.Os ?? null,
    arch: parsed.Architecture ?? null,
    runtimeVersion: labels[SUPERCOLLIDER_IMAGE_LABELS.runtimeVersion] ?? null,
    recipeHash: labels[SUPERCOLLIDER_IMAGE_LABELS.recipeHash] ?? null,
  };
}

/**
 * Judge a measured probe render (`measureWavAudio` output) against the fixed
 * format and duration. Returns null when it passes, else the reason.
 */
export function superColliderSmokeFailure(measurement, { durationSec = SUPERCOLLIDER_SMOKE.durationSec } = {}) {
  if (!measurement) return 'no readable WAV was written';
  const { sampleRate, channels } = SUPERCOLLIDER_RENDER_FORMAT;
  if (measurement.channels !== channels) return `expected ${channels} channels, got ${measurement.channels}`;
  if (measurement.sampleRate !== sampleRate) return `expected ${sampleRate} Hz, got ${measurement.sampleRate} Hz`;
  if (Math.abs(measurement.durationMs - durationSec * 1000) > SUPERCOLLIDER_SMOKE.durationToleranceMs) {
    return `expected ${durationSec * 1000} ms of audio, got ${measurement.durationMs} ms`;
  }
  if (measurement.nonFinite > 0) return `${measurement.nonFinite} non-finite samples`;
  if (measurement.peak < SUPERCOLLIDER_SMOKE.minPeak) return 'the render is silent';
  return null;
}

/**
 * The bounded render the Music Designer asks for (#9413). Duration is the Code
 * panel's 4–120 s take window; format, tempo and every path come from the
 * trusted runner, never from the source.
 */
export const SUPERCOLLIDER_RENDER = Object.freeze({
  minDurationSec: 4,
  maxDurationSec: 120,
  tempoBpm: 120,
  maxSeed: 2_147_483_647,
  wrapper: 'render.scd',
  source: 'source.scd',
  output: 'render.wav',
});

/**
 * The trusted render wrapper. It compiles the untrusted source file without
 * executing anything on a parse error, seeds the interpreter, evaluates the
 * source (its last expression must be a Pattern), scores that pattern for
 * exactly the requested duration at the fixed tempo, sends every SynthDef the
 * source `.add`ed (plus the stock `\\default`), and renders 48 kHz stereo
 * float through non-realtime scsynth. It runs INSIDE the same container as the
 * source — it is a convenience contract, not a security boundary.
 *
 * `thisProcess.argv`: source path, output path, duration (s), sample rate,
 * seed, beat length (s). Each failure prints ONE
 * `PORTOS_RENDER_ERROR <kind>: <message>` line and exits non-zero, so the
 * host can tell a syntax error from a runtime error from a failed synthesis.
 */
export const SUPERCOLLIDER_RENDER_WRAPPER_SOURCE = `var argv = thisProcess.argv;
var sourcePath = argv[0];
var outPath = argv[1];
var duration = argv[2].asFloat;
var sampleRate = argv[3].asInteger;
var seed = argv[4].asInteger;
var stretch = argv[5].asFloat;
var fail = { |kind, code, message|
	("PORTOS_RENDER_ERROR " ++ kind ++ ": " ++ message).postln;
	code.exit;
};
var compiled, pattern, problem, defs, proto, score, options;
"PORTOS_PHASE compiling".postln;
compiled = thisProcess.interpreter.compileFile(sourcePath);
if(compiled.isNil) {
	fail.("syntax", 65, "the source has a syntax error");
} {
	thisThread.randSeed = seed;
	{ pattern = compiled.value }.try { |error|
		error.reportError;
		problem = error.errorString;
	};
	if(problem.notNil) {
		fail.("source", 67, "the source raised an error: " ++ problem);
	} {
		if(pattern.isKindOf(Pattern).not) {
			fail.("pattern", 66, "the source must end with a pattern expression (Pbind, Ppar, Pseq, ...); its last value was a " ++ pattern.class.name);
		} {
			{
				"PORTOS_PHASE scoring".postln;
				defs = List.new;
				SynthDescLib.global.synthDescs.do { |desc|
					desc.def !? { |def| defs.add([0.0, [\\d_recv, def.asBytes]]) };
				};
				proto = Event.default;
				proto[\\stretch] = stretch;
				score = pattern.asScore(duration, 0, proto);
				score = Score(defs.asArray ++ score.score);
				options = ServerOptions.new.numOutputBusChannels_(2).numInputBusChannels_(0).sampleRate_(sampleRate);
				"PORTOS_PHASE rendering".postln;
				score.recordNRT(nil, outPath, nil, sampleRate, "WAV", "float", options, "", duration, { |exitCode|
					if(exitCode == 0) { 0.exit } { fail.("synthesis", 70, "scsynth exited with code " ++ exitCode) };
				});
			}.try { |error|
				error.reportError;
				fail.("score", 68, "the pattern could not be scored: " ++ error.errorString);
			};
		};
	};
};
`;

const RENDER_ERROR_RE = /^PORTOS_RENDER_ERROR (syntax|source|pattern|score|synthesis): (.*)$/;
const SCLANG_DIAGNOSTIC_RE = /^ERROR:|^\s*line \d+ char \d+/;
export const SUPERCOLLIDER_RENDER_ERROR_CODES = Object.freeze({
  syntax: 'SUPERCOLLIDER_SYNTAX_ERROR',
  source: 'SUPERCOLLIDER_SOURCE_ERROR',
  pattern: 'SUPERCOLLIDER_NOT_A_PATTERN',
  score: 'SUPERCOLLIDER_SCORE_ERROR',
  synthesis: 'SUPERCOLLIDER_SYNTHESIS_FAILED',
});

/** Is this sclang output line one the failure classifier reads? (Lets the runner keep only those.) */
export const isSuperColliderDiagnosticLine = (line) => RENDER_ERROR_RE.test(line) || SCLANG_DIAGNOSTIC_RE.test(line);

/**
 * Classify a failed render from the wrapper's output: the LAST
 * `PORTOS_RENDER_ERROR` marker names the kind, and sclang's own `ERROR:` /
 * `line N char M` lines are the detail (where a syntax error is). Null when the
 * wrapper never reported (crash, kill, timeout).
 * @param {string[]} lines
 * @returns {{ kind: string, code: string, message: string, detail: string } | null}
 */
export function classifySuperColliderRenderLog(lines) {
  let marker = null;
  const detail = [];
  for (const line of lines) {
    const match = RENDER_ERROR_RE.exec(line);
    if (match) marker = { kind: match[1], message: match[2] };
    else if (SCLANG_DIAGNOSTIC_RE.test(line) && detail.length < 4) detail.push(line.trim());
  }
  if (!marker) return null;
  return { ...marker, code: SUPERCOLLIDER_RENDER_ERROR_CODES[marker.kind], detail: detail.join(' ') };
}

/**
 * Parse `docker ps --format '{{json .}}'` (one object per line) into
 * `[{ name, createdAtMs }]`; `createdAtMs` is null when docker's
 * `2006-01-02 15:04:05 -0700 MST` timestamp cannot be read, so a caller can
 * refuse to judge that container's age.
 */
export function parseDockerContainerList(stdout) {
  return String(stdout || '').split('\n').flatMap((line) => {
    let row;
    try { row = JSON.parse(line); } catch { return []; }
    const name = String(row?.Names ?? '').split(',')[0].trim();
    if (!name) return [];
    const stamp = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)? ([+-])(\d{2})(\d{2})\b/.exec(String(row?.CreatedAt ?? ''));
    const createdAtMs = stamp ? Date.parse(`${stamp[1]}T${stamp[2]}${stamp[3]}${stamp[4]}:${stamp[5]}`) : NaN;
    return [{ name, createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : null }];
  });
}

/** Does recorded evidence describe THIS runtime, policy and image? */
function isSuperColliderEvidenceCurrent(evidence, image) {
  return Boolean(evidence && image?.id
    && evidence.runtimeVersion === SUPERCOLLIDER_RUNTIME_VERSION
    && evidence.policyVersion === SUPERCOLLIDER_POLICY_VERSION
    && evidence.policyFingerprint === SUPERCOLLIDER_POLICY_FINGERPRINT
    && evidence.imageId === image.id);
}

/**
 * The one readiness verdict: `{ state, ready, message, action, docker, image,
 * runtime, smoke }`. `state` is one of docker-missing, docker-stopped,
 * docker-unsupported, image-missing, image-stale, unverified, smoke-failed,
 * ready. Status only READS cached evidence — it never builds or renders.
 *
 * @param {object} input
 * @param {{installed: boolean, running: boolean, serverVersion?: string|null, os?: string|null, arch?: string|null, error?: string|null}} input.docker
 * @param {ReturnType<typeof parseDockerImage>} [input.image]
 * @param {object|null} [input.evidence] - the last recorded smoke result
 * @param {string} input.recipeHash - hash of the checked-in recipe
 */
export function evaluateSuperColliderStatus({ docker, image = null, evidence = null, recipeHash }) {
  const imageCurrent = Boolean(image
    && image.runtimeVersion === SUPERCOLLIDER_RUNTIME_VERSION
    && image.recipeHash === recipeHash);
  const evidenceCurrent = imageCurrent && isSuperColliderEvidenceCurrent(evidence, image);
  const verdict = (state, message, action = SUPERCOLLIDER_SETUP_COMMAND) => ({
    state,
    ready: state === 'ready',
    message,
    action: state === 'ready' ? null : action,
    docker,
    image: image ? { ...image, current: imageCurrent } : null,
    runtime: {
      version: SUPERCOLLIDER_RUNTIME_VERSION,
      supercollider: SUPERCOLLIDER_VERSION,
      policyVersion: SUPERCOLLIDER_POLICY_VERSION,
      image: SUPERCOLLIDER_IMAGE,
    },
    smoke: evidence ? { ...evidence, current: evidenceCurrent } : null,
  });

  if (!docker?.installed) {
    return verdict('docker-missing', 'Docker is not installed. Install Docker Desktop (macOS/Windows) or Docker Engine (Linux) and start it — PortOS never installs or reconfigures Docker for you.',
      'Install and start Docker, then run: ' + SUPERCOLLIDER_SETUP_COMMAND);
  }
  if (!docker.running) {
    return verdict('docker-stopped', `Docker is installed but its engine is not reachable${docker.error ? ` (${docker.error})` : ''}. Start Docker and try again.`,
      'Start Docker, then run: ' + SUPERCOLLIDER_SETUP_COMMAND);
  }
  if (docker.os !== 'linux') {
    return verdict('docker-unsupported', `Docker is serving ${docker.os || 'unknown'} containers; the SuperCollider runtime needs Linux containers.`,
      'Switch Docker to Linux containers, then run: ' + SUPERCOLLIDER_SETUP_COMMAND);
  }
  if (!SUPERCOLLIDER_SUPPORTED_ARCHITECTURES.includes(docker.arch)) {
    return verdict('docker-unsupported', `Docker reports architecture ${docker.arch || 'unknown'}; the SuperCollider runtime supports ${SUPERCOLLIDER_SUPPORTED_ARCHITECTURES.join(' and ')}.`, null);
  }
  if (!image) {
    return verdict('image-missing', `The managed SuperCollider ${SUPERCOLLIDER_VERSION} image has not been built on this machine.`);
  }
  if (!imageCurrent) {
    return verdict('image-stale', `The SuperCollider image was built from an older recipe (${image.runtimeVersion || 'unknown version'}); rebuild it for ${SUPERCOLLIDER_RUNTIME_VERSION}.`);
  }
  if (!evidenceCurrent) {
    return verdict('unverified', evidence
      ? 'The last synthetic render probe ran against a different image, runtime or containment policy; re-run setup to verify this one.'
      : 'The SuperCollider image is built but has not passed the synthetic render probe yet.');
  }
  if (!evidence.ok) {
    return verdict('smoke-failed', `The synthetic render probe failed: ${evidence.error || 'unknown error'}.`,
      `${SUPERCOLLIDER_SETUP_COMMAND} --rebuild`);
  }
  return verdict('ready', `SuperCollider ${SUPERCOLLIDER_VERSION} is ready (probe passed ${evidence.checkedAt}).`);
}
