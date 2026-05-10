import { describe, it, expect, beforeEach, vi } from 'vitest';

let svc;

beforeEach(async () => {
  vi.resetModules();
  // Stub settings so resolveCivitaiKey doesn't read data/settings.json.
  vi.doMock('./settings.js', () => ({ getSettings: async () => ({}) }));
  svc = await import('./civitaiSuggestions.js');
  svc._resetSuggestionsCache();
});

const buildModel = (id, name, baseModel) => ({
  id,
  name,
  type: 'LORA',
  description: `${name} description`,
  creator: { username: 'someone' },
  stats: { downloadCount: 12345, rating: 4.8 },
  modelVersions: [
    {
      id: id * 10,
      baseModel,
      trainedWords: [`${name.toLowerCase()}-trigger`],
      images: [{ url: `https://civitai.com/${id}.jpg`, nsfwLevel: 1, meta: { prompt: `a sample for ${name}` } }],
      files: [{ name: `${name.replace(/\s/g, '_')}.safetensors`, primary: true, sizeKB: 50000 }],
    },
  ],
});

describe('getSuggestions', () => {
  it('returns curated + per-runner shape', async () => {
    const fetchImpl = async (url) => {
      // Curated direct fetches go through /models/<id>; search goes through /models?...
      const m = url.match(/api\/v1\/models\/(\d+)$/);
      if (m) return { ok: true, status: 200, json: async () => buildModel(Number(m[1]), `Curated-${m[1]}`, 'Flux.1 D') };
      // Search endpoint — return a list with entries matching the requested baseModel.
      const search = new URL(url);
      const baseModels = search.searchParams.getAll('baseModels');
      const items = baseModels.map((bm, i) => buildModel(9000 + i, `Top-${bm}-${i}`, bm));
      return { ok: true, status: 200, json: async () => ({ items }) };
    };
    const out = await svc.getSuggestions({ fetchImpl, limit: 5 });
    expect(Array.isArray(out.curated)).toBe(true);
    expect(out.curated.length).toBeGreaterThan(0);
    expect(out.runners).toHaveProperty('mflux');
    expect(out.runners).toHaveProperty('flux2');
    expect(out.runners).toHaveProperty('z-image');
    expect(out.runners.mflux.length).toBeGreaterThan(0);
    // Curated entries are flagged + carry a note.
    expect(out.curated[0].curated).toBe(true);
    expect(typeof out.curated[0].note).toBe('string');
    expect(typeof out.fetchedAt).toBe('string');
  });

  it('survives a curated fetch failure (one bad id) without dropping the rest', async () => {
    let calls = 0;
    const fetchImpl = async (url) => {
      const m = url.match(/api\/v1\/models\/(\d+)$/);
      if (m) {
        calls += 1;
        // First curated call 404s; rest succeed.
        if (calls === 1) return { ok: false, status: 404 };
        return { ok: true, status: 200, json: async () => buildModel(Number(m[1]), `Ok-${m[1]}`, 'Flux.1 D') };
      }
      return { ok: true, status: 200, json: async () => ({ items: [buildModel(9999, 'Search', 'Flux.1 D')] }) };
    };
    const out = await svc.getSuggestions({ fetchImpl });
    // The first curated entry was dropped, but we should still have the others.
    expect(out.curated.length).toBeGreaterThan(0);
    expect(out.runners.mflux.length).toBe(1);
  });

  it('caches per-runner results across calls (no re-fetch within TTL)', async () => {
    let calls = 0;
    const fetchImpl = async (url) => {
      calls += 1;
      const m = url.match(/api\/v1\/models\/(\d+)$/);
      if (m) return { ok: true, status: 200, json: async () => buildModel(Number(m[1]), `Curated`, 'Flux.1 D') };
      return { ok: true, status: 200, json: async () => ({ items: [buildModel(1, 'Cached', 'Flux.1 D')] }) };
    };
    await svc.getSuggestions({ fetchImpl });
    const callsAfterFirst = calls;
    await svc.getSuggestions({ fetchImpl });
    // Second call should hit cache for both curated and runners — no new HTTP.
    expect(calls).toBe(callsAfterFirst);
  });

  it('force=true busts the cache', async () => {
    let calls = 0;
    const fetchImpl = async (url) => {
      calls += 1;
      const m = url.match(/api\/v1\/models\/(\d+)$/);
      if (m) return { ok: true, status: 200, json: async () => buildModel(Number(m[1]), `C`, 'Flux.1 D') };
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    };
    await svc.getSuggestions({ fetchImpl });
    const callsAfterFirst = calls;
    await svc.getSuggestions({ fetchImpl, force: true });
    expect(calls).toBeGreaterThan(callsAfterFirst);
  });

  it('curated card produces a per-runner-family installs map (one entry per family, first version wins)', async () => {
    const fetchImpl = async (url) => {
      const m = url.match(/api\/v1\/models\/(\d+)$/);
      if (m) {
        const id = Number(m[1]);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ...buildModel(id, 'Multi', 'Flux.1 D'),
            modelVersions: [
              // Most recent (first) per family wins. Two flux2 versions —
              // only the first should be in installs.flux2.
              { id: 100, baseModel: 'Flux.2', files: [{ name: 'a.safetensors', primary: true, sizeKB: 1024 }] },
              { id: 99, baseModel: 'Flux.2', files: [{ name: 'older.safetensors', primary: true, sizeKB: 900 }] },
              { id: 80, baseModel: 'Z-Image', files: [{ name: 'z.safetensors', primary: true, sizeKB: 800 }] },
              { id: 70, baseModel: 'Ernie-Image', files: [{ name: 'e.safetensors', primary: true, sizeKB: 700 }] },
              { id: 60, baseModel: 'Flux.1 D', files: [{ name: 'f1.safetensors', primary: true, sizeKB: 600 }] },
              // Unsupported base — shouldn't appear in installs
              { id: 50, baseModel: 'SDXL 1.0', files: [{ name: 's.safetensors', primary: true, sizeKB: 500 }] },
            ],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    };
    const out = await svc.getSuggestions({ fetchImpl });
    const card = out.curated[0];
    expect(card.installs).toBeDefined();
    expect(card.installs.flux2.versionId).toBe(100); // first match wins
    expect(card.installs['z-image'].versionId).toBe(80);
    expect(card.installs.ernie.versionId).toBe(70);
    expect(card.installs.mflux.versionId).toBe(60);
    // Unsupported base model excluded
    expect(card.installs.sdxl).toBeUndefined();
    // installUrl carries modelVersionId so the install path picks the right version
    expect(card.installs.flux2.installUrl).toMatch(/modelVersionId=100/);
  });

  it('curated card derives runnerFamilies from ALL the model versions', async () => {
    const fetchImpl = async (url) => {
      const m = url.match(/api\/v1\/models\/(\d+)$/);
      if (m) {
        // Multi-version model — Flux.1 D + Flux.2.
        const id = Number(m[1]);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ...buildModel(id, 'Multi', 'Flux.1 D'),
            modelVersions: [
              { id: id * 10, baseModel: 'Flux.1 D', trainedWords: [], images: [], files: [{ name: 'a.safetensors', primary: true }] },
              { id: id * 10 + 1, baseModel: 'Flux.2', trainedWords: [], images: [], files: [{ name: 'b.safetensors', primary: true }] },
            ],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    };
    const out = await svc.getSuggestions({ fetchImpl });
    const card = out.curated[0];
    expect(card.runnerFamilies).toContain('mflux');
    expect(card.runnerFamilies).toContain('flux2');
  });
});
