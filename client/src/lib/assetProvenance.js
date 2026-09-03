/**
 * Asset license provenance — stamp at finalize time, never re-read later.
 *
 * PortOS already resolves a model's license when it downloads one
 * (`licenseOf` in huggingFaceCatalog, Civitai/HF LoRA cards) and then drops
 * it on the floor. Create-suite outputs leave the machine (collections,
 * pipeline export, albums), so the terms that applied WHEN THE PIXELS WERE
 * MADE have to travel with the asset. A license re-read months later can
 * differ from the one in force at render; unknown stays unknown (`null`),
 * displayed as "unknown" — never a permissive default.
 *
 * Shape (schemaVersion 1):
 *   {
 *     schemaVersion: 1,
 *     capturedAt: ISO-8601 | null,
 *     sources: [{ kind: 'model'|'lora', id, name, license, sourceUrl }]
 *   }
 *
 * Pure — no I/O. Server and client share this module byte-for-byte.
 */

export const PROVENANCE_SCHEMA_VERSION = 1;
export const PROVENANCE_SOURCE_KINDS = Object.freeze(['model', 'lora']);
export const UNKNOWN_LICENSE_LABEL = 'unknown';

export function normalizeLicense(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function licenseLabel(license) {
  const normalized = normalizeLicense(license);
  return normalized || UNKNOWN_LICENSE_LABEL;
}

export function huggingfaceUrl(repo) {
  if (typeof repo !== 'string') return null;
  const id = repo.trim();
  return id ? `https://huggingface.co/${id}` : null;
}

export function licenseFromHuggingFaceModel(model) {
  const card = normalizeLicense(model?.cardData?.license || model?.license);
  if (card) return card;
  const tags = Array.isArray(model?.tags) ? model.tags : [];
  const tag = tags.find((t) => typeof t === 'string' && /^license:/i.test(t));
  return tag ? normalizeLicense(tag.slice(tag.indexOf(':') + 1)) : null;
}

export function licenseFromCivitaiModel(model) {
  // Civitai's `allowCommercialUse` is a policy flag, not a license string —
  // never promote it into one. Only a real `license` field counts.
  return normalizeLicense(model?.license);
}

export function buildProvenanceSource({ kind, id, name = null, license = null, sourceUrl = null } = {}) {
  if (!PROVENANCE_SOURCE_KINDS.includes(kind)) return null;
  if (typeof id !== 'string' || !id.trim()) return null;
  const url = typeof sourceUrl === 'string' && sourceUrl.trim() ? sourceUrl.trim() : null;
  const display = typeof name === 'string' && name.trim() ? name.trim() : null;
  return {
    kind,
    id: id.trim(),
    name: display,
    license: normalizeLicense(license),
    sourceUrl: url,
  };
}

const sourceKey = (src) => `${src.kind}:${src.id}`;

export function buildProvenance({ sources = [], capturedAt = null } = {}) {
  const captured = typeof capturedAt === 'string' && capturedAt.trim() ? capturedAt.trim() : null;
  const byKey = new Map();
  for (const raw of Array.isArray(sources) ? sources : []) {
    const src = buildProvenanceSource(raw);
    if (!src) continue;
    const key = sourceKey(src);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, src);
      continue;
    }
    // Prefer a known license over unknown when the same source appears twice
    // in one stamp (model + LoRA list shouldn't collide, but a rollup can).
    if (existing.license == null && src.license != null) {
      byKey.set(key, {
        ...existing,
        license: src.license,
        name: existing.name || src.name,
        sourceUrl: existing.sourceUrl || src.sourceUrl,
      });
      continue;
    }
    byKey.set(key, {
      ...existing,
      name: existing.name || src.name,
      sourceUrl: existing.sourceUrl || src.sourceUrl,
    });
  }
  return {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    capturedAt: captured,
    sources: [...byKey.values()],
  };
}

export function readProvenance(record) {
  const raw = record?.provenance;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const built = buildProvenance({
    sources: Array.isArray(raw.sources) ? raw.sources : [],
    capturedAt: raw.capturedAt,
  });
  return built.sources.length ? built : null;
}

function pickLoraFilenames(record) {
  if (Array.isArray(record?.loraFilenames)) return record.loraFilenames;
  if (Array.isArray(record?.lora_filenames)) return record.lora_filenames;
  return [];
}

export function resolveAssetProvenance(record) {
  const stamped = readProvenance(record);
  if (stamped) return { ...stamped, reconstructed: false };
  if (!record || typeof record !== 'object') return null;
  const modelId = record.modelId || record.model;
  const loras = pickLoraFilenames(record).filter((f) => typeof f === 'string' && f);
  if (!modelId && !loras.length) return null;
  const capturedAt = typeof record.createdAt === 'string' ? record.createdAt : null;
  return {
    ...buildProvenance({
      sources: [
        ...(modelId ? [{ kind: 'model', id: String(modelId), license: null }] : []),
        ...loras.map((id) => ({ kind: 'lora', id, license: null })),
      ],
      capturedAt,
    }),
    reconstructed: true,
  };
}

export function licenseFromRegistryModel(model) {
  // Weights terms only. `disclosure.runtimeLicense` is the inference stack
  // (often MIT) and must never be promoted into the asset's model license.
  return normalizeLicense(model?.license)
    || normalizeLicense(model?.disclosure?.weightsLicense?.name);
}

export function provenanceForRender({ model = null, loras = [], capturedAt = null } = {}) {
  const sources = [];
  if (model && (model.id || model.name)) {
    const id = String(model.id || model.name);
    const disclosureUrl = typeof model.disclosure?.modelCardUrl === 'string'
      ? model.disclosure.modelCardUrl
      : null;
    const weightsUrl = typeof model.disclosure?.weightsLicense?.url === 'string'
      ? model.disclosure.weightsLicense.url
      : null;
    sources.push({
      kind: 'model',
      id,
      name: model.name || null,
      license: licenseFromRegistryModel(model),
      sourceUrl: model.sourceUrl || huggingfaceUrl(model.repo) || disclosureUrl || weightsUrl,
    });
  }
  for (const lora of Array.isArray(loras) ? loras : []) {
    const filename = typeof lora === 'string' ? lora : lora?.filename;
    if (typeof filename !== 'string' || !filename) continue;
    sources.push({
      kind: 'lora',
      id: filename,
      name: typeof lora === 'object' ? (lora.name || null) : null,
      license: typeof lora === 'object' ? lora.license : null,
      sourceUrl: typeof lora === 'object' ? lora.sourceUrl : null,
    });
  }
  return buildProvenance({ sources, capturedAt });
}

export function rollupProvenance(records) {
  const sources = [];
  for (const record of Array.isArray(records) ? records : []) {
    const resolved = resolveAssetProvenance(record);
    if (!resolved) continue;
    sources.push(...resolved.sources);
  }
  return buildProvenance({ sources, capturedAt: null });
}

export function formatProvenanceSource(src) {
  const built = buildProvenanceSource(src);
  if (!built) return null;
  return { ...built, licenseLabel: licenseLabel(built.license) };
}
