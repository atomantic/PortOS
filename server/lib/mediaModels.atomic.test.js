import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const hooks = vi.hoisted(() => ({ write: null, rename: null }));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    writeFileSync: (...args) => hooks.write ? hooks.write(actual, ...args) : actual.writeFileSync(...args),
    renameSync: (...args) => hooks.rename ? hooks.rename(actual, ...args) : actual.renameSync(...args),
  };
});

let root;
let file;
const priorRegistryFile = process.env.PORTOS_MEDIA_MODELS_FILE;
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'media-atomic-'));
  file = join(root, 'media-models.json');
  process.env.PORTOS_MEDIA_MODELS_FILE = file;
  vi.resetModules();
});
afterEach(() => {
  hooks.write = null;
  hooks.rename = null;
  if (priorRegistryFile === undefined) delete process.env.PORTOS_MEDIA_MODELS_FILE;
  else process.env.PORTOS_MEDIA_MODELS_FILE = priorRegistryFile;
  fs.rmSync(root, { recursive: true, force: true });
});

const boot = () => import('../test/fixtures/mediaRegistryImport.js');

describe('registry publication at the boot import boundary', () => {
  it('finishes two interleaved initializations without consuming the other writer’s file', async () => {
    fs.writeFileSync(file, JSON.stringify({ marker: 'original' }));
    const second = await import('./mediaModels.js');
    vi.resetModules();
    let interleaved = false;
    hooks.rename = (actual, source, destination) => {
      hooks.rename = null;
      // The first writer is fully prepared but has not published. A second
      // module instance loads and publishes before the first resumes.
      expect(JSON.parse(actual.readFileSync(file, 'utf8')).marker).toBe('original');
      const loaded = second.loadMediaModels();
      expect(JSON.parse(actual.readFileSync(file, 'utf8'))).toEqual(loaded);
      expect(actual.existsSync(source)).toBe(true);
      interleaved = true;
      actual.renameSync(source, destination);
    };
    const { registry } = await boot();
    expect(interleaved).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(registry);
    expect(registry._shippedDefaults.image.list.length).toBeGreaterThan(0);
    expect(fs.readdirSync(root)).toEqual(['media-models.json']);
  });

  it.each(['write', 'rename'])('preserves the original and other temporary files after %s failure', async (phase) => {
    const original = JSON.stringify({ marker: 'preserved' });
    fs.writeFileSync(file, original);
    const other = join(root, 'media-models.json.other.tmp');
    fs.writeFileSync(other, 'another operation');
    const failure = new Error(`injected ${phase} failure`);
    hooks[phase] = (actual, ...args) => {
      if (phase === 'write') actual.writeFileSync(args[0], 'partial preparation');
      throw failure;
    };
    await expect(boot()).rejects.toBe(failure);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.readFileSync(other, 'utf8')).toBe('another operation');
    expect(fs.readdirSync(root).sort()).toEqual(['media-models.json', 'media-models.json.other.tmp']);
  });

  it('publishes a complete registry on first boot', async () => {
    const { registry } = await boot();
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(registry);
    expect(fs.readdirSync(root)).toEqual(['media-models.json']);
  });
});
