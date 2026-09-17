/**
 * The model manifest's durability contract.
 *
 * These are the behaviors a scan can no longer supply once the Status page reads
 * a persisted record instead of walking the disk on every visit: that an
 * uninstall actually clears the row, that a re-install does not reset an install
 * date, that a reconcile adopts weights PortOS never installed and drops ones
 * that vanished — and, the one that costs real data if it regresses, that a
 * backend the scan could NOT see is never pruned against.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { hfInventoryRow, loraInventoryRow, localModelInventoryRow } from '../lib/modelInventory.js';

const { TEMP_ROOT } = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join: joinPath } = await import('path');
  return { TEMP_ROOT: mkdtempSync(joinPath(tmpdir(), 'portos-model-manifest-')) };
});

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makePathsProxy(actual, { dataRoot: TEMP_ROOT });
});

const {
  getModelManifest,
  recordModelInstall,
  recordModelUninstall,
  reconcileModelManifest,
  resetModelManifestCache,
  trustedInventoryBackends,
} = await import('./modelManifest.js');

const MANIFEST_PATH = join(TEMP_ROOT, 'model-manifest.json');

const hfRow = (overrides = {}) => ({
  ...hfInventoryRow({ dirName: 'models--example--repo', name: 'Example (Image)', detail: 'example/repo', sizeBytes: 4096 }),
  loaded: false,
  ...overrides,
});

beforeEach(() => {
  rmSync(MANIFEST_PATH, { force: true });
  // The store caches reads; deleting the file behind it would otherwise leave the
  // previous test's manifest live for the TTL.
  resetModelManifestCache();
});
afterAll(() => rmSync(TEMP_ROOT, { recursive: true, force: true }));

describe('install and uninstall records', () => {
  it('tracks a model across install, re-install, and uninstall', async () => {
    const row = loraInventoryRow({ filename: 'lora-example-v1.safetensors', name: 'Example LoRA', sizeBytes: 100 });
    expect(await recordModelInstall(row)).toBe(true);

    const first = await getModelManifest();
    expect(first.models).toHaveLength(1);
    expect(first.models[0]).toMatchObject({
      id: 'lora:lora-example-v1.safetensors',
      backend: 'lora',
      name: 'Example LoRA',
      sizeBytes: 100,
      source: 'install',
    });
    // Never reconciled, so the page must not read this as a verified inventory.
    expect(first.reconciledAt).toBeNull();

    // A re-download of the same filename keeps the original install date and
    // provenance, but does refresh the measured size.
    await recordModelInstall({ ...row, sizeBytes: 250, source: 'download' });
    const reinstalled = await getModelManifest();
    expect(reinstalled.models[0].installedAt).toBe(first.models[0].installedAt);
    expect(reinstalled.models[0].source).toBe('install');
    expect(reinstalled.models[0].sizeBytes).toBe(250);

    expect(await recordModelUninstall({ backend: 'lora', key: 'lora-example-v1.safetensors' })).toBe(true);
    expect((await getModelManifest()).models).toEqual([]);
    // A second delete of the same row is not a removal — the caller learns that
    // nothing was there, rather than a success it can report.
    expect(await recordModelUninstall({ backend: 'lora', key: 'lora-example-v1.safetensors' })).toBe(false);
  });

  it('stores only durable facts, leaving residency to the read projection', async () => {
    await recordModelInstall(localModelInventoryRow({ backend: 'ollama', modelId: 'qwen3:8b' }));
    const [entry] = (await getModelManifest()).models;
    expect(entry.id).toBe('ollama:qwen3:8b');
    expect(entry.residencyUnknown).toBe(true);
    expect(entry.loaded).toBe(false);
    // `key` is the second half of `id`; storing it too would be a second source of
    // truth for one string.
    expect(entry).not.toHaveProperty('key');
    expect(JSON.parse(String(require('fs').readFileSync(MANIFEST_PATH))).models['ollama:qwen3:8b'])
      .not.toHaveProperty('residencyUnknown');
  });

  it('refuses to record a model it cannot identify', async () => {
    expect(await recordModelInstall(localModelInventoryRow({ backend: 'ollama', modelId: '  ' }))).toBe(false);
    expect(await recordModelUninstall({ backend: 'unknown-backend', key: 'x' })).toBe(false);
    expect((await getModelManifest()).models).toEqual([]);
  });

  it('leaves an unreadable manifest alone rather than replacing it with an empty one', async () => {
    writeFileSync(MANIFEST_PATH, '{"models": {"hf:models--a--b": ');
    await expect(getModelManifest()).rejects.toThrow(/unreadable/i);
    // A best-effort record must not paper over it either: a successful write here
    // would persist an empty manifest over the bytes, destroying the record.
    expect(await recordModelInstall(loraInventoryRow({ filename: 'x.safetensors' }))).toBe(false);
    expect(await reconcileModelManifest([hfRow()], {})).toBeNull();
  });
});

describe('reconciliation against a scan', () => {
  it('adopts models it never installed and drops ones that are gone', async () => {
    await recordModelInstall(loraInventoryRow({ filename: 'stale.safetensors', name: 'Stale' }));
    expect(await reconcileModelManifest([hfRow()], {})).toMatchObject({ added: 1, removed: 1 });

    const manifest = await getModelManifest();
    expect(manifest.models.map((model) => model.id)).toEqual(['hf:models--example--repo']);
    // `scan` rather than `install`: this row's installedAt is when PortOS first
    // LOOKED, not when the weights landed, and the page says so.
    expect(manifest.models[0].source).toBe('scan');
    expect(manifest.models[0].action).toEqual({ type: 'hf-model', dirName: 'models--example--repo' });
    expect(manifest.reconciledAt).toEqual(expect.any(String));
  });

  it('keeps a tracked install date and provenance across a reconcile that re-sees it', async () => {
    await recordModelInstall({ ...hfRow(), source: 'download' });
    const installedAt = (await getModelManifest()).models[0].installedAt;

    await reconcileModelManifest([hfRow({ sizeBytes: 9999 })], {});
    const [entry] = (await getModelManifest()).models;
    expect(entry).toMatchObject({ installedAt, source: 'download', sizeBytes: 9999 });
  });

  it('never prunes a backend the scan could not see', async () => {
    await recordModelInstall(localModelInventoryRow({ backend: 'ollama', modelId: 'qwen3:8b' }));
    await recordModelInstall(localModelInventoryRow({ backend: 'lmstudio', modelId: 'example/model' }));
    await recordModelInstall(loraInventoryRow({ filename: 'kept.safetensors', name: 'Kept' }));

    // Ollama disabled in settings, LM Studio unreachable, the LoRA store failed to
    // read — a scan that reports nothing for any of them is not evidence of
    // deletion, and pruning on it would erase three correct rows.
    const result = await reconcileModelManifest([], {
      sourceErrors: ['lmstudio-backend', 'loras'],
      disabledSources: ['ollama'],
    });
    expect(result).toMatchObject({ added: 0, removed: 0, trusted: ['huggingface'] });
    expect((await getModelManifest()).models).toHaveLength(3);
  });

  it('ignores a row whose on-disk folder the scan could not verify', async () => {
    await reconcileModelManifest([hfRow({ inventoryUnknown: true })], {});
    expect((await getModelManifest()).models).toEqual([]);
  });

  // The other half of that rule, and the one that costs data. An unverified row is
  // excluded from the scanned set, which on its own makes it indistinguishable from
  // a model the backend never mentioned — so the pruning loop would read a model
  // Ollama positively listed as deleted and drop the manifest entry for it.
  it('keeps a tracked row the scan reported but could not verify on disk', async () => {
    await recordModelInstall(localModelInventoryRow({ backend: 'ollama', modelId: 'qwen3:8b' }));
    await recordModelInstall(loraInventoryRow({ filename: 'gone.safetensors', name: 'Gone' }));

    // Ollama's API lists qwen3:8b but the disk listing did not corroborate it; the
    // LoRA store was read cleanly and simply no longer holds gone.safetensors.
    const result = await reconcileModelManifest([
      { ...localModelInventoryRow({ backend: 'ollama', modelId: 'qwen3:8b' }), inventoryUnknown: true },
    ], {});

    expect(result).toMatchObject({ added: 0, removed: 1 });
    expect((await getModelManifest()).models.map((model) => model.id)).toEqual(['ollama:qwen3:8b']);
  });

  it('maps every scan source error to the backend it actually invalidates', () => {
    expect([...trustedInventoryBackends({})]).toEqual(['huggingface', 'lora', 'ollama', 'lmstudio']);
    expect([...trustedInventoryBackends({ sourceErrors: ['huggingface'] })]).not.toContain('huggingface');
    expect([...trustedInventoryBackends({ sourceErrors: ['loras'] })]).not.toContain('lora');
    expect([...trustedInventoryBackends({ sourceErrors: ['ollama-inventory'] })]).not.toContain('ollama');
    expect([...trustedInventoryBackends({ sourceErrors: ['lmstudio-backend'] })]).not.toContain('lmstudio');
    expect([...trustedInventoryBackends({ disabledSources: ['lmstudio'] })]).not.toContain('lmstudio');
    // A residency probe failure says nothing about what is ON DISK, so it must
    // not stop a reconcile — the inventory read is a separate source.
    expect([...trustedInventoryBackends({ sourceErrors: ['ollama-residency', 'lmstudio-residency'] })])
      .toEqual(['huggingface', 'lora', 'ollama', 'lmstudio']);
  });
});
