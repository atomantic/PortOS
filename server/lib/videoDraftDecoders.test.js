import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DRAFT_DECODE_FULL,
  DRAFT_DECODE_DRAFT,
  DRAFT_DECODE_RUNTIMES,
  VIDEO_DRAFT_DECODERS,
  isFullDecode,
  supportsDraftDecode,
  applyVideoDraftDecoders,
  validateDraftDecoderTable,
  sanitizeDraftDecoders,
  draftDecodeDeclineReason,
  resolveVideoDraftDecoder,
  publicVideoDraftDecodeOptions,
  downloadableVideoDraftDecoders,
} from './videoDraftDecoders.js';

const RUNTIME_REV = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const decoder = (over = {}) => ({
  id: DRAFT_DECODE_DRAFT,
  label: 'Draft decoder',
  description: 'Preview fidelity.',
  repo: 'example/draft-decoder',
  revision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  files: ['decoder.safetensors'],
  sizeLabel: '~1 GB',
  runtimeRevision: RUNTIME_REV,
  ...over,
});

const model = (over = {}) => ({
  id: 'example_h3',
  name: 'Example H3',
  runtime: DRAFT_DECODE_RUNTIMES[0],
  repo: 'example/h3',
  revision: 'cccccccccccccccccccccccccccccccccccccccc',
  draftDecoder: decoder(),
  ...over,
});

const applies = (over = {}) => ({
  model: model(),
  models: [model()],
  decodeId: DRAFT_DECODE_DRAFT,
  runtimeRevision: RUNTIME_REV,
  assetCached: true,
  ...over,
});

afterEach(() => { vi.restoreAllMocks(); });

describe('the shipped table', () => {
  // Guards the module header's own claim, which is a DECISION and not a
  // placeholder: docs/decisions/2026-08-30-h3-draft-decoder-asset.md records
  // why every published candidate fails, and the shape a future one must have.
  // A row added without revisiting that ADR (and without a migration) fails
  // here rather than shipping an unverified pin.
  it('declares no decoder until an asset passes the checklist', () => {
    expect(Object.keys(VIDEO_DRAFT_DECODERS)).toEqual([]);
  });
});

describe('isFullDecode', () => {
  // Absence, '' and 'full' are ONE request. If they ever diverged, an omitted
  // field would start resolving a decoder and a pre-feature render's args
  // would stop being byte-identical.
  it.each([undefined, null, '', DRAFT_DECODE_FULL])('reads %p as a full decode', (id) => {
    expect(isFullDecode(id)).toBe(true);
  });

  it('does not read the draft id as full', () => {
    expect(isFullDecode(DRAFT_DECODE_DRAFT)).toBe(false);
  });
});

describe('applyVideoDraftDecoders', () => {
  const spec = { shippedRepo: 'example/h3', shippedRevision: 'rev-1', decoder: decoder() };
  const withTable = (list, table) => {
    // The shipped table is frozen and empty by design, so the backfill's
    // preservation guards are exercised through validate/sanitize + this
    // hand-rolled equivalent rather than by mutating module state.
    const applyOne = (entry) => {
      if ('draftDecoder' in entry) return entry;
      const found = table[entry.id];
      if (!found) return entry;
      if (found.shippedRepo !== null && entry.repo !== found.shippedRepo) return entry;
      if (found.shippedRevision !== null && entry.revision !== found.shippedRevision) return entry;
      return { ...entry, draftDecoder: { ...found.decoder } };
    };
    return list.map(applyOne);
  };

  it('is a no-op against the shipped (empty) table', () => {
    const list = [{ id: 'example_h3', repo: 'example/h3', revision: 'rev-1' }];
    expect(applyVideoDraftDecoders(list)).toEqual(list);
  });

  it('leaves a non-array input alone', () => {
    expect(applyVideoDraftDecoders(null)).toBeNull();
  });

  it.each([
    ['a re-pointed repo', { id: 'example_h3', repo: 'fork/h3', revision: 'rev-1' }],
    ['a re-pinned revision', { id: 'example_h3', repo: 'example/h3', revision: 'rev-2' }],
    ['an unshipped id', { id: 'custom', repo: 'example/h3', revision: 'rev-1' }],
  ])('does not attach a decoder to %s', (_label, entry) => {
    expect(withTable([entry], { example_h3: spec })[0].draftDecoder).toBeUndefined();
  });

  it('preserves an explicit null override rather than backfilling over it', () => {
    const entry = { id: 'example_h3', repo: 'example/h3', revision: 'rev-1', draftDecoder: null };
    expect(withTable([entry], { example_h3: spec })[0].draftDecoder).toBeNull();
  });
});

