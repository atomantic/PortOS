import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite, ensureDir, rmGuarded } from '../../lib/fileCore.js';
import { canonicalStringify } from '../../lib/objects.js';
import { FABLELOOM_EXPORT_LIMITS } from '../../lib/fableLoomExport.js';
import { FABLELOOM_MEDIA_PROFILES } from '../../lib/fableLoomMediaProfiles.js';
import { checkExportCancelled, fableLoomExportEncoder, prepareFableLoomExportMedia } from './exportMedia.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const parts = value => [['primary', value], ...['poster', 'webm'].filter(k => value[k]).map(k => [k, value[k]])];
const digestPattern = /^[a-f0-9]{64}$/;

/** The exporter serializes jobs; this bounded cache never retains buffers between calls. */
export async function createFableLoomMediaCache(root, options, signal) {
  const profile = { ...FABLELOOM_MEDIA_PROFILES[options.mediaProfile], includeWebm: options.includeWebm };
  const encoders = new Map();
  await ensureDir(root);
  const entries = [];
  let size = 0;
  for (const name of await readdir(root)) {
    if (!digestPattern.test(name)) continue;
    const directory = join(root, name);
    const files = await readdir(directory);
    const info = await stat(directory);
    let bytes = 0;
    for (const file of files) bytes += (await stat(join(directory, file))).size;
    if (Date.now() - info.mtimeMs >= FABLELOOM_EXPORT_LIMITS.maxAgeMs) await rmGuarded(directory, { recursive: true, force: true });
    else { entries.push({ name, bytes, modified: info.mtimeMs }); size += bytes; }
  }
  entries.sort((a, b) => a.modified - b.modified || a.name.localeCompare(b.name));
  async function evict(required) {
    while (size + required > FABLELOOM_EXPORT_LIMITS.maxPackageBytes && entries.length) {
      const oldest = entries.shift();
      await rmGuarded(join(root, oldest.name), { recursive: true, force: true });
      size -= oldest.bytes;
    }
  }
  await evict(0);
  return async (bytes, kind, work) => {
    checkExportCancelled(signal);
    if (!encoders.has(kind)) encoders.set(kind, await fableLoomExportEncoder(kind));
    const encoder = encoders.get(kind);
    const sourceSha256 = hash(bytes);
    const key = hash(canonicalStringify({ sourceSha256, kind, profile, encoder }));
    const directory = join(root, key);
    const encoding = { profile, encoder, sourceSha256, cacheKey: key };
    let cached;
    try {
      const meta = JSON.parse(await readFile(join(directory, 'entry.json'), 'utf8'));
      const expected = kind === 'video' && profile.id !== 'source'
        ? ['primary', 'poster', ...(profile.includeWebm ? ['webm'] : [])] : ['primary'];
      if (Object.keys(meta).sort().join() !== expected.sort().join()) throw new Error('Invalid cache entry');
      cached = {};
      for (const name of expected) {
        const item = meta[name];
        const extension = name === 'webm' ? 'webm' : name === 'poster' || kind === 'image' ? 'png' : 'mp4';
        if (!digestPattern.test(item.sha256) || item.extension !== extension || !Number.isSafeInteger(item.durationMs)
          || item.durationMs < 0 || !Number.isSafeInteger(item.size) || item.size <= 0
          || item.size > FABLELOOM_EXPORT_LIMITS.maxAssetBytes) throw new Error('Invalid cache descriptor');
        const file = join(directory, `${name}.${extension}`);
        if ((await stat(file)).size !== item.size) throw new Error('Cache size changed');
        const content = await readFile(file);
        if (hash(content) !== item.sha256) throw new Error('Cache hash changed');
        const value = { bytes: content, extension, durationMs: item.durationMs };
        if (name === 'primary') Object.assign(cached, value);
        else cached[name] = value;
      }
    } catch (failure) {
      if (failure.code && failure.code !== 'ENOENT') throw failure;
      cached = null;
    }
    if (cached) { checkExportCancelled(signal); return { ...cached, encoding }; }
    const result = await prepareFableLoomExportMedia(bytes, kind, work, { ...options, signal });
    checkExportCancelled(signal);
    const meta = Object.fromEntries(parts(result).map(([name, item]) => [name, {
      extension: item.extension, durationMs: item.durationMs, size: item.bytes.length, sha256: hash(item.bytes),
    }]));
    const required = parts(result).reduce((total, [, item]) => total + item.bytes.length, Buffer.byteLength(canonicalStringify(meta)) + 1);
    const existing = entries.findIndex(e => e.name === key);
    if (existing >= 0) { size -= entries[existing].bytes; entries.splice(existing, 1); }
    await rmGuarded(directory, { recursive: true, force: true });
    await evict(required);
    await ensureDir(directory);
    for (const [name, item] of parts(result)) await atomicWrite(join(directory, `${name}.${item.extension}`), item.bytes);
    checkExportCancelled(signal);
    await atomicWrite(join(directory, 'entry.json'), canonicalStringify(meta));
    entries.push({ name: key, bytes: required, modified: Date.now() });
    size += required;
    return { ...result, encoding };
  };
}
