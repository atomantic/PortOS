import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the settings store before importing the SUT — the resolver reads
// `settings.codeReview` synchronously on every call and we want test-local
// control of that value without touching disk.
const mockedSettings = { current: {} }
vi.mock('./settings.js', () => ({
  getSettings: () => Promise.resolve(mockedSettings.current),
  // Stub the EventEmitter shape the module subscribes to for cache
  // invalidation — only `.on()` is hit at import time; the SUT never emits.
  settingsEvents: { on: () => {}, emit: () => {} },
}))
// Same one-liner stub for the two backend managers — `getCodeReviewDefaults`
// + `pickCodeReviewDefaults` don't touch them, only `runLocalCodeReview`
// does, and those tests stub `global.fetch` directly.
vi.mock('./lmStudioManager.js', () => ({ getBaseUrl: () => 'http://localhost:1234' }))
vi.mock('./ollamaManager.js', () => ({ getBaseUrl: () => 'http://localhost:11434' }))
// Reviewer-CLI-installed probe: stub the shared execFile-based helper so the
// test controls per-binary results without touching the real PATH.
const commandExistsMock = { impl: async () => true }
vi.mock('../lib/commandExists.js', () => ({ commandExists: (...args) => commandExistsMock.impl(...args) }))

import { mockJsonResponse, mockTextResponse } from '../lib/testHelper.js'
import {
  isLocalLlmReviewer,
  pickCodeReviewDefaults,
  getCodeReviewDefaults,
  resolveReviewLoopOptions,
  runLocalCodeReview,
  getReviewerCliInstalled,
  __resetCodeReviewDefaultsCache,
  __resetReviewerCliInstalledCache,
} from './codeReview.js'
import { MODEL_SELECTABLE_REVIEWERS, EFFORT_SELECTABLE_REVIEWERS } from '../lib/cosValidation.js'

// Minimal stand-ins for the deps resolveReviewLoopOptions is handed by its
// callers (agentCliSpawning / agentCompletionCleanup) — kept trivial so the
// test exercises the resolver's own model-map assembly, not validation.js.
const testDeps = {
  normalize: (meta, fallback) => (Array.isArray(meta?.reviewers) && meta.reviewers.length ? meta.reviewers : (fallback || ['copilot'])),
  isTruthyMeta: (v) => v === true,
}

