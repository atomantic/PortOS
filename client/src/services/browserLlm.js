// Client for Chrome's built-in, on-device LLM ("Gemini Nano") via the Prompt
// API. Feature-detects BOTH the current global `LanguageModel` and the legacy
// `self.ai.languageModel`, normalizes availability into one enum, and exposes a
// small session-cached `promptNano()` with a timeout + bare-call fallback.
//
// This is tier 2 of the voice fast-resolution cascade (see voiceFastPath.js):
// a fast, private responder/router that runs entirely in the browser, so it
// never touches a provider the user hasn't triggered. There is deliberately no
// cloud fallback here — when Nano is unavailable the cascade falls through to
// the server LLM. Callers decide the fallback; this module only speaks to the
// on-device model.

// Availability states, normalized across both API generations. Only AVAILABLE
// means "usable right now" — DOWNLOADABLE/DOWNLOADING mean the model isn't on
// disk yet, and we never trigger the download implicitly (the user opts into
// the fast path in Settings, and Chrome downloads on first real create()).
export const NANO_AVAILABILITY = Object.freeze({
  AVAILABLE: 'available',
  DOWNLOADABLE: 'downloadable',
  DOWNLOADING: 'downloading',
  UNAVAILABLE: 'unavailable',
  NO_API: 'no-api',
});

// Detect either API generation. Prefer the newer global `LanguageModel`
// (Chrome 128+ origin trial → stable); fall back to the legacy
// `self.ai.languageModel` shape used by earlier Canary builds. Guarded so the
// module imports cleanly in a non-browser (test/SSR) context where `self` is
// undefined.
const getApi = () => {
  if (typeof self === 'undefined') return null;
  if (self.LanguageModel) return { kind: 'global', api: self.LanguageModel };
  const legacy = self.ai && self.ai.languageModel;
  return legacy ? { kind: 'legacy', api: legacy } : null;
};

export const isBrowserLlmApiPresent = () => !!getApi();

// Declared once so availability() and create() advertise the SAME I/O languages
// — Chrome warns (and newer builds refuse) when the output language is left
// unspecified.
const LANG_OPTS = Object.freeze({
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
});

/**
 * @returns {Promise<'available'|'downloadable'|'downloading'|'unavailable'|'no-api'>}
 */
export const nanoAvailability = async () => {
  const found = getApi();
  if (!found) return NANO_AVAILABILITY.NO_API;
  try {
    if (found.kind === 'global') {
      // New API: LanguageModel.availability(opts) → status string. Older builds
      // reject the opts arg, so retry bare before giving up.
      let a;
      try { a = await found.api.availability(LANG_OPTS); }
      catch { a = await found.api.availability(); }
      return a || NANO_AVAILABILITY.UNAVAILABLE;
    }
    // Legacy API: capabilities().available is 'readily'|'after-download'|'no'.
    const caps = await found.api.capabilities();
    return ({
      readily: NANO_AVAILABILITY.AVAILABLE,
      'after-download': NANO_AVAILABILITY.DOWNLOADABLE,
      no: NANO_AVAILABILITY.UNAVAILABLE,
    })[caps?.available] || NANO_AVAILABILITY.UNAVAILABLE;
  } catch (err) {
    console.warn(`⚠️ [voice] browser-LLM availability check failed: ${err.message}`);
    return NANO_AVAILABILITY.UNAVAILABLE;
  }
};

export const isNanoReady = async () => (await nanoAvailability()) === NANO_AVAILABILITY.AVAILABLE;

// ─── Session cache ─────────────────────────────────────────────────────────
// One warm session reused across turns (create() has real latency). Keyed by
// system prompt + generation params; when any change, the stale session is
// destroyed and rebuilt. A creation latch collapses concurrent ensureSession()
// calls onto a single in-flight create().
let session = null;
let sessionKey = null;
let creating = null;

const keyOf = ({ systemPrompt, temperature, topK }) => `${temperature}|${topK}|${systemPrompt || ''}`;

const createSession = ({ systemPrompt, temperature, topK }) => {
  const found = getApi();
  if (!found) throw new Error('browser LLM API not present');
  const sys = systemPrompt || '';
  if (found.kind === 'global') {
    // New global API: the system prompt is an initial 'system' message.
    return found.api.create({
      ...(sys ? { initialPrompts: [{ role: 'system', content: sys }] } : {}),
      ...LANG_OPTS,
      temperature,
      topK,
    });
  }
  // Legacy API: system prompt is a top-level string.
  return found.api.create({ systemPrompt: sys, temperature, topK });
};

export const destroyNanoSession = () => {
  try { session?.destroy?.(); } catch { /* already gone */ }
  session = null;
  sessionKey = null;
};

export const ensureNanoSession = async ({ systemPrompt = '', temperature = 0.7, topK = 3 } = {}) => {
  const key = keyOf({ systemPrompt, temperature, topK });
  if (session && sessionKey === key) return session;
  // Params/prompt changed — tear down the stale session before building a new
  // one so we don't leak the old on-device context window.
  if (session && sessionKey !== key) destroyNanoSession();
  if (creating) return creating;
  creating = Promise.resolve()
    .then(() => createSession({ systemPrompt, temperature, topK }))
    .then((s) => { session = s; sessionKey = key; return s; })
    .finally(() => { creating = null; });
  return creating;
};

// Reject after `ms` so a wedged on-device model can't stall a voice turn — the
// caller treats a timeout the same as "Nano declined" and escalates to the
// server. `onTimeout` lets the caller cancel the underlying prompt.
const withTimeout = (promise, ms, onTimeout) => {
  if (!ms) return promise;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { onTimeout?.(); reject(new Error('browser LLM timeout')); }, ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
};

/**
 * One non-streaming prompt against the on-device model. Returns the raw string
 * reply. Throws on timeout / abort / model error — the caller decides whether
 * to escalate to the server.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.systemPrompt]
 * @param {number} [opts.temperature=0.7]
 * @param {number} [opts.topK=3]
 * @param {number} [opts.timeoutMs=8000]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<string>}
 */
export const promptNano = async (text, {
  systemPrompt = '',
  temperature = 0.7,
  topK = 3,
  timeoutMs = 8000,
  signal,
} = {}) => {
  const s = await ensureNanoSession({ systemPrompt, temperature, topK });
  const run = (async () => {
    // Per-request output-language hint; older builds reject the opts arg, so
    // retry bare — but never retry an abort (that would relaunch the work the
    // user just cancelled).
    try {
      return await s.prompt(text, { outputLanguage: 'en', ...(signal ? { signal } : {}) });
    } catch (err) {
      if (signal?.aborted) throw err;
      return s.prompt(text);
    }
  })();
  return withTimeout(run, timeoutMs);
};

// Pre-build the session so the first real turn doesn't pay create() latency.
// No-op (returns false) unless the model is fully downloaded — we never kick
// off a download here. Swallows errors so warming is best-effort.
export const warmNano = async (opts = {}) => {
  if ((await nanoAvailability()) !== NANO_AVAILABILITY.AVAILABLE) return false;
  await ensureNanoSession(opts).catch(() => null);
  return !!session;
};
