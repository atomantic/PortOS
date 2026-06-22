import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  parseOllamaRegistryId,
  quantFromOllamaTag,
  sizeTokenOf,
  sumModelLayerBytes,
  fetchOllamaRegistryVariants,
  __resetOllamaRegistryCache
} from './ollamaRegistryCatalog.js'

const response = (body, ok = true) => ({
  ok,
  status: ok ? 200 : 404,
  json: vi.fn(async () => body),
  text: vi.fn(async () => JSON.stringify(body))
})

// Route the registry's two endpoints to a mock: tags/list → `tags`, per-tag
// manifests → model-layer bytes from `sizes` (omit a tag for an unsized build).
const registry = (tags, sizes = {}) => (url) => {
  if (/\/tags\/list$/.test(url)) return Promise.resolve(response({ tags }))
  const m = url.match(/\/manifests\/([^/]+)$/)
  if (m) {
    const size = sizes[decodeURIComponent(m[1])]
    return Promise.resolve(response({
      layers: Number.isFinite(size)
        ? [
            { mediaType: 'application/vnd.ollama.image.model', size },
            { mediaType: 'application/vnd.ollama.image.template', size: 1234 }
          ]
        : [{ mediaType: 'application/vnd.ollama.image.template', size: 1234 }]
    }))
  }
  return Promise.resolve(response({}))
}

describe('ollamaRegistryCatalog pure helpers', () => {
  it('parseOllamaRegistryId splits name/tag and defaults to the library namespace', () => {
    expect(parseOllamaRegistryId('llama3.2')).toEqual({ name: 'llama3.2', repoPath: 'library/llama3.2', tag: null })
    expect(parseOllamaRegistryId('gpt-oss:20b')).toEqual({ name: 'gpt-oss', repoPath: 'library/gpt-oss', tag: '20b' })
    expect(parseOllamaRegistryId('acme/model:q4_K_M')).toEqual({ name: 'acme/model', repoPath: 'acme/model', tag: 'q4_K_M' })
    expect(parseOllamaRegistryId('acme/model')).toEqual({ name: 'acme/model', repoPath: 'acme/model', tag: null })
  })

  it('parseOllamaRegistryId rejects hf.co repos and empty ids', () => {
    expect(parseOllamaRegistryId('hf.co/unsloth/Foo-GGUF:Q4_K_M')).toBeNull()
    expect(parseOllamaRegistryId('')).toBeNull()
    expect(parseOllamaRegistryId(null)).toBeNull()
  })

  it('quantFromOllamaTag parses the trailing quant component, canonicalized uppercase', () => {
    expect(quantFromOllamaTag('3b-instruct-q4_K_M')).toBe('Q4_K_M')
    expect(quantFromOllamaTag('q8_0')).toBe('Q8_0')
    expect(quantFromOllamaTag('8b-instruct-fp16')).toBe('FP16')
    expect(quantFromOllamaTag('70b-instruct-bf16')).toBe('BF16')
    expect(quantFromOllamaTag('iq2_xxs')).toBe('IQ2_XXS')
    // Size-only and alias tags carry no quant.
    expect(quantFromOllamaTag('3b')).toBeNull()
    expect(quantFromOllamaTag('latest')).toBeNull()
  })

  it('sizeTokenOf extracts the leading parameter size, or null', () => {
    expect(sizeTokenOf('3b-instruct-q4_K_M')).toBe('3b')
    expect(sizeTokenOf('70b')).toBe('70b')
    expect(sizeTokenOf('1.5b')).toBe('1.5b')
    expect(sizeTokenOf('35b-a3b-q4_K_M')).toBe('35b')
    expect(sizeTokenOf('35B / 3B active')).toBe('35b')
    expect(sizeTokenOf('q4_K_M')).toBeNull()
    expect(sizeTokenOf('137m')).toBeNull()
  })

  it('sumModelLayerBytes sums only the model-weight layers', () => {
    expect(sumModelLayerBytes({
      layers: [
        { mediaType: 'application/vnd.ollama.image.model', size: 2_000_000_000 },
        { mediaType: 'application/vnd.ollama.image.template', size: 999 }
      ]
    })).toBe(2_000_000_000)
    expect(sumModelLayerBytes({ layers: [{ mediaType: 'application/vnd.ollama.image.template', size: 999 }] })).toBeNull()
    expect(sumModelLayerBytes(null)).toBeNull()
  })
})

