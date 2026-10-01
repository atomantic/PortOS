import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PATHS } from './paths.js';
import {
  SUPERCOLLIDER_IMAGE,
  SUPERCOLLIDER_POLICY_FINGERPRINT,
  SUPERCOLLIDER_POLICY_VERSION,
  SUPERCOLLIDER_RECIPE_DIR,
  SUPERCOLLIDER_RUNTIME_VERSION,
  SUPERCOLLIDER_VERSION,
  buildSuperColliderRunArgs,
  evaluateSuperColliderStatus,
  hashSuperColliderRecipe,
  superColliderContainerUser,
} from './superColliderRuntime.js';

const recipeFile = (name) => readFileSync(join(PATHS.root, SUPERCOLLIDER_RECIPE_DIR, name), 'utf8');
const runArgs = (overrides = {}) => buildSuperColliderRunArgs({
  containerName: 'portos-sc-test', inputDir: '/srv/jobs/a/in', outputDir: '/srv/jobs/a/out', user: '1000:1000', ...overrides,
});
const flagValues = (args, flag) => args.flatMap((arg, i) => (arg === flag ? [args[i + 1]] : []));

describe('SuperCollider containment policy', () => {
  it('runs generated source with no network, privileges, writable root, host env or docker socket', () => {
    const args = runArgs({ scriptArgs: ['/out/render.wav', 4, 48000] });
    expect(args.slice(0, 3)).toEqual(['run', '--rm', '--pull']);
    expect(flagValues(args, '--pull')).toEqual(['never']);
    expect(flagValues(args, '--network')).toEqual(['none']);
    expect(flagValues(args, '--cap-drop')).toEqual(['ALL']);
    expect(flagValues(args, '--security-opt')).toEqual(['no-new-privileges']);
    expect(args).toContain('--read-only');
    expect(args).toContain('--init');
    expect(flagValues(args, '--user')).toEqual(['1000:1000']);
    for (const flag of ['--cpus', '--memory', '--memory-swap', '--pids-limit']) expect(flagValues(args, flag)).toHaveLength(1);
    // A bare `--env NAME` would forward the server's own value (credentials included).
    expect(flagValues(args, '--env').every((pair) => /^[A-Z_]+=/.test(pair))).toBe(true);
    expect(flagValues(args, '--env')).toContain('HOME=/tmp');
    expect(args.some((arg) => /docker\.sock|privileged|--volume|^-v$/.test(arg))).toBe(false);
    expect(flagValues(args, '--mount')).toEqual([
      'type=bind,source=/srv/jobs/a/in,target=/in,readonly',
      'type=bind,source=/srv/jobs/a/out,target=/out',
    ]);
    // Stock-only class library; the script's argv are plain argv entries after it.
    expect(args.slice(args.indexOf(SUPERCOLLIDER_IMAGE))).toEqual([
      SUPERCOLLIDER_IMAGE, '-l', '/opt/portos/sclang_conf.yaml', '/in/score.scd', '/out/render.wav', '4', '48000',
    ]);
  });

  it('refuses inputs that would widen the boundary', () => {
    expect(() => runArgs({ user: '0:0' })).toThrow('non-root');
    expect(() => runArgs({ outputDir: '/srv/out,target=/etc' })).toThrow('cannot mount');
    expect(() => runArgs({ inputDir: 'relative/in' })).toThrow('absolute');
    expect(() => runArgs({ script: '../escape.scd' })).toThrow('plain .scd');
    expect(() => runArgs({ containerName: '--privileged' })).toThrow('container name');
    expect(runArgs({ inputDir: 'C:\\portos\\in' })).toContain('type=bind,source=C:\\portos\\in,target=/in,readonly');
  });

  it('maps the host user, but never runs as root', () => {
    expect(superColliderContainerUser({ uid: 1000, gid: 1000 })).toBe('1000:1000');
    expect(superColliderContainerUser({ uid: 0, gid: 0 })).toBe('65534:65534');
    expect(superColliderContainerUser({})).toBe('65534:65534');
  });
});

