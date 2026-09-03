import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  inspectSglangQwenProject,
  readRecordedSglangProjectDir,
  recordSglangProjectDir,
  resolveSglangProjectDir,
  sglangDefaultProjectDir,
  sglangProjectDirIsSettled,
  sglangStartBlockedReason,
  SGLANG_PROJECT_DIR_ENV,
  SGLANG_WEIGHTS_DIR_ENV,
} from './sglangQwenProject.js';

let root;
/**
 * A fully injected env — HOME/USERPROFILE included — so no assertion here can
 * ever be answered by the developer's real HuggingFace cache.
 */
const envAt = (overrides = {}) => ({ HOME: root, USERPROFILE: root, ...overrides });
/**
 * The `.env` PortOS records a detected directory in — inside the sandbox, so a
 * value the developer's own install recorded can never answer an assertion here
 * (nor can one of these writes land in it).
 */
const envPath = () => join(root, '.env');

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'sglang-project-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('resolveSglangProjectDir', () => {
  it('defaults to ~/sglang-qwen38', () => {
    expect(resolveSglangProjectDir(envAt(), envPath())).toBe(sglangDefaultProjectDir(envAt()));
    expect(resolveSglangProjectDir(envAt(), envPath())).toBe(join(root, 'sglang-qwen38'));
  });

  it('honors the override, ignoring a blank one', () => {
    expect(resolveSglangProjectDir(envAt({ [SGLANG_PROJECT_DIR_ENV]: '/srv/sglang' }), envPath())).toBe('/srv/sglang');
    expect(resolveSglangProjectDir(envAt({ [SGLANG_PROJECT_DIR_ENV]: '   ' }), envPath())).toBe(join(root, 'sglang-qwen38'));
  });

  it('falls back to the UNC path PortOS detected and recorded for itself', async () => {
    // The Windows shape: the project is prepared by hand inside a WSL2 distro,
    // and `~/sglang-qwen38` resolves to a Windows home it is not in.
    const recorded = '\\\\wsl.localhost\\Example-Distro\\home\\example-user\\sglang-qwen38';
    await recordSglangProjectDir(recorded, envPath());

    expect(readRecordedSglangProjectDir(envPath())).toBe(recorded);
    expect(resolveSglangProjectDir(envAt(), envPath())).toBe(recorded);
    // An exported override still outranks it — that is this run's decision, and
    // a directory detected on some earlier run must not outlive it.
    expect(resolveSglangProjectDir(envAt({ [SGLANG_PROJECT_DIR_ENV]: '/srv/sglang' }), envPath())).toBe('/srv/sglang');
  });

  it('rewrites its own record instead of appending a second line', async () => {
    writeFileSync(envPath(), 'PGPASSWORD=portos');
    await recordSglangProjectDir('/srv/first', envPath());
    await recordSglangProjectDir('/srv/second', envPath());

    const contents = readFileSync(envPath(), 'utf8');
    expect(contents.match(/^SGLANG_QWEN_PROJECT_DIR=/gm)).toHaveLength(1);
    expect(readRecordedSglangProjectDir(envPath())).toBe('/srv/second');
    // The line it was appended after had no trailing newline — splicing onto it
    // would have corrupted both settings.
    expect(contents).toContain('PGPASSWORD=portos\n');
  });

  it('reports nothing settled until something answers', async () => {
    expect(sglangProjectDirIsSettled(envAt(), envPath())).toBe(false);
    expect(sglangProjectDirIsSettled(envAt({ [SGLANG_PROJECT_DIR_ENV]: '/srv/sglang' }), envPath())).toBe(true);

    await recordSglangProjectDir('/srv/recorded', envPath());
    expect(sglangProjectDirIsSettled(envAt(), envPath())).toBe(true);
  });
});

