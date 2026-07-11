import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { FolderOpen, Loader2, Sparkles, FolderTree, Layers } from 'lucide-react';
import { formatDateTime } from '../../utils/formatters';
import { RUNNER_FAMILIES, loraCompatKey } from '../../lib/runnerFamilies';
import { IMAGE_GEN_MODE } from '../../lib/imageGenBackends';
import ImageGenSettingsForm from '../imageGen/ImageGenSettingsForm';
import { TRUNK_TABS, humanizeCategory } from '../../lib/universeBuilderShared';
import { totalVariationCount, countCanonWithContent } from '../../lib/universeBuilderCounts';

// Batch-render tab for the Universe Builder. Renders the shared image-gen
// settings form plus per-trunk / canon / composite bulk-render targets and a
// recent-runs list. Extracted from UniverseBuilder.jsx (#2374). handleRender
// (owned by the page) queues the actual render jobs.
export default function RenderTab({
  draft, selectedId, bucketsByKind, renderOpts, setRenderOpts,
  availableBackends, defaultMode, imageModels, availableLoras = [],
  handleRender, rendering, runs,
}) {
  const currentModel = useMemo(
    () => imageModels.find((m) => m.id === renderOpts.modelId),
    [imageModels, renderOpts.modelId],
  );
  const currentRunnerFamily = currentModel?.runner || RUNNER_FAMILIES.MFLUX;
  const currentCompatKey = loraCompatKey(currentModel);
  // Memoize the counts that drive button labels + disable states. Drafts can
  // be large (full canon + variations + sheets) and ImageGenSettingsForm
  // re-renders RenderTab on every keystroke into the per-batch fields.
  const counts = useMemo(() => {
    // Mirror server-side compile skip rules — `renderPromptCount` already
    // filters canon via `canonEntryHasContent`, so each trunk's counts and
    // the "Render everything" total agree with what the server enqueues.
    const totalSheets = draft.compositeSheets?.length || 0;
    const totalVariations = totalVariationCount(draft);
    const totalCanon = countCanonWithContent(draft, 'characters')
      + countCanonWithContent(draft, 'places')
      + countCanonWithContent(draft, 'objects');
    const otherBuckets = bucketsByKind?.other || [];
    const totalOtherVariations = otherBuckets.reduce(
      (n, k) => n + (draft.categories?.[k]?.variations?.length || 0),
      0,
    );
    return {
      totalSheets,
      totalVariations,
      totalCanon,
      otherBuckets,
      totalOtherVariations,
      totalEverything: totalSheets + totalVariations + totalCanon,
    };
  }, [draft, bucketsByKind]);
  const { totalSheets, totalCanon, otherBuckets, totalOtherVariations, totalEverything } = counts;
  const perPrompt = renderOpts.batchPerVariation || 1;

  return (
    <>
      <section className="bg-port-card border border-port-border rounded p-4 flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-white flex items-center gap-2">
          <FolderOpen size={16} className="text-port-accent" /> Batch render
        </h2>
        {availableBackends.length === 0 && (
          <p className="text-xs text-port-warning">
            Configure a local mflux Python path or enable Codex Imagegen in Settings → Image Gen
            to enable batch render.
          </p>
        )}
        <ImageGenSettingsForm
          value={{ ...renderOpts, mode: renderOpts.mode || defaultMode || IMAGE_GEN_MODE.LOCAL }}
          onChange={(next) => setRenderOpts(next)}
          models={imageModels}
          availableBackends={availableBackends}
          showLoras
          availableLoras={availableLoras}
          currentRunnerFamily={currentRunnerFamily}
          currentCompatKey={currentCompatKey}
          showStylePreset
        />
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div>
            <label htmlFor="world-render-batch" className="block text-xs font-medium text-gray-400 mb-1">Renders per prompt</label>
            <input
              id="world-render-batch"
              type="number" min={1} max={20}
              value={renderOpts.batchPerVariation ?? 1}
              onChange={(e) => {
                const n = Number(e.target.value);
                setRenderOpts((r) => ({ ...r, batchPerVariation: Number.isFinite(n) && n > 0 ? n : 1 }));
              }}
              className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
            />
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => handleRender({
              promptMode: 'all',
              // Both `scopedPromptCount` (client) and `compilePrompts` (server)
              // skip canon entirely when `canonSelection` is omitted. The button
              // label promises "everything", so we must explicitly select every
              // canon trunk — derived from TRUNK_TABS so the set stays in sync
              // when a new trunk is added.
              canonSelection: Object.fromEntries(TRUNK_TABS.map((t) => [t.kind, 'all'])),
            })}
            disabled={rendering || !selectedId || totalEverything === 0 || availableBackends.length === 0}
            className="px-4 py-2 bg-port-accent hover:bg-port-accent/90 disabled:opacity-50 text-white rounded flex items-center gap-2 min-h-[40px]"
            title="Render every canon entry + every variation + every composite board with these knobs"
          >
            {rendering ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
            Render everything ({totalEverything * perPrompt} image{totalEverything * perPrompt === 1 ? '' : 's'})
          </button>
          <span className="text-[11px] text-gray-500">…or pick a narrower scope below.</span>
        </div>
        {!selectedId && <p className="text-xs text-gray-500">Save the world first to enable rendering.</p>}
      </section>

      <section className="bg-port-card border border-port-border rounded p-4 flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-white">Render targets</h3>
        <p className="text-[11px] text-gray-500 -mt-1">
          Click a target to queue that scope immediately with the knobs above.
        </p>
        <div className="flex flex-col gap-2">
          {TRUNK_TABS.map((trunk) => {
            const buckets = bucketsByKind[trunk.kind] || [];
            // Use the synthesizable count for both the display label and the
            // "Bulk-render all" total so the button advertises the number that
            // will actually land on the server.
            const canonCount = countCanonWithContent(draft, trunk.kind);
            const variationCount = buckets.reduce((n, k) => n + (draft.categories?.[k]?.variations?.length || 0), 0);
            const total = canonCount + variationCount;
            if (total === 0) return null;
            const Icon = trunk.icon;
            return (
              <div key={trunk.id} className="border border-port-border rounded p-2 bg-port-bg flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2 text-sm text-gray-200">
                    <Icon size={14} className="text-port-accent" />
                    <span className="font-medium">{trunk.label}</span>
                    <span className="text-[11px] text-gray-500">
                      {canonCount} canon · {variationCount} variation{variationCount === 1 ? '' : 's'}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRender({
                      promptMode: 'all',
                      selection: Object.fromEntries(buckets.map((b) => [b, 'all'])),
                      canonSelection: canonCount > 0 ? { [trunk.kind]: 'all' } : undefined,
                      // Trunk scope excludes composite sheets — see comment on
                      // TrunkView's onBulkRenderTrunk for why this opt-out matters.
                      sheetSelection: [],
                    })}
                    disabled={!selectedId || availableBackends.length === 0 || rendering}
                    className="text-xs px-2 py-1 bg-port-accent/15 hover:bg-port-accent/25 disabled:opacity-30 disabled:cursor-not-allowed text-port-accent rounded min-h-[32px]"
                    title={`Render every ${trunk.label.toLowerCase()} canon entry AND every variation under this trunk`}
                  >
                    Bulk-render all ({total})
                  </button>
                </div>
                {buckets.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1 pl-5">
                    {buckets.map((bucket) => {
                      const count = draft.categories?.[bucket]?.variations?.length || 0;
                      return (
                        <button
                          key={bucket}
                          type="button"
                          onClick={() => handleRender({ promptMode: 'variations', selection: { [bucket]: 'all' } })}
                          disabled={count === 0 || !selectedId || availableBackends.length === 0 || rendering}
                          className="text-[11px] px-1.5 py-0.5 bg-port-card border border-port-border hover:border-port-accent disabled:opacity-30 disabled:cursor-not-allowed text-gray-300 rounded"
                          title={count === 0 ? 'No variations yet' : `Bulk-render ${humanizeCategory(bucket)} (${count})`}
                        >
                          {humanizeCategory(bucket)} ({count})
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          {otherBuckets.length > 0 && totalOtherVariations > 0 ? (
            <div className="border border-port-border rounded p-2 bg-port-bg flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 text-sm text-gray-200">
                  <FolderTree size={14} className="text-port-accent" />
                  <span className="font-medium">Other</span>
                  <span className="text-[11px] text-gray-500">
                    {otherBuckets.length} bucket{otherBuckets.length === 1 ? '' : 's'}
                    {' · '}{totalOtherVariations} variation{totalOtherVariations === 1 ? '' : 's'}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => handleRender({
                    promptMode: 'variations',
                    selection: Object.fromEntries(otherBuckets.map((b) => [b, 'all'])),
                  })}
                  disabled={!selectedId || availableBackends.length === 0 || rendering}
                  className="text-xs px-2 py-1 bg-port-accent/15 hover:bg-port-accent/25 disabled:opacity-30 disabled:cursor-not-allowed text-port-accent rounded min-h-[32px]"
                  title="Render every variation in every Other bucket"
                >
                  Bulk-render all ({totalOtherVariations})
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-1 pl-5">
                {otherBuckets.map((bucket) => {
                  const count = draft.categories?.[bucket]?.variations?.length || 0;
                  return (
                    <button
                      key={bucket}
                      type="button"
                      onClick={() => handleRender({ promptMode: 'variations', selection: { [bucket]: 'all' } })}
                      disabled={count === 0 || !selectedId || availableBackends.length === 0 || rendering}
                      className="text-[11px] px-1.5 py-0.5 bg-port-card border border-port-border hover:border-port-accent disabled:opacity-30 disabled:cursor-not-allowed text-gray-300 rounded"
                      title={count === 0 ? 'No variations yet' : `Bulk-render ${humanizeCategory(bucket)} (${count})`}
                    >
                      {humanizeCategory(bucket)} ({count})
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
          {totalCanon > 0 ? (
            <div className="border border-port-border rounded p-2 bg-port-bg flex items-center justify-between gap-2">
              <span className="text-sm text-gray-200 flex items-center gap-2">
                <Sparkles size={14} className="text-port-accent" />
                All canon
                <span className="text-[11px] text-gray-500">
                  {totalCanon} entr{totalCanon === 1 ? 'y' : 'ies'}
                </span>
              </span>
              <button
                type="button"
                onClick={() => handleRender({
                  promptMode: 'canon',
                  canonSelection: Object.fromEntries(TRUNK_TABS.map((t) => [t.kind, 'all'])),
                })}
                disabled={!selectedId || availableBackends.length === 0 || rendering}
                className="text-xs px-2 py-1 bg-port-accent/15 hover:bg-port-accent/25 disabled:opacity-30 disabled:cursor-not-allowed text-port-accent rounded min-h-[32px]"
              >
                Bulk-render all canon
              </button>
            </div>
          ) : null}
          {totalSheets > 0 && (
            <div className="border border-port-border rounded p-2 bg-port-bg flex items-center justify-between gap-2">
              <span className="text-sm text-gray-200 flex items-center gap-2">
                <Layers size={14} className="text-port-accent" />
                Composite boards
                <span className="text-[11px] text-gray-500">{totalSheets} board{totalSheets === 1 ? '' : 's'}</span>
              </span>
              <button
                type="button"
                onClick={() => handleRender({ promptMode: 'sheets', sheetSelection: 'all' })}
                disabled={!selectedId || availableBackends.length === 0 || rendering}
                className="text-xs px-2 py-1 bg-port-accent/15 hover:bg-port-accent/25 disabled:opacity-30 disabled:cursor-not-allowed text-port-accent rounded min-h-[32px]"
              >
                Bulk-render composites
              </button>
            </div>
          )}
        </div>
      </section>

      {selectedId && runs.length > 0 && (
        <section className="bg-port-card border border-port-border rounded p-4">
          <h2 className="text-sm font-semibold text-white mb-2">Recent runs</h2>
          <ul className="flex flex-col gap-1">
            {runs.map((r) => (
              <li key={r.id} className="flex items-center justify-between text-sm text-gray-300 border-b border-port-border/40 py-1.5">
                <span className="truncate">
                  <span className="text-gray-500">{formatDateTime(r.createdAt)} —</span>{' '}
                  {r.promptCount} prompt{r.promptCount === 1 ? '' : 's'}
                </span>
                {r.collectionId && (
                  <Link
                    to={`/media/collections/${r.collectionId}`}
                    className="text-xs text-port-accent hover:underline whitespace-nowrap"
                  >
                    Open collection →
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

    </>
  );
}
