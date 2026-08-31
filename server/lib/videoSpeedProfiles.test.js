import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  SPEED_PROFILE_DEFAULT_ID,
  VIDEO_SPEED_PROFILES,
  applyVideoSpeedProfiles,
  isDefaultSpeedProfile,
  videoSpeedProfiles,
  supportsSpeedProfiles,
  findVideoSpeedProfile,
  speedProfileDeclineReason,
  resolveVideoSpeedProfile,
  resolveVideoSpeedProfileForModes,
  inferEffectiveVideoMode,
  speedProfileDeclineReasonForModes,
  resolveVideoSampler,
  validateSpeedProfileTable,
  sanitizeSpeedProfiles,
} from './videoSpeedProfiles.js';

const SHIPPED_ID = 'ltx25_mlx_q8';
const spec = VIDEO_SPEED_PROFILES[SHIPPED_ID];

// A registry entry exactly as it ships, so the pin guards are exercised against
// the real values rather than a hand-typed copy that could drift from them.
const shippedEntry = (overrides = {}) => ({
  id: SHIPPED_ID,
  name: 'LTX-2.5 MLX Q8',
  repo: spec.shippedRepo,
  revision: spec.shippedRevision,
  runtime: 'ltx25',
  steps: 8,
  guidance: 3.0,
  ...overrides,
});

const decorated = (overrides = {}) => applyVideoSpeedProfiles([shippedEntry(overrides)])[0];

afterEach(() => vi.restoreAllMocks());

describe('applyVideoSpeedProfiles', () => {
  it('attaches the shipped profiles to a pin-matching entry', () => {
    const entry = decorated();
    expect(entry.speedProfiles).toHaveLength(spec.profiles.length);
    expect(entry.speedProfiles[0].id).toBe('fast');
  });

  it('returns copies rather than the frozen shipped objects', () => {
    const a = decorated().speedProfiles[0];
    const b = decorated().speedProfiles[0];
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
    // A consumer mutating one entry's list must not corrupt the shipped table.
    a.steps = 999;
    expect(VIDEO_SPEED_PROFILES[SHIPPED_ID].profiles[0].steps).not.toBe(999);
  });

  it('skips an entry whose repo was re-pointed at a fork', () => {
    expect(decorated({ repo: 'someone/ltx-2.5-fork' }).speedProfiles).toBeUndefined();
  });

  // The revision guard is what this decorator adds over applyVideoFinishProfiles:
  // a sampler schedule is validated against ONE snapshot of the weights.
  it('skips an entry whose revision was moved off the validated pin', () => {
    expect(decorated({ revision: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }).speedProfiles).toBeUndefined();
  });

  it('skips an entry with no revision at all', () => {
    const { revision: _drop, ...noRevision } = shippedEntry();
    expect(applyVideoSpeedProfiles([noRevision])[0].speedProfiles).toBeUndefined();
  });

  it('leaves an existing key alone, including an explicit opt-out', () => {
    expect(decorated({ speedProfiles: [] }).speedProfiles).toEqual([]);
    expect(decorated({ speedProfiles: null }).speedProfiles).toBeNull();
  });

  it('leaves custom and malformed entries untouched', () => {
    const custom = { id: 'my_model', repo: 'me/mine' };
    expect(applyVideoSpeedProfiles([custom])[0]).toEqual(custom);
    expect(applyVideoSpeedProfiles([null, 7])).toEqual([null, 7]);
    expect(applyVideoSpeedProfiles('nope')).toBe('nope');
  });
});

describe('the default profile is a no-op', () => {
  it('treats absence, empty string and the default id identically', () => {
    for (const id of [null, undefined, '', SPEED_PROFILE_DEFAULT_ID]) {
      expect(isDefaultSpeedProfile(id)).toBe(true);
      expect(findVideoSpeedProfile(decorated(), id)).toBeNull();
      expect(speedProfileDeclineReason({ model: decorated(), profileId: id, mode: 'text' })).toBeNull();
      expect(resolveVideoSpeedProfile({ model: decorated(), profileId: id, mode: 'text' })).toBeNull();
    }
  });

  it('leaves the sampler exactly where it was', () => {
    const model = decorated();
    const profile = resolveVideoSpeedProfile({ model, profileId: SPEED_PROFILE_DEFAULT_ID, mode: 'text' });
    expect(resolveVideoSampler({ model, steps: undefined, guidanceScale: undefined, speedProfile: profile }))
      .toEqual({ steps: 8, guidance: 3.0, stage2Steps: null });
  });
});

