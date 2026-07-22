import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { searchHuggingFaceModels, enrichCatalogWithVariants } from './huggingFaceCatalog.js'
import { __resetOllamaRegistryCache } from './ollamaRegistryCatalog.js'

const response = (body, ok = true) => ({
  ok,
  status: ok ? 200 : 500,
  json: vi.fn(async () => body),
  text: vi.fn(async () => JSON.stringify(body))
})

describe('huggingFaceCatalog', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('maps GGUF search results to Ollama hf.co install ids with preferred quants', async () => {
    fetch.mockResolvedValue(response([
      {
        modelId: 'unsloth/Qwen3.6-35B-A3B-GGUF',
        downloads: 100000,
        likes: 1000,
        tags: ['gguf', 'qwen', 'image-text-to-text', 'license:apache-2.0'],
        lastModified: new Date().toISOString(),
        siblings: [
          { rfilename: 'Qwen3.6-35B-A3B-UD-IQ2_XXS.gguf', size: 13_000_000_000 },
          { rfilename: 'Qwen3.6-35B-A3B-UD-Q4_K_M.gguf', size: 24_000_000_000 }
        ]
      }
    ]))

    const results = await searchHuggingFaceModels({
      backend: 'ollama',
      query: 'qwen3.6',
      category: 'coding',
      installedIds: []
    })

    expect(results[0]).toMatchObject({
      id: 'hf.co/unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_M',
      repository: 'unsloth/Qwen3.6-35B-A3B-GGUF',
      category: 'coding',
      source: 'huggingface',
      quant: 'UD-Q4_K_M',
      license: 'apache-2.0'
    })
    expect(results[0].capabilities).toEqual(expect.arrayContaining(['chat', 'code']))
    expect(results[0].installable).toBe(true)
  })

  it('returns LM Studio repo ids and marks installed repos', async () => {
    fetch.mockResolvedValue(response([
      {
        id: 'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF',
        downloads: 10,
        likes: 2,
        tags: ['gguf'],
        siblings: [{ rfilename: 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf', size: 4_700_000_000 }]
      }
    ]))

    const results = await searchHuggingFaceModels({
      backend: 'lmstudio',
      query: 'llama',
      installedIds: ['bartowski/Meta-Llama-3.1-8B-Instruct-GGUF']
    })

    expect(results[0].id).toBe('bartowski/Meta-Llama-3.1-8B-Instruct-GGUF')
    expect(results[0].installed).toBe(true)
  })

  it('backfills file sizes from the per-model blobs endpoint when the search omits them', async () => {
    fetch
      .mockResolvedValueOnce(response([
        {
          modelId: 'nomic-ai/nomic-embed-text-v1.5-GGUF',
          downloads: 50,
          tags: ['gguf'],
          siblings: [{ rfilename: 'nomic-embed-text-v1.5.Q4_K_M.gguf' }] // search returns no size
        }
      ]))
      .mockResolvedValueOnce(response({
        id: 'nomic-ai/nomic-embed-text-v1.5-GGUF',
        siblings: [{ rfilename: 'nomic-embed-text-v1.5.Q4_K_M.gguf', size: 84_106_624 }]
      }))

    const results = await searchHuggingFaceModels({ backend: 'ollama', query: 'nomic-embed' })

    expect(results[0].sizeBytes).toBe(84_106_624)
    expect(results[0].size).toMatch(/\d+(\.\d+)?\s(MB|GB)/)
  })

  it('backfills the native context window from the per-model gguf metadata', async () => {
    fetch
      .mockResolvedValueOnce(response([
        {
          modelId: 'lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF',
          downloads: 50,
          tags: ['gguf'],
          // search listing omits both the size and the gguf metadata block
          siblings: [{ rfilename: 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf' }]
        }
      ]))
      .mockResolvedValueOnce(response({
        id: 'lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF',
        gguf: { context_length: 131072 },
        siblings: [{ rfilename: 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf', size: 4_700_000_000 }]
      }))

    const results = await searchHuggingFaceModels({ backend: 'ollama', query: 'llama' })

    expect(results[0].contextLength).toBe(131072)
    expect(results[0].sizeBytes).toBe(4_700_000_000)
  })

  it('leaves contextLength null when the repo record carries no gguf window', async () => {
    fetch
      .mockResolvedValueOnce(response([
        { modelId: 'org/Useful-GGUF', downloads: 1, tags: ['gguf'], siblings: [{ rfilename: 'Useful-Q4_K_M.gguf', size: 100 }] }
      ]))
      .mockResolvedValueOnce(response({ id: 'org/Useful-GGUF', siblings: [{ rfilename: 'Useful-Q4_K_M.gguf', size: 100 }] }))

    const results = await searchHuggingFaceModels({ backend: 'ollama', query: 'useful' })

    expect(results[0].contextLength).toBeNull()
  })

  it('filters out non-GGUF results even if Hugging Face returns them', async () => {
    fetch.mockResolvedValue(response([
      { modelId: 'org/Plain-Safetensors', tags: ['safetensors'], siblings: [] },
      { modelId: 'org/Useful-GGUF', tags: [], siblings: [{ rfilename: 'Useful-Q4_K_M.gguf' }] }
    ]))

    const results = await searchHuggingFaceModels({ backend: 'ollama', query: 'useful' })

    expect(results.map((r) => r.repository)).toEqual(['org/Useful-GGUF'])
  })

  describe('audio category', () => {
    it('surfaces non-GGUF audio models (relaxes the GGUF filter) and infers the engine', async () => {
      fetch.mockResolvedValue(response([
        {
          modelId: 'facebook/musicgen-large',
          downloads: 500000,
          likes: 2000,
          tags: ['text-to-audio', 'musicgen', 'safetensors'],
          pipeline_tag: 'text-to-audio',
          siblings: [{ rfilename: 'model.safetensors', size: 13_000_000_000 }]
        }
      ]))

      const results = await searchHuggingFaceModels({ backend: 'ollama', query: 'musicgen', category: 'audio' })
      const musicgen = results.find((r) => r.repository === 'facebook/musicgen-large')

      expect(musicgen).toBeTruthy()
      expect(musicgen.category).toBe('audio')
      expect(musicgen.capabilities).toEqual(['audio'])
      expect(musicgen.engine).toBe('musicgen')
      // MusicGen threads --model into from_pretrained → custom checkpoints work.
      expect(musicgen.installable).toBe(true)
      // The Ollama install id is never used for audio — it's the bare repo id.
      expect(musicgen.id).toBe('facebook/musicgen-large')
    })

    it('always leads with curated suggestions (ACE-Step / Magenta / Stable Audio)', async () => {
      fetch.mockResolvedValue(response([]))

      const results = await searchHuggingFaceModels({ backend: 'ollama', category: 'audio' })
      const byRepo = Object.fromEntries(results.map((r) => [r.repository, r]))

      // ACE-Step uses a fixed checkpoint (customModels: false) → Visit-only.
      expect(byRepo['ACE-Step/acestep-v15-xl-base']).toMatchObject({ category: 'audio', engine: 'acestep', installable: false, suggested: true })
      // No PortOS runtime yet → not installable.
      expect(byRepo['google/magenta-realtime-2']).toMatchObject({ engine: null, installable: false, suggested: true })
      // Gated behind a data-sharing agreement.
      expect(byRepo['stabilityai/stable-audio-3-medium']).toMatchObject({ gated: true, installable: false })
      expect(byRepo['stabilityai/stable-audio-3-medium'].note).toMatch(/data-sharing agreement/i)
    })

    it('drops non-audio results from a non-audio query (no GGUF, but audio-only)', async () => {
      // category=audio relaxes the GGUF filter — but a query like "llama" must
      // not surface unrelated chat models mislabeled as audio. Only the curated
      // suggestions (which match the query? none here) should remain.
      fetch.mockResolvedValue(response([
        {
          modelId: 'meta-llama/Llama-3.1-8B-Instruct',
          downloads: 999999,
          tags: ['text-generation', 'safetensors'],
          pipeline_tag: 'text-generation',
          siblings: [{ rfilename: 'model.safetensors', size: 8_000_000_000 }]
        }
      ]))

      const results = await searchHuggingFaceModels({ backend: 'ollama', query: 'llama', category: 'audio' })
      expect(results.find((r) => r.repository === 'meta-llama/Llama-3.1-8B-Instruct')).toBeUndefined()
    })

  })

  describe('quant variants + RAM-aware default', () => {
    // Each test uses a UNIQUE repo id: `fetchRepoModel` caches per repo at module
    // scope, so reusing an id would replay a prior test's blobs response.
    const listing = (modelId, files) => response([
      { modelId, downloads: 100, likes: 10, tags: ['gguf'], siblings: files.map((rfilename) => ({ rfilename })) }
    ])
    const blobs = (id, sized) => response({ id, siblings: Object.entries(sized).map(([rfilename, size]) => ({ rfilename, size })) })

    it('exposes every quant as a size-desc variant and defaults to the largest that fits a big machine', async () => {
      const repo = 'empero-ai/Qwythos-9B-Claude-GGUF'
      fetch
        .mockResolvedValueOnce(listing(repo, ['Qwythos-9B-Q4_K_M.gguf', 'Qwythos-9B-Q8_0.gguf', 'Qwythos-9B-BF16.gguf']))
        .mockResolvedValueOnce(blobs(repo, {
          'Qwythos-9B-Q4_K_M.gguf': 5_500_000_000,
          'Qwythos-9B-Q8_0.gguf': 9_500_000_000,
          'Qwythos-9B-BF16.gguf': 18_000_000_000,
        }))

      const [result] = await searchHuggingFaceModels({ backend: 'ollama', query: 'qwythos', systemMemoryBytes: 128 * 1024 ** 3 })

      expect(result.variants.map((v) => v.quant)).toEqual(['BF16', 'Q8_0', 'Q4_K_M'])
      expect(result.variants[0].installId).toBe(`hf.co/${repo}:BF16`)
      // 128 GB unified memory → default to the highest-fidelity build that fits.
      expect(result).toMatchObject({ id: `hf.co/${repo}:BF16`, quant: 'BF16', sizeBytes: 18_000_000_000 })
      expect(result.variants.find((v) => v.quant === 'BF16')).toMatchObject({ recommended: true, fit: 'comfortable' })
    })

    it('does not mistake a custom quant scheme suffix for a standard quant tag', async () => {
      // `…-AVQ2.gguf` is a repo-specific scheme, not `Q2`. Emitting `hf.co/<repo>:Q2`
      // makes Ollama reject the pull ("not a valid quantization scheme"); the bare
      // repo id resolves through Ollama's `latest` manifest instead.
      const repo = 'exampleorg/Example-3-Compact'
      fetch
        .mockResolvedValueOnce(listing(repo, ['model/Example-3-Compact-AVQ2.gguf']))
        .mockResolvedValueOnce(blobs(repo, { 'model/Example-3-Compact-AVQ2.gguf': 8_400_000_000 }))

      const [result] = await searchHuggingFaceModels({ backend: 'ollama', query: 'example-3', systemMemoryBytes: 128 * 1024 ** 3 })

      expect(result).toMatchObject({ id: `hf.co/${repo}`, quant: null, installable: true, sizeBytes: 8_400_000_000 })
      expect(result.variants || []).toEqual([])
    })

    it('defaults to a small quant on a low-memory machine', async () => {
      const repo = 'empero-ai/Qwythos-9B-Small-GGUF'
      fetch
        .mockResolvedValueOnce(listing(repo, ['Qwythos-9B-Q4_K_M.gguf', 'Qwythos-9B-Q8_0.gguf', 'Qwythos-9B-BF16.gguf']))
        .mockResolvedValueOnce(blobs(repo, {
          'Qwythos-9B-Q4_K_M.gguf': 5_500_000_000,
          'Qwythos-9B-Q8_0.gguf': 9_500_000_000,
          'Qwythos-9B-BF16.gguf': 18_000_000_000,
        }))

      // 16 GB total → usable 8 GB → only Q4_K_M's ~6.6 GB resident estimate fits.
      const [result] = await searchHuggingFaceModels({ backend: 'ollama', query: 'qwythos', systemMemoryBytes: 16 * 1024 ** 3 })

      expect(result).toMatchObject({ id: `hf.co/${repo}:Q4_K_M`, quant: 'Q4_K_M' })
      const byQuant = Object.fromEntries(result.variants.map((v) => [v.quant, v.fit]))
      // Q4_K_M still fits (it's the chosen default) but its ~6.6 GB resident
      // estimate is past the 60%-of-usable comfort line → 'tight'.
      expect(byQuant).toEqual({ BF16: 'too-large', Q8_0: 'too-large', Q4_K_M: 'tight' })
    })

    it('keeps the QUANT_PRIORITY default and marks fit unknown when no memory budget is supplied', async () => {
      const repo = 'empero-ai/Qwythos-9B-NoBudget-GGUF'
      fetch
        .mockResolvedValueOnce(listing(repo, ['Qwythos-9B-Q4_K_M.gguf', 'Qwythos-9B-Q8_0.gguf', 'Qwythos-9B-BF16.gguf']))
        .mockResolvedValueOnce(blobs(repo, {
          'Qwythos-9B-Q4_K_M.gguf': 5_500_000_000,
          'Qwythos-9B-Q8_0.gguf': 9_500_000_000,
          'Qwythos-9B-BF16.gguf': 18_000_000_000,
        }))

      const [result] = await searchHuggingFaceModels({ backend: 'ollama', query: 'qwythos' })

      // No systemMemoryBytes → the QUANT_PRIORITY pick (Q4_K_M) is preserved.
      expect(result).toMatchObject({ id: `hf.co/${repo}:Q4_K_M`, quant: 'Q4_K_M' })
      expect(result.variants.map((v) => v.quant)).toEqual(['BF16', 'Q8_0', 'Q4_K_M'])
      expect(result.variants.find((v) => v.recommended).quant).toBe('Q4_K_M')
      expect(result.variants.every((v) => v.fit === 'unknown')).toBe(true)
    })

    it('sums multi-part GGUF shards into a single variant and resolves the quant', async () => {
      const repo = 'org/Big-Shard-GGUF'
      fetch
        .mockResolvedValueOnce(listing(repo, ['Big-BF16-00001-of-00002.gguf', 'Big-BF16-00002-of-00002.gguf']))
        .mockResolvedValueOnce(blobs(repo, {
          'Big-BF16-00001-of-00002.gguf': 20_000_000_000,
          'Big-BF16-00002-of-00002.gguf': 20_000_000_000,
        }))

      const [result] = await searchHuggingFaceModels({ backend: 'ollama', query: 'big', systemMemoryBytes: 128 * 1024 ** 3 })

      expect(result.variants).toHaveLength(1)
      expect(result.variants[0]).toMatchObject({ quant: 'BF16', sizeBytes: 40_000_000_000 })
    })

    it('flags a sharded quant as Ollama-unsupported (ollama/ollama#5245)', async () => {
      const repo = 'org/Sharded-Only-GGUF'
      fetch
        .mockResolvedValueOnce(listing(repo, ['Big-Q8_0-00001-of-00002.gguf', 'Big-Q8_0-00002-of-00002.gguf']))
        .mockResolvedValueOnce(blobs(repo, {
          'Big-Q8_0-00001-of-00002.gguf': 40_000_000_000,
          'Big-Q8_0-00002-of-00002.gguf': 40_000_000_000,
        }))

      const [result] = await searchHuggingFaceModels({ backend: 'ollama', query: 'sharded', systemMemoryBytes: 128 * 1024 ** 3 })

      expect(result.variants[0]).toMatchObject({ quant: 'Q8_0', sharded: true, unsupported: 'sharded' })
      expect(result.variants[0].unsupportedReason).toMatch(/sharded/i)
    })

    it('does not flag a sharded quant on LM Studio (it loads shards natively)', async () => {
      const repo = 'org/Sharded-Lms-GGUF'
      fetch
        .mockResolvedValueOnce(listing(repo, ['Big-Q8_0-00001-of-00002.gguf', 'Big-Q8_0-00002-of-00002.gguf']))
        .mockResolvedValueOnce(blobs(repo, {
          'Big-Q8_0-00001-of-00002.gguf': 40_000_000_000,
          'Big-Q8_0-00002-of-00002.gguf': 40_000_000_000,
        }))

      const [result] = await searchHuggingFaceModels({ backend: 'lmstudio', query: 'sharded', systemMemoryBytes: 128 * 1024 ** 3 })

      expect(result.variants[0]).toMatchObject({ quant: 'Q8_0', sharded: true })
      expect(result.variants[0].unsupported).toBeUndefined()
    })

    it('defaults Ollama to a single-file quant when the larger quant is sharded', async () => {
      const repo = 'org/Mixed-Shard-GGUF'
      fetch
        // Q8_0 is sharded (80 GB, two parts); Q4_K_M is a single 40 GB file.
        .mockResolvedValueOnce(listing(repo, [
          'M-Q8_0-00001-of-00002.gguf', 'M-Q8_0-00002-of-00002.gguf', 'M-Q4_K_M.gguf',
        ]))
        .mockResolvedValueOnce(blobs(repo, {
          'M-Q8_0-00001-of-00002.gguf': 40_000_000_000,
          'M-Q8_0-00002-of-00002.gguf': 40_000_000_000,
          'M-Q4_K_M.gguf': 40_000_000_000,
        }))

      const [result] = await searchHuggingFaceModels({ backend: 'ollama', query: 'mixed', systemMemoryBytes: 256 * 1024 ** 3 })

      // Even on a huge machine where the 80 GB Q8_0 "fits", the RAM-aware default
      // must skip the sharded build and recommend the installable single-file quant.
      expect(result.quant).toBe('Q4_K_M')
      expect(result.variants.find((v) => v.recommended).quant).toBe('Q4_K_M')
      expect(result.variants.find((v) => v.quant === 'Q8_0')).toMatchObject({ unsupported: 'sharded' })
    })

    it('builds LM Studio variant ids with the @quant syntax and still detects installed repos', async () => {
      const repo = 'bartowski/LmModel-GGUF'
      fetch
        .mockResolvedValueOnce(listing(repo, ['LmModel-Q4_K_M.gguf', 'LmModel-Q8_0.gguf']))
        .mockResolvedValueOnce(blobs(repo, {
          'LmModel-Q4_K_M.gguf': 4_000_000_000,
          'LmModel-Q8_0.gguf': 8_000_000_000,
        }))

      const [result] = await searchHuggingFaceModels({
        backend: 'lmstudio', query: 'lmmodel', systemMemoryBytes: 128 * 1024 ** 3, installedIds: [repo]
      })

      expect(result.variants.map((v) => v.installId)).toEqual([`${repo}@Q8_0`, `${repo}@Q4_K_M`])
      // RAM-aware default applies the quant to the LM Studio id too.
      expect(result.id).toBe(`${repo}@Q8_0`)
      // Bare-repo installed list still matches the quant-tagged result.
      expect(result.installed).toBe(true)
    })

    it('excludes multimodal projector (mmproj) GGUFs from variants and the default pick', async () => {
      const repo = 'unsloth/Qwen2-VL-7B-GGUF'
      fetch
        .mockResolvedValueOnce(listing(repo, ['Qwen2-VL-7B-Q4_K_M.gguf', 'mmproj-Qwen2-VL-7B-f16.gguf']))
        .mockResolvedValueOnce(blobs(repo, {
          'Qwen2-VL-7B-Q4_K_M.gguf': 5_000_000_000,
          'mmproj-Qwen2-VL-7B-f16.gguf': 1_400_000_000,
        }))

      // 8 GB box: with the projector counted, the tight-budget fallback (smallest)
      // would wrongly land on the 1.4 GB projector. It must be excluded entirely.
      const [result] = await searchHuggingFaceModels({ backend: 'ollama', query: 'qwen2-vl', systemMemoryBytes: 8 * 1024 ** 3 })

      expect(result.variants.map((v) => v.quant)).toEqual(['Q4_K_M'])
      expect(result.id).toBe(`hf.co/${repo}:Q4_K_M`)
    })

    it('does not sum two standalone same-quant files into one double-size variant', async () => {
      const repo = 'org/Dup-Quant-GGUF'
      fetch
        .mockResolvedValueOnce(listing(repo, ['Model-Q4_K_M.gguf', 'Model-v2-Q4_K_M.gguf']))
        .mockResolvedValueOnce(blobs(repo, {
          'Model-Q4_K_M.gguf': 5_000_000_000,
          'Model-v2-Q4_K_M.gguf': 4_000_000_000,
        }))

      const [result] = await searchHuggingFaceModels({ backend: 'ollama', query: 'dup', systemMemoryBytes: 128 * 1024 ** 3 })

      // One Q4_K_M variant (the tag installs one file), sized as the largest single
      // unit (5 GB) — NOT 9 GB summed across two unrelated files.
      expect(result.variants).toHaveLength(1)
      expect(result.variants[0]).toMatchObject({ quant: 'Q4_K_M', sizeBytes: 5_000_000_000 })
    })

    it('treats a tiny machine (zero usable RAM) as a real budget: smallest variant, all too-large', async () => {
      const repo = 'empero-ai/Qwythos-9B-Tiny-GGUF'
      fetch
        .mockResolvedValueOnce(listing(repo, ['Qwythos-9B-Q4_K_M.gguf', 'Qwythos-9B-Q8_0.gguf']))
        .mockResolvedValueOnce(blobs(repo, {
          'Qwythos-9B-Q4_K_M.gguf': 5_500_000_000,
          'Qwythos-9B-Q8_0.gguf': 9_500_000_000,
        }))

      // 8 GB total → usable 0 (at/below reserved headroom). Must NOT revert to the
      // QUANT_PRIORITY default — pick the smallest and flag everything too-large.
      const [result] = await searchHuggingFaceModels({ backend: 'ollama', query: 'qwythos', systemMemoryBytes: 8 * 1024 ** 3 })

      expect(result.id).toBe(`hf.co/${repo}:Q4_K_M`)
      expect(Object.fromEntries(result.variants.map((v) => [v.quant, v.fit]))).toEqual({ Q8_0: 'too-large', Q4_K_M: 'too-large' })
    })

    it('marks LM Studio installed state per-quant when the installed list carries the quantization', async () => {
      const repo = 'bartowski/PerQuant-GGUF'
      fetch
        .mockResolvedValueOnce(listing(repo, ['PerQuant-Q4_K_M.gguf', 'PerQuant-Q8_0.gguf']))
        .mockResolvedValueOnce(blobs(repo, {
          'PerQuant-Q4_K_M.gguf': 4_000_000_000,
          'PerQuant-Q8_0.gguf': 8_000_000_000,
        }))

      // The route encodes LM Studio installs as `<id>@<quant>`; only Q4_K_M is down.
      const [result] = await searchHuggingFaceModels({
        backend: 'lmstudio', query: 'perquant', systemMemoryBytes: 128 * 1024 ** 3, installedIds: [`${repo}@Q4_K_M`]
      })

      expect(Object.fromEntries(result.variants.map((v) => [v.quant, v.installed]))).toEqual({ Q8_0: false, Q4_K_M: true })
      // Default is Q8_0 (largest fits) and it is NOT installed → the card offers Install.
      expect(result.id).toBe(`${repo}@Q8_0`)
      expect(result.installed).toBe(false)
    })

    it('marks per-quant installed state for Ollama variants and aligns the result flag with the default', async () => {
      const repo = 'empero-ai/Qwythos-9B-Installed-GGUF'
      fetch
        .mockResolvedValueOnce(listing(repo, ['Qwythos-9B-Q4_K_M.gguf', 'Qwythos-9B-Q8_0.gguf', 'Qwythos-9B-BF16.gguf']))
        .mockResolvedValueOnce(blobs(repo, {
          'Qwythos-9B-Q4_K_M.gguf': 5_500_000_000,
          'Qwythos-9B-Q8_0.gguf': 9_500_000_000,
          'Qwythos-9B-BF16.gguf': 18_000_000_000,
        }))

      // Only the Q4_K_M quant is installed on Ollama.
      const [result] = await searchHuggingFaceModels({
        backend: 'ollama', query: 'qwythos', systemMemoryBytes: 128 * 1024 ** 3, installedIds: [`hf.co/${repo}:Q4_K_M`]
      })

      const byQuant = Object.fromEntries(result.variants.map((v) => [v.quant, v.installed]))
      expect(byQuant).toEqual({ BF16: false, Q8_0: false, Q4_K_M: true })
      // 128 GB box defaults to BF16, which is NOT installed — so the card must
      // offer Install, not claim "Installed" off the repo's Q4 presence.
      expect(result.id).toBe(`hf.co/${repo}:BF16`)
      expect(result.installed).toBe(false)
    })

    it('anchors the LM Studio default on a variant even when the repo omits file sizes', async () => {
      const repo = 'bartowski/NoSize-GGUF'
      fetch
        .mockResolvedValueOnce(listing(repo, ['NoSize-Q4_K_M.gguf', 'NoSize-Q8_0.gguf']))
        // HF's blobs endpoint sometimes omits per-file sizes — the budget pick
        // can't fire, but the default must still resolve to a real variant id.
        .mockResolvedValueOnce(response({ id: repo, siblings: [{ rfilename: 'NoSize-Q4_K_M.gguf' }, { rfilename: 'NoSize-Q8_0.gguf' }] }))

      const [result] = await searchHuggingFaceModels({ backend: 'lmstudio', query: 'nosize', systemMemoryBytes: 128 * 1024 ** 3 })

      expect(result.variants.map((v) => v.installId)).toEqual([`${repo}@Q4_K_M`, `${repo}@Q8_0`])
      // Falls back to the QUANT_PRIORITY pick (Q4_K_M) as the default — and it
      // must equal a listed variant so the client's controlled <select> matches.
      expect(result.id).toBe(`${repo}@Q4_K_M`)
      expect(result.variants.find((v) => v.recommended).installId).toBe(result.id)
    })

    it('does not cache a transient blobs-fetch failure — re-enriches once HF recovers', async () => {
      const repo = 'org/Flaky-GGUF'
      let blobsCalls = 0
      fetch.mockImplementation(async (url) => {
        const u = String(url)
        if (u.includes('blobs=true')) {
          blobsCalls += 1
          if (blobsCalls === 1) throw new Error('transient network error')
          return response({ id: repo, siblings: [{ rfilename: 'M-Q4_K_M.gguf', size: 4_000_000_000 }] })
        }
        return response([{ modelId: repo, downloads: 10, tags: ['gguf'], siblings: [{ rfilename: 'M-Q4_K_M.gguf' }] }])
      })

      const [first] = await searchHuggingFaceModels({ backend: 'ollama', query: 'flaky', systemMemoryBytes: 128 * 1024 ** 3 })
      // Transient failure → no variants, and crucially NOT cached as a null result.
      expect(first.variants).toBeUndefined()

      const [second] = await searchHuggingFaceModels({ backend: 'ollama', query: 'flaky', systemMemoryBytes: 128 * 1024 ** 3 })
      // Retried (the null wasn't cached) → enrichment succeeds this time.
      expect(second.variants).toBeTruthy()
      expect(second.sizeBytes).toBe(4_000_000_000)
    })
  })

  describe('sort order', () => {
    it('ranks by downloads, with recency breaking near-ties between equally-popular models', async () => {
      const now = Date.now()
      const day = 86_400_000
      const models = [
        { modelId: 'org/Old-Popular-GGUF', downloads: 5000, lastModified: new Date(now - 800 * day).toISOString(), tags: ['gguf'], siblings: [{ rfilename: 'm-Q4_K_M.gguf', size: 4_000_000_000 }] },
        { modelId: 'org/New-Popular-GGUF', downloads: 5000, lastModified: new Date(now - 3 * day).toISOString(), tags: ['gguf'], siblings: [{ rfilename: 'm-Q4_K_M.gguf', size: 4_000_000_000 }] },
        { modelId: 'org/Huge-GGUF', downloads: 5_000_000, lastModified: new Date(now - 200 * day).toISOString(), tags: ['gguf'], siblings: [{ rfilename: 'm-Q4_K_M.gguf', size: 4_000_000_000 }] },
      ]
      fetch.mockImplementation(async (url) => (
        String(url).includes('blobs=true')
          ? response({ id: 'x', siblings: [{ rfilename: 'm-Q4_K_M.gguf', size: 4_000_000_000 }] })
          : response(models)
      ))

      const results = await searchHuggingFaceModels({ backend: 'ollama', query: 'm' })
      const order = results.map((r) => r.repository)

      // Far-and-away most-downloaded model leads overall.
      expect(order[0]).toBe('org/Huge-GGUF')
      // Between two models with identical downloads, the fresher one ranks higher.
      expect(order.indexOf('org/New-Popular-GGUF')).toBeLessThan(order.indexOf('org/Old-Popular-GGUF'))
    })
  })

  describe('empty-query category browse', () => {
    // Clicking a category tag with no search term seeds the Hub query from
    // CATEGORY_SEARCH. The Hub `search` param is AND-across the space-separated
    // tokens against the model id, so a multi-word phrase ('coding coder agentic
    // code gguf') matches ZERO repos and the tab renders blank. Each browse
    // phrase must stay a short keyword + 'gguf' so the default browse returns the
    // top-downloaded matches. These tests lock that in for the GGUF categories.
    const sentSearch = () => {
      const call = fetch.mock.calls.find(([u]) => /[?&]search=/.test(String(u)) && /filter=gguf/.test(String(u)))
      return decodeURIComponent(String(call[0]).match(/[?&]search=([^&]*)/)[1])
    }

    it.each(['chat', 'reasoning', 'coding', 'vision', 'embedding', 'lightweight', 'multilingual'])(
      'seeds a short (<=2 token) gguf browse phrase for category %s',
      async (category) => {
        fetch.mockResolvedValue(response([]))
        await searchHuggingFaceModels({ backend: 'ollama', category }) // no query
        const search = sentSearch()
        // A 5-word AND phrase is exactly the bug that blanked the coding tab.
        expect(search.trim().split(/\s+/).length).toBeLessThanOrEqual(2)
        expect(search).toMatch(/gguf/)
      }
    )
  })

  describe('MLX models (Apple Silicon)', () => {
    // URL-aware mock: order matters (most-specific first). MLX adds a parallel
    // `filter=mlx` query + per-repo blobs fetch, so a sequential mock is fragile;
    // route by URL instead.
    const urlRouter = (routes) => vi.fn(async (url) => {
      const u = String(url)
      for (const [match, body] of routes) {
        const hit = typeof match === 'function' ? match(u) : u.includes(match)
        if (hit) return response(body)
      }
      return response([])
    })
    const mlxListing = (modelId, files) => (
      { modelId, downloads: 5000, likes: 200, tags: ['mlx', 'safetensors'], siblings: files.map((rfilename) => ({ rfilename })) }
    )
    const mlxBlobs = (id, sized) => ({ id, siblings: Object.entries(sized).map(([rfilename, size]) => ({ rfilename, size })) })

    it('surfaces an MLX result for LM Studio on Apple Silicon with a summed safetensors variant', async () => {
      const repo = 'mlx-community/Qwythos-9B-MLX-4bit'
      fetch.mockImplementation(urlRouter([
        ['filter=mlx', [mlxListing(repo, ['model-00001-of-00002.safetensors', 'model-00002-of-00002.safetensors'])]],
        ['filter=gguf', []],
        [(u) => u.includes('blobs=true'), mlxBlobs(repo, {
          'model-00001-of-00002.safetensors': 9_000_000_000,
          'model-00002-of-00002.safetensors': 9_000_000_000,
        })],
      ]))

      const results = await searchHuggingFaceModels({
        backend: 'lmstudio', query: 'qwythos', systemMemoryBytes: 128 * 1024 ** 3, appleSilicon: true
      })
      const mlx = results.find((r) => r.repository === repo)

      expect(mlx).toBeTruthy()
      expect(mlx).toMatchObject({ format: 'mlx', id: repo, quant: '4bit', installable: true, sizeBytes: 18_000_000_000 })
      expect(mlx.variants).toHaveLength(1)
      expect(mlx.variants[0]).toMatchObject({ format: 'mlx', quant: '4bit', installId: repo, sizeBytes: 18_000_000_000, fit: 'comfortable', recommended: true })
    })

    it('never surfaces MLX for the Ollama backend (Ollama MLX uses its own registry, not HF safetensors)', async () => {
      const ggufRepo = 'org/Plain-GGUF'
      const mlxRepo = 'mlx-community/Should-Not-Appear-4bit'
      fetch.mockImplementation(urlRouter([
        ['filter=mlx', [mlxListing(mlxRepo, ['model.safetensors'])]],
        ['filter=gguf', [{ modelId: ggufRepo, downloads: 10, tags: ['gguf'], siblings: [{ rfilename: 'Plain-Q4_K_M.gguf', size: 4_000_000_000 }] }]],
        [(u) => u.includes('blobs=true'), { id: ggufRepo, siblings: [{ rfilename: 'Plain-Q4_K_M.gguf', size: 4_000_000_000 }] }],
      ]))

      const results = await searchHuggingFaceModels({ backend: 'ollama', query: 'plain', appleSilicon: true })

      expect(results.some((r) => r.format === 'mlx')).toBe(false)
      expect(results.some((r) => r.repository === mlxRepo)).toBe(false)
    })

    it('does not surface MLX on a non-Apple host even for LM Studio', async () => {
      const mlxRepo = 'mlx-community/Hidden-On-Intel-4bit'
      fetch.mockImplementation(urlRouter([
        ['filter=mlx', [mlxListing(mlxRepo, ['model.safetensors'])]],
        ['filter=gguf', []],
      ]))

      const results = await searchHuggingFaceModels({ backend: 'lmstudio', query: 'hidden', appleSilicon: false })

      expect(results.some((r) => r.repository === mlxRepo)).toBe(false)
    })

    it('parses a bf16 repo-name quant and marks an installed MLX repo', async () => {
      const repo = 'mlx-community/Qwythos-9B-MLX-bf16'
      fetch.mockImplementation(urlRouter([
        ['filter=mlx', [mlxListing(repo, ['model.safetensors'])]],
        ['filter=gguf', []],
        [(u) => u.includes('blobs=true'), mlxBlobs(repo, { 'model.safetensors': 18_000_000_000 })],
      ]))

      // The route appends LM Studio's reported quantization, so an installed MLX
      // model arrives as `<repo>@<quant>` — the bare-repo MLX target must still
      // match it (repo-level fallback when the target carries no quant).
      const results = await searchHuggingFaceModels({
        backend: 'lmstudio', query: 'qwythos', systemMemoryBytes: 128 * 1024 ** 3, appleSilicon: true, installedIds: [`${repo}@bf16`]
      })
      const mlx = results.find((r) => r.repository === repo)

      expect(mlx.quant).toBe('bf16')
      expect(mlx.installed).toBe(true)
      expect(mlx.variants[0].installed).toBe(true)
    })

    it('queries MLX with MLX-specific terms (not the gguf browse phrase) on a default browse', async () => {
      fetch.mockImplementation(urlRouter([
        ['filter=mlx', []],
        ['filter=gguf', []],
      ]))

      await searchHuggingFaceModels({ backend: 'lmstudio', category: 'coding', appleSilicon: true }) // no query

      const mlxCall = fetch.mock.calls.find(([u]) => String(u).includes('filter=mlx'))
      expect(mlxCall).toBeTruthy()
      // The category browse phrase ('coder gguf') must be rewritten for MLX, or
      // `filter=mlx&search=…gguf` filters every MLX-only repo out of the browse.
      expect(String(mlxCall[0])).not.toMatch(/search=[^&]*gguf/)
      expect(String(mlxCall[0])).toMatch(/search=[^&]*mlx/)
    })

    it('still returns GGUF results when the optional MLX query fails', async () => {
      const ggufRepo = 'org/Survivor-GGUF'
      fetch.mockImplementation(async (url) => {
        const u = String(url)
        if (u.includes('filter=mlx')) throw new Error('mlx query boom')
        if (u.includes('filter=gguf')) return response([{ modelId: ggufRepo, downloads: 10, tags: ['gguf'], siblings: [{ rfilename: 'S-Q4_K_M.gguf', size: 4_000_000_000 }] }])
        if (u.includes('blobs=true')) return response({ id: ggufRepo, siblings: [{ rfilename: 'S-Q4_K_M.gguf', size: 4_000_000_000 }] })
        return response([])
      })

      const results = await searchHuggingFaceModels({ backend: 'lmstudio', query: 's', appleSilicon: true })

      expect(results.some((r) => r.repository === ggufRepo)).toBe(true)
    })
  })

  describe('curated catalog quant enrichment', () => {
    const blobs = (id, sized) => response({ id, siblings: Object.entries(sized).map(([rfilename, size]) => ({ rfilename, size })) })

    it('adds the RAM-aware variant picker to an LM Studio curated (HF-repo) entry', async () => {
      const repo = 'lmstudio-community/Curated-Llama-GGUF'
      fetch.mockResolvedValueOnce(blobs(repo, {
        'Curated-Llama-Q4_K_M.gguf': 4_000_000_000,
        'Curated-Llama-Q8_0.gguf': 8_000_000_000,
      }))

      const catalog = [{ id: repo, key: 'curated-llama', name: 'Curated Llama', category: 'chat', size: '2.0 GB' }]
      await enrichCatalogWithVariants(catalog, { backend: 'lmstudio', systemMemoryBytes: 128 * 1024 ** 3, installedIds: [] })

      expect(catalog[0].format).toBe('gguf')
      expect(catalog[0].variants.map((v) => v.installId)).toEqual([`${repo}@Q8_0`, `${repo}@Q4_K_M`])
      // The curated id stays STABLE (playground matches installed models on it) —
      // the RAM-aware default is conveyed via the recommended variant instead.
      expect(catalog[0].id).toBe(repo)
      // 128 GB → highest-fidelity that fits becomes the recommended default.
      expect(catalog[0].variants.find((v) => v.recommended).installId).toBe(`${repo}@Q8_0`)
      expect(catalog[0].sizeBytes).toBe(8_000_000_000)
    })

    it('enriches an Ollama hf.co curated id and keeps the hf.co install ids', async () => {
      const repo = 'unsloth/Curated-Devstral-GGUF'
      fetch.mockResolvedValueOnce(blobs(repo, {
        'Devstral-UD-Q4_K_XL.gguf': 14_000_000_000,
        'Devstral-Q8_0.gguf': 24_000_000_000,
      }))

      const catalog = [{ id: `hf.co/${repo}:UD-Q4_K_XL`, key: 'devstral', name: 'Devstral', category: 'coding', size: '14 GB' }]
      await enrichCatalogWithVariants(catalog, { backend: 'ollama', systemMemoryBytes: 128 * 1024 ** 3, installedIds: [] })

      expect(catalog[0].variants.map((v) => v.installId)).toEqual([`hf.co/${repo}:Q8_0`, `hf.co/${repo}:UD-Q4_K_XL`])
      // Stable curated id; recommended variant carries the RAM-aware install id.
      expect(catalog[0].id).toBe(`hf.co/${repo}:UD-Q4_K_XL`)
      expect(catalog[0].variants.find((v) => v.recommended).installId).toBe(`hf.co/${repo}:Q8_0`)
    })

    it('falls back to the QUANT_PRIORITY quant (not HF file order) and keeps the curated size when HF omits sizes', async () => {
      const repo = 'lmstudio-community/NoSize-Curated-GGUF'
      // BF16 listed first; with no sizes the size-desc sort is stable (file order),
      // so the fallback must NOT just take variants[0] or a small box defaults to BF16.
      fetch.mockResolvedValueOnce(response({ id: repo, siblings: [
        { rfilename: 'M-BF16.gguf' }, { rfilename: 'M-Q4_K_M.gguf' }, { rfilename: 'M-Q8_0.gguf' },
      ] }))
      const catalog = [{ id: repo, key: 'nosize', name: 'NoSize', category: 'chat', size: '2.0 GB' }]
      // 8 GB box: budget pick can't fire (no sizes) — must land on the balanced
      // QUANT_PRIORITY default, not the largest by file order.
      await enrichCatalogWithVariants(catalog, { backend: 'lmstudio', systemMemoryBytes: 8 * 1024 ** 3, installedIds: [] })

      expect(catalog[0].id).toBe(repo) // stable curated id
      expect(catalog[0].variants.find((v) => v.recommended).installId).toBe(`${repo}@Q4_K_M`)
      // The curated size estimate is preserved (not clobbered with a bare quant label).
      expect(catalog[0].size).toBe('2.0 GB')
    })

    // Route the Ollama registry's two endpoints (tags/list + per-tag manifests)
    // to a mock. `tags` is the tag list; `sizes` maps a tag → model-layer bytes.
    const ollamaRegistry = (tags, sizes = {}) => (url) => {
      if (/\/tags\/list$/.test(url)) return Promise.resolve(response({ tags }))
      const m = url.match(/\/manifests\/([^/]+)$/)
      if (m) {
        const tag = decodeURIComponent(m[1])
        const size = sizes[tag]
        return Promise.resolve(response({
          layers: Number.isFinite(size)
            ? [{ mediaType: 'application/vnd.ollama.image.model', size }]
            : []
        }))
      }
      return Promise.resolve(response({}))
    }

    it('adds a RAM-aware quant picker to a bare Ollama registry name', async () => {
      __resetOllamaRegistryCache()
      fetch.mockImplementation(ollamaRegistry(
        ['latest', '3b', '3b-instruct-q4_K_M', '3b-instruct-q8_0', '3b-instruct-fp16', '1b-instruct-q4_K_M'],
        { '3b-instruct-q4_K_M': 2_000_000_000, '3b-instruct-q8_0': 3_500_000_000, '3b-instruct-fp16': 6_500_000_000 }
      ))
      const catalog = [{ id: 'pickerllama', key: 'pickerllama', name: 'Picker Llama 3B', category: 'chat', params: '3B', size: '2.0 GB' }]
      await enrichCatalogWithVariants(catalog, { backend: 'ollama', systemMemoryBytes: 128 * 1024 ** 3, installedIds: [] })

      expect(catalog[0].format).toBe('gguf')
      // Only the 3B (target-size) quant-tagged builds become variants — the 1B
      // build is a different size and the bare `3b`/`latest` carry no quant.
      expect(catalog[0].variants.map((v) => v.installId)).toEqual([
        'pickerllama:3b-instruct-fp16', 'pickerllama:3b-instruct-q8_0', 'pickerllama:3b-instruct-q4_K_M'
      ])
      // Stable curated id; the RAM-aware default (128 GB → highest fidelity that fits) is recommended.
      expect(catalog[0].id).toBe('pickerllama')
      expect(catalog[0].variants.find((v) => v.recommended).installId).toBe('pickerllama:3b-instruct-fp16')
      expect(catalog[0].sizeBytes).toBe(6_500_000_000)
    })

    it('honors an explicit size tag and marks the per-quant installed build', async () => {
      __resetOllamaRegistryCache()
      fetch.mockImplementation(ollamaRegistry(
        ['20b', '20b-q4_K_M', '20b-q8_0', '120b-q4_K_M'],
        { '20b-q4_K_M': 12_000_000_000, '20b-q8_0': 22_000_000_000 }
      ))
      const catalog = [{ id: 'gpt-pick:20b', key: 'gpt-pick', name: 'GPT Pick 20B', category: 'reasoning', params: '20B', size: '12 GB' }]
      await enrichCatalogWithVariants(catalog, {
        backend: 'ollama', systemMemoryBytes: 16 * 1024 ** 3, installedIds: ['gpt-pick:20b-q4_K_M']
      })

      // Only the 20B builds (the card's size) — the 120B quant is excluded.
      expect(catalog[0].variants.map((v) => v.installId)).toEqual(['gpt-pick:20b-q8_0', 'gpt-pick:20b-q4_K_M'])
      // 16 GB box: the Q8 (22 GB) is too large, so the Q4 (12 GB) is recommended.
      expect(catalog[0].variants.find((v) => v.recommended).installId).toBe('gpt-pick:20b-q4_K_M')
      expect(catalog[0].variants.find((v) => v.installId === 'gpt-pick:20b-q4_K_M').installed).toBe(true)
      expect(catalog[0].variants.find((v) => v.installId === 'gpt-pick:20b-q8_0').installed).toBe(false)
    })

    it('surfaces the installed default build as a selected variant for a default/:latest bare Ollama install', async () => {
      __resetOllamaRegistryCache()
      fetch.mockImplementation(ollamaRegistry(
        ['3b-instruct-q4_K_M', '3b-instruct-q8_0'],
        { '3b-instruct-q4_K_M': 2_000_000_000, '3b-instruct-q8_0': 3_500_000_000 }
      ))
      // getCatalog flagged this installed (the user pulled `defllama`, stored as :latest).
      // None of the exact `<name>:<tag>` quant variants matches that alias.
      const catalog = [{ id: 'defllama', key: 'defllama', name: 'Def Llama 3B', category: 'chat', params: '3B', size: '2.0 GB', installed: true }]
      await enrichCatalogWithVariants(catalog, {
        backend: 'ollama', systemMemoryBytes: 128 * 1024 ** 3, installedIds: ['defllama:latest']
      })

      // The installed default build is surfaced as its own variant (install id = the
      // curator's id) and selected, so the card reads Installed (LocalLlmTab gates on the
      // chosen variant) instead of offering a duplicate pull.
      expect(catalog[0].installed).toBe(true)
      const defaultVariant = catalog[0].variants.find((v) => v.installId === 'defllama')
      expect(defaultVariant).toMatchObject({ installed: true, recommended: true })
      // The discovered quant variants keep their true (not-installed) per-tag state.
      expect(catalog[0].variants.filter((v) => v.installId !== 'defllama').every((v) => v.installed === false)).toBe(true)
      expect(catalog[0].variants.filter((v) => v.recommended).length).toBe(1)
    })

    it('does NOT add a default variant when a specific quant tag is already installed', async () => {
      __resetOllamaRegistryCache()
      fetch.mockImplementation(ollamaRegistry(
        ['3b-instruct-q4_K_M', '3b-instruct-q8_0'],
        { '3b-instruct-q4_K_M': 2_000_000_000, '3b-instruct-q8_0': 3_500_000_000 }
      ))
      // The user has the exact q8 build — the per-quant flag already shows Installed,
      // so no synthesized default build is needed.
      const catalog = [{ id: 'qllama', key: 'qllama', name: 'Q Llama 3B', category: 'chat', params: '3B', size: '2.0 GB', installed: true }]
      await enrichCatalogWithVariants(catalog, {
        backend: 'ollama', systemMemoryBytes: 128 * 1024 ** 3, installedIds: ['qllama:3b-instruct-q8_0']
      })

      expect(catalog[0].variants.some((v) => v.installId === 'qllama')).toBe(false)
      expect(catalog[0].variants.find((v) => v.installId === 'qllama:3b-instruct-q8_0').installed).toBe(true)
    })

    it('leaves a bare Ollama name untouched when the model is not on the registry', async () => {
      __resetOllamaRegistryCache()
      // tags/list 404s (unknown model) → no tags → no variants.
      fetch.mockResolvedValue(response({}, false))
      const catalog = [{ id: 'nonexistent-model', key: 'nope', name: 'Nope', category: 'chat', params: '3B', size: '2.0 GB' }]
      await enrichCatalogWithVariants(catalog, { backend: 'ollama', systemMemoryBytes: 128 * 1024 ** 3, installedIds: [] })

      expect(catalog[0].variants).toBeUndefined()
      expect(catalog[0].id).toBe('nonexistent-model')
      expect(catalog[0].size).toBe('2.0 GB')
    })

    it('degrades gracefully (keeps the curated entry) when the HF probe fails', async () => {
      const repo = 'lmstudio-community/Unreachable-GGUF'
      fetch.mockRejectedValue(new Error('network down'))
      const catalog = [{ id: repo, key: 'unreachable', name: 'Unreachable', category: 'chat', size: '2.0 GB' }]
      await enrichCatalogWithVariants(catalog, { backend: 'lmstudio', systemMemoryBytes: 128 * 1024 ** 3 })

      expect(catalog[0].variants).toBeUndefined()
      expect(catalog[0].id).toBe(repo)
      expect(catalog[0].size).toBe('2.0 GB')
    })

    it('returns within the timeout budget when HF is slow instead of blocking the catalog', async () => {
      const repo = 'lmstudio-community/Slow-GGUF'
      // Resolves long after the budget; unref'd so the pending timer can't hang the run.
      fetch.mockImplementation(() => new Promise((resolve) => {
        const t = setTimeout(() => resolve(response({ id: repo, siblings: [{ rfilename: 'Slow-Q4_K_M.gguf', size: 4_000_000_000 }] })), 5000)
        t.unref?.()
      }))
      const catalog = [{ id: repo, key: 'slow', name: 'Slow', category: 'chat', size: '2.0 GB' }]

      const started = Date.now()
      await enrichCatalogWithVariants(catalog, { backend: 'lmstudio', systemMemoryBytes: 128 * 1024 ** 3, timeoutMs: 50 })

      expect(Date.now() - started).toBeLessThan(2000)
      expect(catalog[0].variants).toBeUndefined()
    })
  })

  describe('audio installed registry', () => {
    it('marks an audio model installed when it is in the shared registry', async () => {
      fetch.mockResolvedValue(response([
        {
          modelId: 'facebook/musicgen-small',
          downloads: 100,
          tags: ['text-to-audio'],
          pipeline_tag: 'text-to-audio',
          siblings: [{ rfilename: 'model.safetensors', size: 2_000_000_000 }]
        }
      ]))

      const results = await searchHuggingFaceModels({
        backend: 'ollama',
        query: 'musicgen-small',
        category: 'audio',
        installedAudioRepos: ['facebook/musicgen-small']
      })
      const small = results.find((r) => r.repository === 'facebook/musicgen-small')
      expect(small.installed).toBe(true)
    })
  })
})