describe('SuperCollider recipe pins', () => {
  it('agrees with the runtime constants and pins every input', () => {
    const dockerfile = recipeFile('Dockerfile');
    expect(dockerfile).toContain(`ARG SC_VERSION=${SUPERCOLLIDER_VERSION}\n`);
    expect(SUPERCOLLIDER_RUNTIME_VERSION.startsWith(`${SUPERCOLLIDER_VERSION}-portos.`)).toBe(true);
    const sha = dockerfile.match(/ARG SC_SOURCE_SHA256=([0-9a-f]{64})\n/)?.[1];
    expect(sha).toBeTruthy();
    expect(recipeFile('NOTICE.md')).toContain(sha);
    expect(dockerfile).toMatch(/ARG DEBIAN_IMAGE=debian:[\w.-]+@sha256:[0-9a-f]{64}\n/);
    expect(dockerfile).toMatch(/ARG DEBIAN_SNAPSHOT=\d{8}T\d{6}Z\n/);
    expect(dockerfile).toContain('sha256sum -c');
    expect(recipeFile('sclang_conf.yaml')).toMatch(/excludeDefaultPaths: true/);
  });

  it('hashes a CRLF checkout of the recipe like the LF original', () => {
    const lf = [{ name: 'Dockerfile', content: 'FROM a\nRUN b\n' }, { name: 'NOTICE.md', content: 'x\n' }];
    const crlf = [...lf].reverse().map((file) => ({ ...file, content: file.content.replace(/\n/g, '\r\n') }));
    expect(hashSuperColliderRecipe(crlf)).toBe(hashSuperColliderRecipe(lf));
    expect(hashSuperColliderRecipe([{ name: 'Dockerfile', content: 'FROM c\n' }])).not.toBe(hashSuperColliderRecipe(lf));
  });
});

describe('evaluateSuperColliderStatus', () => {
  const recipeHash = 'recipe-1';
  const docker = { installed: true, running: true, serverVersion: '27.0.0', os: 'linux', arch: 'arm64', error: null };
  const image = { id: 'sha256:image-1', runtimeVersion: SUPERCOLLIDER_RUNTIME_VERSION, recipeHash, os: 'linux', arch: 'arm64' };
  const evidence = {
    ok: true, error: null, checkedAt: '2026-01-01T00:00:00.000Z', imageId: image.id,
    runtimeVersion: SUPERCOLLIDER_RUNTIME_VERSION, policyVersion: SUPERCOLLIDER_POLICY_VERSION, policyFingerprint: SUPERCOLLIDER_POLICY_FINGERPRINT,
  };
  const state = (input) => evaluateSuperColliderStatus({ docker, image, evidence, recipeHash, ...input });

  it('is ready only with a reachable Linux engine, the current image and current passing evidence', () => {
    expect(state({})).toMatchObject({ state: 'ready', ready: true, action: null, smoke: { current: true } });
    expect(state({ docker: { installed: false, running: false } })).toMatchObject({ state: 'docker-missing', ready: false });
    expect(state({ docker: { ...docker, running: false, error: 'Cannot connect' } }).message).toContain('Cannot connect');
    expect(state({ docker: { ...docker, os: 'windows' } }).state).toBe('docker-unsupported');
    expect(state({ docker: { ...docker, arch: 's390x' } })).toMatchObject({ state: 'docker-unsupported', action: null });
    expect(state({ image: null }).state).toBe('image-missing');
    expect(state({ evidence: null }).state).toBe('unverified');
    expect(state({ evidence: { ...evidence, ok: false, error: 'the render is silent' } })).toMatchObject({ state: 'smoke-failed', message: expect.stringContaining('silent') });
  });

  it('voids evidence and images from another runtime, recipe, policy or image', () => {
    expect(state({ image: { ...image, runtimeVersion: '3.13.0-portos.1' } }).state).toBe('image-stale');
    expect(state({ recipeHash: 'recipe-2' }).state).toBe('image-stale');
    for (const stale of [
      { runtimeVersion: '3.13.0-portos.1' },
      { policyVersion: SUPERCOLLIDER_POLICY_VERSION - 1 },
      { policyFingerprint: 'edited-policy' },
      { imageId: 'sha256:rebuilt' },
    ]) {
      expect(state({ evidence: { ...evidence, ...stale } })).toMatchObject({ state: 'unverified', smoke: { current: false } });
    }
    // A stale failure is not reported as a current one either.
    expect(state({ evidence: { ...evidence, ok: false, imageId: 'sha256:rebuilt' } }).state).toBe('unverified');
  });
});
