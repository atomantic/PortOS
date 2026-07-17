import { useState } from 'react';
import { Loader2, Plus, Sparkles, Wand2 } from 'lucide-react';
import toast from '../ui/Toast';
import {
  WORLD_CATEGORIES,
  WORLD_CATEGORY_KEY_MAX,
} from '../../services/api';
import {
  BUCKET_CANON,
  normalizeCategoryKey,
} from '../../lib/universeBuilderShared';
import { canonEntryHasContent } from '../../lib/universeBuilderCounts';
import UniverseCanonSection from '../universe/UniverseCanonSection';
import BucketChipStrip from './BucketChipStrip';
import { CategoryEditor } from './UniverseCategoryEditor';

export function TrunkView({
  trunk, draft, selectedId, buckets, activeBucket, setBucket,
  canRender, canPromote, imageCfg, onUniverseChange,
  onRemoveBucket, onUpdateBucket, onGenerateInBucket, onPromoteVariation,
  onBulkRenderBucket, onRenderVariation, onBulkRenderTrunk,
  onAddBucket,
  onPreviewVariation = null,
  onCanonPreview = null,
  pendingByEntryId = {},
  // Same pending head-map, passed through to UniverseCanonSection so canon
  // rows show a spinner when a batch `/render` queues canon prompts.
  externalPendingByEntryId = null,
  onPendingCleared = null, onJobCompletedForEntry = null,
}) {
  const canonList = Array.isArray(draft[trunk.kind]) ? draft[trunk.kind] : [];
  // Only count canon entries the server will actually compile — mirror the
  // `synthesizeCanonPrompt`-empty-seed skip via `canonEntryHasContent`. Without
  // this, "Bulk-render all (N)" would advertise more images than land, and the
  // server can 400 with WORLD_BUILDER_EMPTY when every entry under the trunk
  // synthesizes to nothing.
  const canonRenderable = canonList.filter((e) => canonEntryHasContent(e, trunk.kind)).length;
  const totalUnderTrunk =
    canonRenderable
    + buckets.reduce((n, k) => n + (draft.categories?.[k]?.variations?.length || 0), 0);
  const [addingBucket, setAddingBucket] = useState(false);
  const [newBucketName, setNewBucketName] = useState('');

  const handleAddBucket = () => {
    const key = normalizeCategoryKey(newBucketName);
    if (!key) {
      toast.error('Use letters or numbers for the bucket name');
      return;
    }
    if (draft.categories?.[key]) {
      toast.error('A bucket with that name already exists');
      return;
    }
    onAddBucket({ key });
    setNewBucketName('');
    setAddingBucket(false);
    setBucket(key);
  };

  return (
    <>
      <section className="bg-port-card border border-port-border rounded p-3 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <BucketChipStrip
            buckets={buckets}
            activeBucket={activeBucket}
            setBucket={setBucket}
            extraChips={canonList.length > 0 ? [{ key: BUCKET_CANON, label: `Canon (${canonList.length})` }] : []}
          />
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              type="button"
              onClick={() => setAddingBucket((v) => !v)}
              className="text-xs px-2 py-1.5 bg-port-bg hover:bg-port-border text-gray-300 border border-port-border rounded flex items-center gap-1 min-h-[32px]"
              title={`Add a sub-bucket under ${trunk.label}`}
            >
              <Plus size={12} /> Bucket
            </button>
            <button
              type="button"
              onClick={onBulkRenderTrunk}
              disabled={!canRender || totalUnderTrunk === 0}
              className="text-xs px-2 py-1.5 bg-port-accent/15 hover:bg-port-accent/25 disabled:opacity-30 disabled:cursor-not-allowed text-port-accent rounded flex items-center gap-1 min-h-[32px]"
              title={totalUnderTrunk === 0 ? `No ${trunk.label.toLowerCase()} to render yet` : `Bulk-render all ${trunk.label.toLowerCase()} — ${totalUnderTrunk} prompt${totalUnderTrunk === 1 ? '' : 's'}`}
            >
              <Sparkles size={12} /> Bulk-render all ({totalUnderTrunk})
            </button>
          </div>
        </div>
        {addingBucket && (
          <div className="flex items-center gap-2 flex-wrap pt-1">
            <input
              type="text"
              value={newBucketName}
              onChange={(e) => setNewBucketName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleAddBucket(); }}
              placeholder={trunk.kind === 'characters' ? 'heroes, villains, factions' : trunk.kind === 'places' ? 'colonies, ruins' : 'weapons, vehicles'}
              className="flex-1 min-w-[160px] bg-port-bg border border-port-border rounded px-2 py-1.5 text-white text-sm focus:outline-none focus:border-port-accent"
              maxLength={WORLD_CATEGORY_KEY_MAX}
              autoFocus
            />
            <button
              onClick={handleAddBucket}
              disabled={!newBucketName.trim()}
              className="text-xs px-2 py-1.5 bg-port-accent hover:bg-port-accent/90 disabled:opacity-50 text-white rounded min-h-[32px]"
            >
              Add
            </button>
            <button
              onClick={() => { setAddingBucket(false); setNewBucketName(''); }}
              className="text-xs px-2 py-1.5 bg-port-bg hover:bg-port-border text-gray-300 rounded min-h-[32px]"
            >
              Cancel
            </button>
          </div>
        )}
      </section>

      {/* Canon visibility: "All" (no bucket selected) or the canon pseudo-bucket.
          Gated on `draft.id === selectedId` to avoid the universe-switch race
          documented on UniverseCanonSection itself. */}
      {(!activeBucket || activeBucket === BUCKET_CANON) && selectedId && draft.id === selectedId ? (
        <UniverseCanonSection
          universe={draft}
          universeId={selectedId}
          onUniverseChange={onUniverseChange}
          imageCfg={imageCfg}
          kindFilter={trunk.kind}
          externalPendingByEntryId={externalPendingByEntryId}
          onExternalCanonJobSettled={onPendingCleared}
          onPreview={onCanonPreview}
        />
      ) : null}

      {activeBucket !== BUCKET_CANON && (
        <>
          {(activeBucket ? [activeBucket] : buckets).length === 0 ? (
            <section className="bg-port-card border border-port-border rounded p-6 text-center text-sm text-gray-500">
              No {trunk.label.toLowerCase()} sub-buckets yet.{' '}
              <button
                type="button"
                onClick={() => setAddingBucket(true)}
                className="text-port-accent hover:underline"
              >
                Add one
              </button>
              {' '}or click <em>Generate From Idea</em> on the Bible tab to seed them.
            </section>
          ) : (
            <section className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {(activeBucket ? [activeBucket] : buckets).map((cat) => (
                <CategoryEditor
                  key={cat}
                  category={cat}
                  variations={draft.categories?.[cat]?.variations || []}
                  canRemove={!WORLD_CATEGORIES.includes(cat)}
                  onChange={(next) => onUpdateBucket(cat, next)}
                  onRemove={() => onRemoveBucket(cat)}
                  canRender={canRender}
                  onRenderCategory={() => onBulkRenderBucket(cat)}
                  onRenderVariation={(v) => onRenderVariation(cat, v)}
                  onGenerate={(count) => onGenerateInBucket(cat, count)}
                  canPromote={canPromote}
                  bucketKind={draft.categories?.[cat]?.kind ?? trunk.kind}
                  onPromote={onPromoteVariation ? (v) => onPromoteVariation(cat, v) : null}
                  onPreviewVariation={onPreviewVariation}
                  pendingByEntryId={pendingByEntryId}
                  onJobCompleted={(entryId, filename, completedJobId) =>
                    onJobCompletedForEntry?.(entryId, filename, cat, completedJobId)}
                  onJobFailed={(entryId, err, failedJobId) => {
                    // Toast BEFORE clearing — clearing removes the
                    // MediaJobThumb from the row and the failure state
                    // disappears with it. Without the toast, a failed
                    // variation render collapses silently to the empty
                    // thumbnail (mirrors UniverseCanonSection.onJobFailed).
                    if (err) toast.error(`Render failed: ${typeof err === 'string' ? err : (err.message || err)}`);
                    onPendingCleared?.(entryId, failedJobId);
                  }}
                />
              ))}
            </section>
          )}
        </>
      )}
    </>
  );
}
// Other tab — un-kinded buckets that haven't been sorted into a trunk yet.
// Same card grid as TrunkView but no canon plumbing, plus an "Auto-sort"
// action that (eventually) LLM-classifies each bucket into the right trunk.
export function OtherTab({
  draft, buckets, activeBucket, setBucket, canRender, canPromote,
  onUpdateBucket, onRemoveBucket, onGenerateInBucket, onPromoteVariation,
  onBulkRenderBucket, onRenderVariation, onAssignBucketKind, onAutoSort,
  autoSorting = false,
  onPreviewVariation = null,
  pendingByEntryId = {}, onPendingCleared = null, onJobCompletedForEntry = null,
}) {
  return (
    <>
      <section className="bg-port-card border border-port-border rounded p-3 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <BucketChipStrip
            buckets={buckets}
            activeBucket={activeBucket}
            setBucket={setBucket}
          />
          <button
            type="button"
            onClick={onAutoSort}
            disabled={autoSorting}
            className="text-xs px-2 py-1.5 bg-port-accent/15 hover:bg-port-accent/25 disabled:opacity-50 text-port-accent rounded flex items-center gap-1 min-h-[32px]"
            title="Auto-sort with AI — sends every Other-tab bucket to the active LLM and assigns each to characters / places / objects"
          >
            {autoSorting ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
            {autoSorting ? 'Sorting…' : 'Auto-sort with AI'}
          </button>
        </div>
        <p className="text-[11px] text-gray-500">
          These buckets aren't tagged as Cast / Places / Objects yet — they were
          either added manually or imported from a pre-Phase-A universe. Auto-sort
          asks the active LLM to classify every bucket into the right trunk.
        </p>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {(activeBucket ? [activeBucket] : buckets).map((cat) => (
          <CategoryEditor
            key={cat}
            category={cat}
            variations={draft.categories?.[cat]?.variations || []}
            canRemove={!WORLD_CATEGORIES.includes(cat)}
            onChange={(next) => onUpdateBucket(cat, next)}
            onRemove={() => onRemoveBucket(cat)}
            canRender={canRender}
            onRenderCategory={() => onBulkRenderBucket(cat)}
            onRenderVariation={(v) => onRenderVariation(cat, v)}
            onGenerate={(count) => onGenerateInBucket(cat, count)}
            canPromote={canPromote}
            bucketKind={draft.categories?.[cat]?.kind}
            onPromote={onPromoteVariation ? (v, opts) => onPromoteVariation(cat, v, opts) : null}
            onAssignBucketKind={onAssignBucketKind ? (targetKind) => onAssignBucketKind(cat, targetKind) : null}
            onPreviewVariation={onPreviewVariation}
            pendingByEntryId={pendingByEntryId}
            onJobCompleted={(entryId, filename, completedJobId) =>
              onJobCompletedForEntry?.(entryId, filename, cat, completedJobId)}
            onJobFailed={(entryId, err, failedJobId) => {
              // Same surface-then-clear order as the Trunk-tab handler above:
              // MediaJobThumb is unmounted on clear, so the toast must fire
              // first or the user gets no signal that the render failed.
              if (err) toast.error(`Render failed: ${typeof err === 'string' ? err : (err.message || err)}`);
              onPendingCleared?.(entryId, failedJobId);
            }}
          />
        ))}
      </section>
    </>
  );
}