describe('inspectSglangQwenProject', () => {
  it('reports an absent project without claiming anything about weights', async () => {
    const project = await inspectSglangQwenProject(envAt(), envPath());
    expect(project).toMatchObject({ hasProject: false, composeFile: null, weightsRoot: null });
    // No cache root was readable, so `hasWeights` must be the null sentinel —
    // NOT `false`, which would claim the caches were read and found empty.
    expect(project.hasWeights).toBeNull();
  });

  it('finds a compose file in docker\'s own precedence order', async () => {
    const dir = join(root, 'sglang-qwen38');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'compose.yaml'), '');
    expect((await inspectSglangQwenProject(envAt(), envPath())).composeFile).toBe('compose.yaml');
    writeFileSync(join(dir, 'docker-compose.yml'), '');
    expect((await inspectSglangQwenProject(envAt(), envPath())).composeFile).toBe('docker-compose.yml');
  });

  it('distinguishes a readable-but-empty cache from an unreadable one', async () => {
    const dir = join(root, 'sglang-qwen38');
    mkdirSync(join(dir, 'hf-cache'), { recursive: true });
    const project = await inspectSglangQwenProject(envAt(), envPath());
    expect(project.hasWeights).toBe(false);
    expect(project.weightsRoot).toBeNull();
  });

  it('detects the HuggingFace hub layout', async () => {
    const hub = join(root, 'sglang-qwen38', 'hf-cache', 'hub');
    mkdirSync(join(hub, 'models--Qwen--Qwen3.8-27B-FP8'), { recursive: true });
    const project = await inspectSglangQwenProject(envAt(), envPath());
    expect(project).toMatchObject({ hasWeights: true, weightsRoot: hub });
  });

  it('detects a --local-dir download, but only with a real weight file in it', async () => {
    const models = join(root, 'sglang-qwen38', 'models');
    mkdirSync(join(models, 'Qwen3.8-27B-FP8'), { recursive: true });
    // A directory named after the model but holding no tensors is notes, not weights.
    expect((await inspectSglangQwenProject(envAt(), envPath())).hasWeights).toBe(false);
    writeFileSync(join(models, 'Qwen3.8-27B-FP8', 'model.safetensors.index.json'), '{}');
    expect((await inspectSglangQwenProject(envAt(), envPath())).hasWeights).toBe(true);
  });

  it('checks the explicit weights override first', async () => {
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(join(elsewhere, 'models--Qwen--Qwen3.8-27B-NVFP4'), { recursive: true });
    const project = await inspectSglangQwenProject(envAt({ [SGLANG_WEIGHTS_DIR_ENV]: elsewhere }), envPath());
    expect(project).toMatchObject({ hasWeights: true, weightsRoot: elsewhere });
  });
});

describe('sglangStartBlockedReason', () => {
  const base = { dir: '/srv/sglang', hasProject: true, composeFile: 'docker-compose.yml', hasWeights: true };

  it('allows a fully prepared project', () => {
    expect(sglangStartBlockedReason(base)).toBeNull();
  });

  it('names the project dir and the doc when the directory is missing', () => {
    const reason = sglangStartBlockedReason({ ...base, hasProject: false });
    expect(reason).toContain('/srv/sglang');
    expect(reason).toContain('docs/features/sglang-qwen38.md');
  });

  it('points at the doc\'s compose file when only that is missing', () => {
    expect(sglangStartBlockedReason({ ...base, composeFile: null }))
      .toContain('docs/features/sglang-qwen38.md');
  });

  it('gives the empty-cache and unreadable-cache cases DIFFERENT copy', () => {
    // The whole point of the tri-state: "your cache is empty" and "I cannot see
    // your cache" send the operator to different fixes.
    const empty = sglangStartBlockedReason({ ...base, hasWeights: false });
    const unknown = sglangStartBlockedReason({ ...base, hasWeights: null });
    expect(empty).toMatch(/no Qwen weights are cached yet/);
    expect(unknown).toMatch(/cannot read a HuggingFace cache/);
    // Both overrides, because a stale recorded project directory is now one of
    // the ways this case is reached on Windows.
    expect(unknown).toContain(SGLANG_WEIGHTS_DIR_ENV);
    expect(unknown).toContain(SGLANG_PROJECT_DIR_ENV);
    expect(empty).not.toBe(unknown);
  });
});