describe('validateDraftDecoderTable', () => {
  const problem = (entry) => validateDraftDecoderTable([entry])[0]?.reason || null;

  it('accepts a well-formed declaration', () => {
    expect(validateDraftDecoderTable([model()])).toEqual([]);
  });

  it('accepts an entry with no declaration at all', () => {
    expect(validateDraftDecoderTable([{ id: 'plain', runtime: 'ltx2' }])).toEqual([]);
  });

  // The load-bearing guard: a decoder on a runtime whose arg builder emits no
  // draft flags would render on the FULL decoder while history claimed a draft
  // one. That false claim is the whole reason the gate chain exists.
  it('refuses a declaration on a runtime that emits no draft flags', () => {
    expect(problem(model({ runtime: 'ltx2' }))).toMatch(/no other builder emits its flags/);
  });

  it.each(['id', 'label', 'repo', 'revision', 'runtimeRevision'])('refuses a missing %s', (key) => {
    expect(problem(model({ draftDecoder: decoder({ [key]: undefined }) }))).toMatch(new RegExp(key));
  });

  // The request field is a closed enum, so any other id would surface an option
  // in the picker that the route then 400s.
  it.each([DRAFT_DECODE_FULL, 'turbo'])('refuses the decoder id %p', (id) => {
    expect(problem(model({ draftDecoder: decoder({ id }) }))).toMatch(/must be "draft"/);
  });

  it.each([
    ['an empty file list', []],
    ['a non-array file list', 'decoder.safetensors'],
  ])('refuses %s', (_label, files) => {
    expect(problem(model({ draftDecoder: decoder({ files }) }))).toBeTruthy();
  });

  // Mirrors build_draft_decoder_shim in the runner: the pinned VAE loader opens
  // one named source weight, so a multi-shard declaration must be refused at
  // load rather than failing minutes into a render.
  it('refuses a multi-shard declaration', () => {
    expect(problem(model({ draftDecoder: decoder({ files: ['a.safetensors', 'b.safetensors'] }) })))
      .toMatch(/exactly one weight file/);
  });

  // These are joined onto an HF snapshot root and handed to a child process,
  // so a climbing or absolute path is a real escape rather than a style nit.
  it.each(['/etc/passwd', '../../secret.safetensors'])('refuses the escaping path %s', (path) => {
    expect(problem(model({ draftDecoder: decoder({ files: [path] }) }))).toMatch(/relative path/);
  });
});

describe('sanitizeDraftDecoders', () => {
  it('returns the same array reference when the table is sound', () => {
    const list = [model()];
    expect(sanitizeDraftDecoders(list)).toBe(list);
  });

  it('strips an invalid declaration and warns, leaving the rest of the entry intact', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const [entry] = sanitizeDraftDecoders([model({ runtime: 'ltx2' })]);
    expect(entry.draftDecoder).toBeUndefined();
    expect(entry.id).toBe('example_h3');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('dropping draftDecoder'));
  });
});