describe('speedProfileDeclineReason', () => {
  it('accepts the modes the profile was validated for', () => {
    for (const mode of ['text', 'image']) {
      expect(speedProfileDeclineReason({ model: decorated(), profileId: 'fast', mode })).toBeNull();
    }
  });

  it('treats an absent mode as the default text render', () => {
    expect(speedProfileDeclineReason({ model: decorated(), profileId: 'fast', mode: null })).toBeNull();
    expect(speedProfileDeclineReason({ model: decorated(), profileId: 'fast', mode: '' })).toBeNull();
  });

  it('declines the modes that route through a different pipeline', () => {
    for (const mode of ['fflf', 'extend', 'a2v', 'ic-control']) {
      const reason = speedProfileDeclineReason({ model: decorated(), profileId: 'fast', mode });
      expect(reason?.code).toBe('SPEED_PROFILE_MODE_UNSUPPORTED');
      expect(reason.message).toContain(mode);
    }
  });

  it('declines an id the model does not offer', () => {
    expect(speedProfileDeclineReason({ model: decorated(), profileId: 'turbo', mode: 'text' })?.code)
      .toBe('SPEED_PROFILE_UNSUPPORTED');
    // An undecorated (forked / custom) model offers nothing at all.
    expect(speedProfileDeclineReason({ model: shippedEntry(), profileId: 'fast', mode: 'text' })?.code)
      .toBe('SPEED_PROFILE_UNSUPPORTED');
  });

  it('declines on a samplerLocked model, whose own schedule is the authority', () => {
    const model = { ...decorated(), samplerLocked: true };
    expect(speedProfileDeclineReason({ model, profileId: 'fast', mode: 'text' })?.code)
      .toBe('SPEED_PROFILE_SAMPLER_LOCKED');
    expect(resolveVideoSpeedProfile({ model, profileId: 'fast', mode: 'text' })).toBeNull();
  });
});

describe('resolveVideoSpeedProfile', () => {
  it('returns the concrete override for a compatible request', () => {
    expect(resolveVideoSpeedProfile({ model: decorated(), profileId: 'fast', mode: 'text' })).toEqual({
      id: 'fast',
      steps: 8,
      stage2Steps: 3,
      guidance: 1.0,
      teacache: true,
      teacacheThresh: null,
      requiresAdapter: 'ltx-2.5-22b-distilled-lora-450.safetensors',
    });
  });

  it('returns null for every declined request', () => {
    expect(resolveVideoSpeedProfile({ model: decorated(), profileId: 'fast', mode: 'fflf' })).toBeNull();
    expect(resolveVideoSpeedProfile({ model: decorated(), profileId: 'nope', mode: 'text' })).toBeNull();
  });
});

describe('resolveVideoSampler precedence', () => {
  const model = decorated();
  const fast = resolveVideoSpeedProfile({ model, profileId: 'fast', mode: 'text' });

  it('gives a locked sampler the last word, over profile AND user values', () => {
    const locked = { ...model, samplerLocked: true, steps: 40, guidance: 6 };
    expect(resolveVideoSampler({ model: locked, steps: 12, guidanceScale: 2, speedProfile: fast }))
      .toEqual({ steps: 40, guidance: 6, stage2Steps: null });
  });

  it('lets a profile drive steps AND guidance together, over explicit values', () => {
    expect(resolveVideoSampler({ model, steps: 30, guidanceScale: 7, speedProfile: fast }))
      .toEqual({ steps: 8, guidance: 1.0, stage2Steps: 3 });
  });

  it('honors explicit user values when no profile applies', () => {
    expect(resolveVideoSampler({ model, steps: '30', guidanceScale: '7', speedProfile: null }))
      .toEqual({ steps: 30, guidance: 7, stage2Steps: null });
  });

  it('falls back to the registry defaults, treating 0/empty guidance as explicit', () => {
    expect(resolveVideoSampler({ model, steps: undefined, guidanceScale: undefined, speedProfile: null }))
      .toEqual({ steps: 8, guidance: 3.0, stage2Steps: null });
    // guidance 0 is a real request (no CFG), not "unset" — the `!= null && !== ''`
    // check exists precisely so it isn't collapsed into the model default.
    expect(resolveVideoSampler({ model, steps: undefined, guidanceScale: 0, speedProfile: null }).guidance).toBe(0);
    expect(resolveVideoSampler({ model, steps: undefined, guidanceScale: '', speedProfile: null }).guidance).toBe(3.0);
  });
});

