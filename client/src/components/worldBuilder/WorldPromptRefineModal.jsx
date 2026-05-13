import { useEffect, useMemo, useState } from 'react';
import { Check, Lock, Minus, Plus, Sparkles, Wand2, X } from 'lucide-react';
import ProviderModelSelector from '../ProviderModelSelector';
import toast from '../ui/Toast';
import useProviderModels from '../../hooks/useProviderModels';
import {
  refineWorldPrompts, WORLD_LOCKABLE_FIELDS, ensureInfluences, isInfluenceLockField, normalizeLabelKey,
} from '../../services/api';
import InfluenceChipsInput from './InfluenceChipsInput';

/**
 * Refines world fields (bible + influences) and, when the world has been
 * expanded, also the structure (categories + composite sheets) based on user
 * feedback. Mirrors PromptRefineModal's shape — feedback box, provider/model
 * selector, refined-fields review, then apply.
 *
 * Locked fields / locked variations / locked composites are preserved
 * server-side; the modal renders them as read-only and never applies a change
 * to a locked entity. Locked influence lists are append-only in this path
 * (server may add new tokens; existing ones round-trip in order).
 */

const FIELD_LABELS = {
  starterPrompt: 'Starter idea',
  stylePrompt: 'Style prompt',
  negativePrompt: 'Negative prompt',
  logline: 'Logline',
  premise: 'Premise',
  styleNotes: 'Style notes',
};

// Multi-line fields use a textarea with per-field row counts (logline gets a
// single-line input via rows=0). Influences uses its own chip renderer.
const FIELD_ROWS = {
  starterPrompt: 4,
  stylePrompt: 4,
  negativePrompt: 3,
  logline: 0,
  premise: 6,
  styleNotes: 6,
};

const emptyInfluences = () => ({ embrace: [], avoid: [] });

