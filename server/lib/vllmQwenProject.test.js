import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  VLLM_PROJECT_DIR_ENV,
  VLLM_WEIGHTS_DIR_ENV,
  inspectVllmQwenProject,
  readRecordedVllmProjectDir,
  recordVllmProjectDir,
  resolveVllmProjectDir,
  vllmDefaultProjectDir,
  vllmProjectDirIsSettled,
  vllmProjectSetupState,
  vllmStartBlockedReason,
} from './vllmQwenProject.js';

let root;
const projectDir = () => join(root, 'qwen-serving');
/**
 * The `.env` PortOS records a detected directory in — inside the sandbox, so
 * the developer's own install can never answer one of these assertions.
 */
const envPath = () => join(root, '.env');

/**
 * An env with HOME/USERPROFILE/HF_HOME pointed inside the sandbox. Without it,
 * the developer's own `~/.cache/huggingface/hub` is a readable candidate root
 * and the "nothing readable" case can never be exercised.
 */
const env = (extra = {}) => ({
  [VLLM_PROJECT_DIR_ENV]: projectDir(),
  HOME: join(root, 'home'),
  USERPROFILE: join(root, 'home'),
  HF_HOME: join(root, 'no-hf'),
  ...extra,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vllm-project-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('resolveVllmProjectDir', () => {
  it('prefers the operator override over upstream default', () => {
    expect(resolveVllmProjectDir({ [VLLM_PROJECT_DIR_ENV]: '/srv/qwen' })).toBe('/srv/qwen');
  });

  it('ignores a blank override rather than resolving to an empty path', () => {
    const home = { HOME: '/home/example', USERPROFILE: '/home/example' };
    expect(resolveVllmProjectDir({ ...home, [VLLM_PROJECT_DIR_ENV]: '   ' }, envPath()))
      .toBe(vllmDefaultProjectDir(home));
  });

  it('falls back to the directory PortOS recorded for itself', async () => {
    const home = { HOME: '/home/example', USERPROFILE: '/home/example' };
    const recorded = '\\\\wsl.localhost\\Ubuntu\\home\\alice\\qwen-serving';
    await recordVllmProjectDir(recorded, envPath());

    expect(readRecordedVllmProjectDir(envPath())).toBe(recorded);
    expect(resolveVllmProjectDir(home, envPath())).toBe(recorded);
    // An exported override still outranks it — that is this run's decision,
    // and a directory detected on some earlier run must not outlive it.
    expect(resolveVllmProjectDir({ ...home, [VLLM_PROJECT_DIR_ENV]: '/srv/qwen' }, envPath())).toBe('/srv/qwen');
  });

  it('rewrites its own record instead of appending a second line', async () => {
    writeFileSync(envPath(), 'PGPASSWORD=portos');
    await recordVllmProjectDir('/srv/first', envPath());
    await recordVllmProjectDir('/srv/second', envPath());

    const contents = readFileSync(envPath(), 'utf8');
    expect(contents.match(/^VLLM_QWEN_PROJECT_DIR=/gm)).toHaveLength(1);
    expect(readRecordedVllmProjectDir(envPath())).toBe('/srv/second');
    // The line it was appended after had no trailing newline — splicing onto it
    // would have corrupted both settings.
    expect(contents).toContain('PGPASSWORD=portos\n');
  });

  it('reports nothing settled until something answers', async () => {
    const bare = { HOME: '/home/example', USERPROFILE: '/home/example' };
    expect(vllmProjectDirIsSettled(bare, envPath())).toBe(false);

    expect(vllmProjectDirIsSettled({ ...bare, [VLLM_PROJECT_DIR_ENV]: '/srv/qwen' }, envPath())).toBe(true);

    await recordVllmProjectDir('/srv/recorded', envPath());
    expect(vllmProjectDirIsSettled(bare, envPath())).toBe(true);
  });
});

describe('inspectVllmQwenProject', () => {
  it('reports no project when the directory is absent', async () => {
    const project = await inspectVllmQwenProject(env(), envPath());
    expect(project).toMatchObject({ hasProject: false, composeFile: null });
    // Points at the checklist button that does the whole sequence, not at a
    // `git clone` the operator has to run themselves.
    expect(vllmStartBlockedReason(project)).toContain('Clone, build & prepare');
  });

  it('reports a directory with no compose file as not a project', async () => {
    mkdirSync(projectDir(), { recursive: true });
    const project = await inspectVllmQwenProject(env(), envPath());
    expect(project).toMatchObject({ hasProject: true, composeFile: null });
    expect(vllmStartBlockedReason(project)).toContain('no docker-compose file');
  });

  it('finds the compose file but blocks while no weights cache is readable', async () => {
    mkdirSync(projectDir(), { recursive: true });
    writeFileSync(join(projectDir(), 'docker-compose.yml'), 'services: {}\n');

    const project = await inspectVllmQwenProject(env(), envPath());
    expect(project.composeFile).toBe('docker-compose.yml');
    // `null`, not `false` — nothing was READ, which is a different fix than an
    // empty cache. The distinction is the point of the sentinel.
    expect(project.hasWeights).toBeNull();
    expect(vllmStartBlockedReason(project)).toContain('cannot read a models directory');
  });

  it('distinguishes a readable-but-empty cache from an unreadable one', async () => {
    mkdirSync(projectDir(), { recursive: true });
    writeFileSync(join(projectDir(), 'compose.yaml'), 'services: {}\n');
    mkdirSync(join(projectDir(), 'models'), { recursive: true });

    const project = await inspectVllmQwenProject(env(), envPath());
    expect(project).toMatchObject({ composeFile: 'compose.yaml', hasWeights: false });
    expect(vllmStartBlockedReason(project)).toContain('no Qwen weights are cached');
  });

  it('clears the block once a Qwen hub-cache entry is present', async () => {
    mkdirSync(projectDir(), { recursive: true });
    writeFileSync(join(projectDir(), 'docker-compose.yml'), 'services: {}\n');
    mkdirSync(join(projectDir(), 'models', 'models--syv-ai--Qwen3.8-27B-w4a16'), { recursive: true });

    const project = await inspectVllmQwenProject(env(), envPath());
    expect(project.hasWeights).toBe(true);
    expect(project.weightsRoot).toBe(join(projectDir(), 'models'));
    expect(vllmStartBlockedReason(project)).toBeNull();
  });

  it('clears the block for the local-dir layout upstream prepare actually writes', async () => {
    // `docker/prepare.sh` runs `hf download … --local-dir models/<model>`, so a
    // prepared machine has no `models--…` hub entry at all.
    mkdirSync(projectDir(), { recursive: true });
    writeFileSync(join(projectDir(), 'docker-compose.yml'), 'services: {}\n');
    const model = join(projectDir(), 'models', 'Qwen3.8-27B-W4A16-AutoRound');
    mkdirSync(model, { recursive: true });
    writeFileSync(join(model, 'model.safetensors.index.json'), '{"weight_map":{}}\n');

    const project = await inspectVllmQwenProject(env(), envPath());
    expect(project.hasWeights).toBe(true);
    expect(project.weightsRoot).toBe(join(projectDir(), 'models'));
    expect(vllmStartBlockedReason(project)).toBeNull();
  });

  it('accepts a single-file model directory (the DFlash2 drafter shape)', async () => {
    mkdirSync(projectDir(), { recursive: true });
    writeFileSync(join(projectDir(), 'docker-compose.yml'), 'services: {}\n');
    const model = join(projectDir(), 'models', 'Qwen3.8-27B-DFlash2-W4A16');
    mkdirSync(model, { recursive: true });
    writeFileSync(join(model, 'model.safetensors'), 'tensors\n');

    expect((await inspectVllmQwenProject(env(), envPath())).hasWeights).toBe(true);
  });

  it('does not count a qwen-named directory that holds no weight file', async () => {
    // Name matching alone would report a notes folder as a prepared model.
    mkdirSync(projectDir(), { recursive: true });
    writeFileSync(join(projectDir(), 'docker-compose.yml'), 'services: {}\n');
    const notes = join(projectDir(), 'models', 'qwen-notes');
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, 'README.md'), 'not weights\n');

    expect((await inspectVllmQwenProject(env(), envPath())).hasWeights).toBe(false);
  });

  it('ignores a cache holding only unrelated models', async () => {
    mkdirSync(projectDir(), { recursive: true });
    writeFileSync(join(projectDir(), 'docker-compose.yml'), 'services: {}\n');
    mkdirSync(join(projectDir(), 'models', 'models--meta-llama--Llama-3.1-8B'), { recursive: true });

    expect((await inspectVllmQwenProject(env(), envPath())).hasWeights).toBe(false);
  });

  it('honors the weights-directory override, for a cache PortOS cannot otherwise see', async () => {
    mkdirSync(projectDir(), { recursive: true });
    writeFileSync(join(projectDir(), 'docker-compose.yml'), 'services: {}\n');
    const cache = join(root, 'elsewhere', 'hub');
    mkdirSync(join(cache, 'models--syv-ai--qwen3.8-27b'), { recursive: true });

    const project = await inspectVllmQwenProject(env({ [VLLM_WEIGHTS_DIR_ENV]: cache }), envPath());
    expect(project).toMatchObject({ hasWeights: true, weightsRoot: cache });
  });

  it('finds an HF_HOME hub cache', async () => {
    mkdirSync(projectDir(), { recursive: true });
    writeFileSync(join(projectDir(), 'docker-compose.yml'), 'services: {}\n');
    const hfHome = join(root, 'hf');
    mkdirSync(join(hfHome, 'hub', 'models--Qwen--Qwen3.8-27B'), { recursive: true });

    const project = await inspectVllmQwenProject(env({ HF_HOME: hfHome }), envPath());
    expect(project.hasWeights).toBe(true);
  });
});