describe('validateSpeedProfileTable / sanitizeSpeedProfiles', () => {
  // `runtime` defaults to a valid one so each case exercises the rule it names
  // rather than tripping the runtime gate first.
  const withProfile = (profile, extra = {}) => [{ id: 'm', runtime: 'ltx25', ...extra, speedProfiles: [profile] }];
  const base = { id: 'fast', name: 'Fast', steps: 8, stage2Steps: 3, guidance: 1.0, modes: ['text'] };

  it('passes the shipped table', () => {
    expect(validateSpeedProfileTable(applyVideoSpeedProfiles([shippedEntry()]))).toEqual([]);
  });

  it('passes an entry with no speedProfiles key, and an explicit opt-out', () => {
    expect(validateSpeedProfileTable([{ id: 'm' }])).toEqual([]);
    expect(validateSpeedProfileTable([{ id: 'm', speedProfiles: null }])).toEqual([]);
    // An empty list is a valid opt-out on ANY runtime — the gate is about
    // declaring a profile, not about carrying the key.
    expect(validateSpeedProfileTable([{ id: 'm', runtime: 'wan22', speedProfiles: [] }])).toEqual([]);
  });

  it.each([
    ['a non-array value', [{ id: 'm', runtime: 'ltx25', speedProfiles: 'fast' }], /must be an array/],
    ['a missing id', withProfile({ ...base, id: undefined }), /non-empty string/],
    ['the reserved default id', withProfile({ ...base, id: SPEED_PROFILE_DEFAULT_ID }), /reserved default/],
    ['NaN steps', withProfile({ ...base, steps: Number.NaN }), /positive integer/],
    ['zero steps', withProfile({ ...base, steps: 0 }), /positive integer/],
    ['non-integer steps', withProfile({ ...base, steps: 8.5 }), /positive integer/],
    ['missing guidance', withProfile({ ...base, guidance: undefined }), /finite number/],
    ['negative guidance', withProfile({ ...base, guidance: -1 }), /finite number/],
    ['zero stage2Steps', withProfile({ ...base, stage2Steps: 0 }), /positive integer/],
    ['empty modes', withProfile({ ...base, modes: [] }), /non-empty array/],
    ['non-string modes', withProfile({ ...base, modes: [7] }), /non-empty array/],
  ])('rejects %s', (_label, list, pattern) => {
    const problems = validateSpeedProfileTable(list);
    expect(problems).toHaveLength(1);
    expect(problems[0].reason).toMatch(pattern);
  });

  it.each([
    ['a non-numeric teacacheThresh', { teacacheThresh: 'high' }, /teacacheThresh must be a positive number/],
    ['a zero teacacheThresh', { teacacheThresh: 0 }, /teacacheThresh must be a positive number/],
    ['a non-string requiresAdapter', { requiresAdapter: 450 }, /requiresAdapter must be a non-empty string/],
    ['an empty requiresAdapter', { requiresAdapter: '' }, /requiresAdapter must be a non-empty string/],
  ])('rejects %s — both reach the helper argv', (_label, overrides, pattern) => {
    // A non-numeric threshold exits the child at argparse (type=float) mid-job;
    // a non-string adapter name throws ERR_INVALID_ARG_TYPE out of spawn.
    const problems = validateSpeedProfileTable(withProfile({ ...base, ...overrides }));
    expect(problems).toHaveLength(1);
    expect(problems[0].reason).toMatch(pattern);
  });

  it('accepts both optional fields when absent or well-formed', () => {
    expect(validateSpeedProfileTable(withProfile(base))).toEqual([]);
    expect(validateSpeedProfileTable(withProfile({
      ...base, teacacheThresh: 0.8, requiresAdapter: 'a.safetensors',
    }))).toEqual([]);
    expect(validateSpeedProfileTable(withProfile({
      ...base, teacacheThresh: null, requiresAdapter: null,
    }))).toEqual([]);
  });

  it('rejects a duplicate profile id within one entry', () => {
    const problems = validateSpeedProfileTable([{ id: 'm', runtime: 'ltx25', speedProfiles: [base, { ...base }] }]);
    expect(problems[0].reason).toMatch(/duplicate/);
  });

  // Only buildLtx2Args emits the profile's runner flags. Anywhere else the step
  // schedule would apply while TeaCache/adapter silently would not, and no
  // SPEEDPROFILE: report would come back — so history would read as a full
  // speed-up that never happened.
  it('rejects profiles declared on a runtime whose builder cannot emit their flags', () => {
    for (const runtime of ['mlx_video', 'wan22', 'minimax_h3', 'fastvideo', undefined]) {
      const problems = validateSpeedProfileTable(withProfile(base, { runtime }));
      expect(problems).toHaveLength(1);
      expect(problems[0].reason).toMatch(/LTX-2-family runtime/);
    }
  });

  it.each(['ltx2', 'ltx25'])('accepts profiles on the %s runtime', (runtime) => {
    expect(validateSpeedProfileTable(withProfile(base, { runtime }))).toEqual([]);
  });

  it('rejects a samplerLocked model that also declares profiles', () => {
    const problems = validateSpeedProfileTable(withProfile(base, { samplerLocked: true }));
    expect(problems[0].reason).toMatch(/samplerLocked/);
  });

  it('strips a bad entry at load and warns, leaving good entries untouched', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const good = { id: 'good', runtime: 'ltx25', speedProfiles: [base] };
    const bad = { id: 'bad', runtime: 'ltx25', speedProfiles: [{ ...base, steps: Number.NaN }] };
    const out = sanitizeSpeedProfiles([good, bad]);
    expect(out[0]).toEqual(good);
    expect(out[1]).toEqual({ id: 'bad', runtime: 'ltx25' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('dropping speedProfiles on "bad"'));
  });

  it('returns the input array unchanged when the table is sound', () => {
    const list = [{ id: 'm', runtime: 'ltx25', speedProfiles: [base] }];
    expect(sanitizeSpeedProfiles(list)).toBe(list);
  });
});