export default function WorldPromptRefineModal({
  open,
  onClose,
  onApply,
  starterPrompt = '',
  stylePrompt = '',
  negativePrompt = '',
  logline = '',
  premise = '',
  styleNotes = '',
  influences = emptyInfluences(),
  // Post-Expand world structure — when present, the refiner sees and may
  // edit categories + composite sheets alongside the bible. Pre-Expand drafts
  // pass null/empty and the modal degrades to bible-only mode.
  categories = null,
  compositeSheets = null,
  locked = {},
  // Optional pre-selected provider/model — when a world already pins an LLM
  // for expansion, default the refiner to the same combo so the user doesn't
  // have to re-pick.
  defaultProviderId = null,
  defaultModel = null,
}) {
  const {
    providers,
    selectedProviderId,
    selectedModel,
    availableModels,
    setSelectedProviderId,
    setSelectedModel,
    loading: providersLoading,
  } = useProviderModels();

  // Memoized so child components receive a stable ref across renders. Without
  // this, every keystroke in the feedback box rebuilt `originals.influences`
  // and forced ReadOnlyInfluences / RefinedInfluences to re-render unnecessarily.
  const originals = useMemo(() => ({
    starterPrompt, stylePrompt, negativePrompt, logline, premise, styleNotes,
    influences: ensureInfluences(influences),
    categories: categories && typeof categories === 'object' ? categories : {},
    compositeSheets: Array.isArray(compositeSheets) ? compositeSheets : [],
  }), [starterPrompt, stylePrompt, negativePrompt, logline, premise, styleNotes, influences, categories, compositeSheets]);

  // Pre-Expand drafts have starter category buckets in `originals.categories`
  // (the WorldBuilder seeds them as empty objects so the UI can render the
  // category editor), so checking `Object.keys.length > 0` would always be
  // true and force the structure-aware path before the user has generated
  // any actual variations. Count real variations instead.
  const hasStructure = useMemo(() => (
    Object.values(originals.categories).some((cat) => (cat?.variations || []).length > 0)
    || originals.compositeSheets.length > 0
  ), [originals.categories, originals.compositeSheets]);

  const [feedback, setFeedback] = useState('');
  const [refined, setRefined] = useState({});
  const [rationale, setRationale] = useState('');
  const [changes, setChanges] = useState([]);
  const [refining, setRefining] = useState(false);

  // Reset transient state every time the modal is re-opened so a previous
  // refinement doesn't leak into a new session.
  useEffect(() => {
    if (!open) return;
    setFeedback('');
    setRefined({});
    setRationale('');
    setChanges([]);
  }, [open]);

  // Seed the provider/model picker from the world's stored LLM choice the
  // first time it becomes available — but never clobber an in-flight user
  // selection.
  useEffect(() => {
    if (!open) return;
    if (defaultProviderId && !selectedProviderId) {
      setSelectedProviderId(defaultProviderId);
      if (defaultModel) setSelectedModel(defaultModel);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultProviderId, defaultModel]);

  if (!open) return null;

  const allTopLocked = WORLD_LOCKABLE_FIELDS.every((k) => locked[k]);
  // The button stays enabled when there's *any* category variation or composite
  // sheet present — the holistic refine flow can still tune unlocked structure
  // items even if every top-level bible field is locked. Reuse the memoized
  // hasStructure (counts real variations, not just category-key presence).
  const allLocked = allTopLocked && !hasStructure;
  const hasResult = Object.keys(refined).length > 0 || rationale !== '';
  const canRefine = feedback.trim() && starterPrompt.trim() && selectedProviderId && !refining && !allLocked;
  const canApply = hasResult && (refined.starterPrompt || '').trim();

  const runRefine = async () => {
    if (!canRefine) return;
    setRefining(true);
    setRefined({});
    setRationale('');
    setChanges([]);
    const result = await refineWorldPrompts({
      ...originals,
      // Empty structure → server reverts to bible-only refine.
      categories: hasStructure ? originals.categories : undefined,
      compositeSheets: hasStructure ? originals.compositeSheets : undefined,
      locked,
      feedback: feedback.trim(),
      providerId: selectedProviderId,
      model: selectedModel || undefined,
    }).catch(() => null); // services/apiCore#request already toasts on errors.
    setRefining(false);
    if (!result) return;
    const next = {};
    for (const key of WORLD_LOCKABLE_FIELDS) {
      if (isInfluenceLockField(key)) continue;
      next[key] = result[key] ?? '';
    }
    next.influences = ensureInfluences(result.influences);
    if (result.categories && typeof result.categories === 'object') {
      next.categories = result.categories;
    }
    if (Array.isArray(result.compositeSheets)) {
      next.compositeSheets = result.compositeSheets;
    }
    setRefined(next);
    setRationale(result.rationale || '');
    setChanges(Array.isArray(result.changes) ? result.changes : []);
  };

  const setRefinedField = (key, value) => setRefined((prev) => ({ ...prev, [key]: value }));

  const handleApply = () => {
    if (!canApply) return;
    // Only emit unlocked fields — the server already enforces this, but
    // belt-and-suspenders prevents a stale lock-toggle race from clobbering
    // a pinned value. Influences uses per-list locks: build the new object
    // by picking originals for locked lists and refined for unlocked.
    const patch = {};
    for (const key of WORLD_LOCKABLE_FIELDS) {
      if (isInfluenceLockField(key)) continue;
      if (locked[key]) continue;
      patch[key] = (refined[key] ?? '').trim();
    }
    const refinedInf = ensureInfluences(refined.influences);
    const origInf = originals.influences;
    // Locked lists are append-only server-side (returned list always contains
    // locked tokens in order). Unlocked lists may be cleared by the LLM in
    // response to feedback like "drop all influences" — apply the empty list
    // when it's an explicit decision rather than an omission. `refined` only
    // carries `influences` when the server actually returned one, so a missing
    // key here means "no change" and falls back to the originals.
    const refinedHasInfluences = Object.prototype.hasOwnProperty.call(refined, 'influences');
    if (refinedHasInfluences) {
      patch.influences = {
        embrace: locked.influencesEmbrace && refinedInf.embrace.length === 0 ? origInf.embrace : refinedInf.embrace,
        avoid: locked.influencesAvoid && refinedInf.avoid.length === 0 ? origInf.avoid : refinedInf.avoid,
      };
    }
    // Server already enforced per-item locks before returning these.
    if (refined.categories) patch.categories = refined.categories;
    if (refined.compositeSheets) patch.compositeSheets = refined.compositeSheets;
    onApply(patch);
    toast.success('Refined world applied');
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[70] bg-black/80 flex items-center justify-center p-4"
      onClick={onClose}
      role="presentation"
    >
      <section
        className="w-full max-w-3xl max-h-[90vh] overflow-hidden bg-port-card border border-port-border rounded-xl shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="world-refine-title"
      >
        <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-port-border">
          <div className="flex items-center gap-2 min-w-0">
            <Sparkles className="w-4 h-4 text-port-accent shrink-0" />
            <h2 id="world-refine-title" className="text-sm font-semibold text-white">
              {hasStructure ? 'Refine world' : 'Refine world prompts'}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded text-gray-400 hover:text-white hover:bg-port-border/50"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <p className="text-xs text-gray-400">
            Describe what you want the world to feel like — story tone, era, art-direction
            references, what to avoid. The LLM rewrites your starter, prompts, and bible
            fields{hasStructure ? ', plus categories + composite sheets,' : ''} to match.
            Locked fields and locked items stay untouched (locked influence lists are
            preserved in order but may gain new tokens). Review the result before applying.
          </p>

          {/* Originals — read-only preview so the user remembers what's about
              to change. Lock indicator surfaces which fields the LLM will skip. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
            {WORLD_LOCKABLE_FIELDS.filter((k) => !isInfluenceLockField(k)).map((key) => (
              <ReadOnlyField
                key={key}
                label={FIELD_LABELS[key]}
                value={originals[key]}
                locked={!!locked[key]}
              />
            ))}
            <ReadOnlyInfluences
              label="Influences"
              value={originals.influences}
              lockedEmbrace={!!locked.influencesEmbrace}
              lockedAvoid={!!locked.influencesAvoid}
            />
          </div>

          {allLocked && (
            <p className="text-xs text-port-warning">
              All fields are locked — unlock at least one to enable refinement.
            </p>
          )}

          <div>
            <label htmlFor="world-refine-feedback" className="block text-[11px] uppercase tracking-wide text-gray-500 mb-1">
              Feedback
            </label>
            <textarea
              id="world-refine-feedback"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="e.g. lean grimmer and more spiritual; pull style toward Moebius + Tarkovsky; avoid neon and cyberpunk clichés."
              rows={4}
              className="w-full bg-port-bg border border-port-border rounded-lg p-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-port-accent resize-y"
            />
          </div>

          <ProviderModelSelector
            providers={providers}
            selectedProviderId={selectedProviderId}
            selectedModel={selectedModel}
            availableModels={availableModels}
            onProviderChange={setSelectedProviderId}
            onModelChange={setSelectedModel}
            label="LLM Provider"
            disabled={providersLoading || refining}
          />

          {providers.length === 0 && !providersLoading && (
            <p className="text-xs text-port-warning">No enabled providers are configured.</p>
          )}

          {!starterPrompt.trim() && (
            <p className="text-xs text-port-warning">
              Add a starter idea on the world first — there's nothing for the LLM to refine.
            </p>
          )}

          <button
            type="button"
            onClick={runRefine}
            disabled={!canRefine}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-accent text-white text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90"
          >
            <Wand2 className="w-4 h-4" />
            {refining ? 'Refining…' : (hasResult ? 'Refine again' : 'Refine prompts')}
          </button>

          {hasResult && (
            <div className="space-y-4">
              {rationale && (
                <p className="text-sm text-gray-300 bg-port-bg border border-port-border rounded-lg p-3">
                  {rationale}
                </p>
              )}

              {changes.length > 0 && (
                <ul className="text-xs text-gray-400 list-disc pl-5 space-y-0.5">
                  {changes.map((c, idx) => (
                    <li key={`${c.slice(0, 24)}-${idx}`}>{c}</li>
                  ))}
                </ul>
              )}

              {WORLD_LOCKABLE_FIELDS.filter((k) => !isInfluenceLockField(k)).map((key) => (
                <RefinedField
                  key={key}
                  label={`New ${FIELD_LABELS[key].toLowerCase()}`}
                  value={refined[key] ?? ''}
                  onChange={(v) => setRefinedField(key, v)}
                  rows={FIELD_ROWS[key]}
                  locked={!!locked[key]}
                />
              ))}
              <RefinedInfluences
                label="New influences"
                value={ensureInfluences(refined.influences)}
                onChange={(v) => setRefinedField('influences', v)}
                lockedEmbrace={!!locked.influencesEmbrace}
                lockedAvoid={!!locked.influencesAvoid}
              />
              {(refined.categories || refined.compositeSheets) && (
                <StructureDiff
                  originalCategories={originals.categories}
                  refinedCategories={refined.categories}
                  originalComposites={originals.compositeSheets}
                  refinedComposites={refined.compositeSheets}
                />
              )}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 px-4 py-3 border-t border-port-border">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-2 rounded-lg text-sm text-gray-300 hover:text-white hover:bg-port-border/50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={!canApply}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-success text-white text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90"
          >
            <Check className="w-4 h-4" />
            Apply to world
          </button>
        </footer>
      </section>
    </div>
  );
}

function ReadOnlyField({ label, value, locked }) {
  return (
    <div className={`bg-port-bg border rounded p-2 ${locked ? 'border-port-accent/40' : 'border-port-border'}`}>
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
        {locked && (
          <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-port-accent">
            <Lock className="w-3 h-3" /> Locked
          </span>
        )}
      </div>
      <div className="text-[11px] text-gray-300 line-clamp-4 whitespace-pre-wrap">
        {value?.trim() ? value : <span className="text-gray-600">(empty)</span>}
      </div>
    </div>
  );
}

function ReadOnlyInfluences({ label, value, lockedEmbrace, lockedAvoid }) {
  const hasAny = value.embrace.length || value.avoid.length;
  const anyLocked = lockedEmbrace || lockedAvoid;
  return (
    <div className={`bg-port-bg border rounded p-2 sm:col-span-2 ${anyLocked ? 'border-port-accent/40' : 'border-port-border'}`}>
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-port-accent">
          {lockedEmbrace && <span className="inline-flex items-center gap-1"><Lock className="w-3 h-3" /> Embrace</span>}
          {lockedAvoid && <span className="inline-flex items-center gap-1"><Lock className="w-3 h-3" /> Avoid</span>}
        </div>
      </div>
      {hasAny ? (
        <div className="grid grid-cols-2 gap-2">
          <InfluenceChipsInput tokens={value.embrace} onChange={() => {}} tone="success" readOnly />
          <InfluenceChipsInput tokens={value.avoid} onChange={() => {}} tone="error" readOnly />
        </div>
      ) : (
        <div className="text-[11px] text-gray-600">(empty)</div>
      )}
    </div>
  );
}

function RefinedInfluences({ label, value, onChange, lockedEmbrace, lockedAvoid }) {
  const lockBadge = (
    <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-port-accent">
      <Lock className="w-3 h-3" /> Kept as-is
    </span>
  );
  return (
    <div>
      <label className="block text-[11px] uppercase tracking-wide text-gray-500 mb-1">{label}</label>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <div>
          <div className="flex items-center justify-between gap-2 mb-1">
            <div className="text-[10px] uppercase tracking-wide text-port-success/80">Embrace</div>
            {lockedEmbrace && lockBadge}
          </div>
          <InfluenceChipsInput
            tokens={value.embrace}
            onChange={(next) => onChange({ ...value, embrace: next })}
            tone="success"
            readOnly={lockedEmbrace}
          />
        </div>
        <div>
          <div className="flex items-center justify-between gap-2 mb-1">
            <div className="text-[10px] uppercase tracking-wide text-port-error/80">Avoid</div>
            {lockedAvoid && lockBadge}
          </div>
          <InfluenceChipsInput
            tokens={value.avoid}
            onChange={(next) => onChange({ ...value, avoid: next })}
            tone="error"
            placeholder="Add avoid token, press Enter"
            readOnly={lockedAvoid}
          />
        </div>
      </div>
    </div>
  );
}

function diffItems(orig, fresh) {
  const origByKey = new Map(orig.map((i) => [normalizeLabelKey(i.label), i]));
  const freshByKey = new Map(fresh.map((i) => [normalizeLabelKey(i.label), i]));
  const rows = [];
  for (const item of fresh) {
    const prev = origByKey.get(normalizeLabelKey(item.label));
    if (!prev) {
      rows.push({ status: 'added', current: item });
    } else if (prev.locked) {
      rows.push({ status: 'locked', current: prev });
    } else if (prev.prompt === item.prompt) {
      rows.push({ status: 'unchanged', current: item });
    } else {
      rows.push({ status: 'changed', current: item, previous: prev });
    }
  }
  for (const item of orig) {
    if (!freshByKey.has(normalizeLabelKey(item.label))) {
      rows.push({ status: 'removed', current: item });
    }
  }
  return rows;
}

const DIFF_ACCENTS = {
  added: 'border-port-success/40 bg-port-success/5',
  removed: 'border-port-error/40 bg-port-error/5',
  changed: 'border-port-accent/40 bg-port-accent/5',
  locked: 'border-port-accent/20 bg-port-bg',
  unchanged: 'border-port-border bg-port-bg',
};

const DIFF_BADGES = {
  added: <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-port-success"><Plus className="w-3 h-3" /> Added</span>,
  removed: <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-port-error"><Minus className="w-3 h-3" /> Removed</span>,
  changed: <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-port-accent">Changed</span>,
  locked: <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-port-accent"><Lock className="w-3 h-3" /> Locked</span>,
  unchanged: <span className="text-[10px] uppercase tracking-wide text-gray-500">Unchanged</span>,
};

function DiffRow({ status, current, previous }) {
  return (
    <div className={`border rounded p-2 ${DIFF_ACCENTS[status]}`}>
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="text-xs font-medium text-white truncate">{current.label}</div>
        {DIFF_BADGES[status]}
      </div>
      {status === 'changed' && (
        <div className="text-[11px] text-gray-500 whitespace-pre-wrap line-clamp-2 line-through">
          {previous.prompt}
        </div>
      )}
      <div className={`text-[11px] whitespace-pre-wrap ${status === 'removed' ? 'text-gray-500 line-through' : 'text-gray-300'}`}>
        {current.prompt}
      </div>
    </div>
  );
}

function StructureDiff({ originalCategories, refinedCategories, originalComposites, refinedComposites }) {
  const catKeys = useMemo(() => {
    const keys = new Set([
      ...Object.keys(originalCategories || {}),
      ...Object.keys(refinedCategories || {}),
    ]);
    return Array.from(keys).sort();
  }, [originalCategories, refinedCategories]);

  return (
    <div className="space-y-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-gray-400">
        Structure changes
      </div>
      {catKeys.map((key) => {
        const orig = originalCategories?.[key]?.variations || [];
        const fresh = refinedCategories?.[key]?.variations || [];
        const rows = diffItems(orig, fresh);
        if (!rows.length) return null;
        return (
          <div key={key} className="border border-port-border rounded-lg p-2 bg-port-bg/50">
            <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-2">{key}</div>
            <div className="space-y-1.5">
              {rows.map((r, i) => (
                <DiffRow key={`${key}-${r.current.label}-${i}`} {...r} />
              ))}
            </div>
          </div>
        );
      })}
      {(originalComposites?.length || refinedComposites?.length) > 0 && (
        <div className="border border-port-border rounded-lg p-2 bg-port-bg/50">
          <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-2">composite sheets</div>
          <div className="space-y-1.5">
            {diffItems(originalComposites || [], refinedComposites || []).map((r, i) => (
              <DiffRow key={`comp-${r.current.label}-${i}`} {...r} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function RefinedField({ label, value, onChange, rows, locked }) {
  // Locked fields render as a disabled read-only preview — a visible reminder
  // that the LLM was told to skip them and the value the user pinned is
  // intact. We hide them when there's no value rather than showing "(empty)"
  // because there's nothing to confirm.
  if (locked) {
    return (
      <div>
        <div className="flex items-center justify-between gap-2 mb-1">
          <label className="block text-[11px] uppercase tracking-wide text-gray-500">{label}</label>
          <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-port-accent">
            <Lock className="w-3 h-3" /> Locked — kept as-is
          </span>
        </div>
        <div className="w-full bg-port-bg/60 border border-port-accent/40 rounded-lg p-3 text-sm text-gray-400 whitespace-pre-wrap">
          {value?.trim() ? value : <span className="text-gray-600">(empty)</span>}
        </div>
      </div>
    );
  }
  // Single-line fields (rows = 0) render as inputs so logline doesn't get a
  // multi-line textarea for one sentence.
  if (!rows || rows < 2) {
    return (
      <div>
        <label className="block text-[11px] uppercase tracking-wide text-gray-500 mb-1">{label}</label>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-port-bg border border-port-border rounded-lg p-3 text-sm text-white focus:outline-none focus:border-port-accent"
        />
      </div>
    );
  }
  return (
    <div>
      <label className="block text-[11px] uppercase tracking-wide text-gray-500 mb-1">{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        className="w-full bg-port-bg border border-port-border rounded-lg p-3 text-sm text-white focus:outline-none focus:border-port-accent resize-y"
      />
    </div>
  );
}
