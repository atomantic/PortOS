/**
 * Universe Builder page (Media Gen → Universe Builder).
 *
 * Lets the user describe a universe in one starter prompt, expand it into a
 * full set of style + per-category variation prompts via the LLM of their
 * choice, edit/save the template, and kick off a batch of image renders
 * that all land in a single auto-named collection.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Plus, Trash2, Sparkles, Wand2, Loader2, Save, FolderOpen,
  Edit3, X, MessageSquarePlus, Play, Lock, Unlock,
  ArrowUpCircle, Search, ChevronDown, Check,
  BookOpen, Users, MapPin, Package, Layers, ImagePlus, FolderTree,
} from 'lucide-react';
import toast from '../components/ui/Toast';
import {
  listUniverses, getUniverse, createUniverse, updateUniverse, deleteUniverse, expandUniverse,
  generateCategoryVariations, promoteVariationToCanon,
  renderWorld, listWorldRuns, getProviders, refineWorldPrompts, WORLD_CATEGORIES,
  WORLD_CATEGORY_KEY_MAX, COMPOSITE_PROMPT_MAX, WORLD_LOGLINE_MAX,
  WORLD_PREMISE_MAX, WORLD_STYLE_NOTES_MAX, WORLD_LOCKABLE_FIELDS,
  ensureInfluences, isInfluenceLockField, mergeInfluencesWithLocks,
  listImageModels, listLorasFull, getSettings,
} from '../services/api';
import useClickOutside from '../hooks/useClickOutside';
import { useLocalStoragePersisted } from '../hooks/useLocalStorageBool';
import InfluenceChipsInput from '../components/universeBuilder/InfluenceChipsInput';
import ImageGenSettingsForm from '../components/imageGen/ImageGenSettingsForm';
import { RUNNER_FAMILIES } from '../lib/runnerFamilies';
import ShareToButton from '../components/sharing/ShareToButton';
import OriginBadge from '../components/sharing/OriginBadge';
import UniverseCanonSection from '../components/universe/UniverseCanonSection';
import { deriveAvailableBackends, IMAGE_GEN_MODE } from '../lib/imageGenBackends';
import { PIPELINE_IMAGE_DEFAULTS, readPipelineImageSettings } from '../lib/pipelineImageDefaults';
import { normalizeSlugline } from '../lib/scenePrompt';

const CATEGORY_LABELS = {
  landscapes: 'Landscapes',
  environments: 'Environments',
  structures: 'Structures',
  vehicles: 'Vehicles',
};

// Tab order in the Universe Builder. Bible / Composites / Render are always
// visible; the three canon trunks (Cast / Places / Objects) render even when
// empty so the user has a discoverable target for canon+variation work; Other
// only renders when at least one un-kinded bucket exists.
const TAB_BIBLE = 'bible';
const TAB_CAST = 'cast';
const TAB_PLACES = 'places';
const TAB_OBJECTS = 'objects';
const TAB_OTHER = 'other';
const TAB_COMPOSITES = 'composites';
const TAB_RENDER = 'render';
// Pseudo-bucket key for the canon-only view inside a trunk. Overloads
// `?bucket=` (alongside real bucket keys) AND a `promptMode` value on the
// render route; same string in both contexts to keep the contract consistent.
const BUCKET_CANON = 'canon';
// `kind` doubles as the canon-array key on the universe (`draft[kind]`) and
// the canon-trunk identifier the server's `canonSelection` schema accepts.
const TRUNK_TABS = [
  { id: TAB_CAST, kind: 'characters', label: 'Cast', icon: Users },
  { id: TAB_PLACES, kind: 'settings', label: 'Places', icon: MapPin },
  { id: TAB_OBJECTS, kind: 'objects', label: 'Objects', icon: Package },
];
const TRUNK_BY_ID = Object.fromEntries(TRUNK_TABS.map((t) => [t.id, t]));
const TRUNK_BY_KIND = Object.fromEntries(TRUNK_TABS.map((t) => [t.kind, t]));

// Group category buckets by their `kind` tag. Buckets with an unknown / missing
// kind fall into the `other` bin — that bin drives whether the Other tab shows.
const groupBucketsByKind = (categories = {}) => {
  const out = { characters: [], settings: [], objects: [], other: [] };
  for (const [key, bucket] of Object.entries(categories || {})) {
    const kind = bucket?.kind || 'other';
    if (out[kind]) out[kind].push(key);
    else out.other.push(key);
  }
  return out;
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

// Merge LLM-expanded canon entries into the draft's existing canon array.
// Existing entries always win on collision (lock or no — the user authored
// them; the LLM's repeat is a hallucination at this point). Mirrors the
// server-side dedupe in backfillCanonFromCategories + storyBible's
// MERGE_CONFIG (`storyBible.js` keyFields).
//
// Identity rules are kind-aware to match the server's MERGE_CONFIG:
//   - characters/objects → `normalizeBibleName` (trim + lowercase) on `name`
//                          AND `aliases[]`. Without aliases, an existing
//                          character "Ashley" with alias "Ash" would not
//                          collide with an LLM-returned "Ash", producing a
//                          duplicate canon entry the user has to merge by hand.
//   - settings           → `normalizeSlugline` for BOTH `slugline` AND `name`
//                          (`storyBible.js` MERGE_CONFIG.setting.keyFields).
//                          Without this, sluglines that differ only in dash
//                          style or punctuation ("INT. FOUNDRY CITY — DAY"
//                          vs "INT FOUNDRY CITY - DAY") would land as two
//                          separate place-canon entries, and `Foundry-City`
//                          vs `Foundry City` would duplicate by name even
//                          though every downstream lookup treats them as one.
// Match server's BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX so the client doesn't
// optimistically display + count entries the server will silently truncate
// at sanitize time. Without this cap, the post-expand toast can claim
// "+12 canon entries" while the server-saved record only kept some of them.
const CLIENT_CANON_MAX = 200;

const mergeCanonByName = (existing, fresh, kind = 'character') => {
  // Empty/missing fresh — return `existing` unchanged (preserve reference so
  // a no-op expand doesn't trigger downstream identity-comparing effects).
  if (!fresh?.length) return existing || [];
  const isSetting = kind === 'setting';
  const normName = isSetting
    ? (s) => (typeof s === 'string' ? normalizeSlugline(s) : '')
    : (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');
  const normSlug = (s) => (typeof s === 'string' ? normalizeSlugline(s) : '');
  // Aliases participate in identity for character/object only — settings use
  // slugline collision instead (the server's MERGE_CONFIG.setting has no
  // aliases field).
  const aliasKeys = (entry) => {
    if (isSetting || !Array.isArray(entry?.aliases)) return [];
    return entry.aliases.map(normName).filter(Boolean);
  };
  const seen = new Set();
  for (const e of existing || []) {
    if (e?.name) seen.add(normName(e.name));
    if (e?.slugline) seen.add(normSlug(e.slugline));
    for (const k of aliasKeys(e)) seen.add(k);
  }
  const merged = [...(existing || [])];
  for (const e of fresh) {
    const nameKey = normName(e?.name);
    const sluglineKey = normSlug(e?.slugline);
    const aliasMatches = aliasKeys(e);
    const collides = (nameKey && seen.has(nameKey))
      || (sluglineKey && seen.has(sluglineKey))
      || aliasMatches.some((k) => seen.has(k));
    // On collision, still register every identity key the fresh entry
    // carried — so a *later* fresh entry with overlapping aliases/sluglines
    // is recognized as a within-batch duplicate too. Without this, fresh
    // entry A (collides on alias) gets skipped silently and fresh entry B
    // (uses A's primary name) slips in as a duplicate of the existing record.
    if (nameKey) seen.add(nameKey);
    if (sluglineKey) seen.add(sluglineKey);
    for (const k of aliasMatches) seen.add(k);
    if (collides) continue;
    if (merged.length >= CLIENT_CANON_MAX) break;
    merged.push(e);
  }
  return merged;
};

const humanizeCategory = (key) => CATEGORY_LABELS[key]
  || key.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());

// Toast summary for handleExpand — same body, different tail depending on
// whether the auto-save succeeded.
// `addedCanonCount` is the number of NEW canon entries the expand actually
// contributed (post-merge minus pre-existing) — NOT the draft's total. On a
// universe that already has canon, an expand that adds zero would otherwise
// boast about preserved entries it didn't create. `variationCount` is the
// total because every expand recomputes variations from scratch (locked +
// freshly-generated); the diff isn't meaningful there.
const expandToast = ({ variationCount, sheetCount, addedCanonCount, saved }) => {
  const base = `Expanded into ${variationCount} variations, ${sheetCount} boards, ${addedCanonCount} new canon entries`;
  return `${base} — ${saved ? 'saved' : 'review then Save'}`;
};

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
  // Extended Image Gen surface used by the batch render form. Server accepts
  // these as optional patches on top of the universe's stored influences.
  seed: '',
  negativePrompt: '',
  extraStyle: '',
  stylePreset: null,
  loras: [],
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

// Universe autocomplete combobox: search existing universes or create one when
// the trimmed query doesn't exactly match any. `onCreate` is wired to a
// dedicated create path (not handleSave) so typing a new name while an existing
// universe is selected never accidentally renames it.
const LIST_ID = 'universe-selector-list';
const OPTION_ID_PREFIX = 'universe-option-';
const CREATE_OPTION_ID = 'universe-option-create';

function UniverseSelector({ universes, selectedId, value, onChange, onPick, onCreate, busy }) {
  const wrapRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  // Memoize the close callback so useClickOutside doesn't rebind its window
  // listener on every render of the parent (which re-renders per keystroke).
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(wrapRef, open, close);

  const trimmed = (value || '').trim();
  const lower = trimmed.toLowerCase();

  // Exclude current — clicking it would be a navigation no-op.
  const filtered = useMemo(() => {
    if (!Array.isArray(universes) || universes.length === 0) return [];
    return universes
      .filter((u) => u.id !== selectedId)
      .filter((u) => !lower || (u.name || '').toLowerCase().includes(lower))
      .slice(0, 20);
  }, [universes, selectedId, lower]);

  // exactMatch still considers the current one so renaming-to-same doesn't
  // surface a misleading Create option.
  const exactMatch = useMemo(() => {
    if (!trimmed) return false;
    return (universes || []).some((u) => (u.name || '').trim().toLowerCase() === lower);
  }, [universes, trimmed, lower]);

  const showCreateOption = !!trimmed && !exactMatch;
  const totalItems = filtered.length + (showCreateOption ? 1 : 0);

  // Reset on result change to avoid stale Enter target.
  useEffect(() => { setActiveIdx(0); }, [filtered.length, showCreateOption]);

  const activeOptionId = open
    ? (activeIdx < filtered.length
      ? `${OPTION_ID_PREFIX}${filtered[activeIdx]?.id}`
      : (showCreateOption ? CREATE_OPTION_ID : undefined))
    : undefined;

  const handleKeyDown = (e) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      setOpen(true);
      e.preventDefault();
      return;
    }
    if (!open) return;
    if (e.key === 'Escape') { setOpen(false); e.preventDefault(); return; }
    if (e.key === 'ArrowDown') {
      setActiveIdx((i) => (totalItems ? Math.min(totalItems - 1, i + 1) : 0));
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowUp') {
      setActiveIdx((i) => Math.max(0, i - 1));
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter') {
      if (activeIdx < filtered.length) {
        const u = filtered[activeIdx];
        if (u) { onPick(u.id); setOpen(false); }
        e.preventDefault();
      } else if (showCreateOption) {
        onCreate();
        setOpen(false);
        e.preventDefault();
      }
    }
  };

  return (
    <div ref={wrapRef} className="relative flex-1 min-w-[200px]">
      <div className="relative">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
        <input
          id="universe-name"
          type="text"
          value={value}
          onChange={(e) => { onChange(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder="Search universes or type a new name…"
          className="w-full bg-port-bg border border-port-border rounded pl-8 pr-9 py-2 text-white focus:outline-none focus:border-port-accent"
          maxLength={100}
          autoComplete="off"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={LIST_ID}
          aria-activedescendant={activeOptionId}
        />
        <button
          type="button"
          onClick={() => setOpen((p) => !p)}
          className="absolute right-1 top-1/2 -translate-y-1/2 p-1 text-gray-500 hover:text-white"
          aria-label={open ? 'Close universe list' : 'Open universe list'}
          tabIndex={-1}
        >
          <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>
      {open && (
        <ul
          id={LIST_ID}
          role="listbox"
          className="absolute left-0 right-0 top-full mt-1 z-30 max-h-80 overflow-y-auto bg-port-card border border-port-border rounded shadow-lg"
        >
          {filtered.length === 0 && !showCreateOption && (
            <li className="px-3 py-2 text-xs text-gray-500">
              {(universes?.length || 0) === 0 ? 'No universes yet — type a name and Create.' : 'No matches'}
            </li>
          )}
          {filtered.map((u, i) => (
            <li key={u.id}>
              <button
                type="button"
                id={`${OPTION_ID_PREFIX}${u.id}`}
                role="option"
                aria-selected={u.id === selectedId}
                onClick={() => { onPick(u.id); setOpen(false); }}
                onMouseEnter={() => setActiveIdx(i)}
                className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 ${
                  i === activeIdx ? 'bg-port-bg text-white' : 'text-gray-300 hover:bg-port-bg'
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">{u.name}</div>
                  <div className="text-[11px] text-gray-500 truncate">{u.starterPrompt || 'No starter prompt'}</div>
                </div>
                {u.id === selectedId && <Check size={14} className="text-port-accent" />}
              </button>
            </li>
          ))}
          {showCreateOption && (
            <li>
              <button
                type="button"
                id={CREATE_OPTION_ID}
                role="option"
                aria-selected={false}
                disabled={busy}
                onClick={() => { onCreate(); setOpen(false); }}
                onMouseEnter={() => setActiveIdx(filtered.length)}
                className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 border-t border-port-border disabled:opacity-50 ${
                  activeIdx === filtered.length
                    ? 'bg-port-accent/20 text-port-accent'
                    : 'text-port-accent hover:bg-port-accent/15'
                }`}
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                Create &ldquo;{trimmed}&rdquo;
              </button>
            </li>
          )}
        </ul>
      )}
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
  // Preserve the `?tab=&bucket=` (and `?series=`) query string so the
  // auto-save → create path doesn't snap the user back to the Bible tab
  // after they triggered Generate From Idea from inside Cast/Places/Objects.
  // The stale-bucket effect already strips any bucket that no longer exists
  // under the new universe's categories.
  const goToWorld = (id) => navigate({
    pathname: id ? `${basePath}/${encodeURIComponent(id)}` : basePath,
    search: location.search,
  });

  const [universes, setWorlds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [expanding, setExpanding] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [providers, setProviders] = useState([]);
  const [activeProviderId, setActiveProviderId] = useState(null);
  // Image-gen plumbing for the batch-render form (reused from Image Gen).
  const [imageModels, setImageModels] = useState([]);
  const [availableLoras, setAvailableLoras] = useState([]);
  const [availableBackends, setAvailableBackends] = useState([]);
  const [defaultMode, setDefaultMode] = useState(null);
  // Per-render config used by the embedded Canon section for reference
  // renders (size, steps, etc.). Derived from the same settings fetch as the
  // batch-render plumbing above so we don't round-trip getSettings() twice.
  const [imageCfg, setImageCfg] = useState(PIPELINE_IMAGE_DEFAULTS);

  // The draft is the editable copy of the currently-selected world. New
  // universes start as a draft with no id; saving creates the persisted record.
  const [draft, setDraft] = useState(emptyTemplate());
  // Mount tracker for deferred setState after async work (handlePromoteVariation
  // can run for 5–30s while the LLM thinks). CLAUDE.md "Deferred work must
  // respect both staleness and unmount" — never reset to true so dev-mode
  // double-mount stays clean.
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  // Always-current draft snapshot. Click handlers that close over `draft`
  // can race against in-flight setDraft calls (e.g. handleGenerateInCategory
  // finishes its auto-save between render and click) — read draftRef.current
  // for the freshest local state so PATCH payloads carry the latest merged
  // categories instead of the stale closure value.
  const draftRef = useRef(null);
  useEffect(() => { draftRef.current = draft; }, [draft]);
  // Page-level in-flight gate for the promote action. Ref + state pair so
  // the disable check stays synchronous (ref) while still triggering renders
  // (state). Promote writes to `universe[bibleField]` and `categories[key]`
  // as wholesale replacements from a stale snapshot — letting two run in
  // parallel against the same universe would let the second clobber the
  // first's canon append.
  const [promoting, setPromoting] = useState(false);
  const promotingRef = useRef(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  // True when handleExpand merged new canon entries into the draft that the
  // server doesn't yet know about (auto-save failed or hasn't run). On the
  // next manual Save, include canon arrays in the update payload so the
  // merged entries actually persist. Cleared on successful save and on
  // universe-switch (the new draft's canon is loaded from server, in sync).
  const [canonDirty, setCanonDirty] = useState(false);
  // Sidecar ledger of the EXACT canon entries the last expand merged into
  // the draft but haven't been persisted yet. On save, only these entries
  // are merged onto the refetched server canon — NOT the full stale draft.
  // That avoids resurrecting entries another tab/surface deleted: a deletion
  // wins because our ledger doesn't contain it, so the refetched canon
  // (which already lacks the deleted entry) is the final state. Cleared on
  // successful save and on universe-switch.
  const pendingCanonAdditionsRef = useRef({ characters: [], settings: [], objects: [] });
  const clearPendingCanonAdditions = () => {
    pendingCanonAdditionsRef.current = { characters: [], settings: [], objects: [] };
  };

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

  const refresh = async () => {
    setLoading(true);
    const [list, provData, models, loras, settings] = await Promise.all([
      listUniverses().catch(() => []),
      getProviders().catch(() => ({ providers: [] })),
      listImageModels().catch(() => []),
      listLorasFull().catch(() => []),
      getSettings().catch(() => ({})),
    ]);
    setWorlds(list);
    setProviders(provData.providers || []);
    setActiveProviderId(provData.activeProvider || null);
    setImageModels(models || []);
    setAvailableLoras(Array.isArray(loras) ? loras : []);
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
    setCanonDirty(false);
    clearPendingCanonAdditions();
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

  // Create-from-selector path: builds a universe from just the typed name
  // (everything else empty) and navigates to it. Distinct from handleSave so
  // typing a new name while an existing universe is selected doesn't rename
  // that universe — Create always makes a new record.
  const handleCreateNamed = async (rawName) => {
    const name = (rawName || '').trim();
    if (!name) { toast.error('Name is required'); return; }
    setSaving(true);
    const result = await createUniverse({
      ...emptyTemplate(),
      name,
    }).catch((e) => { toast.error(`Create failed: ${e.message}`); return null; });
    setSaving(false);
    if (!result) return;
    toast.success('World created');
    setWorlds((prev) => {
      const without = prev.filter((w) => w.id !== result.id);
      return [result, ...without];
    });
    goToWorld(result.id);
  };

  const handleSave = async () => {
    if (!draft.name?.trim()) {
      toast.error('Name is required');
      return;
    }
    setSaving(true);
    const basePayload = {
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
    // Canon arrays are wholesale-replaced server-side, so including them on
    // a manual update can clobber concurrent edits from the canon UI / other
    // tabs. Send canon when EITHER:
    //   - creating (new universe needs the expanded canon as initial state)
    //   - the draft has merged-but-unpersisted canon from a failed/skipped
    //     auto-save after expand (`canonDirty`). Without this, the user's
    //     "review then Save" toast doesn't actually persist the new canon.
    // Otherwise the canon UI's own targeted PATCHes own the writes.
    //
    // When sending canon on UPDATE, refetch the server's current canon and
    // merge our local additions onto it — that way concurrent edits from
    // another tab (Nouns stage etc.) aren't clobbered by the stale draft.
    // mergeCanonByName preserves the server entries on identity collision.
    const needsCanonInPayload = !selectedId || canonDirty;
    let payload = basePayload;
    if (needsCanonInPayload) {
      // For create: send the draft's canon as-is (the new universe starts empty).
      // For update with canonDirty: refetch + merge ONLY the pending-additions
      // ledger (not the full stale draft) so concurrent deletions in other
      // tabs aren't resurrected.
      // If the refetch fails for an existing universe, abort the save entirely:
      // falling back to the stale draft would replace the server's canon wholesale
      // and could undo concurrent canon edits/deletions in other tabs.
      if (selectedId) {
        const fresh = await getUniverse(selectedId).catch(() => null);
        if (!fresh) {
          setSaving(false);
          toast.error('Save failed: could not fetch latest canon — please try again');
          return;
        }
        const additions = pendingCanonAdditionsRef.current;
        const baseCanon = {
          characters: mergeCanonByName(fresh.characters || [], additions.characters, 'character'),
          settings: mergeCanonByName(fresh.settings || [], additions.settings, 'setting'),
          objects: mergeCanonByName(fresh.objects || [], additions.objects, 'object'),
        };
        payload = { ...basePayload, ...baseCanon };
      } else {
        const baseCanon = { characters: draft.characters || [], settings: draft.settings || [], objects: draft.objects || [] };
        payload = { ...basePayload, ...baseCanon };
      }
    }
    const result = selectedId
      ? await updateUniverse(selectedId, payload).catch((e) => { toast.error(`Save failed: ${e.message}`); return null; })
      : await createUniverse(payload).catch((e) => { toast.error(`Save failed: ${e.message}`); return null; });
    setSaving(false);
    if (result) {
      // Save persisted whatever canon was in the payload; clear the dirty
      // flag so the next save can resume the "skip canon to avoid clobber"
      // path. No-op if it was already false. Also drain the pending-additions
      // ledger since those entries are now on the server.
      if (needsCanonInPayload) {
        setCanonDirty(false);
        clearPendingCanonAdditions();
      }
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
      // Preserve the bucket's `kind` so the category-to-canon-trunk contract
      // survives the round-trip. Precedence:
      //   - existing non-'other' draft kind (user curated it to a specific trunk)
      //   - LLM-returned kind for this expand round (fresh classification)
      //   - existing 'other' draft kind (Phase-B default for custom buckets)
      //   - undefined (server's sanitizeCategory falls back to default-map / 'other')
      // Allowing a fresh LLM kind to supersede an existing 'other' is intentional:
      // pre-Phase-B "factions" buckets saved as `other` can be promoted to
      // `characters` by a re-expand without requiring the user to manually change
      // the trunk. User-curated non-`other` kinds (e.g. `settings`) are preserved.
      const existingKind = draft.categories?.[cat]?.kind;
      const freshKind = llmCategories[cat]?.kind;
      const kind = (existingKind && existingKind !== 'other') ? existingKind : (freshKind || existingKind);
      mergedCategories[cat] = {
        ...(kind ? { kind } : {}),
        variations: mergeVariations(locked, fresh),
      };
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

    // Merge LLM-emitted canon arrays into the draft's existing canon. Existing
    // entries always win on name/slugline collision so a re-expand can't
    // clobber hand-authored or series-extracted records. mergeCanonByName
    // short-circuits when `fresh` is empty so identity is preserved.
    //
    // `kind` is passed so settings use `normalizeSlugline` for both `name` and
    // `slugline` (matching the server's MERGE_CONFIG.setting.keyFields) —
    // dash/punct-variant identifiers collide instead of duplicating.
    const pickCanon = (key, kind) => mergeCanonByName(
      draft[key] || [],
      Array.isArray(result[key]) ? result[key] : [],
      kind,
    );
    const mergedCharacters = pickCanon('characters', 'character');
    const mergedSettings = pickCanon('settings', 'setting');
    const mergedObjects = pickCanon('objects', 'object');
    // Count NEW canon entries this expand added (post-merge minus pre-existing).
    // Used by the toast so a re-expand on a populated universe doesn't claim
    // credit for entries the user already authored. Existing entries always win
    // on collision in mergeCanonByName, so the delta is always non-negative.
    const addedCanonCount =
      (mergedCharacters.length - (draft.characters?.length || 0))
      + (mergedSettings.length - (draft.settings?.length || 0))
      + (mergedObjects.length - (draft.objects?.length || 0));

    const expandedDraft = {
      ...draft,
      starterPrompt: pick('starterPrompt', result.starterPrompt),
      logline: pick('logline', result.logline),
      premise: pick('premise', result.premise),
      styleNotes: pick('styleNotes', result.styleNotes),
      influences: refinedInfluences,
      categories: ensureDraftCategories(mergedCategories),
      compositeSheets: mergedSheets,
      characters: mergedCharacters,
      settings: mergedSettings,
      objects: mergedObjects,
      llm: result.llm || draft.llm,
    };
    setDraft(expandedDraft);
    // Flag the merged-but-not-yet-persisted canon so a subsequent manual
    // Save (if auto-save fails or is bypassed) includes the new entries.
    // Record exactly which entries we added (vs. what was already in the
    // draft) so the save-time merge only re-applies the new ones, not the
    // full stale draft.
    if (addedCanonCount > 0) {
      setCanonDirty(true);
      const computeAdditions = (existing, merged) => {
        const norm = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');
        const existingNames = new Set((existing || []).map((e) => norm(e?.name)).filter(Boolean));
        const existingSluglines = new Set((existing || []).map((e) => norm(e?.slugline)).filter(Boolean));
        return (merged || []).filter((e) => {
          const n = norm(e?.name);
          const s = norm(e?.slugline);
          return !(n && existingNames.has(n)) && !(s && existingSluglines.has(s));
        });
      };
      pendingCanonAdditionsRef.current = {
        characters: [...pendingCanonAdditionsRef.current.characters, ...computeAdditions(draft.characters, mergedCharacters)],
        settings: [...pendingCanonAdditionsRef.current.settings, ...computeAdditions(draft.settings, mergedSettings)],
        objects: [...pendingCanonAdditionsRef.current.objects, ...computeAdditions(draft.objects, mergedObjects)],
      };
    }
    const lockedKeys = Object.keys(locks).filter((k) => locks[k]);
    if (lockedKeys.length) {
      console.log(`🔒 Universe Builder expand preserved ${lockedKeys.length} locked field(s): ${lockedKeys.join(', ')}`);
    }
    const total = totalVariationCount(expandedDraft);
    if (expandedDraft.compositeSheets?.length) {
      setRenderOpts((r) => ({ ...r, promptMode: 'sheets' }));
    }
    // Auto-persist expansion when the draft has a name. Updates the existing
    // record when one is selected; creates a new one when the user has only
    // typed a name + starter prompt and clicked Expand. The create path is
    // important for the canon section's visibility — it's gated on
    // `selectedId && draft.id === selectedId`, so without an id the user
    // can't see/manage the canon arrays just merged into the draft.
    //
    // Wrap the auto-save in `setSaving(true/false)` so the Create button
    // (disabled={saving || ...}) can't double-submit during the await window
    // between expanding=false and goToWorld(saved.id).
    if (expandedDraft.name?.trim()) {
      // Set saving BEFORE the refetch so the Expand + Save buttons
      // (both disabled on `saving`) can't double-fire during the
      // getUniverse await window below.
      setSaving(true);
      // For updates: refetch the server's canon and merge in ONLY the local
      // additions ledger so a concurrent canon edit (Nouns stage, another tab)
      // landing during the LLM call isn't wholesale-clobbered. If the refetch
      // fails for an existing record, skip the auto-save (mark canonDirty so
      // the user can retry via manual Save) rather than falling back to the
      // stale draft, which would replace the server's canon wholesale and undo
      // any concurrent deletions/edits.
      let canonForPayload = {
        characters: expandedDraft.characters || [],
        settings: expandedDraft.settings || [],
        objects: expandedDraft.objects || [],
      };
      if (selectedId) {
        const fresh = await getUniverse(selectedId).catch(() => null);
        if (!fresh) {
          // Refetch failed — skip auto-save for this update to avoid a stale
          // canon write. The new entries are already in the draft and the
          // canonDirty flag is already set, so the user's manual Save will
          // retry the refetch+merge path.
          setSaving(false);
          toast.success(expandToast({
            variationCount: total,
            sheetCount: expandedDraft.compositeSheets?.length || 0,
            addedCanonCount,
            saved: false,
          }));
          return;
        }
        canonForPayload = {
          // Merge ONLY pending additions onto refetched server canon
          // (not the full stale draft). Without this, concurrent canon
          // deletions in other tabs/surfaces get resurrected because the
          // deleted entry is still present in the stale draft.
          characters: mergeCanonByName(fresh.characters || [], pendingCanonAdditionsRef.current.characters, 'character'),
          settings: mergeCanonByName(fresh.settings || [], pendingCanonAdditionsRef.current.settings, 'setting'),
          objects: mergeCanonByName(fresh.objects || [], pendingCanonAdditionsRef.current.objects, 'object'),
        };
      }
      const payload = {
        name: expandedDraft.name.trim(),
        starterPrompt: expandedDraft.starterPrompt || '',
        logline: expandedDraft.logline || '',
        premise: expandedDraft.premise || '',
        styleNotes: expandedDraft.styleNotes || '',
        categories: expandedDraft.categories,
        compositeSheets: expandedDraft.compositeSheets || [],
        ...canonForPayload,
        influences: ensureInfluences(expandedDraft.influences),
        locked: expandedDraft.locked || {},
        llm: expandedDraft.llm || {},
      };
      // setSaving(true) already happened before the getUniverse refetch
      // above so the disable-gate covers the whole save sequence.
      const saved = await (selectedId
        ? updateUniverse(selectedId, payload)
        : createUniverse(payload))
        .catch((e) => { toast.error(`Auto-save after expand failed: ${e.message}`); return null; })
        .finally(() => setSaving(false));
      if (saved) {
        setWorlds((prev) => {
          const without = prev.filter((w) => w.id !== saved.id);
          return [saved, ...without];
        });
        // Auto-save succeeded — server now has the merged canon, so a
        // subsequent manual Save shouldn't re-send it (avoids the
        // concurrent-edit clobber). Drain the additions ledger too since
        // those entries are now on the server.
        setCanonDirty(false);
        clearPendingCanonAdditions();
        // New record: route to its id so the canon section gates flip and
        // subsequent draft state reflects the persisted record.
        if (!selectedId) goToWorld(saved.id);
        toast.success(expandToast({
          variationCount: total,
          sheetCount: expandedDraft.compositeSheets?.length || 0,
          addedCanonCount,
          saved: true,
        }));
        return;
      }
    }
    toast.success(expandToast({
      variationCount: total,
      sheetCount: expandedDraft.compositeSheets?.length || 0,
      addedCanonCount,
      saved: false,
    }));
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
  //   { promptMode, selection?, sheetSelection?, canonSelection? } — see
  //   server renderSchema.
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
    // Server contract: `compilePrompts` in canon/all modes only emits canon
    // prompts when `canonSelection` is non-null (missing key skips the trunk
    // entirely). When the user picks "canon" or "all" in the Render tab and
    // clicks the bare "Render N images" button (no scope), the UI count
    // already includes canon — so default the payload to "every trunk → all"
    // so the server actually compiles them. Scoped calls always pass their
    // own canonSelection and bypass this default.
    const needsCanonDefault = !scope && (promptMode === 'canon' || promptMode === 'all');
    const effectiveCanonSelection = scope?.canonSelection
      ?? (needsCanonDefault
        ? Object.fromEntries(TRUNK_TABS.map((t) => [t.kind, 'all']))
        : undefined);
    // Per-batch overrides from the ImageGenSettingsForm. Empty strings →
    // undefined so the server falls back to the universe's stored influences.
    // Seed coerces to a non-negative int (matching /api/image-gen/generate
    // semantics) — non-numeric strings become undefined rather than NaN.
    const seedRaw = renderOpts.seed;
    const seedNum = seedRaw === '' || seedRaw == null ? null : Number(seedRaw);
    const seed = Number.isFinite(seedNum) && seedNum >= 0 ? Math.trunc(seedNum) : undefined;
    const loras = Array.isArray(renderOpts.loras) && renderOpts.loras.length
      ? renderOpts.loras
      : undefined;
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
      canonSelection: effectiveCanonSelection,
      seed,
      negativePrompt: renderOpts.negativePrompt?.trim() || undefined,
      extraStyle: renderOpts.extraStyle?.trim() || undefined,
      stylePresetId: renderOpts.stylePreset?.id || undefined,
      loras,
    }).catch((e) => { toast.error(`Render failed: ${e.message}`); return null; });
    setRendering(false);
    if (!result) return;
    toast.success(`Queued ${result.promptCount} renders → "${result.collectionName}"`);
    const updated = await listWorldRuns(selectedId).catch(() => runs);
    setRuns(updated);
  };

  // RenderTab and per-trunk Bulk-render buttons pass a scope object; the
  // bare "Render N images" button passes nothing (= use the renderOpts).
  const handleRender = (scope = null) => runRender(scope);

  const canRender = !!selectedId && availableBackends.length > 0 && !rendering;

  const updateDraft = (patch) => setDraft((d) => ({ ...d, ...patch }));

  // Canon mutations (extract / refine / differentiate / lock / render-ref)
  // round-trip through the server and return the full universe. Only the
  // canon arrays + their updatedAt timestamp flow back into the draft so
  // unsaved edits to logline/premise/styleNotes aren't clobbered by the
  // server's stale copy of those fields.
  const handleCanonChange = (updated) => {
    if (!updated) return;
    setDraft((d) => {
      // If a prior expand merged canon that hasn't been persisted yet,
      // mergeCanonByName ONLY the pending additions (not the full stale
      // draft) against the server's response. Using the additions ledger
      // means concurrent canon deletions (which the server's response
      // already reflects) win — pending additions are still preserved.
      if (canonDirty) {
        const additions = pendingCanonAdditionsRef.current;
        return {
          ...d,
          characters: mergeCanonByName(updated.characters || [], additions.characters, 'character'),
          settings: mergeCanonByName(updated.settings || [], additions.settings, 'setting'),
          objects: mergeCanonByName(updated.objects || [], additions.objects, 'object'),
          updatedAt: updated.updatedAt,
        };
      }
      return {
        ...d,
        characters: updated.characters,
        settings: updated.settings,
        objects: updated.objects,
        updatedAt: updated.updatedAt,
      };
    });
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
    // Preserve the bucket's `kind` (which the server sanitizer would
    // otherwise re-derive from defaults/`other` on the next save). Without
    // this, every user edit to a custom bucket silently resets its canon
    // trunk to `other`.
    categories: { ...d.categories, [cat]: { ...(d.categories?.[cat] || {}), variations } },
  }));
  // Retag an Other-tab bucket as a canon trunk (Cast / Places / Objects).
  // Variations stay in place; the bucket simply moves out of the Other tab
  // into the matching trunk on next render via groupBucketsByKind.
  const assignBucketKind = async (bucket, targetKind) => {
    if (!TRUNK_BY_KIND[targetKind]) return;
    // Read from draftRef so a generate's just-landed auto-save (which set
    // draft via setDraft) is visible here even if React hasn't committed a
    // re-render yet — without this, the PATCH below could overwrite the new
    // variations with the closure's stale ones.
    const latestDraft = draftRef.current || draft;
    const current = latestDraft.categories?.[bucket];
    if (!current) return;
    const nextBucket = { ...current, kind: targetKind };
    // Only the affected bucket is sent in the PATCH — the server's categories
    // patch is keyed (per-bucket replace), so omitting other keys leaves them
    // untouched. That keeps concurrent edits to other buckets safe even when
    // this handler raced an in-flight setDraft.
    setDraft((d) => ({
      ...d,
      categories: {
        ...d.categories,
        [bucket]: { ...(d.categories?.[bucket] || current), kind: targetKind },
      },
    }));
    const trunk = TRUNK_BY_KIND[targetKind];
    if (!selectedId) {
      toast.success(`Tagged "${humanizeCategory(bucket)}" as ${trunk.label} — save to persist`);
      return;
    }
    const updated = await updateUniverse(selectedId, { categories: { [bucket]: nextBucket } }, { silent: true })
      .catch((e) => { toast.error(`Move failed: ${e.message}`); return null; });
    if (updated) {
      setWorlds((prev) => {
        const without = prev.filter((w) => w.id !== updated.id);
        return [updated, ...without];
      });
      toast.success(`Moved "${humanizeCategory(bucket)}" to ${trunk.label}`);
    }
  };
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
      // Preserve the bucket's `kind` (mirror of updateCategory's behavior;
      // see comment there). Generate-more is the second write path that
      // could silently reset the trunk to default/other.
      categories: { ...draft.categories, [cat]: { ...(draft.categories?.[cat] || {}), variations: merged } },
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
  // Requires `selectedId` — the server action reads the persisted record,
  // so an unsaved draft can't be promoted from. The page-level `promoting`
  // gate prevents two promotes (across buckets or trunks) from racing each
  // other to stale-snapshot writes against the same universe.
  const handlePromoteVariation = async (category, variation, { targetKind } = {}) => {
    if (!selectedId) {
      toast.error('Save the universe first — promote needs the persisted record');
      return;
    }
    if (!variation?.label) return;
    if (promotingRef.current) return;
    promotingRef.current = true;
    setPromoting(true);
    const capturedId = selectedId;
    const toastId = toast.loading(`Promoting "${variation.label}" to canon…`);
    const result = await promoteVariationToCanon(selectedId, {
      category,
      label: variation.label,
      targetKind,
      providerId: draft.llm?.provider || undefined,
      model: draft.llm?.model || undefined,
    }, { silent: true }).catch((e) => {
      toast.dismiss(toastId);
      toast.error(`Promote failed: ${e.message}`);
      return null;
    });
    if (mountedRef.current) {
      promotingRef.current = false;
      setPromoting(false);
    }
    if (!result?.universe) return;
    const updated = result.universe;
    // Always update the cached list — even when the user navigated away mid-
    // flight, the persisted shape changed and other surfaces should see it.
    setWorlds((prev) => {
      const without = prev.filter((w) => w.id !== updated.id);
      return [updated, ...without];
    });
    // Guard: if the user navigated to a different universe during the LLM
    // call, the response belongs to the previous one — don't clobber the
    // new draft. The list update above still surfaces the change.
    if (!mountedRef.current || capturedId !== selectedId) return;
    // Selective merge: only the canon array + the affected category bucket
    // changed server-side. Preserve every other draft field (the user may
    // have typed into logline/premise/influences during the LLM call).
    setDraft((d) => ({
      ...d,
      characters: updated.characters,
      settings: updated.settings,
      objects: updated.objects,
      categories: { ...d.categories, [result.removed.category]: updated.categories?.[result.removed.category] },
      schemaVersion: updated.schemaVersion,
      updatedAt: updated.updatedAt,
    }));
    toast.dismiss(toastId);
    toast.success(`Promoted "${variation.label}" → ${result.targetKind} canon`);
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

  // URL-driven tab + bucket state (per CLAUDE.md "Linkable routes for all
  // views"). `?tab=cast&bucket=heroes` deep-links into a sub-bucket; both fall
  // back to bible / "" (All) on first load. We also forward existing params
  // (e.g. `?series=` on the embedded Canon section) untouched.
  const [searchParams, setSearchParams] = useSearchParams();
  const bucketsByKind = useMemo(() => groupBucketsByKind(draft.categories), [draft.categories]);
  const hasOtherBuckets = bucketsByKind.other.length > 0;
  const requestedTab = searchParams.get('tab');
  const isValidTab = (tab) => (
    tab === TAB_BIBLE || tab === TAB_CAST || tab === TAB_PLACES || tab === TAB_OBJECTS
    || tab === TAB_COMPOSITES || tab === TAB_RENDER
    || (tab === TAB_OTHER && hasOtherBuckets)
  );
  const activeTab = isValidTab(requestedTab) ? requestedTab : TAB_BIBLE;
  const activeBucket = searchParams.get('bucket') || '';
  const setTab = useCallback((tab, opts = {}) => {
    const currentTab = searchParams.get('tab') || TAB_BIBLE;
    const isSameTab = tab === currentTab;
    const next = new URLSearchParams(searchParams);
    if (tab === TAB_BIBLE) next.delete('tab');
    else next.set('tab', tab);
    // Bucket behavior:
    //   - explicit `opts.bucket` value (string) → set
    //   - explicit `opts.bucket: null` → clear (callers that want to drop the
    //     filter on the same tab pass null intentionally)
    //   - omitted + same tab → preserve current bucket (re-clicking the
    //     active tab shouldn't drop the user's chip/canon filter)
    //   - omitted + tab transition → clear (the old bucket is meaningless on
    //     the new tab's bucket namespace)
    if (opts.bucket === null) next.delete('bucket');
    else if (opts.bucket) next.set('bucket', opts.bucket);
    else if (!isSameTab) next.delete('bucket');
    setSearchParams(next, { replace: !!opts.replace });
  }, [searchParams, setSearchParams]);
  // Explicit user bucket clicks push a history entry so back/forward actually
  // walks tab+bucket navigation (the PR's headline deep-link promise). The
  // stale-bucket-cleanup effect below uses `replace: true` directly so an
  // implicit URL fix-up doesn't fork the history stack.
  const setBucket = useCallback((bucket, opts = {}) => {
    const next = new URLSearchParams(searchParams);
    if (bucket) next.set('bucket', bucket);
    else next.delete('bucket');
    setSearchParams(next, { replace: !!opts.replace });
  }, [searchParams, setSearchParams]);

  // Drop a stale `?tab=` if it points to an unknown value or `tab=other`
  // when the user has emptied the Other bucket bin. Without this, the URL
  // and UI disagree: `activeTab` silently falls back to Bible but the param
  // stays in the address bar — breaking the deep-link promise and confusing
  // back/forward.
  useEffect(() => {
    if (!requestedTab) return;
    if (isValidTab(requestedTab)) return;
    const next = new URLSearchParams(searchParams);
    next.delete('tab');
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedTab, hasOtherBuckets]);

  // Drop a stale `?bucket=` if the bucket no longer exists under the current
  // tab (e.g. user deleted the bucket, or auto-sort moved it to another kind).
  // `BUCKET_CANON` is a valid pseudo-bucket on every trunk tab — without an
  // explicit allow, the chip's `setBucket(BUCKET_CANON)` flashed in the URL
  // then immediately got stripped by this effect, hiding the canon-only view.
  // Other tab buckets must validate against `bucketsByKind.other`; non-trunk
  // non-Other tabs (Bible / Composites / Render) have no valid bucket scope.
  useEffect(() => {
    if (!activeBucket) return;
    const trunk = TRUNK_BY_ID[activeTab];
    if (trunk && activeBucket === BUCKET_CANON) return;
    const validBuckets = trunk
      ? (bucketsByKind[trunk.kind] || [])
      : (activeTab === TAB_OTHER ? bucketsByKind.other : []);
    if (validBuckets.includes(activeBucket)) return;
    const next = new URLSearchParams(searchParams);
    next.delete('bucket');
    setSearchParams(next, { replace: true });
  }, [activeTab, activeBucket, bucketsByKind, searchParams, setSearchParams]);

  return (
    <div className="flex flex-col h-full">
      <section className="flex-1 flex flex-col gap-3 p-4 min-h-0 overflow-y-auto">
        {/* Thin action header — autocomplete universe selector doubles as the
            name field; Save + Share + Delete sit beside it so they're reachable
            from any tab. The Bible-tab actions (Generate / Refine, starter
            idea, story-bible fields) live inside the Bible tab itself, per
            Phase C "Bible is its own tab". */}
        <header className="bg-port-card border border-port-border rounded p-3 flex items-center gap-2 flex-wrap">
          <UniverseSelector
            universes={universes}
            selectedId={selectedId}
            value={draft.name || ''}
            onChange={(name) => updateDraft({ name })}
            onPick={(id) => goToWorld(id)}
            onCreate={() => handleCreateNamed(draft.name)}
            busy={saving || loading}
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
        </header>

        <TabNav
          activeTab={activeTab}
          setTab={setTab}
          hasOtherBuckets={hasOtherBuckets}
          counts={{
            cast: (draft.characters?.length || 0) + bucketsByKind.characters.reduce((n, k) => n + (draft.categories?.[k]?.variations?.length || 0), 0),
            places: (draft.settings?.length || 0) + bucketsByKind.settings.reduce((n, k) => n + (draft.categories?.[k]?.variations?.length || 0), 0),
            objects: (draft.objects?.length || 0) + bucketsByKind.objects.reduce((n, k) => n + (draft.categories?.[k]?.variations?.length || 0), 0),
            other: bucketsByKind.other.reduce((n, k) => n + (draft.categories?.[k]?.variations?.length || 0), 0),
            composites: totalSheets,
          }}
        />

        {activeTab === TAB_BIBLE && (
          <BibleTab
            draft={draft}
            updateDraft={updateDraft}
            toggleLock={toggleLock}
            llm={{ providers, providerModels, providerLabel, activeProviderId }}
            handleExpand={handleExpand}
            expanding={expanding}
            saving={saving}
            refine={{
              open: refineOpen, setOpen: setRefineOpen,
              feedback: refineFeedback, setFeedback: setRefineFeedback,
              run: runRefine, running: refining, reset: resetRefinePanel,
              rationale: refineRationale, changes: refineChanges,
            }}
            totalVariations={totalVariations}
            categoryKeyCount={categoryKeys.length}
            totalSheets={totalSheets}
          />
        )}

        {TRUNK_TABS.map((trunk) => (
          activeTab === trunk.id ? (
            <TrunkView
              key={trunk.id}
              trunk={trunk}
              draft={draft}
              selectedId={selectedId}
              buckets={bucketsByKind[trunk.kind] || []}
              activeBucket={activeBucket}
              setBucket={setBucket}
              canRender={canRender}
              canPromote={!!selectedId && !promoting}
              imageCfg={imageCfg}
              onUniverseChange={handleCanonChange}
              onRemoveBucket={removeCategory}
              onUpdateBucket={updateCategory}
              onGenerateInBucket={handleGenerateInCategory}
              onPromoteVariation={(bucket, v) => handlePromoteVariation(bucket, v)}
              onBulkRenderBucket={(bucket) => runRender({ promptMode: 'variations', selection: { [bucket]: 'all' } })}
              onRenderVariation={(bucket, v) => runRender({ promptMode: 'variations', selection: { [bucket]: [v.label] } })}
              onBulkRenderTrunk={() => {
                const selection = Object.fromEntries(
                  (bucketsByKind[trunk.kind] || []).map((b) => [b, 'all']),
                );
                const canonSelection = { [trunk.kind]: 'all' };
                // Empty sheetSelection opts out of composite sheets — without
                // it, the server's `sheetSelection || 'all'` default would
                // queue every sheet alongside the trunk's canon + variations,
                // overshooting the user-facing "N images" count.
                runRender({ promptMode: 'all', selection, canonSelection, sheetSelection: [] });
              }}
              onAddBucket={({ key }) => {
                setDraft((d) => ({
                  ...d,
                  categories: { ...d.categories, [key]: { kind: trunk.kind, variations: [] } },
                }));
              }}
            />
          ) : null
        ))}

        {activeTab === TAB_OTHER && hasOtherBuckets && (
          <OtherTab
            draft={draft}
            buckets={bucketsByKind.other}
            activeBucket={activeBucket}
            setBucket={setBucket}
            canRender={canRender}
            canPromote={!!selectedId && !promoting}
            onUpdateBucket={updateCategory}
            onRemoveBucket={removeCategory}
            onGenerateInBucket={handleGenerateInCategory}
            onPromoteVariation={(bucket, v, opts) => handlePromoteVariation(bucket, v, opts)}
            onBulkRenderBucket={(bucket) => runRender({ promptMode: 'variations', selection: { [bucket]: 'all' } })}
            onRenderVariation={(bucket, v) => runRender({ promptMode: 'variations', selection: { [bucket]: [v.label] } })}
            onAssignBucketKind={assignBucketKind}
            onAutoSort={() => {
              toast('Auto-sort with AI is wired in a follow-up. Re-run "Generate From Idea" — Phase B\'s expand call now classifies buckets into the right trunk.', { icon: 'ℹ️' });
            }}
          />
        )}

        {activeTab === TAB_COMPOSITES && (
          <>
            <CompositeSheetsEditor
              sheets={draft.compositeSheets || []}
              onChange={updateCompositeSheets}
              canRender={canRender}
              onRender={(sheet) => runRender({ promptMode: 'sheets', sheetSelection: [sheet.label] })}
            />
            {/* Add-bucket row stays available here for power users who want to
                introduce a brand-new custom bucket without going through
                expand. New buckets default to kind='other' so they land under
                the Other tab. */}
            <section className="bg-port-card border border-port-border rounded p-3 flex items-center gap-2 flex-wrap">
              <span className="text-xs text-gray-400 mr-1">Add a custom sub-bucket (lands under Other):</span>
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
            </section>
          </>
        )}

        {activeTab === TAB_RENDER && (
          <RenderTab
            draft={draft}
            selectedId={selectedId}
            bucketsByKind={bucketsByKind}
            renderOpts={renderOpts}
            setRenderOpts={setRenderOpts}
            availableBackends={availableBackends}
            defaultMode={defaultMode}
            imageModels={imageModels}
            availableLoras={availableLoras}
            handleRender={handleRender}
            rendering={rendering}
            runs={runs}
          />
        )}
      </section>
    </div>
  );
}

