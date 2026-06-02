import { useState, useEffect } from 'react';
import { getSettings } from '../services/api';
import { PIPELINE_IMAGE_DEFAULTS, readPipelineImageSettings } from '../lib/pipelineImageDefaults';

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
 * @returns {{ imageCfg: object }}
 */
export default function useImageRenderSettings() {
  const [imageCfg, setImageCfg] = useState(PIPELINE_IMAGE_DEFAULTS);

  useEffect(() => {
    getSettings({ silent: true })
      .then((s) => setImageCfg(readPipelineImageSettings(s)))
      .catch(() => {});
  }, []);

  return { imageCfg };
}
