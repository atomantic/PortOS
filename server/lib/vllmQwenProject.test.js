import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
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

  // Only a missing .env is an empty start; rewriting after a failed read used to
  // replace the whole file with the one recorded line.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('refuses to rewrite a .env it cannot read', async () => {
    writeFileSync(envPath(), 'PGPASSWORD=portos\n');
    chmodSync(envPath(), 0o000);
    try {
      await expect(recordVllmProjectDir('/srv/first', envPath())).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      chmodSync(envPath(), 0o600);
    }
    expect(readFileSync(envPath(), 'utf8')).toBe('PGPASSWORD=portos\n');
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
    expect(vllmStartBlockedReason(project)).toContain('selected Qwen weights are missing or incomplete');
  });

  const base = 'Qwen3.8-27B-W4A16-AutoRound';
  const revision = '1'.repeat(40);
  const otherRevision = '2'.repeat(40);
  const shard = 'model-00001-of-00001.safetensors';
  const preparedTensors = ['lm_head.weight_packed', 'model.embed_tokens.weight_packed',
    'mtp.layers.0.mlp.down_proj.weight_packed', 'mtp.draft_lm_head.weight_packed'];

  function writeCheckpoint(dir, tensors = preparedTensors) {
    mkdirSync(dir, { recursive: true });
    for (const name of ['config.json', 'tokenizer.json', 'tokenizer_config.json']) {
      writeFileSync(join(dir, name), '{}');
    }
    const weightMap = Object.fromEntries(tensors.map((name) => [name, shard]));
    writeFileSync(join(dir, 'model.safetensors.index.json'), JSON.stringify({ weight_map: weightMap }));
    writeFileSync(join(dir, 'mtp_draft_vocab_ids.pt'), 'vocab');
    const header = Buffer.from(JSON.stringify({ weight: { dtype: 'U8', shape: [1], data_offsets: [0, 1] } }));
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(header.length));
    writeFileSync(join(dir, shard), Buffer.concat([length, header, Buffer.of(1)]));
  }

  function writeProject(settings = '') {
    mkdirSync(projectDir(), { recursive: true });
    writeFileSync(join(projectDir(), 'compose.yaml'), 'services: {}\n');
    writeFileSync(join(projectDir(), '.env'), settings);
  }

  it('checks the configured models mount instead of accepting a complete default directory', async () => {
    writeProject('MODELS_DIR="./elsewhere" # mounted by Compose\n');
    writeCheckpoint(join(projectDir(), 'models', base));
    const elsewhere = join(projectDir(), 'elsewhere');
    mkdirSync(elsewhere);
    expect((await inspectVllmQwenProject(env(), envPath())).hasWeights).toBe(false);

    writeCheckpoint(join(elsewhere, base));
    expect(await inspectVllmQwenProject(env(), envPath()))
      .toMatchObject({ hasWeights: true, weightsRoot: elsewhere });

    const override = join(root, 'override');
    writeCheckpoint(join(override, base));
    expect(await inspectVllmQwenProject(env({ [VLLM_WEIGHTS_DIR_ENV]: override }), envPath()))
      .toMatchObject({ hasWeights: true, weightsRoot: override });
  });

  it('honors an explicit base selection when the auto-selected fast variant is incomplete', async () => {
    writeProject();
    writeCheckpoint(join(projectDir(), 'models', base));
    const fast = join(projectDir(), 'models', `${base}-fast`);
    writeCheckpoint(fast);
    rmSync(join(fast, shard));
    expect((await inspectVllmQwenProject(env(), envPath())).hasWeights).toBe(false);

    writeProject(`MODEL=models/${base}\n`);
    expect((await inspectVllmQwenProject(env(), envPath())).hasWeights).toBe(true);

    writeProject();
    writeCheckpoint(fast);
    expect((await inspectVllmQwenProject(env(), envPath())).hasWeights).toBe(true);
  });

  it('rejects a raw base checkpoint before prepare has finished and a truncated shard', async () => {
    writeProject();
    const baseDir = join(projectDir(), 'models', base);
    writeCheckpoint(baseDir, ['lm_head.weight']);
    expect((await inspectVllmQwenProject(env(), envPath())).hasWeights).toBe(false);

    writeCheckpoint(baseDir);
    const weightPath = join(baseDir, shard);
    writeFileSync(weightPath, readFileSync(weightPath).subarray(0, -1));
    expect((await inspectVllmQwenProject(env(), envPath())).hasWeights).toBe(false);
  });

  it('requires the DFlash2 drafter when the prepared base selects it', async () => {
    writeProject('SPEC=dflash2\n');
    writeCheckpoint(join(projectDir(), 'models', base));
    expect((await inspectVllmQwenProject(env(), envPath())).hasWeights).toBe(false);

    const draft = join(projectDir(), 'models', 'Qwen3.8-27B-DFlash2-W4A16');
    writeCheckpoint(draft);
    writeFileSync(join(draft, 'model.safetensors'), readFileSync(join(draft, shard)));
    rmSync(join(draft, 'model.safetensors.index.json'));
    expect((await inspectVllmQwenProject(env(), envPath())).hasWeights).toBe(true);
  });

  it('checks the selected Hub snapshot and follows weight blob links', async () => {
    writeProject('MODEL=example/qwen\nHF_HUB_OFFLINE=1\nVERIFY=0\n');
    const hfHome = join(root, 'hf');
    const cache = join(hfHome, 'hub');
    const repo = join(cache, 'models--example--qwen');
    const snapshot = join(repo, 'snapshots', revision);
    writeCheckpoint(snapshot);
    writeCheckpoint(join(repo, 'snapshots', otherRevision));
    mkdirSync(join(repo, 'refs'));
    mkdirSync(join(repo, 'blobs'));
    writeFileSync(join(repo, 'refs', 'main'), revision);
    const blob = join(repo, 'blobs', 'weight');
    writeFileSync(blob, readFileSync(join(snapshot, shard)));
    rmSync(join(snapshot, shard));
    symlinkSync(join('..', '..', 'blobs', 'weight'), join(snapshot, shard), 'file');

    expect(await inspectVllmQwenProject(env({ HF_HOME: hfHome }), envPath()))
      .toMatchObject({ hasWeights: true, weightsRoot: cache });
    rmSync(blob);
    expect((await inspectVllmQwenProject(env({ HF_HOME: hfHome }), envPath())).hasWeights).toBe(false);
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
