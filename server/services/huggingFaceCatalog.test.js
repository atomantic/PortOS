import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { searchHuggingFaceModels } from './huggingFaceCatalog.js'

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