describe('videoSpeedProfiles / supportsSpeedProfiles', () => {
  it('reads the decorated list and filters malformed entries', () => {
    expect(supportsSpeedProfiles(decorated())).toBe(true);
    expect(supportsSpeedProfiles(shippedEntry())).toBe(false);
    expect(videoSpeedProfiles({ speedProfiles: [{ id: 'a' }, {}, null] })).toEqual([{ id: 'a' }]);
    expect(videoSpeedProfiles(null)).toEqual([]);
  });
});

// A chained render is ONE clip whose chunks do not all run in the same mode
// (chunk 0 keeps the request's; chunks 1+ re-enter as `extend` on a window
// continuity chain, `image` on a frame hop). Applying the profile to only the
// chunks that accept it would stitch a fast chunk onto quality ones — a
// visible seam mid-clip — and inflate the chain ETA.
describe('resolveVideoSpeedProfileForModes (chained renders)', () => {
  const model = decorated();
  const args = (modes, profileId = 'fast') => ({ model, profileId, modes });

  it('applies when every chunk mode accepts the profile', () => {
    // Frame-hop chain: chunk 0 text/image, chunks 1+ image — all supported.
    expect(resolveVideoSpeedProfileForModes(args(['text', 'image']))?.id).toBe('fast');
    expect(resolveVideoSpeedProfileForModes(args(['image', 'image']))?.id).toBe('fast');
    expect(speedProfileDeclineReasonForModes(args(['text', 'image']))).toBeNull();
  });

  it('declines the WHOLE chain when any chunk mode does not', () => {
    // Window-continuity chain: chunks 1+ are `extend`, which routes through a
    // pipeline this schedule was never measured on.
    expect(resolveVideoSpeedProfileForModes(args(['text', 'extend']))).toBeNull();
    expect(speedProfileDeclineReasonForModes(args(['text', 'extend']))?.code)
      .toBe('SPEED_PROFILE_MODE_UNSUPPORTED');
    // Order doesn't matter — one bad mode is enough.
    expect(resolveVideoSpeedProfileForModes(args(['extend', 'image']))).toBeNull();
  });

  it('treats a single-chunk chain exactly like a lone render', () => {
    expect(resolveVideoSpeedProfileForModes(args(['text']))?.id).toBe('fast');
    expect(resolveVideoSpeedProfileForModes(args(['fflf']))).toBeNull();
  });

  it('falls back to the inferred text render for an empty or absent mode list', () => {
    for (const modes of [[], null, undefined]) {
      expect(resolveVideoSpeedProfileForModes(args(modes))?.id).toBe('fast');
    }
  });

  it('is a no-op for the default profile, whatever the modes', () => {
    expect(resolveVideoSpeedProfileForModes(args(['text', 'extend'], SPEED_PROFILE_DEFAULT_ID))).toBeNull();
    expect(speedProfileDeclineReasonForModes(args(['text', 'extend'], SPEED_PROFILE_DEFAULT_ID))).toBeNull();
  });
});