function totalVariationCount(world) {
  return getCategoryKeys(world.categories).reduce((n, c) => n + (world.categories?.[c]?.variations?.length || 0), 0);
}

// Match server-side `synthesizeCanonPrompt` (server/services/universeBuilder.js)
// per-kind: entries with no identity-anchor (name / slugline / hand-authored
// prompt) AND no descriptive content for that kind compile to an empty seed and
// get skipped. Mirror the predicate here so the "Render N images" button count
// doesn't overshoot what the server will actually enqueue.
//
// IMPORTANT: keep the per-kind field lists in sync with server's
// `synthesizeCanonPrompt`. Drift between client/server here makes scoped render
// counts and disabled states lie about what will actually be enqueued.
// Server's `synthesizeCanonPrompt` trims each string field before pushing into
// `parts` and then filters out empty results via `String(p).trim().filter(Boolean)`.
// A whitespace-only field doesn't anchor renderability there — mirror that here
// so client-side counts/disable states agree under optimistic edits.
const hasNonBlankString = (v) => typeof v === 'string' && v.trim().length > 0;

const canonEntryHasContent = (e, kind) => {
  if (!e) return false;
  if (hasNonBlankString(e.prompt)) return true;
  // Identifier anchors per kind — settings allow slugline-only entries (bible
  // sanitizer); characters/objects ignore stray slugline. Mirrors server
  // synthesizeCanonPrompt's identifier-seed rule.
  if (hasNonBlankString(e.name)) return true;
  if (kind === 'settings' && hasNonBlankString(e.slugline)) return true;
  if (kind === 'characters') {
    return hasNonBlankString(e.physicalDescription) || hasNonBlankString(e.role);
  }
  if (kind === 'settings') {
    return hasNonBlankString(e.description) || hasNonBlankString(e.palette)
      || hasNonBlankString(e.era) || hasNonBlankString(e.weather)
      || hasNonBlankString(e.recurringDetails);
  }
  if (kind === 'objects') {
    return hasNonBlankString(e.description) || hasNonBlankString(e.significance);
  }
  // Unknown kind — fall back to the inclusive union so an unrecognized trunk
  // doesn't silently collapse to 0.
  return hasNonBlankString(e.physicalDescription) || hasNonBlankString(e.description)
    || hasNonBlankString(e.palette) || hasNonBlankString(e.era) || hasNonBlankString(e.weather)
    || hasNonBlankString(e.recurringDetails) || hasNonBlankString(e.role)
    || hasNonBlankString(e.significance);
};

