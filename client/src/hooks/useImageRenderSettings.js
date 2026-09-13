import { useState, useEffect, useMemo } from 'react';
import { getSettings } from '../services/api';
import { IMAGE_RENDER_KNOB_DEFAULTS } from '../lib/pipelineImageDefaults';
import {
  deriveAvailableBackends, IMAGE_GEN_MODE, installLocalModelId, LOCAL_IMAGEGEN_DEFAULT_MODEL,
  pickUsableMode, renderPinLadder, renderTargetPin, supportsCloudModelOverride,
} from '../lib/imageGenBackends';

// What the hook reports before the settings blob lands, and after a failed
// fetch: the shipped knobs on the backend that is always usable. Frozen and
// module-level so an unresolved hook hands every consumer the same identity
// rather than a fresh object per render.
const UNRESOLVED = Object.freeze({
  ...IMAGE_RENDER_KNOB_DEFAULTS,
  mode: IMAGE_GEN_MODE.LOCAL,
  modelId: LOCAL_IMAGEGEN_DEFAULT_MODEL,
  cloudModel: null,
});

/**
 * Resolve "what will this record's next render actually run on" — the client
 * mirror of the server's own ladder — and expose it as a ready-to-use
 * `imageCfg`. Collapses the `getSettings` + resolve every single-image-render
 * call site re-implements (Story Builder's characters step, the universe
 * base-style probe, the Decks render bar).
 *
 * The backend walks `renderPinLadder` (the record's own `imageMode`, then the
 * target's `renderDefaults` pin, both gated on backends this install actually
 * has) and falls through to the install-wide `imageGen.mode` via the shared
 * `pickUsableMode`. The model then follows the backend it belongs to: local
 * takes the pin, else `imageGen.local.modelId`, else the shipped default;
 * an override-capable cloud CLI takes the pin as `cloudModel` and nothing
 * else. Neither ever comes from `settings.pipeline.imageGen` — that slice is
 * the Pipeline visual FORM's sticky state, and reading it here is what made a
 * deck advertise the model a comic page was last rendered with while the
 * server rendered on the install pin.
 *
 * Components that already load the full settings blob for other reasons (e.g.
 * the Universe Builder reads loras + models from the same fetch) should keep
 * deriving `imageCfg` from that shared fetch rather than double-fetching here.
 *
 * @param {object}      [opts]
 * @param {object|null} [opts.record] - Record whose `imageMode`/`imageModelId` pin wins.
 * @param {string|null} [opts.target] - RENDER_TARGET id whose `renderDefaults` pin is next.
 * @returns {{ imageCfg: object, backends: Array<{id:string,label:string}> }} —
 *   `backends` is the enabled, non-external list the pin ladder was gated on
 *   (empty until settings land), for callers that also render a backend picker.
 */
export default function useImageRenderSettings({ record = null, target = null } = {}) {
  // `null` = not fetched yet (or the fetch failed), which is NOT the same as a
  // settings blob with no backends enabled. Holding the raw blob (rather than a
  // derived cfg seeded with the defaults and an `[]` backend list) keeps the two
  // apart: `[]` reads as "loaded, nothing enabled" and would suppress every pin.
  const [settings, setSettings] = useState(null);

  useEffect(() => {
    getSettings({ silent: true }).then(setSettings).catch(() => {});
  }, []);

  // Depend on the pin fields rather than the record identity — callers hand us
  // a freshly-fetched draft object on every save, and re-deriving an identical
  // cfg would churn the render opts for every consumer downstream.
  return useMemo(() => {
    if (!settings) return { imageCfg: UNRESOLVED, backends: [] };
    const backends = deriveAvailableBackends(settings, { excludeExternal: true });
    const pin = renderPinLadder([record, renderTargetPin(settings, target)], backends);
    const mode = pin.mode || pickUsableMode(settings, [settings.imageGen?.mode]);
    const isLocal = mode === IMAGE_GEN_MODE.LOCAL;
    return {
      backends,
      imageCfg: {
        ...IMAGE_RENDER_KNOB_DEFAULTS,
        mode,
        // Only one of these is ever set: a local render reads `modelId`, an
        // override-capable cloud CLI reads `cloudModel`. Carrying the local
        // model alongside a cloud mode is how "Renders on Codex · <local
        // model>" would get advertised.
        modelId: isLocal ? (pin.modelId || installLocalModelId(settings)) : null,
        cloudModel: !isLocal && supportsCloudModelOverride(mode) ? pin.modelId : null,
      },
    };
  }, [settings, target, record?.imageMode, record?.imageModelId]);
}
