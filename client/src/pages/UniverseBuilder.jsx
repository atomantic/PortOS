/**
 * Universe Builder page (Media Gen → Universe Builder).
 *
 * Lets the user describe a universe in one starter prompt, expand it into a
 * full set of style + per-category variation prompts via the LLM of their
 * choice, edit/save the template, and kick off a batch of image renders
 * that all land in a single auto-named collection.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Globe2, Plus, Trash2, Sparkles, Wand2, Loader2, Save, FolderOpen,
  Edit3, X, MessageSquarePlus, Play, Lock, Unlock,
  PanelLeftClose, PanelLeftOpen,
} from 'lucide-react';
import toast from '../components/ui/Toast';
import {
  listUniverses, getUniverse, createUniverse, updateUniverse, deleteUniverse, expandUniverse,
  generateCategoryVariations,
  renderWorld, listWorldRuns, getProviders, refineWorldPrompts, WORLD_CATEGORIES,
  WORLD_CATEGORY_KEY_MAX, COMPOSITE_PROMPT_MAX, WORLD_LOGLINE_MAX,
  WORLD_PREMISE_MAX, WORLD_STYLE_NOTES_MAX, WORLD_LOCKABLE_FIELDS,
  WORLD_INFLUENCE_ENTRY_MAX, WORLD_INFLUENCES_PER_LIST_MAX,
  ensureInfluences, isInfluenceLockField, mergeInfluencesWithLocks,
  listImageModels, getSettings,
} from '../services/api';
import useClickOutside from '../hooks/useClickOutside';
import { useLocalStorageBool, useLocalStoragePersisted } from '../hooks/useLocalStorageBool';
import InfluenceChipsInput from '../components/universeBuilder/InfluenceChipsInput';
import BackendChipStrip from '../components/media/BackendChipStrip';
import ImageGenControls from '../components/imageGen/ImageGenControls';
import ShareToButton from '../components/sharing/ShareToButton';
import OriginBadge from '../components/sharing/OriginBadge';
import UniverseCanonSection from '../components/universe/UniverseCanonSection';
import { deriveAvailableBackends, IMAGE_GEN_MODE } from '../lib/imageGenBackends';
import { PIPELINE_IMAGE_DEFAULTS, readPipelineImageSettings } from '../lib/pipelineImageDefaults';

const CATEGORY_LABELS = {
  landscapes: 'Landscapes',
  environments: 'Environments',
  structures: 'Structures',
  vehicles: 'Vehicles',
};

const normalizeCategoryKey = (raw) => (raw || '')
  .trim()
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '')
  .replace(/_{2,}/g, '_')
  .slice(0, WORLD_CATEGORY_KEY_MAX);

// Merge `fresh` items after `existing`, case-insensitively deduping by label.
// Used by both Expand (locked + LLM result) and per-category Generate (current
// + LLM additions); pinned/existing entries keep their slot at the top.
// Rows with a missing/non-string label (older universes pre-rename, partial
// LLM payloads) are dropped from both sides — keeping them in `merged` while
// excluding from the dedup Set would let a fresh row with the same missing
// label silently duplicate.
const mergeVariations = (existing, fresh) => {
  const merged = [];
  const seen = new Set();
  for (const v of [...(existing || []), ...(fresh || [])]) {
    const key = v?.label?.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(v);
  }
  return merged;
};

const humanizeCategory = (key) => CATEGORY_LABELS[key]
  || key.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());

const ensureDraftCategories = (categories = {}) => ({
  ...Object.fromEntries(WORLD_CATEGORIES.map((c) => [c, { variations: [] }])),
  ...(categories || {}),
});

const getCategoryKeys = (categories = {}) => {
  const seen = new Set();
  const keys = [];
  for (const key of [...WORLD_CATEGORIES, ...Object.keys(categories || {})]) {
    const normalized = normalizeCategoryKey(key);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    keys.push(normalized);
  }
  return keys;
};

// Default per-render knobs. Mirrors the Image Gen page's default chip.
const DEFAULT_RENDER_OPTS = {
  width: 1024,
  height: 1024,
  steps: 30,
  guidance: '',
  cfgScale: 7,
  quantize: '8',
  modelId: '',
  mode: '',
  promptMode: 'variations',
  batchPerVariation: 1,
};

// Mirror of COMPOSITE_SHEET_KINDS in server/services/universeBuilder.js — keep
// in sync when adding kinds.
const COMPOSITE_BOARD_KINDS = [
  { value: 'reference_sheet', label: 'Reference sheet' },
  { value: 'world_pitch_poster', label: 'World pitch poster' },
];

const compositeKindLabel = (kind) => COMPOSITE_BOARD_KINDS.find((k) => k.value === kind)?.label || 'Reference sheet';

const emptyTemplate = () => ({
  name: '',
  starterPrompt: '',
  logline: '',
  premise: '',
  styleNotes: '',
  categories: ensureDraftCategories(),
  compositeSheets: [],
  influences: { embrace: [], avoid: [] },
  locked: {},
  llm: { provider: null, model: null },
});


// Renders a small lock-toggle button to the right of a field label. The user
// clicks it to pin a field against AI refinement/expansion. The icon flips
// between locked (filled) and unlocked (outline) to make state obvious.
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

export default function UniverseBuilder() {
  // The selected world id lives in the URL so deep-linking + back/forward
  // work. The page is mounted at /universe-builder, /universe-builder/:universeId,
  // and /media/universe-builder(/:universeId) — strip any trailing /<id> off the
  // current pathname to derive the base for navigation back to the list.
  const params = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const selectedId = params.universeId || null;
  const basePath = location.pathname.replace(/\/universe-builder(?:\/.*)?$/, '/universe-builder');
  const goToWorld = (id) => navigate(id ? `${basePath}/${encodeURIComponent(id)}` : basePath);

  const [universes, setWorlds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [expanding, setExpanding] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [providers, setProviders] = useState([]);
  const [activeProviderId, setActiveProviderId] = useState(null);
  // Image-gen plumbing for the batch-render form (reused from Image Gen).
  const [imageModels, setImageModels] = useState([]);
  const [availableBackends, setAvailableBackends] = useState([]);
  const [defaultMode, setDefaultMode] = useState(null);
  // Per-render config used by the embedded Canon section for reference
  // renders (size, steps, etc.). Derived from the same settings fetch as the
  // batch-render plumbing above so we don't round-trip getSettings() twice.
  const [imageCfg, setImageCfg] = useState(PIPELINE_IMAGE_DEFAULTS);

  // The draft is the editable copy of the currently-selected world. New
  // universes start as a draft with no id; saving creates the persisted record.
  const [draft, setDraft] = useState(emptyTemplate());
  const [newCategoryName, setNewCategoryName] = useState('');

  // Per-page render knobs. Persisted to localStorage so the user's
  // preferred batch size sticks across visits.
  // useLocalStoragePersisted handles JSON round-trip + parse-failure fallback.
  // The `parse` hook spreads DEFAULT_RENDER_OPTS under the saved object so a
  // shape change (new field added to DEFAULT_RENDER_OPTS) populates that
  // field without nuking the user's saved batch-size / cadence preferences.
  const [renderOpts, setRenderOpts] = useLocalStoragePersisted(
    'universeBuilder.renderOpts',
    DEFAULT_RENDER_OPTS,
    { parse: (raw) => ({ ...DEFAULT_RENDER_OPTS, ...(raw || {}) }) },
  );

  const [runs, setRuns] = useState([]);

  // Two-click delete: first click flips this to the world id; a second
  // click within the live render confirms. Avoids window.confirm per
  // CLAUDE.md UI Patterns.
  const [pendingDeleteId, setPendingDeleteId] = useState(null);

  const [refineOpen, setRefineOpen] = useState(false);
  const [refineFeedback, setRefineFeedback] = useState('');
  const [refining, setRefining] = useState(false);
  const [refineRationale, setRefineRationale] = useState('');
  const [refineChanges, setRefineChanges] = useState([]);

  const resetRefinePanel = () => {
    setRefineOpen(false);
    setRefineFeedback('');
    setRefineRationale('');
    setRefineChanges([]);
  };

  // Universes list collapsed state — desktop only (mobile stacks the sidebar
  // above the editor and there's no horizontal-space tradeoff to make).
  // Persists across visits so users who prefer a maximized editor stay there.
  const [worldsCollapsed, setWorldsCollapsed] = useLocalStorageBool(
    'universeBuilder.worldsCollapsed',
    false,
  );
  const toggleWorldsCollapsed = () => setWorldsCollapsed((prev) => !prev);

  const refresh = async () => {
    setLoading(true);
    const [list, provData, models, settings] = await Promise.all([
      listUniverses().catch(() => []),
      getProviders().catch(() => ({ providers: [] })),
      listImageModels().catch(() => []),
      getSettings().catch(() => ({})),
    ]);
    setWorlds(list);
    setProviders(provData.providers || []);
    setActiveProviderId(provData.activeProvider || null);
    setImageModels(models || []);
    // Batch render rejects external (would block the request for the whole
    // batch), so hide that chip even if it's configured.
    const backends = deriveAvailableBackends(settings, { excludeExternal: true });
    setAvailableBackends(backends);
    const saved = settings?.imageGen?.mode;
    const fallback = backends.find((b) => b.id === saved)?.id || backends[0]?.id || IMAGE_GEN_MODE.LOCAL;
    setDefaultMode(fallback);
    setImageCfg(readPipelineImageSettings(settings));
    setLoading(false);
  };

  useEffect(() => { refresh(); }, []);

  // Whenever the selection changes, deep-load that world (for runs) and
  // hydrate the draft.
  useEffect(() => {
    setPendingDeleteId(null);
    resetRefinePanel();
    if (!selectedId) {
      setDraft(emptyTemplate());
      setRuns([]);
      return;
    }
    let cancelled = false;
    Promise.all([
      getUniverse(selectedId).catch(() => null),
      listWorldRuns(selectedId).catch(() => []),
    ]).then(([w, r]) => {
      if (cancelled) return;
      if (w) {
        setDraft({
          ...w,
          // Ensure starter buckets exist, but preserve custom buckets returned
          // by the LLM or added by the user.
          categories: ensureDraftCategories(w.categories),
          compositeSheets: w.compositeSheets || [],
          logline: w.logline || '',
          premise: w.premise || '',
          styleNotes: w.styleNotes || '',
          influences: ensureInfluences(w.influences),
          locked: w.locked || {},
          llm: w.llm || { provider: null, model: null },
        });
      }
      setRuns(r);
    });
    return () => { cancelled = true; };
  }, [selectedId]);

  // Hash-scroll for deep-links — the legacy `/canon` redirect and
  // PipelineSeries' "Manage characters, places, and objects" link both
  // navigate to `/universe-builder/<id>#canon`. React Router doesn't
  // auto-scroll to hashes, so wait until the section is rendered (gated by
  // `draft.id === selectedId`) then scroll. The element id (`canon`) is set
  // on UniverseCanonSection's root <section>.
  useEffect(() => {
    if (!location.hash) return;
    if (!selectedId || draft.id !== selectedId) return;
    const id = location.hash.slice(1);
    // Defer one frame so the lazy section is in the DOM before we query for it.
    const t = setTimeout(() => {
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
    return () => clearTimeout(t);
  }, [location.hash, selectedId, draft.id]);

  const handleNew = () => {
    goToWorld(null);
    setDraft(emptyTemplate());
    setRuns([]);
  };

  const handleSave = async () => {
    if (!draft.name?.trim()) {
      toast.error('Name is required');
      return;
    }
    setSaving(true);
    const payload = {
      name: draft.name.trim(),
      starterPrompt: draft.starterPrompt || '',
      logline: draft.logline || '',
      premise: draft.premise || '',
      styleNotes: draft.styleNotes || '',
      categories: draft.categories,
      compositeSheets: draft.compositeSheets || [],
      influences: ensureInfluences(draft.influences),
      locked: draft.locked || {},
      llm: draft.llm || {},
    };
    const result = selectedId
      ? await updateUniverse(selectedId, payload).catch((e) => { toast.error(`Save failed: ${e.message}`); return null; })
      : await createUniverse(payload).catch((e) => { toast.error(`Save failed: ${e.message}`); return null; });
    setSaving(false);
    if (result) {
      toast.success(selectedId ? 'World updated' : 'World created');
      setWorlds((prev) => {
        const without = prev.filter((w) => w.id !== result.id);
        return [result, ...without];
      });
      // After Create: jump to the new id's URL so back-button / refresh
      // returns to the same world. After Update: id is unchanged, but
      // navigating is harmless (replace-style).
      if (result.id !== selectedId) goToWorld(result.id);
    }
  };

  const handleDelete = async () => {
    if (!selectedId) return;
    if (pendingDeleteId !== selectedId) {
      setPendingDeleteId(selectedId);
      toast(`Click delete again to confirm — "${draft.name}" will be removed`, { icon: '⚠️' });
      return;
    }
    const id = selectedId;
    // Only update local UI + show success toast when the server confirmed the
    // delete. Otherwise the user would see both a red "Delete failed" toast
    // AND a green "World deleted" toast, with the world apparently gone from
    // the sidebar even though it's still on disk.
    const ok = await deleteUniverse(id)
      .then(() => true)
      .catch((e) => { toast.error(`Delete failed: ${e.message}`); return false; });
    if (!ok) return;
    setWorlds((prev) => prev.filter((w) => w.id !== id));
    goToWorld(null);
    setDraft(emptyTemplate());
    setPendingDeleteId(null);
    toast.success('World deleted');
  };

  const handleExpand = async () => {
    if (!draft.starterPrompt?.trim()) {
      toast.error('Add a starter prompt to expand');
      return;
    }
    // Extract per-item locks so the server can include them in the LLM
    // prompt (avoid duplicate generation) AND we can merge them back in
    // after the result returns. Only LOCKED entries are forwarded — the
    // unlocked items get fully replaced.
    const preservedVariations = {};
    for (const [cat, bucket] of Object.entries(draft.categories || {})) {
      const locked = (bucket?.variations || []).filter((v) => v?.locked === true);
      if (locked.length) preservedVariations[cat] = locked;
    }
    const preservedCompositeSheets = (draft.compositeSheets || []).filter((s) => s?.locked === true);

    setExpanding(true);
    const result = await expandUniverse({
      starterPrompt: draft.starterPrompt,
      // Full prior state + locks ride along so the LLM can keep its output
      // consistent with refined/pinned bible fields (see expand prompt builder).
      influences: ensureInfluences(draft.influences),
      logline: draft.logline || '',
      premise: draft.premise || '',
      styleNotes: draft.styleNotes || '',
      locked: draft.locked || {},
      preservedVariations,
      preservedCompositeSheets,
      providerId: draft.llm?.provider || undefined,
      model: draft.llm?.model || undefined,
    }).catch((e) => { toast.error(`Expansion failed: ${e.message}`); return null; });
    setExpanding(false);
    if (!result) return;
    // For each lockable field: pick the LLM's value when unlocked (falling
    // back to the draft if the LLM produced empty); pick the draft's value
    // verbatim when locked. Categories + compositeSheets aren't lockable
    // (the lock UI scopes to the bible/prompt scalars), so they always
    // come from the LLM. `starterPrompt` is normally untouched by expand
    // (the LLM doesn't return one), but if it ever did, lock honoring
    // protects the user's edits.
    const locks = draft.locked || {};
    // Distinguish "LLM omitted the field" (null/undefined → keep draft) from
    // "LLM returned empty string" (a legitimate "" — the user's `||` would
    // silently restore a stale value they wanted gone).
    const pick = (key, llmValue) => {
      if (locks[key]) return draft[key];
      return llmValue == null ? draft[key] : llmValue;
    };
    const refinedInfluences = mergeInfluencesWithLocks(locks, result.influences, draft.influences);
    const llmCategories = result.categories || {};
    const mergedCategories = {};
    const allCatKeys = new Set([
      ...Object.keys(preservedVariations),
      ...Object.keys(llmCategories),
    ]);
    for (const cat of allCatKeys) {
      const locked = preservedVariations[cat] || [];
      const fresh = (llmCategories[cat]?.variations || []);
      mergedCategories[cat] = { variations: mergeVariations(locked, fresh) };
    }
    // Composite sheets merge follows the same locked-first + dedupe pattern.
    const mergedSheets = (() => {
      const llmSheets = result.compositeSheets || [];
      const seen = new Set(preservedCompositeSheets.map((s) => s.label.toLowerCase()));
      const out = [...preservedCompositeSheets];
      for (const s of llmSheets) {
        const key = s.label?.toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(s);
      }
      return out;
    })();

    const expandedDraft = {
      ...draft,
      starterPrompt: pick('starterPrompt', result.starterPrompt),
      logline: pick('logline', result.logline),
      premise: pick('premise', result.premise),
      styleNotes: pick('styleNotes', result.styleNotes),
      influences: refinedInfluences,
      categories: ensureDraftCategories(mergedCategories),
      compositeSheets: mergedSheets,
      llm: result.llm || draft.llm,
    };
    setDraft(expandedDraft);
    const lockedKeys = Object.keys(locks).filter((k) => locks[k]);
    if (lockedKeys.length) {
      console.log(`🔒 Universe Builder expand preserved ${lockedKeys.length} locked field(s): ${lockedKeys.join(', ')}`);
    }
    const total = totalVariationCount(expandedDraft);
    if (expandedDraft.compositeSheets?.length) {
      setRenderOpts((r) => ({ ...r, promptMode: 'sheets' }));
    }
    // Auto-persist expansion if the world is already saved — otherwise the
    // user clicks Render and hits "No prompts to render" because the disk
    // copy still has empty categories. New (unsaved) drafts still need a
    // manual Save since they have no name yet.
    if (selectedId && expandedDraft.name?.trim()) {
      const updated = await updateUniverse(selectedId, {
        name: expandedDraft.name.trim(),
        starterPrompt: expandedDraft.starterPrompt || '',
        logline: expandedDraft.logline || '',
        premise: expandedDraft.premise || '',
        styleNotes: expandedDraft.styleNotes || '',
        categories: expandedDraft.categories,
        compositeSheets: expandedDraft.compositeSheets || [],
        influences: ensureInfluences(expandedDraft.influences),
        locked: expandedDraft.locked || {},
        llm: expandedDraft.llm || {},
      }).catch((e) => { toast.error(`Auto-save after expand failed: ${e.message}`); return null; });
      if (updated) {
        setWorlds((prev) => {
          const without = prev.filter((w) => w.id !== updated.id);
          return [updated, ...without];
        });
        toast.success(`Expanded into ${total} variations and ${expandedDraft.compositeSheets?.length || 0} boards — saved`);
        return;
      }
    }
    toast.success(`Expanded into ${total} variations and ${expandedDraft.compositeSheets?.length || 0} boards — review then Save`);
  };

  // Writes the LLM-refined fields back to the draft. The modal only emits
  // unlocked fields (server enforces this too), so we apply every key that
  // shows up in the patch and leave everything else on the draft as-is.
  // Mirrors handleExpand's auto-save: if the world is already persisted,
  // persist the refinement immediately so subsequent renders/expansions see
  // it on disk.
  const applyRefinement = async (patch = {}) => {
    const next = { ...draft };
    for (const key of WORLD_LOCKABLE_FIELDS) {
      // Influences live under one top-level `influences` object (not as
      // `influencesEmbrace`/`influencesAvoid` keys on the world); handle below.
      if (isInfluenceLockField(key)) continue;
      if (!(key in patch) || patch[key] == null) continue;
      next[key] = patch[key];
    }
    if (patch.influences != null) next.influences = ensureInfluences(patch.influences);
    // Holistic refine returns categories + composites when the world has
    // been expanded; the server already enforced per-item locks before
    // sending these back, so apply directly.
    if (patch.categories) next.categories = ensureDraftCategories(patch.categories);
    if (Array.isArray(patch.compositeSheets)) next.compositeSheets = patch.compositeSheets;
    setDraft(next);
    if (selectedId && next.name?.trim()) {
      const updated = await updateUniverse(selectedId, {
        name: next.name.trim(),
        starterPrompt: next.starterPrompt || '',
        logline: next.logline || '',
        premise: next.premise || '',
        styleNotes: next.styleNotes || '',
        categories: next.categories,
        compositeSheets: next.compositeSheets || [],
        influences: ensureInfluences(next.influences),
        locked: next.locked || {},
        llm: next.llm || {},
      }).catch((e) => { toast.error(`Auto-save after refine failed: ${e.message}`); return null; });
      if (updated) {
        setWorlds((prev) => {
          const without = prev.filter((w) => w.id !== updated.id);
          return [updated, ...without];
        });
      }
    }
  };

  const runRefine = async () => {
    const feedback = refineFeedback.trim();
    if (!feedback) {
      toast.error('Add feedback to refine');
      return;
    }
    if (!draft.starterPrompt?.trim()) {
      toast.error('Add a starter idea first — there is nothing for the LLM to refine');
      return;
    }
    const locks = draft.locked || {};
    const allTopLocked = WORLD_LOCKABLE_FIELDS.every((k) => locks[k]);
    const hasStructure = totalVariations > 0 || totalSheets > 0;
    if (allTopLocked && !hasStructure) {
      toast.error('All fields are locked — unlock at least one to enable refinement');
      return;
    }

    setRefining(true);
    setRefineRationale('');
    setRefineChanges([]);
    const result = await refineWorldPrompts({
      starterPrompt: draft.starterPrompt || '',
      logline: draft.logline || '',
      premise: draft.premise || '',
      styleNotes: draft.styleNotes || '',
      influences: ensureInfluences(draft.influences),
      categories: hasStructure ? draft.categories : undefined,
      compositeSheets: hasStructure ? draft.compositeSheets : undefined,
      locked: locks,
      feedback,
      providerId: draft.llm?.provider || activeProviderId || undefined,
      model: draft.llm?.model || undefined,
    }).catch(() => null);
    setRefining(false);
    if (!result) return;

    const patch = {};
    for (const key of WORLD_LOCKABLE_FIELDS) {
      if (isInfluenceLockField(key)) continue;
      if (locks[key]) continue;
      patch[key] = (result[key] ?? '').trim();
    }
    if (result.influences) {
      // Locked influence lists are server-side append-only — when the LLM
      // returns an empty list for a locked side, that's an omission, not an
      // intentional clear, so fall back to the originals.
      const origInf = ensureInfluences(draft.influences);
      const refinedInf = ensureInfluences(result.influences);
      patch.influences = {
        embrace: locks.influencesEmbrace && refinedInf.embrace.length === 0 ? origInf.embrace : refinedInf.embrace,
        avoid: locks.influencesAvoid && refinedInf.avoid.length === 0 ? origInf.avoid : refinedInf.avoid,
      };
    }
    if (result.categories && typeof result.categories === 'object') patch.categories = result.categories;
    if (Array.isArray(result.compositeSheets)) patch.compositeSheets = result.compositeSheets;

    await applyRefinement(patch);
    setRefineRationale(result.rationale || '');
    setRefineChanges(Array.isArray(result.changes) ? result.changes : []);
    setRefineFeedback('');
    toast.success('Refined world applied');
  };

  // Render either the full batch (driven by the renderOpts.promptMode dropdown)
  // or a narrow scope passed in by an inline button. Scope shape:
  //   { promptMode, selection?, sheetSelection? } — see server renderSchema.
  const runRender = async (scope = null) => {
    if (!selectedId) {
      toast.error('Save the world first');
      return;
    }
    const promptMode = scope?.promptMode || renderOpts.promptMode || 'variations';
    const total = scope
      ? scopedPromptCount(draft, scope)
      : renderPromptCount(draft, promptMode);
    if (!total) {
      toast.error('No prompts — expand the template first');
      return;
    }
    if (availableBackends.length === 0) {
      toast.error('Configure an image-gen backend first');
      return;
    }
    const effectiveMode = renderOpts.mode || defaultMode || undefined;
    const numericOrUndef = (v) => {
      if (v === '' || v == null) return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    setRendering(true);
    const result = await renderWorld(selectedId, {
      mode: effectiveMode,
      modelId: renderOpts.modelId || undefined,
      width: renderOpts.width,
      height: renderOpts.height,
      steps: numericOrUndef(renderOpts.steps),
      guidance: numericOrUndef(renderOpts.guidance),
      cfgScale: numericOrUndef(renderOpts.cfgScale),
      quantize: renderOpts.quantize || undefined,
      promptMode,
      batchPerVariation: renderOpts.batchPerVariation,
      selection: scope?.selection,
      sheetSelection: scope?.sheetSelection,
    }).catch((e) => { toast.error(`Render failed: ${e.message}`); return null; });
    setRendering(false);
    if (!result) return;
    toast.success(`Queued ${result.promptCount} renders → "${result.collectionName}"`);
    const updated = await listWorldRuns(selectedId).catch(() => runs);
    setRuns(updated);
  };

  const handleRender = () => runRender(null);

  const canRender = !!selectedId && availableBackends.length > 0 && !rendering;

  const updateDraft = (patch) => setDraft((d) => ({ ...d, ...patch }));

  // Canon mutations (extract / refine / differentiate / lock / render-ref)
  // round-trip through the server and return the full universe. Only the
  // canon arrays + their updatedAt timestamp flow back into the draft so
  // unsaved edits to logline/premise/styleNotes aren't clobbered by the
  // server's stale copy of those fields.
  const handleCanonChange = (updated) => {
    if (!updated) return;
    setDraft((d) => ({
      ...d,
      characters: updated.characters,
      settings: updated.settings,
      objects: updated.objects,
      updatedAt: updated.updatedAt,
    }));
  };
  // Toggle a single field's lock state and (when the world is already saved)
  // persist immediately — locks are part of the world template, so a stale
  // disk copy would let a later refine/expand silently overwrite a "locked"
  // field after a refresh.
  const toggleLock = (field) => {
    if (!WORLD_LOCKABLE_FIELDS.includes(field)) return;
    setDraft((d) => {
      const nextLocked = { ...(d.locked || {}) };
      if (nextLocked[field]) delete nextLocked[field];
      else nextLocked[field] = true;
      const next = { ...d, locked: nextLocked };
      if (selectedId && next.name?.trim()) {
        // Fire-and-forget — the in-memory state already reflects the toggle;
        // on failure we toast and the next manual Save still recovers.
        updateUniverse(selectedId, { locked: nextLocked })
          .catch((e) => toast.error(`Lock save failed: ${e.message}`));
      }
      return next;
    });
  };
  const updateCategory = (cat, variations) => setDraft((d) => ({
    ...d,
    categories: { ...d.categories, [cat]: { variations } },
  }));
  const handleGenerateInCategory = async (cat, count) => {
    const current = draft.categories?.[cat]?.variations || [];
    const existingLabels = current.map((v) => v.label).filter(Boolean);
    const result = await generateCategoryVariations({
      category: cat,
      count,
      existingLabels,
      influences: ensureInfluences(draft.influences),
      logline: draft.logline || '',
      premise: draft.premise || '',
      styleNotes: draft.styleNotes || '',
      providerId: draft.llm?.provider || undefined,
      model: draft.llm?.model || undefined,
    }, { silent: true }).catch((e) => { toast.error(`Generate failed: ${e.message}`); return null; });
    if (!result) return;
    const fresh = Array.isArray(result.variations) ? result.variations : [];
    const merged = mergeVariations(current, fresh);
    const additionCount = merged.length - current.length;
    if (additionCount === 0) {
      toast.error('LLM returned no new variations — try again or adjust the universe context');
      return;
    }
    const nextDraft = {
      ...draft,
      categories: { ...draft.categories, [cat]: { variations: merged } },
    };
    setDraft(nextDraft);
    if (selectedId && nextDraft.name?.trim()) {
      const updated = await updateUniverse(selectedId, { categories: nextDraft.categories })
        .catch((e) => { toast.error(`Auto-save after generate failed: ${e.message}`); return null; });
      if (updated) {
        setWorlds((prev) => {
          const without = prev.filter((w) => w.id !== updated.id);
          return [updated, ...without];
        });
        toast.success(`Added ${additionCount} variation${additionCount === 1 ? '' : 's'} to ${humanizeCategory(cat)} — saved`);
        return;
      }
    }
    toast.success(`Added ${additionCount} variation${additionCount === 1 ? '' : 's'} to ${humanizeCategory(cat)} — review then Save`);
  };
  const updateCompositeSheets = (sheets) => setDraft((d) => ({ ...d, compositeSheets: sheets }));
  const addCategory = () => {
    const key = normalizeCategoryKey(newCategoryName);
    if (!key) {
      toast.error('Use letters or numbers for the category name');
      return;
    }
    if (draft.categories?.[key]) {
      toast.error('Category already exists');
      return;
    }
    setDraft((d) => ({
      ...d,
      categories: { ...d.categories, [key]: { variations: [] } },
    }));
    setNewCategoryName('');
  };
  const removeCategory = (cat) => setDraft((d) => {
    const next = { ...d.categories };
    delete next[cat];
    return { ...d, categories: ensureDraftCategories(next) };
  });

  const providerLabel = (id) => providers.find((p) => p.id === id)?.name || id || '—';
  const providerModels = useMemo(() => {
    const p = providers.find((x) => x.id === draft.llm?.provider) || providers.find((x) => x.id === activeProviderId);
    return p?.models || [];
  }, [providers, activeProviderId, draft.llm?.provider]);

  const categoryKeys = getCategoryKeys(draft.categories);
  const totalVariations = totalVariationCount(draft);
  const totalSheets = draft.compositeSheets?.length || 0;
  const renderTotal = renderPromptCount(draft, renderOpts.promptMode);

  // Mobile = flex column (grid template ignored); lg+ = grid where the inline
  // `gridTemplateColumns` swap between collapsed/expanded widths takes effect.
  // Flipping `display` at the breakpoint (rather than overriding grid-cols-1
  // with an inline style) keeps the mobile stack working. Collapsed track is
  // 0px (not a thin rail) — matches CoS pattern where a floating expand
  // button stands in for the rail.
  const desktopGridCols = worldsCollapsed ? '0px minmax(0, 1fr)' : '260px minmax(0, 1fr)';

  return (
    <div className="flex flex-col h-full">
      <div
        className="relative flex-1 flex flex-col lg:grid min-h-0 transition-[grid-template-columns] duration-200"
        style={{ gridTemplateColumns: desktopGridCols }}
      >
      {/* Sidebar — world list. Collapses entirely on desktop (no rail) —
          a floating expand button at the nav edge stands in. Mobile keeps the
          full sidebar inline (the page stacks vertically below `lg`, so
          collapsing doesn't help there). Border-r + tinted bg matches
          WritersRoom's tight integrated look — the editor area flows directly
          off the sidebar without a card gap. */}
      {worldsCollapsed && (
        <button
          onClick={toggleWorldsCollapsed}
          className="hidden lg:flex absolute left-0 top-2 z-20 p-1.5 text-gray-500 hover:text-white transition-colors rounded-r-md hover:bg-port-card bg-port-card/60 border border-l-0 border-port-border"
          title="Show universes"
          aria-label="Show universes"
        >
          <PanelLeftOpen size={16} />
        </button>
      )}
      {worldsCollapsed ? (
        <div className="hidden lg:block overflow-hidden min-w-0" />
      ) : (
        <aside className="border-b lg:border-b-0 lg:border-r border-port-border bg-port-card/40 px-3 py-3 flex flex-col gap-2 lg:overflow-y-auto">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <Globe2 size={16} className="text-port-accent" /> Universes
            </h2>
            <div className="flex items-center gap-1">
              <button
                onClick={handleNew}
                className="text-xs px-2 py-1 bg-port-accent/15 hover:bg-port-accent/25 text-port-accent rounded flex items-center gap-1 min-h-[40px] sm:min-h-0"
                title="New world"
              >
                <Plus size={14} /> New
              </button>
              <button
                onClick={toggleWorldsCollapsed}
                className="hidden lg:inline-flex p-1.5 text-gray-500 hover:text-white"
                title="Collapse universes"
                aria-label="Collapse universes"
              >
                <PanelLeftClose size={14} />
              </button>
            </div>
          </div>
          {loading ? (
            <p className="text-xs text-gray-500">Loading…</p>
          ) : universes.length === 0 ? (
            <p className="text-xs text-gray-500">No universes yet — click <span className="text-port-accent">New</span> to start.</p>
          ) : (
            <ul className="flex flex-col gap-1 overflow-y-auto">
              {universes.map((w) => {
                const active = w.id === selectedId;
                return (
                  <li key={w.id}>
                    <button
                      onClick={() => goToWorld(w.id)}
                      className={`w-full text-left px-2 py-2 rounded text-sm transition-colors min-h-[40px] ${
                        active
                          ? 'bg-port-accent/15 text-port-accent border border-port-accent/40'
                          : 'text-gray-300 hover:bg-port-bg border border-transparent'
                      }`}
                    >
                      <div className="font-medium truncate">{w.name}</div>
                      <div className="text-[11px] text-gray-500 truncate">{w.starterPrompt || 'No starter prompt'}</div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>
      )}

      {/* Editor — owns its own scroll inside the full-width main so the
          sidebar can stay pinned while the long card stack scrolls. */}
      <section className="flex flex-col gap-4 p-4 min-h-0 lg:overflow-y-auto">
        <header className="bg-port-card border border-port-border rounded p-4 flex flex-col gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="text"
              value={draft.name}
              onChange={(e) => updateDraft({ name: e.target.value })}
              placeholder="World name (e.g. Moebius / Scavenger sci-fi)"
              className="flex-1 min-w-[180px] bg-port-bg border border-port-border rounded px-3 py-2 text-white focus:outline-none focus:border-port-accent"
              maxLength={100}
            />
            <button
              onClick={handleSave}
              disabled={saving || !draft.name?.trim()}
              className="px-3 py-2 bg-port-accent hover:bg-port-accent/90 disabled:opacity-50 text-white rounded flex items-center gap-2 min-h-[40px]"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
              {selectedId ? 'Save' : 'Create'}
            </button>
            {selectedId && (
              <>
                <ShareToButton kind="universe" ids={[selectedId]} label="Share" />
                {draft.origin ? <OriginBadge origin={draft.origin} /> : null}
                <button
                  onClick={handleDelete}
                  className={`px-3 py-2 rounded flex items-center gap-2 min-h-[40px] ${
                    pendingDeleteId === selectedId
                      ? 'bg-red-700 hover:bg-red-600 text-white'
                      : 'bg-red-900/30 hover:bg-red-900/50 text-red-300'
                  }`}
                  title="Delete world"
                >
                  <Trash2 size={16} /> {pendingDeleteId === selectedId ? 'Confirm delete' : 'Delete'}
                </button>
              </>
            )}
          </div>

          {/* Starter prompt + LLM picker */}
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
                maxLength={4000}
              />
            </div>
            <div>
              <label htmlFor="world-llm-provider" className="text-xs text-gray-400 mb-1 block">LLM for expansion</label>
              <select
                id="world-llm-provider"
                // Bind to `?? ''` (NOT `|| activeProviderId || ''`) — when
                // provider is null/unset, the empty value should select the
                // "Active provider" option, not silently switch the dropdown
                // to the active provider's explicit option (which would
                // misrepresent saved state as a pinned provider).
                value={draft.llm?.provider ?? ''}
                onChange={(e) => updateDraft({ llm: { ...draft.llm, provider: e.target.value || null, model: null } })}
                className="w-full bg-port-bg border border-port-border rounded px-2 py-2 text-white text-sm min-h-[40px]"
              >
                <option value="">Active provider ({providerLabel(activeProviderId)})</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <select
                value={draft.llm?.model || ''}
                onChange={(e) => updateDraft({ llm: { ...draft.llm, model: e.target.value || null } })}
                className="mt-1 w-full bg-port-bg border border-port-border rounded px-2 py-2 text-white text-sm min-h-[40px]"
              >
                <option value="">Default model</option>
                {providerModels.map((m) => {
                  const id = typeof m === 'string' ? m : m.id;
                  const label = typeof m === 'string' ? m : (m.name || m.id);
                  return <option key={id} value={id}>{label}</option>;
                })}
              </select>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={handleExpand}
              disabled={expanding || !draft.starterPrompt?.trim()}
              className="px-3 py-2 bg-purple-600/30 hover:bg-purple-600/50 disabled:opacity-50 text-purple-200 border border-purple-600/40 rounded flex items-center gap-2 min-h-[40px]"
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
              {totalVariations} variation{totalVariations === 1 ? '' : 's'} across {categoryKeys.length} categories · {totalSheets} composite board{totalSheets === 1 ? '' : 's'}
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
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={runRefine}
                  disabled={refining || !refineFeedback.trim() || !draft.starterPrompt?.trim()}
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
            </div>
          )}
        </header>

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
        </section>

        {/*
          Gate on `draft.id === selectedId` — when the user switches universes,
          `selectedId` updates synchronously but the new `draft` arrives after
          an async `getUniverse(selectedId)` resolves. During that window, an
          optimistic canon mutation routed through `onUniverseChange` would
          send the *previous* universe's canon arrays to
          `updateUniverse(selectedId, ...)`, wholesale-overwriting the newly
          selected universe's canon on the server.
        */}
        {selectedId && draft.id === selectedId ? (
          <UniverseCanonSection
            universe={draft}
            universeId={selectedId}
            onUniverseChange={handleCanonChange}
            imageCfg={imageCfg}
          />
        ) : null}

        <CompositeSheetsEditor
          sheets={draft.compositeSheets || []}
          onChange={updateCompositeSheets}
          canRender={canRender}
          onRender={(sheet) => runRender({ promptMode: 'sheets', sheetSelection: [sheet.label] })}
        />

        {/* Categories */}
        <section className="bg-port-card border border-port-border rounded p-4 flex flex-col gap-3">
          <div className="flex items-end justify-between gap-3 flex-wrap">
            <div>
              <h2 className="text-sm font-semibold text-white">Prompt categories</h2>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addCategory(); }}
                placeholder="colonies, factions, species"
                className="w-44 bg-port-bg border border-port-border rounded px-2 py-2 text-white text-sm focus:outline-none focus:border-port-accent"
                maxLength={WORLD_CATEGORY_KEY_MAX}
              />
              <button
                onClick={addCategory}
                disabled={!newCategoryName.trim()}
                className="px-3 py-2 bg-port-accent/15 hover:bg-port-accent/25 disabled:opacity-50 text-port-accent rounded flex items-center gap-1 min-h-[40px]"
              >
                <Plus size={14} /> Add
              </button>
            </div>
          </div>
        </section>
        <section className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {categoryKeys.map((cat) => (
            <CategoryEditor
              key={cat}
              category={cat}
              variations={draft.categories?.[cat]?.variations || []}
              canRemove={!WORLD_CATEGORIES.includes(cat)}
              onChange={(next) => updateCategory(cat, next)}
              onRemove={() => removeCategory(cat)}
              canRender={canRender}
              onRenderCategory={() => runRender({ promptMode: 'variations', selection: { [cat]: 'all' } })}
              onRenderVariation={(v) => runRender({ promptMode: 'variations', selection: { [cat]: [v.label] } })}
              onGenerate={(count) => handleGenerateInCategory(cat, count)}
            />
          ))}
        </section>

        {/* Render controls — reuses Image Gen's backend chip + knob grid so
            the model picker, resolution presets, etc. stay in lockstep. */}
        <section className="bg-port-card border border-port-border rounded p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <FolderOpen size={16} className="text-port-accent" /> Batch render
            </h2>
            {availableBackends.length > 1 && (
              <BackendChipStrip
                availableBackends={availableBackends}
                value={renderOpts.mode || defaultMode}
                onChange={(id) => setRenderOpts((r) => ({ ...r, mode: id }))}
                titlePrefix="Render via"
              />
            )}
          </div>
          {availableBackends.length === 0 && (
            <p className="text-xs text-port-warning">
              Configure a local mflux Python path or enable Codex Imagegen in Settings → Image Gen
              to enable batch render.
            </p>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label htmlFor="world-render-prompt-mode" className="block text-xs font-medium text-gray-400 mb-1">Prompt set</label>
              <select
                id="world-render-prompt-mode"
                value={renderOpts.promptMode || 'variations'}
                onChange={(e) => setRenderOpts((r) => ({ ...r, promptMode: e.target.value }))}
                className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent min-h-[40px]"
              >
                <option value="sheets" disabled={totalSheets === 0}>Composite boards ({totalSheets})</option>
                <option value="variations" disabled={totalVariations === 0}>Atomic variations ({totalVariations})</option>
                <option value="all" disabled={totalSheets + totalVariations === 0}>Everything ({totalSheets + totalVariations})</option>
              </select>
            </div>
          </div>
          <ImageGenControls
            mode={renderOpts.mode || defaultMode || 'local'}
            models={imageModels}
            modelId={renderOpts.modelId}
            onModelChange={(id) => setRenderOpts((r) => ({ ...r, modelId: id, steps: '', guidance: '' }))}
            width={renderOpts.width}
            height={renderOpts.height}
            onResolutionChange={(w, h) => setRenderOpts((r) => ({ ...r, width: w, height: h }))}
            steps={renderOpts.steps}
            onStepsChange={(v) => setRenderOpts((r) => ({ ...r, steps: v }))}
            guidance={renderOpts.guidance}
            onGuidanceChange={(v) => setRenderOpts((r) => ({ ...r, guidance: v }))}
            cfgScale={renderOpts.cfgScale}
            onCfgScaleChange={(v) => setRenderOpts((r) => ({ ...r, cfgScale: v }))}
            quantize={renderOpts.quantize}
            onQuantizeChange={(v) => setRenderOpts((r) => ({ ...r, quantize: v }))}
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
              onClick={handleRender}
              disabled={rendering || !selectedId || renderTotal === 0 || availableBackends.length === 0}
              className="px-4 py-2 bg-port-accent hover:bg-port-accent/90 disabled:opacity-50 text-white rounded flex items-center gap-2 min-h-[40px]"
            >
              {rendering ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
              Render {renderTotal * (renderOpts.batchPerVariation || 1)} image{renderTotal * (renderOpts.batchPerVariation || 1) === 1 ? '' : 's'}
            </button>
          </div>
          {!selectedId && <p className="text-xs text-gray-500">Save the world first to enable rendering.</p>}
        </section>

        {/* Run history */}
        {selectedId && runs.length > 0 && (
          <section className="bg-port-card border border-port-border rounded p-4">
            <h2 className="text-sm font-semibold text-white mb-2">Recent runs</h2>
            <ul className="flex flex-col gap-1">
              {runs.map((r) => (
                <li key={r.id} className="flex items-center justify-between text-sm text-gray-300 border-b border-port-border/40 py-1.5">
                  <span className="truncate">
                    <span className="text-gray-500">{new Date(r.createdAt).toLocaleString()} —</span>{' '}
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
      </section>
      </div>
    </div>
  );
}

function totalVariationCount(world) {
  return getCategoryKeys(world.categories).reduce((n, c) => n + (world.categories?.[c]?.variations?.length || 0), 0);
}

function renderPromptCount(world, promptMode = 'variations') {
  const variations = totalVariationCount(world);
  const sheets = world.compositeSheets?.length || 0;
  if (promptMode === 'sheets') return sheets;
  if (promptMode === 'all') return variations + sheets;
  return variations;
}

// Mirrors the server's compilePrompts for selection/sheetSelection so an inline
// "Render" button can disable itself + show an accurate count without a round trip.
function scopedPromptCount(world, scope) {
  if (!scope) return 0;
  if (scope.promptMode === 'sheets') {
    const sheets = world.compositeSheets || [];
    if (scope.sheetSelection === 'all' || !scope.sheetSelection) return sheets.length;
    const set = new Set(scope.sheetSelection);
    return sheets.filter((s) => set.has(s.label)).length;
  }
  // variations
  if (!scope.selection) return 0;
  let n = 0;
  for (const [cat, pick] of Object.entries(scope.selection)) {
    const vars = world.categories?.[cat]?.variations || [];
    if (pick === 'all') { n += vars.length; continue; }
    const labels = new Set(pick);
    n += vars.filter((v) => labels.has(v.label)).length;
  }
  return n;
}

function CompositeSheetsEditor({ sheets, onChange, canRender = false, onRender = null }) {
  const [adding, setAdding] = useState(false);
  const [newKind, setNewKind] = useState('reference_sheet');
  const [newLabel, setNewLabel] = useState('');
  const [newPrompt, setNewPrompt] = useState('');
  const [editIdx, setEditIdx] = useState(null);
  const [editKind, setEditKind] = useState('reference_sheet');
  const [editLabel, setEditLabel] = useState('');
  const [editPrompt, setEditPrompt] = useState('');

  const addSheet = () => {
    const label = newLabel.trim();
    const prompt = newPrompt.trim();
    if (!label || !prompt) return;
    onChange([...sheets, { kind: newKind, label: label.slice(0, 120), prompt: prompt.slice(0, COMPOSITE_PROMPT_MAX) }]);
    setNewKind('reference_sheet');
    setNewLabel('');
    setNewPrompt('');
    setAdding(false);
  };

  const removeAt = (idx) => onChange(sheets.filter((_, i) => i !== idx));

  const toggleLockAt = (idx) => onChange(sheets.map((s, i) => {
    if (i !== idx) return s;
    const next = { ...s };
    if (next.locked) delete next.locked;
    else next.locked = true;
    return next;
  }));

  const startEdit = (idx, sheet) => {
    setEditIdx(idx);
    setEditKind(sheet.kind || 'reference_sheet');
    setEditLabel(sheet.label);
    setEditPrompt(sheet.prompt);
  };

  const saveEdit = () => {
    const label = editLabel.trim();
    const prompt = editPrompt.trim();
    if (!label || !prompt) return;
    const next = [...sheets];
    next[editIdx] = { kind: editKind, label: label.slice(0, 120), prompt: prompt.slice(0, COMPOSITE_PROMPT_MAX) };
    onChange(next);
    setEditIdx(null);
  };

  return (
    <section className="bg-port-card border border-port-border rounded p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-white">
          Composite boards
          <span className="ml-2 text-xs text-gray-500">{sheets.length}</span>
        </h2>
        <button
          onClick={() => setAdding((v) => !v)}
          className="text-xs px-2 py-1 bg-port-accent/15 hover:bg-port-accent/25 text-port-accent rounded flex items-center gap-1 min-h-[40px] sm:min-h-0"
        >
          <Plus size={12} /> Add
        </button>
      </div>
      {adding && (
        <div className="bg-port-bg border border-port-border rounded p-2 flex flex-col gap-2">
          <select
            value={newKind}
            onChange={(e) => setNewKind(e.target.value)}
            className="bg-port-card border border-port-border rounded px-2 py-1 text-white text-sm min-h-[40px]"
          >
            {COMPOSITE_BOARD_KINDS.map((kind) => (
              <option key={kind.value} value={kind.value}>{kind.label}</option>
            ))}
          </select>
          <input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder={newKind === 'world_pitch_poster' ? 'World summary concept pitch poster' : 'Gas-Giant Drifters costume sheet'}
            className="bg-port-card border border-port-border rounded px-2 py-1 text-white text-sm"
            maxLength={120}
          />
          <textarea
            value={newPrompt}
            onChange={(e) => setNewPrompt(e.target.value)}
            placeholder={newKind === 'world_pitch_poster'
              ? 'Create a cinematic world summary concept pitch poster with a hero panorama, inset environments, cultures, creatures, visual language, palette, materials, and theme icons...'
              : 'Create a clean illustrated costume reference sheet...'}
            className="bg-port-card border border-port-border rounded px-2 py-1 text-white text-sm"
            rows={6}
            maxLength={COMPOSITE_PROMPT_MAX}
          />
          <div className="flex items-center gap-2">
            <button
              onClick={addSheet}
              disabled={!newLabel.trim() || !newPrompt.trim()}
              className="text-xs px-2 py-1 bg-port-accent hover:bg-port-accent/90 disabled:opacity-50 text-white rounded min-h-[40px] sm:min-h-0"
            >
              Save
            </button>
            <button
              onClick={() => {
                setAdding(false);
                setNewKind('reference_sheet');
                setNewLabel('');
                setNewPrompt('');
              }}
              className="text-xs px-2 py-1 bg-port-bg hover:bg-port-border text-gray-300 rounded min-h-[40px] sm:min-h-0"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {sheets.length === 0 ? (
        <p className="text-xs text-gray-500">No composite boards yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5 max-h-96 overflow-y-auto">
          {sheets.map((sheet, idx) => (
            <li key={`${sheet.label}-${idx}`} className={`bg-port-bg border rounded p-2 text-sm ${sheet.locked ? 'border-port-accent/50' : 'border-port-border'}`}>
              {editIdx === idx ? (
                <div className="flex flex-col gap-1">
                  <select
                    value={editKind}
                    onChange={(e) => setEditKind(e.target.value)}
                    className="bg-port-card border border-port-border rounded px-2 py-1 text-white text-sm min-h-[40px]"
                  >
                    {COMPOSITE_BOARD_KINDS.map((kind) => (
                      <option key={kind.value} value={kind.value}>{kind.label}</option>
                    ))}
                  </select>
                  <input
                    value={editLabel}
                    onChange={(e) => setEditLabel(e.target.value)}
                    className="bg-port-card border border-port-border rounded px-2 py-1 text-white text-sm"
                    maxLength={120}
                  />
                  <textarea
                    value={editPrompt}
                    onChange={(e) => setEditPrompt(e.target.value)}
                    rows={8}
                    className="bg-port-card border border-port-border rounded px-2 py-1 text-white text-sm"
                    maxLength={COMPOSITE_PROMPT_MAX}
                  />
                  <div className="flex gap-2">
                    <button onClick={saveEdit} className="text-xs px-2 py-1 bg-port-accent text-white rounded min-h-[40px] sm:min-h-0">Save</button>
                    <button onClick={() => setEditIdx(null)} className="text-xs px-2 py-1 bg-port-bg text-gray-300 rounded min-h-[40px] sm:min-h-0">Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <div className="text-white font-medium truncate">{sheet.label}</div>
                      <span className="shrink-0 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-port-accent/10 text-port-accent border border-port-accent/20">
                        {compositeKindLabel(sheet.kind)}
                      </span>
                    </div>
                    <div className="text-xs text-gray-400 line-clamp-3">{sheet.prompt}</div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {onRender && (
                      <button
                        onClick={() => onRender(sheet)}
                        disabled={!canRender}
                        className="p-1 text-gray-400 hover:text-port-accent disabled:opacity-30 disabled:cursor-not-allowed rounded"
                        title={canRender ? 'Render this board' : 'Save the world and configure a render backend to enable'}
                      >
                        <Play size={14} />
                      </button>
                    )}
                    <button
                      onClick={() => toggleLockAt(idx)}
                      className={`p-1 rounded ${sheet.locked ? 'text-port-accent hover:bg-port-accent/20' : 'text-gray-500 hover:text-gray-300'}`}
                      title={sheet.locked ? 'Locked — AI expand will preserve this board' : 'Lock this board against AI expand'}
                      aria-pressed={!!sheet.locked}
                    >
                      {sheet.locked ? <Lock size={14} /> : <Unlock size={14} />}
                    </button>
                    <button
                      onClick={() => startEdit(idx, sheet)}
                      className="p-1 text-gray-400 hover:text-port-accent rounded"
                      title="Edit"
                    >
                      <Edit3 size={14} />
                    </button>
                    <button
                      onClick={() => removeAt(idx)}
                      className="p-1 text-gray-400 hover:text-red-400 rounded"
                      title="Remove"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const GENERATE_PRESETS = [3, 5, 10];
const GENERATE_CUSTOM_MIN = 1;
const GENERATE_CUSTOM_MAX = 50;

function CategoryEditor({
  category, variations, canRemove = false, onChange, onRemove,
  canRender = false, onRenderCategory = null, onRenderVariation = null,
  onGenerate = null,
}) {
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newPrompt, setNewPrompt] = useState('');
  const [editIdx, setEditIdx] = useState(null);
  const [editLabel, setEditLabel] = useState('');
  const [editPrompt, setEditPrompt] = useState('');
  const [genOpen, setGenOpen] = useState(false);
  const [genCustom, setGenCustom] = useState('');
  const [generating, setGenerating] = useState(false);
  const genWrapRef = useRef(null);

  useClickOutside(genWrapRef, genOpen, () => setGenOpen(false));
  useEffect(() => {
    if (!genOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setGenOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [genOpen]);

  const runGenerate = async (count) => {
    const n = Math.max(GENERATE_CUSTOM_MIN, Math.min(GENERATE_CUSTOM_MAX, parseInt(count, 10) || 0));
    if (!n || !onGenerate) return;
    setGenOpen(false);
    setGenerating(true);
    try {
      await onGenerate(n);
    } finally {
      setGenerating(false);
      setGenCustom('');
    }
  };

  const addVariation = () => {
    const label = newLabel.trim();
    const prompt = newPrompt.trim();
    if (!label || !prompt) return;
    onChange([...variations, { label: label.slice(0, 120), prompt: prompt.slice(0, 2000) }]);
    setNewLabel('');
    setNewPrompt('');
    setAdding(false);
  };

  const removeAt = (idx) => onChange(variations.filter((_, i) => i !== idx));

  const toggleLockAt = (idx) => onChange(variations.map((v, i) => {
    if (i !== idx) return v;
    const next = { ...v };
    if (next.locked) delete next.locked;
    else next.locked = true;
    return next;
  }));

  const startEdit = (idx, v) => {
    setEditIdx(idx);
    setEditLabel(v.label);
    setEditPrompt(v.prompt);
  };

  const saveEdit = () => {
    const label = editLabel.trim();
    const prompt = editPrompt.trim();
    // Mirror addVariation()'s validation — server-side sanitize would drop
    // a blank entry on save/reload, so refuse rather than store ghost rows
    // the user can't see why they vanished.
    if (!label || !prompt) return;
    const next = [...variations];
    next[editIdx] = { label: label.slice(0, 120), prompt: prompt.slice(0, 2000) };
    onChange(next);
    setEditIdx(null);
  };

  return (
    <div className="bg-port-card border border-port-border rounded p-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-white capitalize">
          {humanizeCategory(category)}
          <span className="ml-2 text-xs text-gray-500">{variations.length}</span>
        </h3>
        <div className="flex items-center gap-1">
          {onRenderCategory && (
            <button
              onClick={onRenderCategory}
              disabled={!canRender || variations.length === 0}
              className="text-xs px-2 py-1 bg-port-accent/15 hover:bg-port-accent/25 disabled:opacity-30 disabled:cursor-not-allowed text-port-accent rounded flex items-center gap-1 min-h-[40px] sm:min-h-0"
              title={variations.length === 0 ? 'Add variations first' : 'Render this category'}
            >
              <Play size={12} /> Render
            </button>
          )}
          {onGenerate && (
            <div className="relative" ref={genWrapRef}>
              <button
                onClick={() => setGenOpen((v) => !v)}
                disabled={generating}
                className="text-xs px-2 py-1 bg-port-accent/15 hover:bg-port-accent/25 disabled:opacity-30 disabled:cursor-not-allowed text-port-accent rounded flex items-center gap-1 min-h-[40px] sm:min-h-0"
                title="Ask the LLM for more variations in this category"
                aria-haspopup="menu"
                aria-expanded={genOpen}
              >
                {generating ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                Generate
              </button>
              {genOpen && (
                <div
                  role="menu"
                  className="absolute right-0 top-full mt-1 z-20 w-44 bg-port-card border border-port-border rounded shadow-lg p-1 flex flex-col gap-0.5"
                >
                  {GENERATE_PRESETS.map((n) => (
                    <button
                      key={n}
                      role="menuitem"
                      onClick={() => runGenerate(n)}
                      className="text-left text-xs px-2 py-1.5 text-gray-200 hover:bg-port-accent/20 rounded"
                    >
                      Generate {n} more
                    </button>
                  ))}
                  <div className="border-t border-port-border my-1" />
                  <div className="flex items-center gap-1 px-1 pb-1">
                    <input
                      type="number"
                      min={GENERATE_CUSTOM_MIN}
                      max={GENERATE_CUSTOM_MAX}
                      value={genCustom}
                      onChange={(e) => setGenCustom(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') runGenerate(genCustom); }}
                      placeholder="Custom"
                      className="w-16 bg-port-bg border border-port-border rounded px-1.5 py-1 text-white text-xs focus:outline-none focus:border-port-accent"
                    />
                    <button
                      onClick={() => runGenerate(genCustom)}
                      disabled={!Number(genCustom) || Number(genCustom) < GENERATE_CUSTOM_MIN}
                      className="flex-1 text-xs px-2 py-1 bg-port-accent/20 hover:bg-port-accent/30 disabled:opacity-30 disabled:cursor-not-allowed text-port-accent rounded"
                    >
                      Go
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          {canRemove && (
            <button
              onClick={onRemove}
              className="p-1 text-gray-400 hover:text-red-400 rounded"
              title="Remove category"
            >
              <Trash2 size={14} />
            </button>
          )}
          <button
            onClick={() => setAdding((v) => !v)}
            className="text-xs px-2 py-1 bg-port-accent/15 hover:bg-port-accent/25 text-port-accent rounded flex items-center gap-1 min-h-[40px] sm:min-h-0"
          >
            <Plus size={12} /> Add
          </button>
        </div>
      </div>
      {adding && (
        <div className="bg-port-bg border border-port-border rounded p-2 mb-2 flex flex-col gap-2">
          <input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="Label (e.g. Crystalline canyon basin)"
            className="bg-port-card border border-port-border rounded px-2 py-1 text-white text-sm"
            maxLength={120}
          />
          <textarea
            value={newPrompt}
            onChange={(e) => setNewPrompt(e.target.value)}
            placeholder="Prompt fragment (subject only)"
            className="bg-port-card border border-port-border rounded px-2 py-1 text-white text-sm"
            rows={2}
            maxLength={2000}
          />
          <div className="flex items-center gap-2">
            <button
              onClick={addVariation}
              disabled={!newLabel.trim() || !newPrompt.trim()}
              className="text-xs px-2 py-1 bg-port-accent hover:bg-port-accent/90 disabled:opacity-50 text-white rounded min-h-[40px] sm:min-h-0"
            >
              Save
            </button>
            <button
              onClick={() => { setAdding(false); setNewLabel(''); setNewPrompt(''); }}
              className="text-xs px-2 py-1 bg-port-bg hover:bg-port-border text-gray-300 rounded min-h-[40px] sm:min-h-0"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {variations.length === 0 ? (
        <p className="text-xs text-gray-500">No variations yet — expand the starter prompt or add one manually.</p>
      ) : (
        <ul className="flex flex-col gap-1.5 max-h-72 overflow-y-auto">
          {variations.map((v, idx) => (
            <li key={`${v.label}-${idx}`} className={`bg-port-bg border rounded p-2 text-sm ${v.locked ? 'border-port-accent/50' : 'border-port-border'}`}>
              {editIdx === idx ? (
                <div className="flex flex-col gap-1">
                  <input
                    value={editLabel}
                    onChange={(e) => setEditLabel(e.target.value)}
                    className="bg-port-card border border-port-border rounded px-2 py-1 text-white text-sm"
                    maxLength={120}
                  />
                  <textarea
                    value={editPrompt}
                    onChange={(e) => setEditPrompt(e.target.value)}
                    rows={3}
                    className="bg-port-card border border-port-border rounded px-2 py-1 text-white text-sm"
                    maxLength={2000}
                  />
                  <div className="flex gap-2">
                    <button onClick={saveEdit} className="text-xs px-2 py-1 bg-port-accent text-white rounded min-h-[40px] sm:min-h-0">Save</button>
                    <button onClick={() => setEditIdx(null)} className="text-xs px-2 py-1 bg-port-bg text-gray-300 rounded min-h-[40px] sm:min-h-0">Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-white font-medium truncate">{v.label}</div>
                    <div className="text-xs text-gray-400 line-clamp-2">{v.prompt}</div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {onRenderVariation && (
                      <button
                        onClick={() => onRenderVariation(v)}
                        disabled={!canRender}
                        className="p-1 text-gray-400 hover:text-port-accent disabled:opacity-30 disabled:cursor-not-allowed rounded"
                        title={canRender ? 'Render this variation' : 'Save the world and configure a render backend to enable'}
                      >
                        <Play size={14} />
                      </button>
                    )}
                    <button
                      onClick={() => toggleLockAt(idx)}
                      className={`p-1 rounded ${v.locked ? 'text-port-accent hover:bg-port-accent/20' : 'text-gray-500 hover:text-gray-300'}`}
                      title={v.locked ? 'Locked — AI expand will preserve this variation' : 'Lock this variation against AI expand'}
                      aria-pressed={!!v.locked}
                    >
                      {v.locked ? <Lock size={14} /> : <Unlock size={14} />}
                    </button>
                    <button
                      onClick={() => startEdit(idx, v)}
                      className="p-1 text-gray-400 hover:text-port-accent rounded"
                      title="Edit"
                    >
                      <Edit3 size={14} />
                    </button>
                    <button
                      onClick={() => removeAt(idx)}
                      className="p-1 text-gray-400 hover:text-red-400 rounded"
                      title="Remove"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
