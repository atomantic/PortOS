import { useState } from 'react';
import {
  Images, Loader2, Lock, MessageSquarePlus, Unlock, Wand2, X,
} from 'lucide-react';
import {
  WORLD_LOGLINE_MAX,
  WORLD_PREMISE_MAX,
  WORLD_STYLE_NOTES_MAX,
  ensureInfluences,
} from '../../services/api';
import ProviderModelSelector from '../ProviderModelSelector';
import GalleryImagePicker from '../imageGen/GalleryImagePicker';
import MoodBoardReferenceStrip from '../moodBoard/MoodBoardReferenceStrip';
import StyleProbeImage from '../universe/StyleProbeImage';
import VisionProviderPicker from '../universe/VisionProviderPicker';
import InfluenceChipsInput from './InfluenceChipsInput';

function LockButton({ field, locked, onToggle, label }) {
  const isLocked = !!locked?.[field];
  const Icon = isLocked ? Lock : Unlock;
  return (
    <button
      type="button"
      onClick={() => onToggle(field)}
      className={`p-1 rounded -mr-1 transition-colors ${
        isLocked
          ? 'bg-port-accent/20 text-port-accent ring-1 ring-port-accent/50 hover:bg-port-accent/30'
          : 'text-gray-600 hover:text-gray-300 hover:bg-white/5'
      }`}
      title={isLocked ? `${label} locked — AI refine/expand will skip it` : `Lock ${label} against AI refine/expand`}
      aria-label={isLocked ? `Unlock ${label}` : `Lock ${label}`}
      aria-pressed={isLocked}
    >
      <Icon size={13} />
    </button>
  );
}

// Render a label row with the field name + lock toggle. Used by every
// lockable bible/prompt field so the lock UI stays consistent.
function FieldLabel({ htmlFor, children, field, locked, onToggleLock }) {
  return (
    <div className="flex items-center justify-between gap-2 mb-1">
      <label htmlFor={htmlFor} className="text-xs text-gray-400">{children}</label>
      <LockButton field={field} locked={locked} onToggle={onToggleLock} label={typeof children === 'string' ? children : field} />
    </div>
  );
}

// Style prompt + Negative prompt editor — two parallel chip lists. Embrace
// tokens become the positive style prompt prepended to every render; avoid
// tokens become the negative prompt. Each list locks independently.
function StyleNegativePromptEditor({ influences, onChange, locked, onToggleLock }) {
  const safe = ensureInfluences(influences);
  return (
    <div>
      <div className="mb-1">
        <label className="text-xs text-gray-400">
          Style + Negative prompts <span className="text-gray-600">— prepended to every render; drag to reorder, click × to remove</span>
        </label>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <div className="flex items-center justify-between gap-2 mb-1">
            <div className="text-[11px] uppercase tracking-wide text-port-success/80">Style prompt (embrace)</div>
            <LockButton field="influencesEmbrace" locked={locked} onToggle={onToggleLock} label="Style prompt" />
          </div>
          <InfluenceChipsInput
            tokens={safe.embrace}
            onChange={(next) => onChange({ ...safe, embrace: next })}
            placeholder="moebius linework, cel-shading, dust palette…"
            tone="success"
            readOnly={!!locked?.influencesEmbrace}
          />
        </div>
        <div>
          <div className="flex items-center justify-between gap-2 mb-1">
            <div className="text-[11px] uppercase tracking-wide text-port-error/80">Negative prompt (avoid)</div>
            <LockButton field="influencesAvoid" locked={locked} onToggle={onToggleLock} label="Negative prompt" />
          </div>
          <InfluenceChipsInput
            tokens={safe.avoid}
            onChange={(next) => onChange({ ...safe, avoid: next })}
            placeholder="blurry, lowres, watermark, neon cyberpunk…"
            tone="error"
            readOnly={!!locked?.influencesAvoid}
          />
        </div>
      </div>
    </div>
  );
}

