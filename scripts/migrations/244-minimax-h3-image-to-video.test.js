import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import migration from './244-minimax-h3-image-to-video.js';

const REFERENCE_PATH = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..', 'data.reference', 'media-models.json',
);

const H3_ID = 'minimax_h3_8bit';
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

const PROCESSOR_FILES = [
  'FL2VA/processor/chat_template.json',
  'FL2VA/processor/merges.txt',
  'FL2VA/processor/preprocessor_config.json',
  'FL2VA/processor/tokenizer.json',
  'FL2VA/processor/tokenizer_config.json',
  'FL2VA/processor/video_preprocessor_config.json',
  'FL2VA/processor/vocab.json',
];

const shippedH3 = () => ({
  id: H3_ID,
  name: 'MiniMax H3 MLX 8-bit',
  repo: 'pipenetwork/MiniMax-H3-MLX-8bit',
  revision: '3ac52081470b0488921c3ec3ba84a39097bf2361',
  runtime: 'minimax_h3',
  supportedModes: ['text'],
  requiredWeights: [{
    repo: 'MiniMaxAI/MiniMax-H3',
    revision: '6818f6c32d12b210915e44ad56a4228c2608f160',
    files: [
      'LICENSE',
      'FL2VA/text_encoder/model.safetensors.index.json',
      'FL2VA/tokenizer/merges.txt',
      'FL2VA/tokenizer/vocab.json',
    ],
  }],
});

const registryWith = (h3) => ({
  video: {
    macos: [{ id: 'ltx23_distilled_q4', name: 'Default' }, ...(h3 ? [h3] : [])],
    windows: [],
    defaultMacos: 'ltx23_distilled_q4',
    defaultWindows: 'ltx_video',
  },
  image: [],
});

const h3In = (config) => config.video.macos.find((entry) => entry.id === H3_ID);

describe('migration 244 — MiniMax H3 image-to-video', () => {
  let rootDir;
  let path;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-244-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    path = join(rootDir, 'data', 'media-models.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  // The migration keeps a frozen copy of the file set on purpose (reading the
  // live seed would let a later seed edit retroactively change what 244 does),
  // so pin it here — otherwise fresh installs and migrated installs could end
  // up downloading different files with nothing failing.
  it('migrates to exactly what data.reference ships today', async () => {
    writeJson(path, registryWith(shippedH3()));
    await migration.up({ rootDir });

    const migrated = h3In(readJson(path));
    const seeded = JSON.parse(readFileSync(REFERENCE_PATH, 'utf-8'))
      .video.mlx.find((entry) => entry.id === H3_ID);
    expect(migrated.supportedModes).toEqual(seeded.supportedModes);
    expect(migrated.requiredWeights[0].files.filter((f) => f.startsWith('FL2VA/processor/')))
      .toEqual(seeded.requiredWeights[0].files.filter((f) => f.startsWith('FL2VA/processor/')));
  });

  it('opens the shipped entry to image + fflf and adds the Qwen3-VL processor files', async () => {
    writeJson(path, registryWith(shippedH3()));
    await migration.up({ rootDir });

    const h3 = h3In(readJson(path));
    expect(h3.supportedModes).toEqual(['text', 'image', 'fflf']);
    expect(h3.requiredWeights[0].files.filter((f) => f.startsWith('FL2VA/processor/')))
      .toEqual(PROCESSOR_FILES);
    // Inserted ahead of the tokenizer block so stored order matches the seed.
    const files = h3.requiredWeights[0].files;
    expect(files.indexOf('FL2VA/processor/vocab.json'))
      .toBeLessThan(files.indexOf('FL2VA/tokenizer/merges.txt'));
    expect(files[0]).toBe('LICENSE');
  });

  it('is idempotent', async () => {
    writeJson(path, registryWith(shippedH3()));
    await migration.up({ rootDir });
    const once = readJson(path);
    await migration.up({ rootDir });
    expect(readJson(path)).toEqual(once);
  });

  it('leaves a user-narrowed mode list alone but still adds the processor files', async () => {
    const custom = shippedH3();
    custom.supportedModes = ['text', 'image'];
    writeJson(path, registryWith(custom));
    await migration.up({ rootDir });

    const h3 = h3In(readJson(path));
    expect(h3.supportedModes).toEqual(['text', 'image']);
    expect(h3.requiredWeights[0].files).toContain('FL2VA/processor/tokenizer.json');
  });

  it('skips an entry the user re-pointed at another repo', async () => {
    const forked = shippedH3();
    forked.repo = 'example-org/h3-fork';
    const before = registryWith(forked);
    writeJson(path, before);
    await migration.up({ rootDir });
    expect(readJson(path)).toEqual(before);
  });

  it('does nothing when the user deleted the entry', async () => {
    const before = registryWith(null);
    writeJson(path, before);
    await migration.up({ rootDir });
    expect(readJson(path)).toEqual(before);
  });

  it('skips a missing registry file (fresh install seeds from data.reference)', async () => {
    await expect(migration.up({ rootDir })).resolves.toBeUndefined();
  });

  it('skips an invalid registry file rather than throwing', async () => {
    writeFileSync(path, '{ not json');
    await expect(migration.up({ rootDir })).resolves.toBeUndefined();
    expect(readFileSync(path, 'utf-8')).toBe('{ not json');
  });
});
