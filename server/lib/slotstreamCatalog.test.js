import { describe, it, expect } from 'vitest';
import {
  SLOTSTREAM_CATALOG,
  isSlotstreamRepoId,
  resolveSlotstreamRepo,
  selectSlotstreamRepoFiles,
  slotstreamCatalogEntry,
  slotstreamModelDirName,
} from './slotstreamCatalog.js';

describe('SLOTSTREAM_CATALOG', () => {
  it('offers only well-formed repo ids with unique catalog ids', () => {
    const ids = SLOTSTREAM_CATALOG.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const row of SLOTSTREAM_CATALOG) {
      expect(isSlotstreamRepoId(row.repo)).toBe(true);
      expect(row.approxBytes).toBeGreaterThan(0);
    }
  });
});

describe('resolveSlotstreamRepo', () => {
  it('maps a catalog id to its repo and passes a bare repo id through', () => {
    const entry = SLOTSTREAM_CATALOG[0];
    expect(resolveSlotstreamRepo(entry.id)).toBe(entry.repo);
    expect(resolveSlotstreamRepo(entry.repo)).toBe(entry.repo);
    expect(resolveSlotstreamRepo('someone/some-moe-4bit')).toBe('someone/some-moe-4bit');
  });

  it('refuses anything that is neither — including path and flag shapes', () => {
    // Each segment must START alphanumeric, so `..` traversal and a leading
    // dash (which a path walk or an argv slot would read as something other
    // than a name) never resolve.
    for (const bad of ['', '   ', null, 42, 'owner', 'owner/../etc', '../owner/name', '-flag/name', 'owner/name/extra']) {
      expect(resolveSlotstreamRepo(bad)).toBeNull();
    }
  });

  it('finds a catalog row by either id or repo', () => {
    const entry = SLOTSTREAM_CATALOG[1];
    expect(slotstreamCatalogEntry(entry.repo)).toBe(entry);
    expect(slotstreamCatalogEntry(' ' + entry.id + ' ')).toBe(entry);
    expect(slotstreamCatalogEntry('someone/unlisted')).toBeNull();
  });
});

describe('slotstreamModelDirName', () => {
  it('flattens the repo to ONE path segment', () => {
    // The directory NAME is the id the cache walk reports and a start hands
    // `--model`; a literal `owner/name` would nest two levels and make the walk
    // report the owner as the checkpoint.
    const name = slotstreamModelDirName('mlx-community/Qwen3-30B-A3B-4bit');
    expect(name).toBe('mlx-community__Qwen3-30B-A3B-4bit');
    expect(name).not.toContain('/');
  });
});

describe('selectSlotstreamRepoFiles', () => {
  const siblings = (...names) => names.map((rfilename) => ({ rfilename }));

  it('keeps the weights, config, and tokenizer of a checkpoint', () => {
    expect(selectSlotstreamRepoFiles(siblings(
      'model-00002-of-00002.safetensors',
      'model-00001-of-00002.safetensors',
      'model.safetensors.index.json',
      'config.json',
      'tokenizer.json',
      'merges.txt',
      'chat_template.jinja',
    ))).toEqual([
      'chat_template.jinja',
      'config.json',
      'merges.txt',
      'model-00001-of-00002.safetensors',
      'model-00002-of-00002.safetensors',
      'model.safetensors.index.json',
      'tokenizer.json',
    ]);
  });

  it('drops mirrored copies of the same weights in formats this runtime never loads', () => {
    // A repo that also ships PyTorch/GGUF/ONNX (or an `original/` copy) would
    // otherwise double or triple a 100 GB+ pull for files that are never read.
    expect(selectSlotstreamRepoFiles(siblings(
      'model.safetensors',
      'pytorch_model.bin',
      'consolidated.pth',
      'model-q4.gguf',
      'onnx/model.onnx',
      'original/consolidated.safetensors',
      'README.md',
      '.gitattributes',
      'preview.png',
    ))).toEqual(['model.safetensors']);
  });

  it('refuses a name that is not a plain relative path', () => {
    // A Hub response must not be able to steer a write out of the checkpoint
    // directory.
    expect(selectSlotstreamRepoFiles(siblings(
      '/etc/passwd.json',
      '../../escape.safetensors',
      'nested/../../escape.json',
      'good.safetensors',
    ))).toEqual(['good.safetensors']);
  });

  it('accepts bare strings and ignores rows with no filename', () => {
    expect(selectSlotstreamRepoFiles(['config.json', { size: 10 }, null, 'x.safetensors'])).toEqual(['config.json', 'x.safetensors']);
    expect(selectSlotstreamRepoFiles(null)).toEqual([]);
  });
});
