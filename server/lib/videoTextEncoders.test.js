import { describe, expect, it } from 'vitest';
import {
  STOCK_TEXT_ENCODER_ID,
  videoTextEncoderOptions,
  videoTextEncoderOption,
  isStockTextEncoder,
  supportsVideoTextEncoder,
  resolveVideoTextEncoder,
  downloadableVideoTextEncoders,
  downloadableVideoTextEncoder,
  publicTextEncoderOption,
  videoTextEncoderRuntimes,
  declaredVideoTextEncoders,
} from './videoTextEncoders.js';
import { isSafeHfRepoRelativePath } from './hfCache.js';

const H3 = { id: 'minimax_h3_8bit', runtime: 'minimax_h3' };
const LTX = { id: 'ltx2_unified', runtime: 'ltx2' };
const LTX25 = { id: 'ltx25_mlx_q8', runtime: 'ltx25' };

describe('videoTextEncoders', () => {
  // An empty list is the signal the client uses to hide the picker entirely, so
  // a runtime with nothing to substitute must NOT report its built-in option —
  // otherwise every model renders a one-entry select that does nothing.
  it('offers nothing for a runtime with no substitutions', () => {
    expect(videoTextEncoderOptions(LTX)).toEqual([]);
    expect(videoTextEncoderOptions({ runtime: 'wan22' })).toEqual([]);
    expect(videoTextEncoderOptions(null)).toEqual([]);
  });

  it('lists the stock option first for a runtime that has substitutions', () => {
    const options = videoTextEncoderOptions(H3);
    expect(options.length).toBeGreaterThan(1);
    expect(options[0].id).toBe(STOCK_TEXT_ENCODER_ID);
    expect(options[0].builtIn).toBe(true);
    expect(options.slice(1).every((option) => !option.builtIn)).toBe(true);
  });

  // The client selects options[0] by default, so a runtime whose list did not
  // lead with its built-in entry would silently start every render on a
  // substitute. Asserted across EVERY runtime rather than the one the tests
  // above happen to name, so a second table key can't ship mis-ordered.
  it('leads every runtime with exactly one built-in option', () => {
    const runtimes = videoTextEncoderRuntimes();
    expect(runtimes).toContain('minimax_h3');
    expect(runtimes).toContain('ltx25');
    for (const runtime of runtimes) {
      const options = videoTextEncoderOptions({ runtime });
      expect(options[0]).toMatchObject({ id: STOCK_TEXT_ENCODER_ID, builtIn: true });
      expect(options.filter((option) => option.builtIn)).toHaveLength(1);
    }
  });

  // Each runtime's built-in entry names ITS conditioner — the picker's default
  // row would otherwise tell an LTX-2.5 user their prompt runs through H3's
  // Qwen tower.
  it('describes each runtime built-in as its own packed conditioner', () => {
    expect(videoTextEncoderOption(H3, STOCK_TEXT_ENCODER_ID).label).toMatch(/Qwen3-VL/);
    expect(videoTextEncoderOption(LTX25, STOCK_TEXT_ENCODER_ID).label).toMatch(/Gemma 4/);
  });

  // Absence and the stock sentinel have to mean the same thing everywhere: the
  // route drops the sentinel from persisted params, so a resumed render sends
  // absence where the original sent 'stock'.
  it.each([undefined, null, '', STOCK_TEXT_ENCODER_ID])('treats %j as no override', (id) => {
    expect(isStockTextEncoder(id)).toBe(true);
    expect(resolveVideoTextEncoder(H3, id)).toBeNull();
    // Even on a runtime that offers no substitutions at all.
    expect(resolveVideoTextEncoder(LTX, id)).toBeNull();
  });

  it('resolves a substitute with the loader mechanics the runner needs', () => {
    const option = resolveVideoTextEncoder(H3, 'heretic-bf16');
    expect(option.repo).toBeTruthy();
    // A floating revision would let the upstream repo change the weights under
    // a pinned PortOS build.
    expect(option.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(option.files).toEqual([expect.stringMatching(/\.safetensors$/)]);
    expect(Object.keys(option.keyPrefixMap).length).toBeGreaterThan(0);
  });

  // An upstream checkpoint arrives as several shards; the ones holding only
  // language layers past the conditioning depth are deliberately not pinned, so
  // the list is a subset of the repo rather than every shard it publishes.
  it('resolves a multi-shard substitute with no loader adapters', () => {
    const option = resolveVideoTextEncoder(H3, 'huihui-abliterated');
    expect(option.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(option.files.length).toBeGreaterThan(1);
    expect(option.files.every((name) => name.endsWith('.safetensors'))).toBe(true);
    // Upstream Hugging Face namespace, and it ships its own final norm — the
    // remap and the synthesized norm exist only for a repackaged checkpoint.
    expect(option.keyPrefixMap).toBeUndefined();
    expect(option.finalNormKey).toBeUndefined();
  });

  // The remap has to land on the namespace the pinned MLX loader matches
  // (`model.language_model.` / `model.visual.`), or every tensor is skipped and
  // the load fails with "missing N tensors" after reading ~48 GB.
  it('maps the ComfyUI namespace onto the loader namespace', () => {
    const { keyPrefixMap } = resolveVideoTextEncoder(H3, 'heretic-bf16');
    expect(keyPrefixMap['model.']).toBe('model.language_model.');
    expect(keyPrefixMap['visual.']).toBe('model.visual.');
    // Declared in the SUBSTITUTE's own namespace so the map above rewrites it
    // like any other key — a post-map name would stay unmapped.
    const { finalNormKey } = resolveVideoTextEncoder(H3, 'heretic-bf16');
    expect(finalNormKey.startsWith('model.')).toBe(true);
    expect(finalNormKey.startsWith('model.language_model.')).toBe(false);
  });

  // Failed ltx25 gates remain unreachable: not in the
  // picker, not accepted by route validation, and not downloadable. Declaring
  // a pinned candidate is not permission to spend 11-13 GB on weights a render
  // still cannot select.
  describe('unverified substitutes', () => {
    const UNVERIFIED = [
      'ltx25-abliterated-4bit',
      'ltx25-heretic-8bit',
      'ltx25-ltx-heretic-mxfp8',
    ];

    it('offers ltx25 only its built-in conditioner', () => {
      expect(videoTextEncoderOptions(LTX25).map((option) => option.id)).toEqual([STOCK_TEXT_ENCODER_ID]);
    });

    it.each(UNVERIFIED)('refuses to resolve or download %s', (id) => {
      expect(supportsVideoTextEncoder(LTX25, id)).toBe(false);
      expect(() => resolveVideoTextEncoder(LTX25, id)).toThrow(/has no text encoder/);
      expect(downloadableVideoTextEncoder(id)).toBeNull();
      expect(downloadableVideoTextEncoders().map((entry) => entry.id)).not.toContain(id);
    });

    // "Not yet checked" must not collapse into "fine": the flag is required on
    // every substitute and only an explicit `true` opens the gate, so a new
    // entry is invisible until someone states a verdict rather than shipping by
    // omission.
    it('requires every declared substitute to state a verdict', () => {
      const declared = declaredVideoTextEncoders();
      expect(declared.length).toBeGreaterThan(downloadableVideoTextEncoders().length);
      for (const entry of declared) expect(typeof entry.verified).toBe('boolean');
      // Everything the two lanes DO expose said `true` — nothing rode in on an
      // absent or falsy flag.
      const offered = videoTextEncoderRuntimes()
        .flatMap((runtime) => videoTextEncoderOptions({ runtime }))
        .filter((option) => !option.builtIn)
        .concat(downloadableVideoTextEncoders());
      for (const entry of offered) expect(entry.verified).toBe(true);
    });

    // An unverified entry gets no shape checking from the download-lane loop
    // below (it isn't in that lane yet), so the pins are enforced here — a
    // floating revision or an unsafe path must fail when it is WRITTEN, not
    // months later when someone flips the flag.
    it('pins every declared substitute whether or not it is offered yet', () => {
      for (const entry of declaredVideoTextEncoders()) {
        expect(entry.repo).toBeTruthy();
        expect(entry.revision).toMatch(/^[0-9a-f]{40}$/);
        expect(entry.files.every(isSafeHfRepoRelativePath)).toBe(true);
        expect(new Set(entry.files.map((name) => name.split('/').pop())).size)
          .toBe(entry.files.length);
        expect(entry.sizeBytes).toBeGreaterThan(0);
        expect(entry.disclosure?.modelCardUrl).toMatch(/^https:\/\/huggingface\.co\//);
      }
    });

    // The shim reads the substitute's OWN config.json to generate the one it
    // writes, so an entry that never pinned it would fail in the runner with a
    // missing-file error minutes after the download completed.
    it('pins the config.json every ltx25 shim is generated from', () => {
      const ltx25 = declaredVideoTextEncoders().filter((entry) => entry.id.startsWith('ltx25-'));
      expect(ltx25.length).toBeGreaterThan(0);
      for (const entry of ltx25) {
        expect(entry.files).toContain('config.json');
        expect(entry.files).toContain('model.safetensors.index.json');
        expect(entry.files).toContain('tokenizer.json');
      }
    });

    // `configOverrides` corrects the ONE thing a unified checkpoint gets wrong.
    // Overriding `text_config` or `quantization` would change how the weights
    // are interpreted rather than how they are labelled — group-size drift
    // dequantizes to noise — so the field must stay a label fix.
    it('limits configOverrides to the model_type label', () => {
      for (const entry of declaredVideoTextEncoders()) {
        if (!entry.configOverrides) continue;
        expect(Object.keys(entry.configOverrides)).toEqual(['model_type']);
        expect(entry.configOverrides.model_type).toBe('gemma4');
      }
      // The text-only export already reports gemma4, so it declares none.
      expect(declaredVideoTextEncoders()
        .find((entry) => entry.id === 'ltx25-abliterated-4bit').configOverrides).toBeUndefined();
      expect(declaredVideoTextEncoders()
        .find((entry) => entry.id === 'ltx25-heretic-8bit').configOverrides)
        .toEqual({ model_type: 'gemma4' });
      expect(declaredVideoTextEncoders()
        .find((entry) => entry.id === 'ltx25-ltx-heretic-mxfp8').configOverrides)
        .toEqual({ model_type: 'gemma4' });
    });
  });

  // The picker offers a substitute only where its runtime's loader can consume
  // it — an id is never global, so H3's conditioners must stay off ltx25 and
  // vice versa even once both are verified.
  it('keeps a runtime\'s substitutes off the other runtimes', () => {
    expect(supportsVideoTextEncoder(LTX25, 'heretic-bf16')).toBe(false);
    expect(() => resolveVideoTextEncoder(LTX25, 'heretic-bf16'))
      .toThrow(/has no text encoder "heretic-bf16"/);
    expect(supportsVideoTextEncoder(H3, 'ltx25-abliterated-4bit')).toBe(false);
  });

  it('rejects an id the model cannot load', () => {
    expect(supportsVideoTextEncoder(H3, 'nope')).toBe(false);
    expect(() => resolveVideoTextEncoder(H3, 'nope')).toThrow(/has no text encoder "nope"/);
    // The message names what IS available so the caller can correct it.
    expect(() => resolveVideoTextEncoder(H3, 'nope')).toThrow(/heretic-bf16/);
  });

  it('rejects a substitute on a runtime with no remap for it', () => {
    expect(supportsVideoTextEncoder(LTX, 'heretic-bf16')).toBe(false);
    expect(() => resolveVideoTextEncoder(LTX, 'heretic-bf16'))
      .toThrow(/does not support a substitute text encoder/);
  });

  // A built-in option ships inside the model's weights and has no repo of its
  // own, so it must never reach the download lane — that would 404 or, worse,
  // try to snapshot a repo that doesn't exist.
  it('excludes built-in options from the download lane', () => {
    const ids = downloadableVideoTextEncoders().map((entry) => entry.id);
    expect(ids).not.toContain(STOCK_TEXT_ENCODER_ID);
    expect(ids).toContain('heretic-bf16');
    expect(downloadableVideoTextEncoder(STOCK_TEXT_ENCODER_ID)).toBeNull();
    expect(downloadableVideoTextEncoder('heretic-bf16')).toBeTruthy();
    for (const entry of downloadableVideoTextEncoders()) {
      expect(entry.repo).toBeTruthy();
      // Always an explicit file list. A snapshot of any of these repos pulls
      // quantizations, generation tails or never-built layers the loader can't
      // use — tens of GB of waste per entry.
      expect(entry.files.length).toBeGreaterThan(0);
      // Weights are the point; the companion files an ltx25 shim also pins
      // (shard index, tokenizer, generation config) are not weights, so the
      // shape rule is "carries weights", not "is nothing but weights".
      expect(entry.files.some((name) => name.endsWith('.safetensors'))).toBe(true);
      expect(new Set(entry.files).size).toBe(entry.files.length);
      // Through the same predicate the download target validates with, so the
      // registry can't declare a path the route would then reject at runtime.
      expect(entry.files.every(isSafeHfRepoRelativePath)).toBe(true);
      // The shim links every shard into one flat directory, so two shards with
      // the same basename would collide on one symlink name.
      expect(new Set(entry.files.map((name) => name.split('/').pop())).size).toBe(entry.files.length);
    }
  });

  // The client projection must not carry loader mechanics — publishing them
  // invites a client-side reimplementation of the remap that can then drift
  // from the runner's.
  it('keeps loader mechanics off the client projection', () => {
    const projected = publicTextEncoderOption(videoTextEncoderOption(H3, 'heretic-bf16'));
    expect(projected.keyPrefixMap).toBeUndefined();
    expect(projected.finalNormKey).toBeUndefined();
    expect(projected.revision).toBeUndefined();
    // …while keeping everything the picker renders.
    expect(projected).toMatchObject({
      id: 'heretic-bf16',
      builtIn: false,
      label: expect.any(String),
      description: expect.any(String),
      // The exact published byte count — the picker formats it, so there is no
      // second "~N GB" literal that could drift from the real download.
      sizeBytes: expect.any(Number),
    });
  });

  it('projects the stock option as built-in with no download of its own', () => {
    const projected = publicTextEncoderOption(videoTextEncoderOption(H3, STOCK_TEXT_ENCODER_ID));
    expect(projected).toMatchObject({ id: STOCK_TEXT_ENCODER_ID, builtIn: true });
    expect(projected.repo).toBeUndefined();
    expect(projected.sizeBytes).toBeUndefined();
  });

  // Size is declared ONCE, as bytes, and the UI formats it. A second GB literal
  // (the shape lib/videoDisclosure.js uses for its own entries) would be a
  // driftable restatement of the same fact.
  it('declares size only as bytes', () => {
    for (const entry of downloadableVideoTextEncoders()) {
      expect(entry.sizeBytes).toBeGreaterThan(0);
      expect(entry.disclosure?.estimatedDownloadGb).toBeUndefined();
    }
  });

  // The licence descriptor is the SHARED one from lib/videoDisclosure.js, not a
  // local restatement — a correction to the licence text URL has to reach both
  // tables from one edit.
  it('reuses the shared license descriptors', async () => {
    const { APACHE_2 } = await import('./videoDisclosure.js');
    const entry = videoTextEncoderOption(H3, 'heretic-bf16');
    expect(entry.disclosure.weightsLicense).toBe(APACHE_2);
  });

  // A substitute is someone else's tens-of-GB checkpoint, so its provenance
  // stays one click away — the picker links the card it declares here.
  it('carries a model card on every non-built-in option', () => {
    for (const entry of downloadableVideoTextEncoders()) {
      expect(entry.disclosure?.modelCardUrl).toMatch(/^https:\/\/huggingface\.co\//);
    }
  });
});
