// This install's local image-model catalog, plus the model a blank pin
// resolves to — everything a local-model picker needs.
//
// `enabled`-gated in the same shape as `useAgyModels`: the catalog probe reads
// the model registry and the install's hardware compatibility server-side, and
// a surface that is rendering on a cloud CLI has no use for it, so nothing is
// fetched until a local render is actually in play. That gate is also what
// keeps a collapsed panel free: the probe only runs once the picker mounts.
//
// The install default is read here rather than passed in so every caller gets
// the same answer without threading a prop — `RecordRenderPinRow` is rendered
// by six unrelated surfaces, and a picker whose blank option names the wrong
// model is the exact class of lie this hook was added to end.

import { useEffect, useState } from 'react';
import { getSettings, listImageModels } from '../services/api';
import { installLocalModelId } from '../lib/imageGenBackends';

/**
 * @param {boolean} enabled - only probe while a local render is in play.
 * @returns {{ models: Array<{id:string,name?:string}>|null, installDefault: string|null }} —
 *   `models` is `null` until the probe resolves (vs `[]` for "probed and
 *   genuinely empty", which a picker must render as "no compatible models"
 *   rather than as "still loading"); `installDefault` is `null` alongside it.
 */
export default function useLocalImageModels(enabled) {
  const [models, setModels] = useState(null);
  const [installDefault, setInstallDefault] = useState(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    listImageModels({ silent: true })
      .then((list) => { if (alive) setModels(Array.isArray(list) ? list : []); })
      .catch(() => { if (alive) setModels([]); });
    getSettings({ silent: true })
      .then((s) => { if (alive) setInstallDefault(installLocalModelId(s)); })
      .catch(() => { if (alive) setInstallDefault(installLocalModelId(null)); });
    return () => { alive = false; };
  }, [enabled]);

  return { models, installDefault };
}