describe('vllmProjectSetupState', () => {
  const project = (over = {}) => ({ dir: '/home/example/qwen-serving', hasProject: true, composeFile: 'docker-compose.yml', hasWeights: true, weightsRoot: null, ...over });

  it('reports a prepared project as ready', () => {
    expect(vllmProjectSetupState(project())).toBe('ready');
  });

  it('reports the two states where cloning/building/preparing IS the fix', () => {
    // Nothing cloned at all — the ordinary first-run shape.
    expect(vllmProjectSetupState(project({ hasProject: false, composeFile: null, hasWeights: null }))).toBe('empty');
    // Cloned, never prepared.
    expect(vllmProjectSetupState(project({ hasWeights: false }))).toBe('empty');
  });

  it('never reports a cache it could not READ as empty', () => {
    // The normal Windows shape before VLLM_QWEN_PROJECT_DIR points at the UNC
    // path. Calling this `empty` would offer to re-download ~20 GB that is
    // already on disk; `unknown` keeps the Start button and its real refusal.
    expect(vllmProjectSetupState(project({ hasWeights: null }))).toBe('unknown');
  });

  it('never offers to clone into a directory it does not recognize', () => {
    // A directory that exists but holds no compose file is not this project.
    expect(vllmProjectSetupState(project({ composeFile: null, hasWeights: null }))).toBe('unknown');
  });

  it('treats a missing inspection as empty rather than throwing', () => {
    expect(vllmProjectSetupState(null)).toBe('empty');
  });
});