// buildLtx2Args infers the helper mode from the conditioning it is handed, so a
// gate reading a raw absent `mode` as "text" would green-light a two-stage
// schedule for a KeyframeInterpolation render the profile was never validated
// on. This is that same inference, and the two must agree.
describe('inferEffectiveVideoMode', () => {
  it('returns an explicit mode untouched, whatever the conditioning', () => {
    expect(inferEffectiveVideoMode({ mode: 'text', keyframes: [{}, {}] })).toBe('text');
    expect(inferEffectiveVideoMode({ mode: 'extend', sourceImagePath: '/a.png' })).toBe('extend');
  });

  it('infers from the conditioning when the mode is absent', () => {
    expect(inferEffectiveVideoMode({})).toBe('text');
    expect(inferEffectiveVideoMode({ mode: '' })).toBe('text');
    expect(inferEffectiveVideoMode({ sourceImagePath: '/a.png' })).toBe('image');
    expect(inferEffectiveVideoMode({ extendFromVideoPath: '/a.mp4' })).toBe('extend');
    expect(inferEffectiveVideoMode({ audioFilePath: '/a.wav' })).toBe('a2v');
    expect(inferEffectiveVideoMode({ keyframes: [{ index: 0 }, { index: 8 }] })).toBe('fflf');
  });

  it('needs two keyframes for fflf, matching buildLtx2Args', () => {
    expect(inferEffectiveVideoMode({ keyframes: [{ index: 0 }] })).toBe('text');
    expect(inferEffectiveVideoMode({ keyframes: [] })).toBe('text');
  });

  // The point of the whole helper: a direct caller that omits `mode` while
  // supplying keyframes must NOT be handed the two-stage schedule.
  it('declines a profile for conditioning that implies another pipeline', () => {
    const model = decorated();
    const args = (ctx) => ({ model, profileId: 'fast', mode: inferEffectiveVideoMode(ctx) });
    expect(resolveVideoSpeedProfile(args({ keyframes: [{ index: 0 }, { index: 8 }] }))).toBeNull();
    expect(resolveVideoSpeedProfile(args({ audioFilePath: '/a.wav' }))).toBeNull();
    expect(resolveVideoSpeedProfile(args({ extendFromVideoPath: '/a.mp4' }))).toBeNull();
    // …while a plain render, and an image render, still take it.
    expect(resolveVideoSpeedProfile(args({}))?.id).toBe('fast');
    expect(resolveVideoSpeedProfile(args({ sourceImagePath: '/a.png' }))?.id).toBe('fast');
  });
});