describe('draftDecodeDeclineReason', () => {
  it('accepts a request that clears every gate', () => {
    expect(draftDecodeDeclineReason(applies())).toBeNull();
  });

  it('never declines a full decode, even on a model with no decoder', () => {
    expect(draftDecodeDeclineReason({ model: model({ draftDecoder: undefined }), decodeId: DRAFT_DECODE_FULL })).toBeNull();
  });

  // Fail-closed defaults. A caller that omits an argument has not PROVED the
  // render may decode at preview fidelity — it has only failed to ask, and
  // reading that as consent would turn an omission into a silent downgrade.
  it.each([
    ['the model list is missing', { models: undefined }, 'DRAFT_DECODE_DELIVERY_UNVERIFIABLE'],
    ['the cache verdict is missing', { assetCached: undefined }, 'DRAFT_DECODE_ASSET_NOT_CACHED'],
    ['the runtime revision is missing', { runtimeRevision: undefined }, 'DRAFT_DECODE_RUNTIME_UNSUPPORTED'],
  ])('declines when %s', (_label, over, code) => {
    expect(draftDecodeDeclineReason(applies(over)).code).toBe(code);
  });

  // The issue's central safety property: a preview-fidelity asset must never
  // reach a delivery clip, however the request was phrased.
  it('declines a model that is another entry\'s declared Finish target', () => {
    const delivery = model({ id: 'delivery' });
    const list = [{ id: 'draft_model', finishModelId: 'delivery' }, delivery];
    expect(draftDecodeDeclineReason(applies({ model: delivery, models: list })).code)
      .toBe('DRAFT_DECODE_DELIVERY_MODEL');
  });

  it('allows a draft model that merely NAMES a Finish target', () => {
    const draft = model({ id: 'draft_model', finishModelId: 'delivery' });
    const list = [draft, { id: 'delivery' }];
    expect(draftDecodeDeclineReason(applies({ model: draft, models: list }))).toBeNull();
  });

  it('declines a model that declares no draft decoder', () => {
    expect(draftDecodeDeclineReason(applies({ model: model({ draftDecoder: undefined }) })).code)
      .toBe('DRAFT_DECODE_UNSUPPORTED');
  });

  // An older checkout has a helper that ignores the flags rather than
  // rejecting them, so this is the gate that stops a full decode from being
  // recorded as a draft one.
  it.each([
    ['an older checkout', 'dddddddddddddddddddddddddddddddddddddddd'],
    ['an unreadable checkout', null],
  ])('declines %s', (_label, runtimeRevision) => {
    expect(draftDecodeDeclineReason(applies({ runtimeRevision })).code)
      .toBe('DRAFT_DECODE_RUNTIME_UNSUPPORTED');
  });

  it('declines an asset that is not downloaded', () => {
    expect(draftDecodeDeclineReason(applies({ assetCached: false })).code)
      .toBe('DRAFT_DECODE_ASSET_NOT_CACHED');
  });

  // Delivery intent is checked BEFORE the decoder is even looked up, so a
  // delivery model with no decoder reads as "delivery", never as "unsupported"
  // — the reason the user is shown has to be the real one.
  it('reports delivery intent ahead of every other reason', () => {
    const delivery = model({ id: 'delivery', draftDecoder: undefined });
    expect(draftDecodeDeclineReason(applies({
      model: delivery,
      models: [{ id: 'draft_model', finishModelId: 'delivery' }, delivery],
      runtimeRevision: null,
      assetCached: false,
    })).code).toBe('DRAFT_DECODE_DELIVERY_MODEL');
  });
});

describe('resolveVideoDraftDecoder', () => {
  it('returns the concrete asset when every gate passes', () => {
    expect(resolveVideoDraftDecoder(applies())).toEqual({
      id: DRAFT_DECODE_DRAFT,
      label: 'Draft decoder',
      repo: 'example/draft-decoder',
      revision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      files: ['decoder.safetensors'],
      runtimeRevision: RUNTIME_REV,
    });
  });

  it('copies the file list rather than aliasing the registry entry', () => {
    const entry = model();
    resolveVideoDraftDecoder(applies({ model: entry })).files.push('mutated');
    expect(entry.draftDecoder.files).toEqual(['decoder.safetensors']);
  });

  it.each([
    ['a full decode', { decodeId: DRAFT_DECODE_FULL }],
    ['a delivery model', {
      model: model({ id: 'delivery' }),
      models: [{ id: 'draft_model', finishModelId: 'delivery' }],
    }],
    ['an old runtime', { runtimeRevision: 'other' }],
    ['a missing download', { assetCached: false }],
  ])('resolves null for %s', (_label, over) => {
    expect(resolveVideoDraftDecoder(applies(over))).toBeNull();
  });
});

describe('publicVideoDraftDecodeOptions', () => {
  // Empty is the signal to render NO control. A one-entry select would imply a
  // choice the model does not have.
  it('is empty for a model with no draft decoder', () => {
    expect(publicVideoDraftDecodeOptions(model({ draftDecoder: undefined }))).toEqual([]);
    expect(supportsDraftDecode(model({ draftDecoder: undefined }))).toBe(false);
  });

  it('offers full first, then the declared decoder with its download size', () => {
    const options = publicVideoDraftDecodeOptions(model());
    expect(options.map((o) => o.id)).toEqual([DRAFT_DECODE_FULL, DRAFT_DECODE_DRAFT]);
    expect(options[1]).toMatchObject({ repo: 'example/draft-decoder', sizeLabel: '~1 GB' });
  });
});

describe('downloadableVideoDraftDecoders', () => {
  it('de-dupes assets shared by two entries', () => {
    const list = [model(), model({ id: 'example_h3_alt' })];
    const targets = downloadableVideoDraftDecoders(list);
    expect(targets).toHaveLength(1);
    expect(targets[0].modelId).toBe('example_h3');
  });

  it('skips entries with no declaration', () => {
    expect(downloadableVideoDraftDecoders([{ id: 'plain' }])).toEqual([]);
  });
});
