import { useState, useEffect, useMemo } from 'react';
import { getSettings } from '../services/api';
import { resolveRenderCfg } from '../lib/pipelineImageDefaults';
import { deriveAvailableBackends } from '../lib/imageGenBackends';

/**
 * Load the settings blob once on mount and expose "what will this record's next
 * render actually run on" as a ready-to-use `imageCfg`. Collapses the
 * `getSettings` + `resolveRenderCfg` pair every single-image-render call site
 * re-implements (Story Builder's characters step, the universe base-style
 * probe, the Decks render bar). The resolution itself lives in
 * `resolveRenderCfg` — read its header for the ladder and for why nothing here
 * may read `settings.pipeline.imageGen`.
 *
 * Components that already load the full settings blob for other reasons (e.g.
 * the Universe Builder reads loras + models from the same fetch) should call
 * `resolveRenderCfg` against that shared fetch rather than double-fetching here.
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
    const backends = settings ? deriveAvailableBackends(settings, { excludeExternal: true }) : [];
    return {
      backends,
      // Display projection only; tagged submissions retain server inheritance.
      imageCfg: resolveRenderCfg(settings, { record, target }),
    };
  }, [settings, target, record?.imageMode, record?.imageModelId]);
}
