/**
 * Named Mixture of Agents (MoA) presets: create, read, update, delete, and resolve `moa:<id>` into its virtual provider record.
 *
 * Storage: `file-primary` (`data/moa-presets.json`) — machine-local, never
 * federated: every member names this install's provider preset ids, which mean
 * nothing on a peer (the same reason `data/providers.json` stays local). A
 * handful of small config records with no relations, beside the provider
 * presets they reference.
 *
 * Reads are STRICT (an unreadable file rejects rather than reading as empty,
 * because the next write would replace it), and writes operate on the RAW
 * stored array, so a record that no longer parses (a hand edit, a future
 * field) is reported with its reason and survives every other preset's write
 * instead of being dropped. All writes share one tail (`createFileWriteQueue`).
 */

import { join } from 'path';
import { PATHS, atomicWrite, readJSONFile } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { ServerError } from '../lib/errorHandler.js';
import { moaMemberRefusal, moaProviderRecord, presetIdFromMoaProviderId } from '../lib/moaConfig.js';
import { MOA_PRESET_ID_RE, moaPresetRecordSchema } from '../lib/moaValidation.js';
import { getProviderById } from './provider/providers.js';

const presetsFile = () => join(PATHS.data, 'moa-presets.json');
const queueWrite = createFileWriteQueue();

async function readRaw() {
  const stored = await readJSONFile(presetsFile(), null, { allowArray: false, strict: true });
  const presets = stored?.presets;
  return Array.isArray(presets) ? presets : [];
}

function parseRecord(raw) {
  const parsed = moaPresetRecordSchema.safeParse(raw);
  if (parsed.success) return { preset: parsed.data, error: null };
  return { preset: null, error: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'record'}: ${issue.message}`).join('; ') };
}

/**
 * Every stored preset. A record that fails the schema is listed as
 * `{ id, name, invalid: <reason> }` so the editor can show it and offer delete.
 */
export async function listMoaPresets() {
  return (await readRaw()).map((raw) => {
    const { preset, error } = parseRecord(raw);
    return preset ?? { id: typeof raw?.id === 'string' ? raw.id : null, name: typeof raw?.name === 'string' ? raw.name : 'Unreadable preset', invalid: error };
  });
}

/** The parsed preset, or null when absent. A stored-but-invalid record throws its reason: it must not run. */
export async function getMoaPreset(id) {
  const raw = (await readRaw()).find((record) => record?.id === id);
  if (!raw) return null;
  const { preset, error } = parseRecord(raw);
  if (!preset) throw new ServerError(`MoA preset "${id}" is invalid: ${error}`, { status: 422, code: 'MOA_PRESET_INVALID' });
  return preset;
}

/**
 * Per-member live eligibility: `[{ role, index, providerId, refusal }]` for
 * every member that cannot run now. Used on save (any refusal is a 400) and
 * by the list route (so the editor can flag a preset a provider change broke).
 */
export async function moaPresetRefusals(preset) {
  const members = [
    ...preset.referenceModels.map((member, index) => ({ role: 'reference', index, member })),
    { role: 'aggregator', index: 0, member: preset.aggregator },
  ];
  const checked = await Promise.all(members.map(async ({ role, index, member }) => {
    const provider = await getProviderById(member.providerId).catch(() => null);
    const refusal = moaMemberRefusal(member, provider);
    return refusal ? { role, index, providerId: member.providerId, refusal } : null;
  }));
  return checked.filter(Boolean);
}

async function assertRunnable(preset) {
  const refusals = await moaPresetRefusals(preset);
  if (refusals.length === 0) return;
  const detail = refusals.map((r) => `${r.role === 'aggregator' ? 'Aggregator' : `Reference model ${r.index + 1}`} ${r.refusal}`).join('; ');
  throw new ServerError(`MoA preset cannot run: ${detail}`, { status: 400, code: 'MOA_MEMBER_INVALID' });
}

const slugify = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);

async function writeRaw(records) {
  await atomicWrite(presetsFile(), { presets: records });
}

export function createMoaPreset(input) {
  return queueWrite(async () => {
    const records = await readRaw();
    const taken = new Set(records.map((record) => record?.id));
    let id = input.id;
    if (id && taken.has(id)) throw new ServerError(`MoA preset "${id}" already exists`, { status: 409, code: 'MOA_PRESET_EXISTS' });
    if (!id) {
      const base = MOA_PRESET_ID_RE.test(slugify(input.name)) ? slugify(input.name) : 'moa';
      id = base;
      for (let n = 2; taken.has(id); n += 1) id = `${base.slice(0, 58)}-${n}`;
    }
    const now = new Date().toISOString();
    const preset = moaPresetRecordSchema.parse({ ...input, id, createdAt: now, updatedAt: now });
    await assertRunnable(preset);
    await writeRaw([...records, preset]);
    console.log(`🧩 MoA preset created: ${id} (${preset.referenceModels.length} reference models)`);
    return preset;
  });
}

/**
 * `undefined` keeps a field; every present field replaces it. Members are
 * re-checked only when the patch changes them, so a preset a provider change
 * broke can still be renamed or disabled; the runner checks every member anyway.
 */
export function updateMoaPreset(id, patch) {
  return queueWrite(async () => {
    const records = await readRaw();
    const index = records.findIndex((record) => record?.id === id);
    if (index < 0) throw new ServerError(`MoA preset "${id}" not found`, { status: 404, code: 'MOA_PRESET_NOT_FOUND' });
    const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
    const preset = moaPresetRecordSchema.parse({ ...records[index], ...defined, id, updatedAt: new Date().toISOString() });
    if (defined.referenceModels || defined.aggregator) await assertRunnable(preset);
    const next = [...records];
    next[index] = preset;
    await writeRaw(next);
    return preset;
  });
}

export function deleteMoaPreset(id) {
  return queueWrite(async () => {
    const records = await readRaw();
    const next = records.filter((record) => record?.id !== id);
    if (next.length === records.length) throw new ServerError(`MoA preset "${id}" not found`, { status: 404, code: 'MOA_PRESET_NOT_FOUND' });
    await writeRaw(next);
    console.log(`🗑️ MoA preset deleted: ${id}`);
    return { id };
  });
}

/**
 * `moa:<id>` → its virtual provider record, or null for a non-MoA id or a
 * missing preset (a resolver then falls through exactly as for an unknown
 * preset id). An invalid stored preset still throws: a selection that names
 * it must surface why, not silently run on another provider.
 */
export async function resolveMoaProvider(providerId) {
  const presetId = presetIdFromMoaProviderId(providerId);
  if (!presetId) return null;
  const preset = await getMoaPreset(presetId);
  if (!preset) return null;
  // An aggregator left on its provider's default reports that model, so a
  // caller that pins or displays the acting model names the one that runs.
  const aggregatorModel = preset.aggregator.model
    || (await getProviderById(preset.aggregator.providerId).catch(() => null))?.defaultModel
    || null;
  return moaProviderRecord({ ...preset, aggregator: { ...preset.aggregator, model: aggregatorModel ?? undefined } });
}