describe('fetchOllamaRegistryVariants', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
    __resetOllamaRegistryCache()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns one variant per quant at the target size, with manifest sizes', async () => {
    fetch.mockImplementation(registry(
      ['latest', '3b', '3b-instruct-q4_K_M', '3b-instruct-q8_0', '1b-instruct-q4_K_M'],
      { '3b-instruct-q4_K_M': 2_000_000_000, '3b-instruct-q8_0': 3_500_000_000 }
    ))

    const variants = await fetchOllamaRegistryVariants('llama3.2', { paramsHint: '3B' })

    expect(variants).toEqual(expect.arrayContaining([
      { tag: '3b-instruct-q4_K_M', installId: 'llama3.2:3b-instruct-q4_K_M', quant: 'Q4_K_M', sizeBytes: 2_000_000_000 },
      { tag: '3b-instruct-q8_0', installId: 'llama3.2:3b-instruct-q8_0', quant: 'Q8_0', sizeBytes: 3_500_000_000 }
    ]))
    // The 1B build is a different size and must be excluded.
    expect(variants.some((v) => v.tag.startsWith('1b'))).toBe(false)
    // Bare `3b` / `latest` carry no quant → not variants.
    expect(variants).toHaveLength(2)
  })

  it('derives the target size from an explicit tag over the params hint', async () => {
    fetch.mockImplementation(registry(
      ['20b-q4_K_M', '120b-q4_K_M'],
      { '20b-q4_K_M': 12_000_000_000, '120b-q4_K_M': 65_000_000_000 }
    ))

    const variants = await fetchOllamaRegistryVariants('gpt-oss:20b', { paramsHint: '20B' })
    expect(variants.map((v) => v.installId)).toEqual(['gpt-oss:20b-q4_K_M'])
  })

  it('prefers an instruct tag over a base/text tag for the same quant', async () => {
    fetch.mockImplementation(registry(
      ['7b-text-q4_K_M', '7b-instruct-q4_K_M'],
      { '7b-text-q4_K_M': 4_000_000_000, '7b-instruct-q4_K_M': 4_000_000_000 }
    ))

    const variants = await fetchOllamaRegistryVariants('mistral', { paramsHint: '7B' })
    expect(variants.map((v) => v.installId)).toEqual(['mistral:7b-instruct-q4_K_M'])
  })

  it('returns [] for an hf.co id (owned by the HF path)', async () => {
    const variants = await fetchOllamaRegistryVariants('hf.co/unsloth/Foo-GGUF:Q4_K_M', { paramsHint: '7B' })
    expect(variants).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns [] when the model is absent from the registry (tags 404)', async () => {
    fetch.mockResolvedValue(response({}, false)) // status 404 → permanent
    expect(await fetchOllamaRegistryVariants('ghost-model', { paramsHint: '3B' })).toEqual([])
  })

  it('does not cache a transient non-OK status (503/429) — only permanent 404/410/403', async () => {
    // 503 Service Unavailable on tags/list — transient, must NOT be cached.
    const unavailable = { ok: false, status: 503, json: vi.fn(async () => ({})), text: vi.fn(async () => '') }
    fetch.mockResolvedValueOnce(unavailable)
    expect(await fetchOllamaRegistryVariants('rate-limited', { paramsHint: '3B' })).toEqual([])
    // The recovered registry re-enriches (the 503 wasn't cached as "no such model").
    fetch.mockImplementation(registry(['3b-instruct-q4_K_M'], { '3b-instruct-q4_K_M': 2_000_000_000 }))
    const variants = await fetchOllamaRegistryVariants('rate-limited', { paramsHint: '3B' })
    expect(variants.map((v) => v.installId)).toEqual(['rate-limited:3b-instruct-q4_K_M'])
  })

  it('keeps a null size when the manifest is unavailable', async () => {
    fetch.mockImplementation(registry(['7b-instruct-q4_K_M'], {})) // no size for the tag
    const variants = await fetchOllamaRegistryVariants('mistral', { paramsHint: '7B' })
    expect(variants).toEqual([{ tag: '7b-instruct-q4_K_M', installId: 'mistral:7b-instruct-q4_K_M', quant: 'Q4_K_M', sizeBytes: null }])
  })

  it('caches a 404 tags result but not a transient failure', async () => {
    // First call: transient throw → null, NOT cached.
    fetch.mockRejectedValueOnce(new Error('network down'))
    expect(await fetchOllamaRegistryVariants('flaky', { paramsHint: '3B' })).toEqual([])
    // Recovered registry re-enriches (cache wasn't poisoned by the transient miss).
    fetch.mockImplementation(registry(['3b-instruct-q4_K_M'], { '3b-instruct-q4_K_M': 2_000_000_000 }))
    const variants = await fetchOllamaRegistryVariants('flaky', { paramsHint: '3B' })
    expect(variants.map((v) => v.installId)).toEqual(['flaky:3b-instruct-q4_K_M'])
  })

  it('does not cache an OK-but-unparseable (HTTP 200) tags response', async () => {
    // A proxy/captive-portal error page served as 200: ok=true but body is not JSON.
    // readResponseJson returns its fallback instead of throwing — this must still be
    // treated as transient (not cached) so a recovered registry re-enriches.
    const htmlError = {
      ok: true, status: 200,
      json: vi.fn(async () => { throw new Error('Unexpected token <') }),
      text: vi.fn(async () => '<html>502 Bad Gateway</html>')
    }
    fetch.mockResolvedValueOnce(htmlError)
    expect(await fetchOllamaRegistryVariants('proxied', { paramsHint: '3B' })).toEqual([])
    // Not cached → the recovered registry produces variants on the next call.
    fetch.mockImplementation(registry(['3b-instruct-q4_K_M'], { '3b-instruct-q4_K_M': 2_000_000_000 }))
    const variants = await fetchOllamaRegistryVariants('proxied', { paramsHint: '3B' })
    expect(variants.map((v) => v.installId)).toEqual(['proxied:3b-instruct-q4_K_M'])
  })
})