describe('codeReview helpers', () => {
  afterEach(() => {
    mockedSettings.current = {}
    __resetCodeReviewDefaultsCache()
    __resetReviewerCliInstalledCache()
    commandExistsMock.impl = async () => true
    vi.restoreAllMocks()
  })

  describe('isLocalLlmReviewer', () => {
    it('classifies only lmstudio + ollama as local-LLM reviewers', () => {
      expect(isLocalLlmReviewer('lmstudio')).toBe(true)
      expect(isLocalLlmReviewer('ollama')).toBe(true)
      expect(isLocalLlmReviewer('copilot')).toBe(false)
      expect(isLocalLlmReviewer('codex')).toBe(false)
      expect(isLocalLlmReviewer('')).toBe(false)
      expect(isLocalLlmReviewer(undefined)).toBe(false)
    })
  })

  describe('pickCodeReviewDefaults', () => {
    // Every effort-capable reviewer reports `null` when nothing is configured.
    // Derived from the roster for the same reason NO_MODELS below is: the keys
    // `pickCodeReviewDefaults` emits come from that roster too, so a hand-listed
    // copy would need editing in lockstep with every future addition (`cursor`
    // joined when its ladder landed) and says nothing extra when it is.
    const NO_EFFORTS = Object.fromEntries(EFFORT_SELECTABLE_REVIEWERS.map((r) => [`${r}Effort`, null]))
    // Same for every model-selectable reviewer — `antigravity` joined the roster
    // when agy's `--model` became pinnable (#3728), `grok` when `grok --model`
    // did (#3729). Derived from the roster, because `pickCodeReviewDefaults`
    // derives its keys the same way: a hand-listed copy would have to be edited
    // in lockstep with every future addition and says nothing extra when it is.
    const NO_MODELS = Object.fromEntries(MODEL_SELECTABLE_REVIEWERS.map((r) => [`${r}Model`, null]))
    it('returns the hardcoded fallback when settings has no codeReview slice', () => {
      expect(pickCodeReviewDefaults(null)).toEqual({
        reviewers: ['copilot'],
        usernames: [],
        optionalReviewers: [],
        reviewerMaxRounds: {},
        stopMode: 'all',
        reviewerApplies: false,
        ...NO_MODELS,
        ...NO_EFFORTS,
      })
      expect(pickCodeReviewDefaults({})).toEqual({
        reviewers: ['copilot'],
        usernames: [],
        optionalReviewers: [],
        reviewerMaxRounds: {},
        stopMode: 'all',
        reviewerApplies: false,
        ...NO_MODELS,
        ...NO_EFFORTS,
      })
    })

    it('strips unknown reviewer enum values from a hand-edited settings.json', () => {
      const out = pickCodeReviewDefaults({
        codeReview: { reviewers: ['antigravity', 'bogus', 'lmstudio', 'antigravity'] },
      })
      expect(out.reviewers).toEqual(['antigravity', 'lmstudio'])
    })

    it('maps legacy gemini defaults to antigravity', () => {
      const out = pickCodeReviewDefaults({
        codeReview: { reviewers: ['gemini', 'lmstudio'] },
      })
      expect(out.reviewers).toEqual(['antigravity', 'lmstudio'])
    })

    it('coerces invalid stop-mode + reviewerApplies + model strings', () => {
      const out = pickCodeReviewDefaults({
        codeReview: {
          reviewers: ['copilot'],
          stopMode: 'nope',
          reviewerApplies: 'truthy-string',
          lmstudioModel: '',
          ollamaModel: 42,
          codexModel: '',
          claudeModel: '',
        },
      })
      expect(out.stopMode).toBe('all')
      expect(out.reviewerApplies).toBe(false)
      expect(out.lmstudioModel).toBeNull()
      expect(out.ollamaModel).toBeNull()
      expect(out.codexModel).toBeNull()
      expect(out.claudeModel).toBeNull()
    })

    it('passes through a valid full payload', () => {
      const out = pickCodeReviewDefaults({
        codeReview: {
          reviewers: ['codex', 'lmstudio'],
          optionalReviewers: ['lmstudio', 'bogus'],
          reviewerMaxRounds: { lmstudio: 1, codex: 0, bogus: 2, ollama: -1 },
          stopMode: 'on-clean',
          reviewerApplies: true,
          lmstudioModel: 'qwen2.5-coder:7b',
          ollamaModel: 'codellama',
          codexModel: 'gpt-5.6-sol',
          claudeModel: 'qwen2.5:7b',
          antigravityModel: 'gemini-3.6-flash',
          grokModel: 'grok-code-fast-1',
        },
      })
      expect(out).toEqual({
        reviewers: ['codex', 'lmstudio'],
        usernames: [],
        // 'bogus' is dropped (not a known reviewer); 'lmstudio' survives.
        optionalReviewers: ['lmstudio'],
        // 'bogus' (unknown token) and ollama's negative cap are dropped; an
        // explicit 0 survives as "loop until clean".
        reviewerMaxRounds: { lmstudio: 1, codex: 0 },
        stopMode: 'on-clean',
        reviewerApplies: true,
        lmstudioModel: 'qwen2.5-coder:7b',
        ollamaModel: 'codellama',
        codexModel: 'gpt-5.6-sol',
        claudeModel: 'qwen2.5:7b',
        antigravityModel: 'gemini-3.6-flash',
        grokModel: 'grok-code-fast-1',
        cursorModel: null,
        ...NO_EFFORTS,
      })
    })

    it('normalizes arbitrary reviewer usernames (strips @, dedupes, drops unsafe)', () => {
      const out = pickCodeReviewDefaults({
        codeReview: {
          usernames: ['@CodeReviewbot', 'codereviewbot', 'bad token!', 'my-org/reviewers'],
        },
      })
      expect(out.usernames).toEqual(['CodeReviewbot', 'my-org/reviewers'])
    })

    it('defaults usernames to an empty array when absent', () => {
      expect(pickCodeReviewDefaults({ codeReview: { reviewers: ['copilot'] } }).usernames).toEqual([])
    })
  })

  describe('getCodeReviewDefaults', () => {
    it('reads from the settings store and runs the same pick logic', async () => {
      mockedSettings.current = {
        codeReview: { reviewers: ['ollama'], ollamaModel: 'codellama' },
      }
      const out = await getCodeReviewDefaults()
      expect(out.reviewers).toEqual(['ollama'])
      expect(out.ollamaModel).toBe('codellama')
      expect(out.stopMode).toBe('all')
    })
  })

  describe('getReviewerCliInstalled', () => {
    it('probes only CLI reviewers, resolving each through reviewerCliBinary', async () => {
      const probed = []
      commandExistsMock.impl = async (binary) => { probed.push(binary); return binary !== 'agy' }
      const out = await getReviewerCliInstalled()
      expect(out).toEqual({ claude: true, antigravity: false, codex: true, grok: true, cursor: true })
      expect(probed.sort()).toEqual(['agy', 'claude', 'codex', 'cursor-agent', 'grok'])
    })

    it('caches the result within the TTL — a second call does not re-probe', async () => {
      let calls = 0
      commandExistsMock.impl = async () => { calls += 1; return true }
      await getReviewerCliInstalled()
      await getReviewerCliInstalled()
      expect(calls).toBe(5) // one probe per CLI reviewer, only on the first call
    })

    it('probes with the longer 15s timeout these heavier agentic CLIs need', async () => {
      const seenOpts = []
      commandExistsMock.impl = async (_binary, _args, opts) => { seenOpts.push(opts); return true }
      await getReviewerCliInstalled()
      expect(seenOpts).toEqual(seenOpts.map(() => ({ timeoutMs: 15_000 })))
    })
  })

  describe('resolveReviewLoopOptions', () => {
    it('assembles a reviewer-keyed model map from the per-CLI-reviewer scalars', async () => {
      mockedSettings.current = {
        codeReview: {
          reviewers: ['codex', 'claude'],
          codexModel: 'gpt-5.6-sol',
          claudeModel: 'qwen2.5:7b',
        },
      }
      const out = await resolveReviewLoopOptions({}, testDeps)
      expect(out.reviewerModels).toEqual({ codex: 'gpt-5.6-sol', claude: 'qwen2.5:7b' })
      // The codex-scalar option is gone — callers thread the map now.
      expect(out.codexModel).toBeUndefined()
    })

    it('omits reviewers with no configured model (absent = CLI default)', async () => {
      mockedSettings.current = { codeReview: { reviewers: ['codex', 'claude'], codexModel: 'gpt-5.6-sol' } }
      const out = await resolveReviewLoopOptions({}, testDeps)
      expect(out.reviewerModels).toEqual({ codex: 'gpt-5.6-sol' })
    })

    it('returns an empty map when no reviewer has a configured model', async () => {
      mockedSettings.current = { codeReview: { reviewers: ['copilot', 'codex'] } }
      const out = await resolveReviewLoopOptions({}, testDeps)
      expect(out.reviewerModels).toEqual({})
    })

    it('carries a local-LLM model pin too, so a per-task one can reach the endpoint (#3133)', async () => {
      mockedSettings.current = { codeReview: { reviewers: ['copilot', 'ollama'], ollamaModel: 'codellama' } }
      const out = await resolveReviewLoopOptions({}, testDeps)
      // /api/code-review/local's own default reads the GLOBAL settings scalar and
      // can't see a task-level pin, so the pin has to travel in this map instead
      // of being dropped as a CLI-only concern.
      expect(out.reviewerModels).toEqual({ ollama: 'codellama' })
    })

    it('lets a task-level model map (including an explicitly empty one) override the defaults', async () => {
      mockedSettings.current = { codeReview: { reviewers: ['codex'], codexModel: 'gpt-5.6-sol' } }
      const pinned = await resolveReviewLoopOptions({ reviewerModels: { codex: 'gpt-tier-b' } }, testDeps)
      expect(pinned.reviewerModels).toEqual({ codex: 'gpt-tier-b' })
      // An explicit `{}` is a real "use each reviewer's own default for this task"
      // choice, not an absent field — it must not fall back to the scalars.
      const cleared = await resolveReviewLoopOptions({ reviewerModels: {} }, testDeps)
      expect(cleared.reviewerModels).toEqual({})
    })

    it('carries an antigravity model pin and splits a suffixed id into model + effort', async () => {
      mockedSettings.current = { codeReview: { reviewers: ['antigravity'], antigravityModel: 'gemini-3.6-flash' } }
      expect((await resolveReviewLoopOptions({}, testDeps)).reviewerModels)
        .toEqual({ antigravity: 'gemini-3.6-flash' })
      // `agy models` lists each tier as its own id; agy validates the model/effort
      // PAIR, so a typed suffixed pin has to reach the invocation already split.
      mockedSettings.current = { codeReview: { reviewers: ['antigravity'], antigravityModel: 'gemini-3.6-flash-high' } }
      __resetCodeReviewDefaultsCache()
      const split = await resolveReviewLoopOptions({}, testDeps)
      expect(split.reviewerModels).toEqual({ antigravity: 'gemini-3.6-flash' })
      expect(split.reviewerEfforts).toEqual({ antigravity: 'high' })
    })

    it('drops a pin on a reviewer that takes no model', async () => {
      mockedSettings.current = { codeReview: { reviewers: ['copilot'] } }
      const out = await resolveReviewLoopOptions({ reviewerModels: { copilot: 'nope', '@bot': 'nope' } }, testDeps)
      expect(out.reviewerModels).toEqual({})
    })

    it('inherits the defaults\' ~max round caps when the task pinned none', async () => {
      mockedSettings.current = { codeReview: { reviewers: ['ollama'], reviewerMaxRounds: { ollama: 1 } } }
      const out = await resolveReviewLoopOptions({}, testDeps)
      expect(out.reviewerMaxRounds).toEqual({ ollama: 1 })
    })

    it('lets a task-level cap map (including an explicitly empty one) override the defaults', async () => {
      mockedSettings.current = { codeReview: { reviewers: ['ollama'], reviewerMaxRounds: { ollama: 1 } } }
      const pinned = await resolveReviewLoopOptions({ reviewerMaxRounds: { ollama: 3 } }, testDeps)
      expect(pinned.reviewerMaxRounds).toEqual({ ollama: 3 })
      // An explicitly empty map is a real "no caps for this task" choice.
      const cleared = await resolveReviewLoopOptions({ reviewerMaxRounds: {} }, testDeps)
      expect(cleared.reviewerMaxRounds).toEqual({})
    })

    // The effort map is the twin of the model map above and rides the same
    // returned bundle. Dropping the `reviewerEfforts` key here silently disables
    // every per-reviewer effort pin across the review loop, so these pin the key
    // itself as much as the precedence.
    it('assembles a reviewer-keyed effort map from the per-reviewer scalars', async () => {
      mockedSettings.current = {
        codeReview: {
          reviewers: ['codex', 'claude'],
          codexEffort: 'xhigh',
          claudeEffort: 'high',
        },
      }
      const out = await resolveReviewLoopOptions({}, testDeps)
      expect(out.reviewerEfforts).toEqual({ codex: 'xhigh', claude: 'high' })
    })

    it('omits reviewers with no configured effort (absent = the reviewer\'s own default)', async () => {
      mockedSettings.current = { codeReview: { reviewers: ['codex', 'claude'], codexEffort: 'high' } }
      const out = await resolveReviewLoopOptions({}, testDeps)
      expect(out.reviewerEfforts).toEqual({ codex: 'high' })
    })

    it('returns an empty effort map when no reviewer has one configured', async () => {
      mockedSettings.current = { codeReview: { reviewers: ['copilot', 'codex'] } }
      const out = await resolveReviewLoopOptions({}, testDeps)
      expect(out.reviewerEfforts).toEqual({})
    })

    it('carries a local-LLM effort pin too, so a per-task one can reach the endpoint', async () => {
      // `/api/code-review/local`'s own default reads the GLOBAL settings scalar
      // and can't see a task-level pin, so the pin travels in this map instead.
      mockedSettings.current = { codeReview: { reviewers: ['copilot', 'ollama'], ollamaEffort: 'low' } }
      const out = await resolveReviewLoopOptions({}, testDeps)
      expect(out.reviewerEfforts).toEqual({ ollama: 'low' })
    })

    it('lets a task-level effort map (including an explicitly empty one) override the defaults', async () => {
      mockedSettings.current = { codeReview: { reviewers: ['codex'], codexEffort: 'high' } }
      const pinned = await resolveReviewLoopOptions({ reviewerEfforts: { codex: 'minimal' } }, testDeps)
      expect(pinned.reviewerEfforts).toEqual({ codex: 'minimal' })
      // An explicit `{}` is a real "use each reviewer's own default effort for
      // this task" choice, not an absent field.
      const cleared = await resolveReviewLoopOptions({ reviewerEfforts: {} }, testDeps)
      expect(cleared.reviewerEfforts).toEqual({})
    })

    it('drops an effort pin a reviewer\'s own ladder does not accept', async () => {
      mockedSettings.current = { codeReview: { reviewers: ['antigravity', 'copilot'] } }
      // `agy` really does reject `--effort max`, and `copilot` is a GitHub review
      // with no effort control at all — both are dropped, not clamped.
      const out = await resolveReviewLoopOptions(
        { reviewerEfforts: { antigravity: 'max', copilot: 'high', '@bot': 'high' } },
        testDeps,
      )
      expect(out.reviewerEfforts).toEqual({})
    })

    it('strips only the unusable entries from a mixed effort map', async () => {
      mockedSettings.current = { codeReview: { reviewers: ['codex', 'antigravity'] } }
      const out = await resolveReviewLoopOptions(
        { reviewerEfforts: { codex: 'minimal', antigravity: 'max' } },
        testDeps,
      )
      // `minimal` is on codex's ladder and `max` is not on agy's — one bad entry
      // must not take the whole map down with it.
      expect(out.reviewerEfforts).toEqual({ codex: 'minimal' })
    })

    it('drops a stale out-of-ladder scalar from the saved defaults', async () => {
      // settings.json is hand-editable, so the scalars are re-validated rather
      // than trusted — an unusable level must not surface as a pin.
      mockedSettings.current = { codeReview: { reviewers: ['antigravity'], antigravityEffort: 'ultra' } }
      const out = await resolveReviewLoopOptions({}, testDeps)
      expect(out.reviewerEfforts).toEqual({})
    })
  })

  describe('runLocalCodeReview', () => {
    beforeEach(() => {
      // Default fetch mock — chat-completions success with a static body. Each
      // test that wants a different shape replaces this in its own setup.
      global.fetch = vi.fn().mockResolvedValue(mockJsonResponse({ choices: [{ message: { content: 'No findings.' } }] }))
    })

    it('rejects unsupported reviewer backends', async () => {
      const r = await runLocalCodeReview({ backend: 'copilot', model: 'x', diff: 'a' })
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/Unsupported reviewer backend/)
    })

    it('requires a model id', async () => {
      const r = await runLocalCodeReview({ backend: 'lmstudio', model: '', diff: 'a' })
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/No model configured/)
    })

    it('requires a non-empty diff', async () => {
      const r = await runLocalCodeReview({ backend: 'lmstudio', model: 'm', diff: '   ' })
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/Empty diff/)
    })

    it('omits reasoning_effort entirely when no effort is pinned — absent is the only spelling of the model default', async () => {
      await runLocalCodeReview({ backend: 'ollama', model: 'codellama', diff: 'd' })
      const body = JSON.parse(global.fetch.mock.calls[0][1].body)
      expect('reasoning_effort' in body).toBe(false)
    })

    it('sends a pinned effort as the OpenAI-compatible reasoning_effort field', async () => {
      const r = await runLocalCodeReview({ backend: 'lmstudio', model: 'm', diff: 'd', effort: 'high' })
      expect(JSON.parse(global.fetch.mock.calls[0][1].body).reasoning_effort).toBe('high')
      expect(r.effort).toBe('high')
    })

    it('drops an effort outside the local ladder rather than letting the backend 400 on it', async () => {
      // `xhigh`/`ultra` are vendor-CLI tiers; an OpenAI-shaped backend rejects them.
      const r = await runLocalCodeReview({ backend: 'ollama', model: 'm', diff: 'd', effort: 'ultra' })
      const body = JSON.parse(global.fetch.mock.calls[0][1].body)
      expect('reasoning_effort' in body).toBe(false)
      expect(r.effort).toBeNull()
    })
    it('posts to the backend chat-completions endpoint and returns the response content', async () => {
      const r = await runLocalCodeReview({ backend: 'ollama', model: 'codellama', diff: 'diff --git a b' })
      expect(r).toEqual({ ok: true, backend: 'ollama', model: 'codellama', effort: null, findings: 'No findings.' })
      expect(global.fetch).toHaveBeenCalledTimes(1)
      const [url, init] = global.fetch.mock.calls[0]
      expect(url).toMatch(/\/v1\/chat\/completions$/)
      // Default Ollama base url; assert it's hitting the right host so a
      // future rename of the env-var fallback doesn't silently flip backends.
      expect(url).toMatch(/11434/)
      const body = JSON.parse(init.body)
      expect(body.model).toBe('codellama')
      expect(body.stream).toBe(false)
      expect(body.messages[0].role).toBe('system')
      expect(body.messages[0].content).toContain('at most five')
      expect(body.messages[0].content).toContain('concrete wrong outcome')
      expect(body.messages[0].content).toContain('Omit a severity heading')
      expect(body.messages[0].content).not.toContain('## Nits')
      expect(body.messages[1].content).toContain('diff --git a b')
    })

    it('widens the fence so a diff containing ``` cannot close it early', async () => {
      // A diff touching a markdown file can legitimately contain a fenced
      // code block of its own. A hardcoded ``` wrapper would let that content
      // close the outer fence, turning the rest of the diff into free text
      // the model reads as instructions rather than diff content.
      const diff = 'diff --git a/README.md b/README.md\n+```js\n+const x = 1\n+```\n'
      await runLocalCodeReview({ backend: 'ollama', model: 'm', diff })
      const body = JSON.parse(global.fetch.mock.calls[0][1].body)
      const content = body.messages[1].content
      const fenceMatch = content.match(/^Review this PR diff:\n\n(`{3,})diff\n/)
      expect(fenceMatch).not.toBeNull()
      const [, fence] = fenceMatch
      // The chosen fence must be longer than every backtick run in the diff.
      expect(fence.length).toBeGreaterThan(3)
      expect(content).toContain(diff)
      // Only the trailing closing fence line may equal the chosen fence — no
      // line WITHIN the diff itself (its own ``` fences) may match or exceed
      // it, which is what would let the diff's content close the block early.
      const lines = content.split('\n')
      expect(lines.at(-1)).toBe(fence)
      expect(lines.slice(0, -1)).not.toContain(fence)
    })

    it('surfaces a non-2xx HTTP error with the status code', async () => {
      global.fetch = vi.fn().mockResolvedValue(mockTextResponse('boom', { ok: false, status: 500 }))
      const r = await runLocalCodeReview({ backend: 'lmstudio', model: 'm', diff: 'x' })
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/lmstudio API error 500: boom/)
    })

    it('surfaces a fetch-level failure', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
      const r = await runLocalCodeReview({ backend: 'lmstudio', model: 'm', diff: 'x' })
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/lmstudio request failed: ECONNREFUSED/)
    })

    it('flags an empty model response so the agent never silently records "no findings"', async () => {
      global.fetch = vi.fn().mockResolvedValue(mockJsonResponse({ choices: [{ message: { content: '' } }] }))
      const r = await runLocalCodeReview({ backend: 'ollama', model: 'm', diff: 'x' })
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/no content/)
    })

    it('surfaces a 200-with-non-JSON body instead of masking it as "no content"', async () => {
      global.fetch = vi.fn().mockResolvedValue(mockTextResponse('<html><body>502 Bad Gateway</body></html>'))
      const r = await runLocalCodeReview({ backend: 'lmstudio', model: 'm', diff: 'x' })
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/non-JSON response/)
      expect(r.error).toMatch(/502 Bad Gateway/)
    })
  })
})
