/**
 * Load settings and project shared record → target → install render preferences.
 *
 * Returns `{ imageCfg, backends }`; `imageCfg.inheritedBackend` marks inherited display/runtime preferences (local model admission stays server-side). Pass `includeExternal` to also list an enabled external image service.
 * Use for single-image render slots: pass record and target, and retain the owning record tag on submission.
 */

import { useState, useEffect, useMemo } from 'react';
import { getSettings } from '../services/apiSystem.js';
import { resolveRenderCfg } from '../lib/pipelineImageDefaults';
import { deriveAvailableBackends } from '../lib/imageGenBackends';

/**
 * Load the settings blob once on mount and expose "what will this record's next render run on" as a ready-to-use `imageCfg`, collapsing the `getSettings` + `resolveRenderCfg` pair every single-image-render call site re-implements
 * (Story Builder characters step, universe base-style probe, Decks render bar). The ladder, and why nothing here may read `settings.pipeline.imageGen`, is in `resolveRenderCfg`'s header. Components that already load the full settings blob
 * (e.g. Universe Builder) should call `resolveRenderCfg` against that fetch rather than double-fetching.
 * @param {object}      [opts]
 * @param {object|null} [opts.record] - Record whose `imageMode`/`imageModelId` pin wins.
 * @param {string|null} [opts.target] - RENDER_TARGET id whose `renderDefaults` pin is next.
 * @param {boolean} [opts.includeExternal] - Also list an enabled external SDAPI backend (default false; the mood-board poster opts in).
 * @returns {{ imageCfg: object, backends: Array<{id:string,label:string}> }} — `backends` is the enabled list the pin ladder was gated on (empty until settings land), for callers that also render a picker.
 */
export default function useImageRenderSettings({ record = null, target = null, includeExternal = false } = {}) {
  // `null` = not fetched (or fetch failed), NOT a blob with no backends enabled: holding the raw blob keeps the two apart, since a derived `[]` backend list would read as "loaded, nothing enabled" and suppress every pin.
  const [settings, setSettings] = useState(null);

  useEffect(() => {
    getSettings({ silent: true }).then(setSettings).catch(() => {});
  }, []);

  // Depend on the pin fields, not the record identity: callers hand a fresh draft object on every save and re-deriving an identical cfg would churn render opts downstream.
  return useMemo(() => {
    const backends = settings ? deriveAvailableBackends(settings, { excludeExternal: !includeExternal }) : [];
    return {
      backends,
      imageCfg: resolveRenderCfg(settings, { record, target }),
    };
  }, [settings, target, includeExternal, record?.imageMode, record?.imageModelId]);
}
