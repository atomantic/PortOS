import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertTextEncoderFilesComplete } from './ensureWeights.js';

let dir;
afterEach(() => rm(dir, { recursive: true, force: true }));

const shard = (name, { truncate = false } = {}) => {
  const header = Buffer.from(JSON.stringify({ w: { dtype: 'F32', shape: [1], data_offsets: [0, 4] } }));
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(header.length));
  const body = truncate ? Buffer.concat([len, header.subarray(0, 5)]) : Buffer.concat([len, header, Buffer.alloc(4)]);
  return writeFile(join(dir, name), body);
};

describe('assertTextEncoderFilesComplete', () => {
  it('accepts intact shards', async () => {
    dir = await mkdtemp(join(tmpdir(), 'te-preflight-'));
    await shard('a.safetensors');
    await expect(assertTextEncoderFilesComplete({ id: 'x', paths: [join(dir, 'a.safetensors')] })).resolves.toBeUndefined();
  });

  it('names every empty, truncated or missing shard with VIDEO_WEIGHTS_INCOMPLETE', async () => {
    dir = await mkdtemp(join(tmpdir(), 'te-preflight-'));
    await shard('ok.safetensors');
    await shard('cut.safetensors', { truncate: true });
    await writeFile(join(dir, 'empty.safetensors'), '');
    const paths = ['ok', 'cut', 'empty', 'gone'].map((n) => join(dir, `${n}.safetensors`));
    const err = await assertTextEncoderFilesComplete({ id: 'x', paths }).catch((e) => e);
    expect(err.code).toBe('VIDEO_WEIGHTS_INCOMPLETE');
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/cut\.safetensors \(bad-header-length\).*empty\.safetensors \(empty\).*gone\.safetensors \(missing\)/);
    expect(err.message).not.toContain('ok.safetensors');
  });
});