// Universe autocomplete combobox: search existing universes or create one when
// the trimmed query doesn't exactly match any. `onCreate` is wired to a
// dedicated create path (not handleSave) so typing a new name while an existing
// universe is selected never accidentally renames it. The match-or-create UX
// lives in the shared `EntityCombobox`; this thin wrapper maps universes into
// its `{ id, name, subtitle }` item shape and preserves the universe-specific
// labels/ids.
export default function BibleTab({
  draft, updateDraft, toggleLock,
  llm,
  handleExpand, expanding, saving,
  refine,
  totalVariations, categoryKeyCount, totalSheets,
  onPreview,
  onStyleProbeRenderComplete = null,
  styleProbeDirty = false,
}) {
  const { providers, providerModels, providerLabel, activeProviderId } = llm;
  const {
    open: refineOpen, setOpen: setRefineOpen,
    feedback: refineFeedback, setFeedback: setRefineFeedback,
    run: runRefine, running: refining, reset: resetRefinePanel,
    rationale: refineRationale, changes: refineChanges,
    image: refineImage, setImage: setRefineImage,
  } = refine;
  // Local-only: gallery picker visibility for the optional style-reference image.
  const [refineGalleryOpen, setRefineGalleryOpen] = useState(false);
  // Vision provider/model selection, lifted from VisionProviderPicker — which is
  // mounted only when a style-reference image is attached, so the refine runs
  // through a vision-capable API provider (not the universe's default expansion
  // LLM) and the provider fetch is deferred until it's actually needed.
  const [refineVision, setRefineVision] = useState({ providerId: '', model: '', hasProviders: false, noVisionModel: false });
  return (
    <>
      <section className="bg-port-card border border-port-border rounded p-4 flex flex-col gap-3">
        <div className="grid grid-cols-1 md:grid-cols-[1fr_220px] gap-3">
          <div>
            <FieldLabel field="starterPrompt" locked={draft.locked} onToggleLock={toggleLock}>
              Starter idea
            </FieldLabel>
            <textarea
              value={draft.starterPrompt}
              onChange={(e) => updateDraft({ starterPrompt: e.target.value })}
              placeholder="moebius and scavengers reign meets Prophet inspired sci fi universe"
              className="w-full bg-port-bg border border-port-border rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-port-accent"
              rows={2}
            />
          </div>
          <div>
            <p className="text-xs text-gray-400 mb-1 block">LLM for expansion</p>
            {/* The selection here is part of the draft and persisted to the
                server (feeds expand/render), not ephemeral like the Importer —
                so we drive it from `draft.llm` and use only the shared
                component, not useProviderModels' auto-select/load machinery. */}
            <ProviderModelSelector
              providers={providers}
              selectedProviderId={draft.llm?.provider ?? ''}
              selectedModel={draft.llm?.model || ''}
              availableModels={providerModels}
              onProviderChange={(id) => updateDraft({ llm: { ...draft.llm, provider: id || null, model: null } })}
              onModelChange={(m) => updateDraft({ llm: { ...draft.llm, model: m || null } })}
              compact
              label="LLM for expansion"
              layout="stacked"
              emptyProviderOption={`Active provider (${providerLabel(activeProviderId)})`}
              emptyModelOption="Default model"
              alwaysShowModel
            />
          </div>
        </div>

        <MoodBoardReferenceStrip storageKey="universe-builder" />

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={handleExpand}
            disabled={expanding || saving || !draft.starterPrompt?.trim()}
            className="px-3 py-2 bg-port-accent-2/30 hover:bg-port-accent-2/50 disabled:opacity-50 text-port-accent-2 border border-port-accent-2/40 rounded flex items-center gap-2 min-h-[40px]"
          >
            {expanding ? <Loader2 size={16} className="animate-spin" /> : <Wand2 size={16} />}
            Generate From Idea
          </button>
          <button
            onClick={() => setRefineOpen((v) => !v)}
            disabled={!draft.starterPrompt?.trim()}
            aria-expanded={refineOpen}
            className={`px-3 py-2 disabled:opacity-50 text-port-accent border border-port-accent/40 rounded flex items-center gap-2 min-h-[40px] ${
              refineOpen ? 'bg-port-accent/25' : 'bg-port-accent/15 hover:bg-port-accent/25'
            }`}
            title="Give feedback to refine the prompts in place — uses the LLM picked above"
          >
            <MessageSquarePlus size={16} />
            Refine prompts
          </button>
          <span className="text-xs text-gray-500">
            {totalVariations} variation{totalVariations === 1 ? '' : 's'} across {categoryKeyCount} categories · {totalSheets} composite board{totalSheets === 1 ? '' : 's'}
          </span>
        </div>

        {refineOpen && (
          <div className="border border-port-accent/40 bg-port-accent/5 rounded p-3 flex flex-col gap-2">
            <label htmlFor="world-refine-feedback" className="text-[11px] uppercase tracking-wide text-gray-500">
              Feedback — describe what you want changed
            </label>
            <textarea
              id="world-refine-feedback"
              value={refineFeedback}
              onChange={(e) => setRefineFeedback(e.target.value)}
              placeholder="e.g. lean grimmer and more spiritual; pull style toward Moebius + Tarkovsky; avoid neon and cyberpunk clichés."
              rows={3}
              disabled={refining}
              className="w-full bg-port-bg border border-port-border rounded p-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-port-accent resize-y disabled:opacity-60"
            />
            {/* Optional visual style reference from the gallery — when set, the
                server refines through a vision-capable API provider. */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] uppercase tracking-wide text-gray-500">Style reference (optional)</span>
              {refineImage ? (
                <div className="relative w-14 h-14">
                  <img
                    src={refineImage.preview || `/data/images/${encodeURIComponent(refineImage.filename)}`}
                    alt="style reference"
                    className="w-full h-full object-cover rounded border border-port-border"
                  />
                  <button
                    type="button"
                    onClick={() => setRefineImage(null)}
                    title="Remove reference image"
                    aria-label="Remove reference image"
                    className="absolute -top-1.5 -right-1.5 bg-port-bg border border-port-border rounded-full p-0.5 text-gray-400 hover:text-port-error"
                  >
                    <X size={11} />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setRefineGalleryOpen(true)}
                  disabled={refining}
                  className="px-2.5 py-1.5 text-xs text-port-accent border border-port-accent/40 rounded flex items-center gap-1.5 hover:bg-port-accent/10 disabled:opacity-50"
                >
                  <Images size={14} />
                  Pick from gallery
                </button>
              )}
              {refineImage ? (
                <span className="text-[11px] text-gray-500">Folds the image's palette/mood into influences + style notes.</span>
              ) : null}
            </div>
            {/* Vision provider/model picker — only when an image is attached, since
                the server forces a vision-capable API provider for image refine.
                Mounting it conditionally also defers its provider fetch. */}
            {refineImage ? (
              <VisionProviderPicker label="Vision provider (for image refine)" onChange={setRefineVision} />
            ) : null}
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => runRefine(refineImage
                  ? { providerId: refineVision.providerId, model: refineVision.model }
                  : null)}
                disabled={refining || !refineFeedback.trim() || !draft.starterPrompt?.trim() || (!!refineImage && !refineVision.model)}
                className="px-3 py-2 bg-port-accent hover:bg-port-accent/90 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded flex items-center gap-2 min-h-[40px]"
              >
                {refining ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
                {refining ? 'Refining…' : 'Refine'}
              </button>
              <button
                type="button"
                onClick={resetRefinePanel}
                disabled={refining}
                className="px-3 py-2 text-sm text-gray-400 hover:text-white rounded min-h-[40px]"
              >
                Close
              </button>
              <span className="text-[11px] text-gray-500">
                Applies in place — locked fields stay pinned.
              </span>
            </div>
            {(refineRationale || refineChanges.length > 0) && (
              <div className="border-t border-port-border/60 pt-2 mt-1 space-y-1.5">
                {refineRationale && (
                  <p className="text-xs text-gray-300 whitespace-pre-wrap">{refineRationale}</p>
                )}
                {refineChanges.length > 0 && (
                  <ul className="text-[11px] text-gray-400 list-disc pl-5 space-y-0.5">
                    {refineChanges.map((c, idx) => (
                      <li key={idx}>{c}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <GalleryImagePicker
              open={refineGalleryOpen}
              onClose={() => setRefineGalleryOpen(false)}
              onSelect={(item) => {
                if (item?.filename) setRefineImage({ filename: item.filename, preview: item.previewUrl });
              }}
            />
          </div>
        )}
      </section>

      <section className="bg-port-card border border-port-border rounded p-4 flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-semibold text-white">Story bible</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Pulled into the Pipeline → New Series form when this world is selected.
          </p>
        </div>
        <div>
          <FieldLabel htmlFor="world-logline" field="logline" locked={draft.locked} onToggleLock={toggleLock}>
            Logline
          </FieldLabel>
          <input
            id="world-logline"
            type="text"
            value={draft.logline || ''}
            onChange={(e) => updateDraft({ logline: e.target.value })}
            placeholder="One-sentence hook — A foundry city goes silent, and the only survivor is a child."
            className="w-full bg-port-bg border border-port-border rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-port-accent"
            maxLength={WORLD_LOGLINE_MAX}
          />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <FieldLabel htmlFor="world-premise" field="premise" locked={draft.locked} onToggleLock={toggleLock}>
              Premise
            </FieldLabel>
            <textarea
              id="world-premise"
              value={draft.premise || ''}
              onChange={(e) => updateDraft({ premise: e.target.value })}
              placeholder="Elevator pitch — 1-3 short paragraphs about the setting, central conflict, stakes, and tone."
              className="w-full bg-port-bg border border-port-border rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-port-accent"
              rows={6}
              maxLength={WORLD_PREMISE_MAX}
            />
          </div>
          <div>
            <FieldLabel htmlFor="world-style-notes" field="styleNotes" locked={draft.locked} onToggleLock={toggleLock}>
              Style notes
            </FieldLabel>
            <textarea
              id="world-style-notes"
              value={draft.styleNotes || ''}
              onChange={(e) => updateDraft({ styleNotes: e.target.value })}
              placeholder="Narrative style: references (artists / films / comics), mood, palette, pacing, voice. Prose, not tokens."
              className="w-full bg-port-bg border border-port-border rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-port-accent"
              rows={6}
              maxLength={WORLD_STYLE_NOTES_MAX}
            />
          </div>
        </div>
        <StyleNegativePromptEditor
          influences={draft.influences}
          onChange={(next) => updateDraft({ influences: next })}
          locked={draft.locked}
          onToggleLock={toggleLock}
        />
        <div className="mt-4 pt-4 border-t border-port-border">
          {/* StyleProbeImage persists styleImageRefs server-side itself; merge
              only that field into the draft so unsaved style edits aren't lost.
              `styleDirty` blocks the render while influences have unsaved edits —
              otherwise the probe pins to a saved record that lacks that style. */}
          {/* The probe's in-flight render state (the EntryThumbSlot spinner +
              the async completion handler) is scoped to one universe by
              `useSingleImageRender`'s `scopeId` (the universe id), so this stays
              mounted across a `/universes/:id` switch WITHOUT a `key` remount —
              no per-switch settings refetch, and switching back resumes a
              still-running render instead of abandoning its completion. */}
          <StyleProbeImage
            universe={draft}
            onUniverseChange={(updated) => updateDraft({ styleImageRefs: updated?.styleImageRefs || [] })}
            onPreview={onPreview}
            onRenderComplete={() => onStyleProbeRenderComplete?.()}
            styleDirty={styleProbeDirty}
          />
        </div>
      </section>
    </>
  );
}

// Sub-bucket chip strip used by TrunkView + OtherTab. The "All" chip is a
// pseudo-bucket that clears `?bucket=`. Each real bucket key gets its own
// chip; clicking toggles it on/off (toggle-off returns to All). Designed so
// it works one-handed on mobile (38px tap targets, wraps to multiple lines).
// Per-trunk view. Three modes driven by `?bucket=`:
//   - blank (default "All"): renders canon + every variation under this trunk
//   - BUCKET_CANON: renders only canon entries (via the existing UniverseCanonSection)
//   - <bucketKey>: renders that bucket's variations via CategoryEditor