const countCanonWithContent = (world, kind) =>
  (Array.isArray(world?.[kind]) ? world[kind] : []).filter((e) => canonEntryHasContent(e, kind)).length;

function renderPromptCount(world, promptMode = 'variations') {
  const variations = totalVariationCount(world);
  const sheets = world.compositeSheets?.length || 0;
  const canon = countCanonWithContent(world, 'characters')
    + countCanonWithContent(world, 'settings')
    + countCanonWithContent(world, 'objects');
  if (promptMode === 'sheets') return sheets;
  if (promptMode === 'canon') return canon;
  if (promptMode === 'all') return variations + sheets + canon;
  return variations;
}

// Mirrors the server's compilePrompts for selection/sheetSelection/canonSelection
// so an inline "Render" button can disable itself + show an accurate count
// without a round trip.
//
// Defaulting rules — mirror server/services/universeBuilder.js compilePrompts:
//   - sheets/all + no sheetSelection → render every sheet (server defaults to 'all')
//   - variations/all + no selection → render every category (server falls back
//     to a full category map via getWorldCategoryKeys)
//   - canon/all + no canonSelection → render NOTHING (server gates on a non-null
//     canonSelection; missing key skips the trunk entirely)
// Canon entries are filtered through `canonEntryHasContent(kind)` since the
// server skips entries whose synthesized seed is empty.
function scopedPromptCount(world, scope) {
  if (!scope) return 0;
  const mode = scope.promptMode || 'variations';
  let n = 0;
  if (mode === 'sheets' || mode === 'all') {
    const sheets = world.compositeSheets || [];
    if (scope.sheetSelection === 'all' || scope.sheetSelection === undefined || scope.sheetSelection === null) {
      // Both `sheets` and `all` default to every sheet when sheetSelection is
      // omitted — server: `options.sheetSelection || 'all'`.
      n += sheets.length;
    } else if (Array.isArray(scope.sheetSelection)) {
      const set = new Set(scope.sheetSelection.map((s) => s.toLowerCase()));
      n += sheets.filter((s) => set.has((s.label || '').toLowerCase())).length;
    }
  }
  if (mode === 'variations' || mode === 'all') {
    if (scope.selection) {
      for (const [cat, pick] of Object.entries(scope.selection)) {
        const vars = world.categories?.[cat]?.variations || [];
        if (pick === 'all') n += vars.length;
        else if (Array.isArray(pick)) {
          const labels = new Set(pick.map((p) => p.toLowerCase()));
          n += vars.filter((v) => labels.has((v.label || '').toLowerCase())).length;
        }
      }
    } else {
      // No selection ⇒ server treats this as "every category, all variations".
      n += totalVariationCount(world);
    }
  }
  if (mode === 'canon' || mode === 'all') {
    if (scope.canonSelection) {
      for (const trunk of ['characters', 'settings', 'objects']) {
        const pick = scope.canonSelection[trunk];
        if (!pick) continue;
        const entries = Array.isArray(world[trunk]) ? world[trunk] : [];
        const withContent = entries.filter((e) => canonEntryHasContent(e, trunk));
        if (pick === 'all') n += withContent.length;
        else if (Array.isArray(pick)) {
          const needles = new Set(pick.map((p) => p.toLowerCase()));
          // Mirror server: slugline matching is settings-only — name is the
          // shared anchor for characters/objects.
          n += withContent.filter((e) => {
            const name = (e.name || '').toLowerCase();
            if (needles.has(name)) return true;
            if (trunk === 'settings') {
              const slug = (e.slugline || '').toLowerCase();
              if (needles.has(slug)) return true;
            }
            return false;
          }).length;
        }
      }
    }
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

export function CategoryEditor({
  category, variations, canRemove = false, onChange, onRemove,
  canRender = false, onRenderCategory = null, onRenderVariation = null,
  onGenerate = null,
  // `bucketKind` drives the promote-button UX: when `'other'` (or absent)
  // the picker opens to choose a trunk; otherwise we promote directly.
  // `canPromote` gates on universe-persisted (the action reads the saved record).
  canPromote = false, bucketKind = null, onPromote = null,
  // Only set by OtherTab — clicking opens a picker that retags the bucket's
  // `kind` to a canon trunk. Variations stay in place; bucket moves tabs.
  onAssignBucketKind = null,
}) {
  const requiresTargetKind = !TRUNK_BY_KIND[bucketKind];
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newPrompt, setNewPrompt] = useState('');
  const [editIdx, setEditIdx] = useState(null);
  const [editLabel, setEditLabel] = useState('');
  const [editPrompt, setEditPrompt] = useState('');
  const [genOpen, setGenOpen] = useState(false);
  const [genCustom, setGenCustom] = useState('');
  const [generating, setGenerating] = useState(false);
  const [promotingIdx, setPromotingIdx] = useState(null);
  const [pickerIdx, setPickerIdx] = useState(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const genWrapRef = useRef(null);
  const pickerWrapRef = useRef(null);
  const assignWrapRef = useRef(null);

  useClickOutside(genWrapRef, genOpen, () => setGenOpen(false));
  useClickOutside(pickerWrapRef, pickerIdx !== null, () => setPickerIdx(null));
  useClickOutside(assignWrapRef, assignOpen, () => setAssignOpen(false));
  useEffect(() => {
    if (!genOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setGenOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [genOpen]);
  useEffect(() => {
    if (pickerIdx === null) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setPickerIdx(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [pickerIdx]);
  useEffect(() => {
    if (!assignOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setAssignOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [assignOpen]);

  const editorMountedRef = useRef(true);
  useEffect(() => () => { editorMountedRef.current = false; }, []);
  const runPromote = async (idx, variation, opts) => {
    if (!onPromote) return;
    setPickerIdx(null);
    setPromotingIdx(idx);
    try {
      await onPromote(variation, opts);
    } finally {
      if (editorMountedRef.current) setPromotingIdx(null);
    }
  };

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
          {onAssignBucketKind && requiresTargetKind && (
            <div className="relative" ref={assignWrapRef}>
              <button
                onClick={() => setAssignOpen((v) => !v)}
                className="text-xs px-2 py-1 bg-port-accent/15 hover:bg-port-accent/25 text-port-accent rounded flex items-center gap-1 min-h-[40px] sm:min-h-0"
                title="Move this bucket into a canon trunk (variations stay in place)"
                aria-haspopup="menu"
                aria-expanded={assignOpen}
              >
                <FolderTree size={12} /> Assign to…
              </button>
              {assignOpen && (
                <div
                  role="menu"
                  className="absolute right-0 top-full mt-1 z-20 w-44 bg-port-card border border-port-border rounded shadow-lg p-1 flex flex-col gap-0.5"
                >
                  <div className="px-2 pt-1 pb-1 text-[10px] uppercase tracking-wide text-gray-500">
                    Move bucket to trunk
                  </div>
                  {TRUNK_TABS.map((trunk) => {
                    const TrunkIcon = trunk.icon;
                    return (
                      <button
                        key={trunk.kind}
                        role="menuitem"
                        onClick={() => { setAssignOpen(false); onAssignBucketKind(trunk.kind); }}
                        className="text-left text-xs px-2 py-1.5 text-gray-200 hover:bg-port-accent/20 rounded flex items-center gap-2"
                      >
                        <TrunkIcon size={12} className="text-port-accent" /> {trunk.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
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
                    {onPromote && (() => {
                      const promoteTitle = !canPromote
                        ? 'Save the universe first to enable promote'
                        : requiresTargetKind
                          ? 'Promote to canon — pick a trunk'
                          : 'Promote to canon — LLM expands this variation into a full canon entry';
                      return (
                      <div className="relative" ref={pickerIdx === idx ? pickerWrapRef : null}>
                        <button
                          onClick={() => {
                            if (requiresTargetKind) {
                              setPickerIdx(pickerIdx === idx ? null : idx);
                              return;
                            }
                            runPromote(idx, v);
                          }}
                          disabled={!canPromote || promotingIdx !== null}
                          className="p-1 text-gray-400 hover:text-port-success disabled:opacity-30 disabled:cursor-not-allowed rounded"
                          title={promoteTitle}
                          aria-haspopup={requiresTargetKind ? 'menu' : undefined}
                          aria-expanded={requiresTargetKind ? pickerIdx === idx : undefined}
                        >
                          {promotingIdx === idx
                            ? <Loader2 size={14} className="animate-spin" />
                            : <ArrowUpCircle size={14} />}
                        </button>
                        {pickerIdx === idx && requiresTargetKind && (
                          <div
                            role="menu"
                            className="absolute right-0 top-full mt-1 z-20 w-44 bg-port-card border border-port-border rounded shadow-lg p-1 flex flex-col gap-0.5"
                          >
                            <div className="px-2 pt-1 pb-1 text-[10px] uppercase tracking-wide text-gray-500">
                              Promote to canon as…
                            </div>
                            {TRUNK_TABS.map((trunk) => (
                              <button
                                key={trunk.kind}
                                role="menuitem"
                                onClick={() => runPromote(idx, v, { targetKind: trunk.kind })}
                                className="text-left text-xs px-2 py-1.5 text-gray-200 hover:bg-port-success/20 rounded"
                              >
                                {trunk.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      );
                    })()}
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

// Tab nav — desktop shows a horizontal pill row; mobile collapses to a
// <select> dropdown (CLAUDE.md "Mobile responsive"). The Other tab only
// renders when at least one un-kinded bucket exists, per Phase C spec.
function TabNav({ activeTab, setTab, hasOtherBuckets, counts }) {
  const tabs = [
    { id: TAB_BIBLE, label: 'Bible', icon: BookOpen, count: null },
    { id: TAB_CAST, label: 'Cast', icon: Users, count: counts.cast },
    { id: TAB_PLACES, label: 'Places', icon: MapPin, count: counts.places },
    { id: TAB_OBJECTS, label: 'Objects', icon: Package, count: counts.objects },
    ...(hasOtherBuckets ? [{ id: TAB_OTHER, label: 'Other', icon: FolderTree, count: counts.other }] : []),
    { id: TAB_COMPOSITES, label: 'Composites', icon: Layers, count: counts.composites },
    { id: TAB_RENDER, label: 'Render', icon: ImagePlus, count: null },
  ];
  return (
    <>
      {/* Mobile dropdown */}
      <div className="sm:hidden">
        <label htmlFor="ub-tab-select" className="sr-only">Section</label>
        <select
          id="ub-tab-select"
          value={activeTab}
          onChange={(e) => setTab(e.target.value)}
          className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-port-accent min-h-[40px]"
        >
          {tabs.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}{t.count != null ? ` (${t.count})` : ''}
            </option>
          ))}
        </select>
      </div>
      {/* Desktop pill row */}
      <div className="hidden sm:flex items-center gap-1 bg-port-card border border-port-border rounded p-1 overflow-x-auto" role="tablist">
        {tabs.map((t) => {
          const Icon = t.icon;
          const active = t.id === activeTab;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-sm transition-colors whitespace-nowrap ${
                active
                  ? 'bg-port-accent/20 text-port-accent border border-port-accent/40'
                  : 'text-gray-300 hover:bg-port-bg border border-transparent'
              }`}
            >
              <Icon size={14} />
              {t.label}
              {t.count != null && (
                <span className={`text-[10px] ${active ? 'text-port-accent/70' : 'text-gray-500'}`}>
                  {t.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </>
  );
}

function BibleTab({
  draft, updateDraft, toggleLock,
  llm,
  handleExpand, expanding, saving,
  refine,
  totalVariations, categoryKeyCount, totalSheets,
}) {
  const { providers, providerModels, providerLabel, activeProviderId } = llm;
  const {
    open: refineOpen, setOpen: setRefineOpen,
    feedback: refineFeedback, setFeedback: setRefineFeedback,
    run: runRefine, running: refining, reset: resetRefinePanel,
    rationale: refineRationale, changes: refineChanges,
  } = refine;
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
            <label htmlFor="world-llm-provider" className="text-xs text-gray-400 mb-1 block">LLM for expansion</label>
            <select
              id="world-llm-provider"
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
            disabled={expanding || saving || !draft.starterPrompt?.trim()}
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
      </section>
    </>
  );
}

// Sub-bucket chip strip used by TrunkView + OtherTab. The "All" chip is a
// pseudo-bucket that clears `?bucket=`. Each real bucket key gets its own
// chip; clicking toggles it on/off (toggle-off returns to All). Designed so
// it works one-handed on mobile (38px tap targets, wraps to multiple lines).
function BucketChipStrip({ buckets, activeBucket, setBucket, showAll = true, extraChips = [] }) {
  if (buckets.length === 0 && extraChips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {showAll && (
        <button
          type="button"
          onClick={() => setBucket('')}
          className={`px-2.5 py-1.5 rounded-full text-xs min-h-[32px] transition-colors ${
            !activeBucket
              ? 'bg-port-accent/25 text-port-accent border border-port-accent/40'
              : 'bg-port-bg text-gray-300 border border-port-border hover:border-gray-500'
          }`}
        >
          All
        </button>
      )}
      {extraChips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          onClick={() => setBucket(chip.key)}
          className={`px-2.5 py-1.5 rounded-full text-xs min-h-[32px] transition-colors ${
            activeBucket === chip.key
              ? 'bg-port-accent/25 text-port-accent border border-port-accent/40'
              : 'bg-port-bg text-gray-300 border border-port-border hover:border-gray-500'
          }`}
        >
          {chip.label}
        </button>
      ))}
      {buckets.map((bucket) => {
        const active = activeBucket === bucket;
        return (
          <button
            key={bucket}
            type="button"
            onClick={() => setBucket(active ? '' : bucket)}
            className={`px-2.5 py-1.5 rounded-full text-xs min-h-[32px] transition-colors ${
              active
                ? 'bg-port-accent/25 text-port-accent border border-port-accent/40'
                : 'bg-port-bg text-gray-300 border border-port-border hover:border-gray-500'
            }`}
          >
            {humanizeCategory(bucket)}
          </button>
        );
      })}
    </div>
  );
}

// Per-trunk view. Three modes driven by `?bucket=`:
//   - blank (default "All"): renders canon + every variation under this trunk
//   - BUCKET_CANON: renders only canon entries (via the existing UniverseCanonSection)
//   - <bucketKey>: renders that bucket's variations via CategoryEditor
export function TrunkView({
  trunk, draft, selectedId, buckets, activeBucket, setBucket,
  canRender, canPromote, imageCfg, onUniverseChange,
  onRemoveBucket, onUpdateBucket, onGenerateInBucket, onPromoteVariation,
  onBulkRenderBucket, onRenderVariation, onBulkRenderTrunk,
  onAddBucket,
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
              placeholder={trunk.kind === 'characters' ? 'heroes, villains, factions' : trunk.kind === 'settings' ? 'colonies, ruins' : 'weapons, vehicles'}
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
function OtherTab({
  draft, buckets, activeBucket, setBucket, canRender, canPromote,
  onUpdateBucket, onRemoveBucket, onGenerateInBucket, onPromoteVariation,
  onBulkRenderBucket, onRenderVariation, onAssignBucketKind, onAutoSort,
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
            className="text-xs px-2 py-1.5 bg-port-accent/15 hover:bg-port-accent/25 text-port-accent rounded flex items-center gap-1 min-h-[32px]"
            title="Auto-sort with AI — shows guidance until the dedicated endpoint lands (tracked in PLAN.md)"
          >
            <Wand2 size={12} /> Auto-sort with AI
          </button>
        </div>
        <p className="text-[11px] text-gray-500">
          These buckets aren't tagged as Cast / Places / Objects yet — they were
          either added manually or imported from a pre-Phase-A universe. Auto-sort
          will classify each bucket into the right trunk with a meaningful name.
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
          />
        ))}
      </section>
    </>
  );
}

function RenderTab({
  draft, selectedId, bucketsByKind, renderOpts, setRenderOpts,
  availableBackends, defaultMode, imageModels, availableLoras = [],
  handleRender, rendering, runs,
}) {
  const currentRunnerFamily = useMemo(() => {
    const currentModel = imageModels.find((m) => m.id === renderOpts.modelId);
    return currentModel?.runner || RUNNER_FAMILIES.MFLUX;
  }, [imageModels, renderOpts.modelId]);
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
      + countCanonWithContent(draft, 'settings')
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
          value={{ ...renderOpts, mode: renderOpts.mode || defaultMode || 'local' }}
          onChange={(next) => setRenderOpts(next)}
          models={imageModels}
          availableBackends={availableBackends}
          showLoras
          availableLoras={availableLoras}
          currentRunnerFamily={currentRunnerFamily}
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
    </>
  );
}
