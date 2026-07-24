/**
 * The generation prompt for one sprite asset, shown inside an image-preview
 * modal (SpriteLightbox, AssetInspector) with a copy button — the same
 * "Prompt + copy" affordance the render-history MediaLightbox has.
 *
 * Self-fetching by (recordId, path): the two hosts open on quite different
 * data (a reference candidate object vs. a bare on-disk asset row), so rather
 * than thread a prompt prop down two paths this resolves it from the shared
 * `/sprites/:id/asset-prompt` endpoint. Best-effort — renders nothing until a
 * prompt resolves, and nothing at all for an asset with no prompt provenance
 * (imports, manifests), so a host can drop it in unconditionally.
 */

import { useEffect, useState } from 'react';
import { Copy } from 'lucide-react';
import { getSpriteAssetPrompt } from '../../services/apiSprites.js';
import { copyToClipboard } from '../../lib/clipboard.js';

export default function AssetPromptSection({ recordId, path }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    let active = true;
    setData(null);
    if (!recordId || !path) return undefined;
    // silent: this is a best-effort provenance lookup — a miss should never
    // toast over the modal the user opened just to look at the image.
    getSpriteAssetPrompt(recordId, path, { silent: true })
      .then((res) => { if (active) setData(res); })
      .catch(() => { if (active) setData(null); });
    return () => { active = false; };
  }, [recordId, path]);

  if (!data?.prompt) return null;

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] uppercase tracking-wide text-gray-500">Prompt</span>
        <button
          type="button"
          onClick={() => copyToClipboard(data.prompt, 'Prompt copied')}
          className="p-1 rounded text-gray-400 hover:text-white hover:bg-port-border/50"
          title="Copy prompt"
          aria-label="Copy prompt"
        >
          <Copy className="w-3.5 h-3.5" />
        </button>
      </div>
      <p className="text-xs text-gray-200 whitespace-pre-wrap max-h-40 overflow-y-auto rounded border border-port-border bg-port-bg p-2">
        {data.prompt}
      </p>
    </div>
  );
}
