import { useState, useEffect, useMemo } from 'react';
import { getSettings } from '../services/api';
import { PIPELINE_IMAGE_DEFAULTS, readPipelineImageSettings } from '../lib/pipelineImageDefaults';
import {
  applyRecordRenderPin, deriveAvailableBackends, renderTargetPin,
} from '../lib/imageGenBackends';

/**
 * Load the pipeline image-gen render config once on mount and expose it as a
 * ready-to-use `imageCfg`. Collapses the `getSettings → readPipelineImageSettings`
 * fetch every single-image-render call site re-implements (Story Builder's
 * characters step, the universe base-style probe). Fails open to
 * `PIPELINE_IMAGE_DEFAULTS` — a transient settings fetch failure shouldn't block
 * rendering, and the defaults are a valid render config on their own.
 *
 * Components that already load the full settings blob for other reasons (e.g.
 * the Universe Builder reads loras + models from the same fetch) should keep
 * deriving `imageCfg` from that shared fetch rather than double-fetching here.
 *
 * Pass `record` + `target` to resolve the render-pin ladder over the install
 * default — see `renderPinLadder` for why the client has to do this at all.
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
  // derived cfg seeded with `PIPELINE_IMAGE_DEFAULTS` and an `[]` backend list)
  // keeps the two apart: `[]` reads as "loaded, nothing enabled" and would
  // suppress every pin. Until the blob lands there is no install default and no
  // backend list to gate against, so the hook fails open to the bare defaults —
  // no pin — exactly as it did before the ladder existed.
  const [settings, setSettings] = useState(null);

  useEffect(() => {
    getSettings({ silent: true }).then(setSettings).catch(() => {});
  }, []);

  // Depend on the pin fields rather than the record identity — callers hand us
  // a freshly-fetched draft object on every save, and re-deriving an identical
  // cfg would churn the render opts for every consumer downstream.
  return useMemo(() => {
    if (!settings) return { imageCfg: PIPELINE_IMAGE_DEFAULTS, backends: [] };
    const backends = deriveAvailableBackends(settings, { excludeExternal: true });
    return {
      imageCfg: applyRecordRenderPin(
        readPipelineImageSettings(settings),
        [record, renderTargetPin(settings, target)],
        backends,
      ),
      backends,
    };
  }, [settings, target, record?.imageMode, record?.imageModelId]);
}
