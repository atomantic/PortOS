/**
 * Universe Builder page (Media Gen → Universe Builder).
 *
 * Lets the user describe a universe in one starter prompt, expand it into a
 * full set of style + per-category variation prompts via the LLM of their
 * choice, edit/save the template, and kick off a batch of image renders
 * that all land in a single auto-named collection.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import {
  Plus, Trash2, Sparkles, Wand2, Loader2, Save, FolderOpen,
  Edit3, X, MessageSquarePlus, Play, Lock, Unlock,
  ArrowUpCircle, ArrowLeft,
  BookOpen, Users, MapPin, Package, Layers, ImagePlus, FolderTree, Images,
} from 'lucide-react';
import toast from '../components/ui/Toast';
import { formatDateTime } from '../utils/formatters';
import {
  listUniverses, getUniverse, createUniverse, updateUniverse, deleteUniverse, expandUniverse,
  generateCategoryVariations, promoteVariationToCanon, autoSortBuckets,
  renderWorld, listWorldRuns, getProviders, refineWorldPrompts, WORLD_CATEGORIES,
  WORLD_CATEGORY_KEY_MAX, COMPOSITE_PROMPT_MAX, WORLD_LOGLINE_MAX,
  WORLD_PREMISE_MAX, WORLD_STYLE_NOTES_MAX, WORLD_LOCKABLE_FIELDS,
  ensureInfluences, isInfluenceLockField,
  listImageModels, listLorasFull, getSettings,
} from '../services/api';
import useClickOutside from '../hooks/useClickOutside';
import EntityCombobox from '../components/EntityCombobox';
import { useLocalStoragePersisted } from '../hooks/useLocalStorageBool';
import useUniverseAction from '../hooks/useUniverseAction';
import { useUniverseNav } from '../hooks/useUniverseNav';
import InfluenceChipsInput from '../components/universeBuilder/InfluenceChipsInput';
import ProviderModelSelector from '../components/ProviderModelSelector';
import VisionProviderPicker from '../components/universe/VisionProviderPicker';
import GalleryImagePicker from '../components/imageGen/GalleryImagePicker';
import ImageGenSettingsForm from '../components/imageGen/ImageGenSettingsForm';
import { RUNNER_FAMILIES, loraCompatKey } from '../lib/runnerFamilies';
import ShareToButton from '../components/sharing/ShareToButton';
import SyncToPeerButton from '../components/sharing/SyncToPeerButton';
import OriginBadge from '../components/sharing/OriginBadge';
import MoodBoardReferenceStrip from '../components/moodBoard/MoodBoardReferenceStrip';
import UniverseCanonSection from '../components/universe/UniverseCanonSection';
import StyleProbeImage from '../components/universe/StyleProbeImage';
import EntryCard from '../components/universe/EntryCard';
import EntryThumbSlot from '../components/universe/EntryThumbSlot';
import useMediaJobProgress from '../hooks/useMediaJobProgress';
import MediaPreview from '../components/media/MediaPreview';
import useMediaPreviewActions from '../hooks/useMediaPreviewActions';
import usePreviewRoute from '../hooks/usePreviewRoute';
import { useMediaAnnotations } from '../hooks/useMediaAnnotations';
import { listImageGallery } from '../services/apiImageVideo';
import TabPills from '../components/ui/TabPills';
import { deriveAvailableBackends, IMAGE_GEN_MODE } from '../lib/imageGenBackends';
import { PIPELINE_IMAGE_DEFAULTS, readPipelineImageSettings } from '../lib/pipelineImageDefaults';
import { hasCanonDescriptorContent, descriptorForCanonEntry } from '../lib/canonPrompt';
import { listSheetPointers } from '../lib/sheetPointers';
import { upsertByIdPrepend } from '../lib/upsertByIdPrepend';
import { sameJsonShape } from '../lib/sameJsonShape';
import { capImageRefs } from '../lib/bibleLimits';
import {
  mergeVariations, mergeCanonByName, mergeExpandIntoDraft, extractPreservedFromDraft,
} from '../lib/universeBuilderExpand';

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
  { id: TAB_PLACES, kind: 'places', label: 'Places', icon: MapPin },
  { id: TAB_OBJECTS, kind: 'objects', label: 'Objects', icon: Package },
];
const TRUNK_BY_ID = Object.fromEntries(TRUNK_TABS.map((t) => [t.id, t]));
const TRUNK_BY_KIND = Object.fromEntries(TRUNK_TABS.map((t) => [t.kind, t]));

// Group category buckets by their `kind` tag. Buckets with an unknown / missing
// kind fall into the `other` bin — that bin drives whether the Other tab shows.
const groupBucketsByKind = (categories = {}) => {
  const out = { characters: [], places: [], objects: [], other: [] };
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

// Stable serialization of the draft fields handleSave persists. Canon arrays
// are excluded — they're owned by UniverseCanonSection/NounsStage's targeted
// PATCHes, not this page's draft.
const draftSnapshotForDirty = (d = {}) => JSON.stringify({
  name: (d.name || '').trim(),
  starterPrompt: d.starterPrompt || '',
  logline: d.logline || '',
  premise: d.premise || '',
  styleNotes: d.styleNotes || '',
  categories: d.categories || {},
  compositeSheets: d.compositeSheets || [],
  influences: ensureInfluences(d.influences),
  locked: d.locked || {},
  llm: d.llm || { provider: null, model: null },
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
// universe is selected never accidentally renames it. The match-or-create UX
// lives in the shared `EntityCombobox`; this thin wrapper maps universes into
// its `{ id, name, subtitle }` item shape and preserves the universe-specific
// labels/ids.
export function UniverseSelector({ universes, selectedId, value, onChange, onPick, onCreate, busy }) {
  const items = useMemo(
    () => (Array.isArray(universes) ? universes : []).map((u) => ({
      id: u.id,
      name: u.name,
      subtitle: u.starterPrompt || 'No starter prompt',
    })),
    [universes],
  );
  return (
    <EntityCombobox
      items={items}
      selectedId={selectedId}
      value={value}
      onChange={onChange}
      onPick={(item) => onPick(item.id)}
      onCreate={onCreate}
      busy={busy}
      inputId="universe-name"
      noun="universe"
      placeholder="Search universes or type a new name…"
      emptyNoItems="No universes yet — type a name and Create."
      maxLength={100}
    />
  );
}

export default function UniverseBuilder() {
  // The selected world id lives in the URL so deep-linking + back/forward
  // work. The editor is mounted at /universes/:universeId and /universes/new —
  // strip any trailing /<id> off the current pathname to derive the base for
  // navigation back to the list.
  const params = useParams();
  const location = useLocation();
  // `/universes/new` is the create-mode entry point from the Universes index —
  // treat the `new` sentinel as "no id" (blank draft). Real universe ids are
  // UUIDs, so this can never shadow an actual record.
  const selectedId = params.universeId && params.universeId !== 'new' ? params.universeId : null;
  // `goToWorld` preserves `location.search` (e.g. `?tab=&bucket=&series=`) so
  // the auto-save → create path doesn't snap the user back to the Bible tab
  // after they triggered Generate From Idea from inside Cast/Places/Objects.
  // The stale-bucket effect already strips any bucket that no longer exists
  // under the new universe's categories.
  const goToWorld = useUniverseNav();

  const [universes, setWorlds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [expanding, setExpanding] = useState(false);
  const [rendering, setRendering] = useState(false);
  // entryId → jobId[] queue for any row with one or more in-flight renders.
  // Stores an ARRAY because `batchPerVariation > 1` (or any path that queues
  // multiple jobs for the same entry) lands several jobIds against the same
  // entryId — a scalar would overwrite siblings and the spinner would clear
  // as soon as the first finished, even though others are still running.
  // Canon entries are included here too (the batch `/render` route compiles
  // canon prompts when the user picks "all" / "canon" mode, and those jobs
  // don't go through `UniverseCanonSection.renderingJobs`).
  const [pendingByEntryId, setPendingByEntryId] = useState({});
  // First-jobId-per-entry view for components that just need a single
  // subscription per row (MediaJobThumb takes one jobId). When the head
  // finishes we shift it off and the next jobId in the queue takes over.
  const pendingHeadByEntryId = useMemo(() => {
    const out = {};
    for (const [entryId, jobs] of Object.entries(pendingByEntryId)) {
      if (Array.isArray(jobs) && jobs.length > 0) out[entryId] = jobs[0];
    }
    return out;
  }, [pendingByEntryId]);
  // Remove a specific completed jobId from the entry's queue (preferred path
  // — handlers know which jobId finished). When called without a jobId
  // (failure paths that want to bail entirely on the entry), drops every
  // pending job for that entry.
  const clearPendingForEntry = useCallback((entryId, jobId = null) => {
    if (!entryId) return;
    setPendingByEntryId((prev) => {
      const jobs = prev[entryId];
      if (!Array.isArray(jobs) || jobs.length === 0) return prev;
      const next = { ...prev };
      if (jobId == null) {
        delete next[entryId];
        return next;
      }
      const remaining = jobs.filter((j) => j !== jobId);
      if (remaining.length === 0) delete next[entryId];
      else next[entryId] = remaining;
      return next;
    });
  }, []);
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
  // Server-side baseline of the draft. LLM-driven mutators (auto-sort /
  // promote / generate) compare current draft against this baseline and
  // flush via handleSave() when they diverge so the server doesn't operate
  // on a stale copy.
  const savedDraftSnapshotRef = useRef(draftSnapshotForDirty(emptyTemplate()));
  // Saved-record influences snapshot, tracked alongside the full-draft snapshot.
  // StyleProbeImage builds its prompt from `influences` but persists only the
  // resulting `styleImageRefs` to the SERVER record — so a probe rendered from
  // unsaved influence edits would get pinned to a record whose influences are
  // still the prior values. Comparing this against the live draft tells the
  // probe when the style is dirty so it can block until the user saves.
  const savedStyleSnapshotRef = useRef(ensureInfluences(emptyTemplate().influences));
  const markDraftSaved = useCallback((snapshotSource) => {
    savedDraftSnapshotRef.current = draftSnapshotForDirty(snapshotSource);
    savedStyleSnapshotRef.current = ensureInfluences(snapshotSource?.influences);
  }, []);
  const isDraftDirty = useCallback(
    () => savedDraftSnapshotRef.current !== draftSnapshotForDirty(draftRef.current || draft),
    [draft],
  );
  // Page-level in-flight gate for the promote action. Ref + state pair so
  // the disable check stays synchronous (ref) while still triggering renders
  // (state). Promote writes to `universe[bibleField]` and `categories[key]`
  // as wholesale replacements from a stale snapshot — letting two run in
  // parallel against the same universe would let the second clobber the
  // first's canon append.
  const [promoting, setPromoting] = useState(false);
  const promotingRef = useRef(false);
  const [autoSorting, setAutoSorting] = useState(false);
  const autoSortingRef = useRef(false);
  // Scaffolding shared by handlePromoteVariation + handleAutoSort:
  // selectedId guard, ref re-entrancy, capturedId + toast lifecycle,
  // setWorlds always-update, stale-write detection. See the hook header.
  const runUniverseAction = useUniverseAction({ selectedId, mountedRef, setWorlds });
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
  const pendingCanonAdditionsRef = useRef({ characters: [], places: [], objects: [] });
  const clearPendingCanonAdditions = () => {
    pendingCanonAdditionsRef.current = { characters: [], places: [], objects: [] };
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
  // Page-level lightbox state. Single MediaPreview at this level covers
  // EVERY thumb on the page: variations, composite sheets, canon imageRefs,
  // and character reference sheets — so clicking any image opens the same
  // full-detail modal History / Collections / ImageGen use, with the same
  // actions (Refine / Remix / SendToVideo / Clean / AddToCollection /
  // Download / notes). Canon previews used to live inside UniverseCanonSection
  // and showed only a refine/add/download subset against the character
  // description; lifting state up here is what unifies them. URL-driven
  // (`?preview=<filename>`) via `usePreviewRoute(previewItems)` below.
  // Filename → full image-metadata-sidecar record (prompt, negativePrompt,
  // modelId, width, height, seed, etc.). Hydrates `previewItems` with the
  // ACTUAL prompt that was used to render the image — without this the
  // modal would only see the variation's label, and Refine Prompt / Remix
  // / Send to Video would all open with empty fields. Loaded once per
  // mount via `listImageGallery()` (the same call the History page uses)
  // and refreshed whenever a render completes (universe `runs` advances).
  const [galleryByFilename, setGalleryByFilename] = useState(() => new Map());
  // Bumped on every job completion so the gallery-metadata fetch below
  // re-runs once the new sidecar exists on disk. Keying the fetch only on
  // `runs.length` was insufficient: that advances when a run is queued or
  // loaded, NOT when one of its jobs completes — so a freshly rendered
  // thumb would open the lightbox with label-only metadata until a full
  // page reload.
  const [galleryRefreshKey, setGalleryRefreshKey] = useState(0);
  const bumpGalleryRefresh = useCallback(() => setGalleryRefreshKey((k) => k + 1), []);
  useEffect(() => {
    let cancelled = false;
    listImageGallery().then((list) => {
      if (cancelled) return;
      const map = new Map();
      for (const item of Array.isArray(list) ? list : []) {
        if (item?.filename) map.set(item.filename, item);
      }
      setGalleryByFilename(map);
    }).catch(() => { /* non-fatal; modal falls back to filename-only display */ });
    return () => { cancelled = true; };
    // `runs.length` covers initial-load and queue-time; `galleryRefreshKey`
    // covers per-job completion (see bumpGalleryRefresh callers).
  }, [runs.length, galleryRefreshKey]);
  const { annotations, updateAnnotation } = useMediaAnnotations();
  const previewItems = useMemo(() => {
    const out = [];
    // Dedupe by full namespaced key (`image:<filename>` vs
    // `canon-sheet:<filename>`) so a gallery image and a character reference
    // sheet that share a basename can coexist in the items list — without the
    // namespace, the first-pushed item would suppress the second and the
    // preview-URL resolver would never see the other asset.
    const seen = new Set();
    const pushFilename = (filename, label) => {
      if (typeof filename !== 'string' || !filename) return;
      const key = `image:${filename}`;
      if (seen.has(key)) return;
      seen.add(key);
      // Pull the real prompt + render settings out of the gallery metadata
      // map when available so the lightbox shows the full prompt that was
      // sent to the renderer (with universe style influences, variation
      // prompt fragment, etc.), not just the row's display label.
      // Falls back to the label-only shape for filenames not in the gallery
      // (legacy renders or pending re-fetch).
      const meta = galleryByFilename.get(filename) || null;
      out.push({
        // Same `image:<filename>` key normalizeImage() stamps everywhere
        // else — History, Collections, ImageGen — so a star/note added
        // from this lightbox is the SAME annotation record those pages
        // already read. A page-local key would silently fork the user's
        // favorites by surface.
        key: `image:${filename}`,
        kind: 'image',
        filename,
        previewUrl: `/data/images/${filename}`,
        downloadUrl: `/data/images/${filename}`,
        prompt: meta?.prompt || label || filename,
        negativePrompt: meta?.negativePrompt || null,
        modelId: meta?.modelId || meta?.model || null,
        width: meta?.width ?? null,
        height: meta?.height ?? null,
        seed: meta?.seed ?? null,
        steps: meta?.steps ?? null,
        guidance: meta?.guidance ?? null,
        quantize: meta?.quantize ?? null,
        // `raw` carries the original sidecar so MediaLightbox's "Refine
        // Prompt" / clean / remix downstream handlers can pull any field
        // the spec doesn't surface at the top level.
        raw: meta,
      });
    };
    const cats = draft?.categories && typeof draft.categories === 'object' ? draft.categories : {};
    for (const [bucketKey, bucket] of Object.entries(cats)) {
      const variations = Array.isArray(bucket?.variations) ? bucket.variations : [];
      for (const v of variations) {
        const refs = Array.isArray(v?.imageRefs) ? v.imageRefs : [];
        for (const f of refs) pushFilename(f, `${bucketKey} · ${v.label}`);
      }
    }
    const sheets = Array.isArray(draft?.compositeSheets) ? draft.compositeSheets : [];
    for (const s of sheets) {
      const refs = Array.isArray(s?.imageRefs) ? s.imageRefs : [];
      for (const f of refs) pushFilename(f, `Composite · ${s.label}`);
    }
    // Base style probe renders — same `image:<filename>` namespace so the
    // lightbox finds them and reuses the gallery sidecar metadata.
    const styleRefs = Array.isArray(draft?.styleImageRefs) ? draft.styleImageRefs : [];
    for (const f of styleRefs) pushFilename(f, 'Base style');
    // Canon refs — characters / places / objects. Hydrate from the gallery
    // sidecar so the modal shows the ACTUAL render prompt (the same one the
    // History page sees), not just the character description. The descriptor
    // string is only used as a fallback label when no sidecar exists (legacy
    // canon renders without metadata). Character reference sheets live in a
    // different static prefix (`/data/image-refs/`) so they get a dedicated
    // `canon-sheet:<filename>` key + don't collide with gallery entries.
    const canonKinds = [
      { key: 'characters', singular: 'character' },
      { key: 'places', singular: 'place' },
      { key: 'objects', singular: 'object' },
    ];
    for (const kind of canonKinds) {
      const list = Array.isArray(draft?.[kind.key]) ? draft[kind.key] : [];
      for (const entry of list) {
        const descriptor = descriptorForCanonEntry(kind.key, entry) || '';
        const fallbackLabel = `${entry.name}${descriptor ? `: ${descriptor}` : ''}`;
        const refs = Array.isArray(entry?.imageRefs) ? entry.imageRefs : [];
        for (const f of refs) pushFilename(f, fallbackLabel);
        if (kind.key === 'characters') {
          for (const { variant, filename } of listSheetPointers(entry)) {
            const sheetKey = `canon-sheet:${variant}:${filename}`;
            if (seen.has(sheetKey)) continue;
            seen.add(sheetKey);
            out.push({
              key: sheetKey,
              kind: 'image',
              filename,
              previewUrl: `/data/image-refs/${filename}`,
              downloadUrl: `/data/image-refs/${filename}`,
              prompt: `${entry.name} — character reference sheet (${variant})`,
            });
          }
        }
      }
    }
    return out;
  }, [draft, galleryByFilename]);
  const [preview, setPreview] = usePreviewRoute(previewItems);
  // Shared preview action handlers (Remix / SendToVideo / Clean) so the
  // universe lightbox opens the same downstream pages with the same params
  // as the History grid + Image Gen page. `onCleanComplete` splices the
  // cleaned image into the local gallery map so the next preview open
  // shows it immediately — no full refetch needed.
  const previewActions = useMediaPreviewActions({
    onCleanComplete: useCallback((cleaned) => {
      if (!cleaned?.filename) return;
      setGalleryByFilename((prev) => {
        const next = new Map(prev);
        next.set(cleaned.filename, cleaned);
        return next;
      });
    }, []),
  });
  // Generic filename → preview opener used by every clickable thumb on the
  // page (variation grids, composite sheets, canon entries, character
  // reference sheets). `opts.isSheet` forces a key match against the
  // `canon-sheet:<variant>:` prefix so a basename collision with a gallery
  // image can't route the lightbox to `/data/images/` instead of
  // `/data/image-refs/`. The exact variant id isn't known at this callsite
  // (the panel reads the field; the variant only lives inside the key),
  // so match on the `canon-sheet:` prefix + filename suffix instead of an
  // exact equality compare. Pre-variant keys (`canon-sheet:<filename>`)
  // still match this prefix check.
  const openPreviewByFilename = useCallback((filename, opts) => {
    if (!filename) return;
    const sheetMatch = opts?.isSheet
      ? previewItems.find((i) => typeof i.key === 'string' && i.key.startsWith('canon-sheet:') && i.filename === filename)
      : null;
    const match = sheetMatch || previewItems.find((i) => i.filename === filename);
    if (match) setPreview(match);
  }, [previewItems, setPreview]);
  // Legacy name retained for the variation/composite call sites that pass a
  // single filename — same implementation, different label.
  const openVariationPreview = openPreviewByFilename;

  // Two-click delete: first click flips this to the world id; a second
  // click within the live render confirms. Avoids window.confirm per
  // CLAUDE.md UI Patterns.
  const [pendingDeleteId, setPendingDeleteId] = useState(null);

  const [refineOpen, setRefineOpen] = useState(false);
  const [refineFeedback, setRefineFeedback] = useState('');
  const [refining, setRefining] = useState(false);
  const [refineRationale, setRefineRationale] = useState('');
  const [refineChanges, setRefineChanges] = useState([]);
  // Optional gallery image used as a visual style reference for refinement —
  // { filename, preview }. When set, the server refines through a vision model.
  const [refineImage, setRefineImage] = useState(null);

  const resetRefinePanel = () => {
    setRefineOpen(false);
    setRefineFeedback('');
    setRefineRationale('');
    setRefineChanges([]);
    setRefineImage(null);
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
      const empty = emptyTemplate();
      setDraft(empty);
      markDraftSaved(empty);
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
        const hydrated = {
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
        };
        setDraft(hydrated);
        markDraftSaved(hydrated);
      }
      setRuns(r);
    });
    return () => { cancelled = true; };
  }, [selectedId]);

  // Hash-scroll for deep-links — the legacy `/canon` redirect and
  // PipelineSeries' "Manage characters, places, and objects" link both
  // navigate to `/universes/<id>#canon`. React Router doesn't
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

  // Create-from-selector path. Two cases, distinguished by whether a universe
  // is already open:
  //   - No universe selected (unsaved new draft): the user has been building a
  //     draft in place — e.g. expanded a starter idea into a starterPrompt,
  //     categories, and canon — then typed a name. That work must be preserved,
  //     so delegate to handleSave (which persists the FULL draft, not just the
  //     name). Previously this path spread emptyTemplate() and silently
  //     obliterated the generated idea/content, creating a blank universe.
  //   - An existing universe is selected: typing a new name must NOT rename or
  //     clone the open universe — make a fresh blank record from just the name.
  const handleCreateNamed = async (rawName) => {
    const name = (rawName || '').trim();
    if (!name) { toast.error('Name is required'); return; }
    if (!selectedId) {
      // draft.name already mirrors the typed value (selector value === draft.name),
      // so handleSave creates a new universe carrying the full in-progress draft.
      await handleSave();
      return;
    }
    setSaving(true);
    const result = await createUniverse({
      ...emptyTemplate(),
      name,
    }).catch((e) => { toast.error(`Create failed: ${e.message}`); return null; });
    setSaving(false);
    if (!result) return;
    toast.success('World created');
    setWorlds((prev) => upsertByIdPrepend(prev, result));
    goToWorld(result.id);
  };

  const handleSave = async () => {
    if (!draft.name?.trim()) {
      toast.error('Name is required');
      return null;
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
          return null;
        }
        const additions = pendingCanonAdditionsRef.current;
        const baseCanon = {
          characters: mergeCanonByName(fresh.characters || [], additions.characters, 'character'),
          places: mergeCanonByName(fresh.places || [], additions.places, 'place'),
          objects: mergeCanonByName(fresh.objects || [], additions.objects, 'object'),
        };
        payload = { ...basePayload, ...baseCanon };
      } else {
        const baseCanon = { characters: draft.characters || [], places: draft.places || [], objects: draft.objects || [] };
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
      markDraftSaved(payload);
      toast.success(selectedId ? 'World updated' : 'World created');
      setWorlds((prev) => upsertByIdPrepend(prev, result));
      // After Create: jump to the new id's URL so back-button / refresh
      // returns to the same world. After Update: id is unchanged, but
      // navigating is harmless (replace-style).
      if (result.id !== selectedId) goToWorld(result.id);
    }
    return result;
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
    const ok = await deleteUniverse(id, { silent: true })
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
    // Extract per-item locks so the server can include them in the LLM prompt
    // (avoid duplicate generation) AND mergeExpandIntoDraft can merge them back
    // in after the result returns. Only LOCKED entries are forwarded — the
    // unlocked items get fully replaced.
    const { preservedVariations, preservedCompositeSheets } = extractPreservedFromDraft(draft);

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
    const {
      expandedDraft, addedCanonCount, pendingAdditions, lockedKeys,
    } = mergeExpandIntoDraft(draft, result, { ensureDraftCategories });
    setDraft(expandedDraft);
    // Flag the merged-but-not-yet-persisted canon so a subsequent manual
    // Save (if auto-save fails or is bypassed) includes the new entries.
    // Record exactly which entries we added (vs. what was already in the
    // draft) so the save-time merge only re-applies the new ones, not the
    // full stale draft.
    if (addedCanonCount > 0) {
      setCanonDirty(true);
      pendingCanonAdditionsRef.current = {
        characters: [...pendingCanonAdditionsRef.current.characters, ...pendingAdditions.characters],
        places: [...pendingCanonAdditionsRef.current.places, ...pendingAdditions.places],
        objects: [...pendingCanonAdditionsRef.current.objects, ...pendingAdditions.objects],
      };
    }
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
        places: expandedDraft.places || [],
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
          places: mergeCanonByName(fresh.places || [], pendingCanonAdditionsRef.current.places, 'place'),
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
        setWorlds((prev) => upsertByIdPrepend(prev, saved));
        // Auto-save succeeded — server now has the merged canon, so a
        // subsequent manual Save shouldn't re-send it (avoids the
        // concurrent-edit clobber). Drain the additions ledger too since
        // those entries are now on the server.
        setCanonDirty(false);
        clearPendingCanonAdditions();
        markDraftSaved(payload);
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
      const refinePayload = {
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
      };
      const updated = await updateUniverse(selectedId, refinePayload)
        .catch((e) => { toast.error(`Auto-save after refine failed: ${e.message}`); return null; });
      if (updated) {
        setWorlds((prev) => upsertByIdPrepend(prev, updated));
        markDraftSaved(refinePayload);
      }
    }
  };

  const runRefine = async (visionOverride = null) => {
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
      image: refineImage?.filename || undefined,
      // With a style-reference image the server forces a vision-capable API
      // provider, so use the form's vision picker selection (not the universe's
      // default expansion LLM, which may be a text-only/CLI provider). Without
      // an image, keep the universe's configured LLM.
      providerId: refineImage
        ? (visionOverride?.providerId || undefined)
        : (draft.llm?.provider || activeProviderId || undefined),
      model: refineImage
        ? (visionOverride?.model || undefined)
        : (draft.llm?.model || undefined),
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
    setRefineImage(null);
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
    // Stamp per-entry pending state so each variation / canon row can swap
    // its thumbnail for a MediaJobThumb spinner. `variation` covers the
    // category-bucket rows; `canon` covers the trunk-canon rows that the
    // `/render` route compiles when `promptMode` is "canon" / "all" / a
    // per-trunk scope (the canon section's own one-off renders go through
    // `UniverseCanonSection`'s `generateImage` path and populate its
    // separate `renderingJobs` map; both maps merge at the read site).
    // Composite sheets are skipped because `CompositeSheetsEditor` has no
    // pending-thumb UI yet — sheet jobs would accumulate forever with no
    // consumer to clear them. When sheets grow per-row pending UI, widen
    // this allow-list to include 'sheet' and wire matching callbacks.
    //
    // Each kind's jobIds are APPENDED to a per-entry queue: `batchPerVariation
    // > 1` queues multiple jobs against the same id, and back-to-back
    // renders on the same row should all stay tracked. Each completion
    // shifts its jobId out (see `clearPendingForEntry`); the head jobId
    // is the one MediaJobThumb subscribes to at any moment.
    if (Array.isArray(result.entryJobs) && result.entryJobs.length > 0) {
      setPendingByEntryId((prev) => {
        const next = { ...prev };
        for (const { jobId, entryRef } of result.entryJobs) {
          if (!jobId || !entryRef?.id) continue;
          if (entryRef.kind !== 'variation' && entryRef.kind !== 'canon') continue;
          const existing = Array.isArray(next[entryRef.id]) ? next[entryRef.id] : [];
          next[entryRef.id] = [...existing, jobId];
        }
        return next;
      });
    }
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
          places: mergeCanonByName(updated.places || [], additions.places, 'place'),
          objects: mergeCanonByName(updated.objects || [], additions.objects, 'object'),
          updatedAt: updated.updatedAt,
        };
      }
      return {
        ...d,
        characters: updated.characters,
        places: updated.places,
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
      setWorlds((prev) => upsertByIdPrepend(prev, updated));
      toast.success(`Moved "${humanizeCategory(bucket)}" to ${trunk.label}`);
    }
  };
  // Auto-sort with AI — one LLM call classifies every Other-tab bucket into
  // characters/places/objects. Each bucket's `kind` is reassigned via a
  // single atomic patch server-side so the universe ends up consistent or
  // unchanged. Renames the LLM suggests are surfaced in the toast but not
  // auto-applied (the user can rename manually if they want it).
  // Returns true when the draft is clean or save succeeded; false (with
  // handleSave's own error toast already raised) when save failed.
  const flushDraftIfDirty = useCallback(async () => {
    if (!isDraftDirty()) return true;
    const saved = await handleSave();
    return !!saved;
  }, [isDraftDirty]);

  const handleAutoSort = () => runUniverseAction({
    ref: autoSortingRef,
    setBusy: setAutoSorting,
    loadingMessage: 'Auto-sorting buckets with AI…',
    errorPrefix: 'Auto-sort failed',
    notSavedMessage: 'Save the universe first — auto-sort needs the persisted record',
    preflight: flushDraftIfDirty,
    action: (capturedId) => autoSortBuckets(capturedId, {
      providerId: draft.llm?.provider || undefined,
      model: draft.llm?.model || undefined,
    }, { silent: true }),
    onFreshResult: (result) => {
      const updated = result.universe;
      // Merge only the reclassified buckets into the draft — wholesale-
      // replacing `categories` with the server snapshot would discard any
      // user edits to OTHER buckets made while the LLM call was in flight.
      // Compute the merge from draftRef so React strict-mode's double-fire
      // of state updaters doesn't double-stringify the dirty baseline.
      const sortedKeys = new Set((result.results || []).map((r) => r.sourceKey));
      const baseDraft = draftRef.current || draft;
      const nextCategories = { ...(baseDraft.categories || {}) };
      for (const key of sortedKeys) {
        if (updated.categories?.[key]) nextCategories[key] = updated.categories[key];
      }
      const newDraft = {
        ...baseDraft,
        categories: nextCategories,
        schemaVersion: updated.schemaVersion,
        updatedAt: updated.updatedAt,
      };
      setDraft(newDraft);
      markDraftSaved(newDraft);
      const sortedCount = result.results?.length || 0;
      const renames = (result.results || []).filter((r) => r.suggestedKey);
      const summary = sortedCount
        ? `Sorted ${sortedCount} bucket${sortedCount === 1 ? '' : 's'} into canon trunks`
        : 'No buckets were classified';
      const renameHint = renames.length
        ? ` — ${renames.length} rename suggestion${renames.length === 1 ? '' : 's'} available`
        : '';
      return `${summary}${renameHint}`;
    },
  });

  const handleGenerateInCategory = async (cat, count) => {
    // Match the runUniverseAction-based handlers — flush dirty draft so the
    // subsequent auto-save can't clobber unrelated fields with a stale spread.
    const flushed = await flushDraftIfDirty();
    if (!flushed) return;
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
        setWorlds((prev) => upsertByIdPrepend(prev, updated));
        markDraftSaved(nextDraft);
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
  const handlePromoteVariation = (category, variation, { targetKind } = {}) => {
    if (!variation?.label) return Promise.resolve(null);
    return runUniverseAction({
      ref: promotingRef,
      setBusy: setPromoting,
      loadingMessage: `Promoting "${variation.label}" to canon…`,
      errorPrefix: 'Promote failed',
      notSavedMessage: 'Save the universe first — promote needs the persisted record',
      preflight: flushDraftIfDirty,
      action: (capturedId) => promoteVariationToCanon(capturedId, {
        category,
        label: variation.label,
        targetKind,
        providerId: draft.llm?.provider || undefined,
        model: draft.llm?.model || undefined,
      }, { silent: true }),
      onFreshResult: (result) => {
        const updated = result.universe;
        // Selective merge: only the canon array + the affected category bucket
        // changed server-side. Preserve every other draft field (the user may
        // have typed into logline/premise/influences during the LLM call).
        // Compute outside setDraft so strict-mode's double-invoke doesn't
        // re-stringify the dirty baseline.
        const baseDraft = draftRef.current || draft;
        const newDraft = {
          ...baseDraft,
          characters: updated.characters,
          places: updated.places,
          objects: updated.objects,
          categories: { ...baseDraft.categories, [result.removed.category]: updated.categories?.[result.removed.category] },
          schemaVersion: updated.schemaVersion,
          updatedAt: updated.updatedAt,
        };
        setDraft(newDraft);
        markDraftSaved(newDraft);
        return `Promoted "${variation.label}" → ${result.targetKind} canon`;
      },
    });
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
  // True when the draft's influences diverge from the saved record. The style
  // probe renders from these influences but pins its filename server-side, so a
  // probe taken while dirty would mis-attribute to style the record never had.
  const styleProbeDirty = !sameJsonShape(savedStyleSnapshotRef.current, ensureInfluences(draft.influences));

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
        {/* Back to the universe index (list/table at /universes). */}
        <Link
          to="/universes"
          className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-port-accent self-start"
        >
          <ArrowLeft size={14} /> All Universes
        </Link>
        {/* Thin action header — autocomplete universe selector doubles as the
            name field; Save + Share + Delete sit beside it so they're reachable
            from any tab. The Bible-tab actions (Generate / Refine, starter
            idea, story-bible fields) live inside the Bible tab itself, per
            Phase C "Bible is its own tab". */}
        {/* relative + z-30: themes that ship a non-none --port-backdrop-filter
            (Lumen Glass, Blueprint Ops) turn every .bg-port-card.border.rounded
            into its own stacking context, trapping the UniverseSelector's
            dropdown beneath later sibling cards (TabPills, section cards).
            Elevating this header lets its stacking context paint above those
            siblings so the dropdown overlays them as intended. */}
        <header className="relative z-30 bg-port-card border border-port-border rounded p-3 flex items-center gap-2 flex-wrap">
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
              <SyncToPeerButton recordKind="universe" recordId={selectedId} label="Sync" />
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

        <TabPills
          variant="pills"
          size="sm"
          mobileDropdown
          mobileSelectId="ub-tab-select"
          activeTab={activeTab}
          onChange={setTab}
          tabs={[
            { id: TAB_BIBLE, label: 'Bible', icon: BookOpen },
            { id: TAB_CAST, label: 'Cast', icon: Users, count: (draft.characters?.length || 0) + bucketsByKind.characters.reduce((n, k) => n + (draft.categories?.[k]?.variations?.length || 0), 0) },
            { id: TAB_PLACES, label: 'Places', icon: MapPin, count: (draft.places?.length || 0) + bucketsByKind.places.reduce((n, k) => n + (draft.categories?.[k]?.variations?.length || 0), 0) },
            { id: TAB_OBJECTS, label: 'Objects', icon: Package, count: (draft.objects?.length || 0) + bucketsByKind.objects.reduce((n, k) => n + (draft.categories?.[k]?.variations?.length || 0), 0) },
            hasOtherBuckets && { id: TAB_OTHER, label: 'Other', icon: FolderTree, count: bucketsByKind.other.reduce((n, k) => n + (draft.categories?.[k]?.variations?.length || 0), 0) },
            { id: TAB_COMPOSITES, label: 'Composites', icon: Layers, count: totalSheets },
            { id: TAB_RENDER, label: 'Render', icon: ImagePlus },
          ]}
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
              image: refineImage, setImage: setRefineImage,
            }}
            totalVariations={totalVariations}
            categoryKeyCount={categoryKeys.length}
            totalSheets={totalSheets}
            onPreview={openPreviewByFilename}
            onStyleProbeRenderComplete={bumpGalleryRefresh}
            styleProbeDirty={styleProbeDirty}
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
              onPreviewVariation={openVariationPreview}
              onCanonPreview={openPreviewByFilename}
              pendingByEntryId={pendingHeadByEntryId}
              externalPendingByEntryId={pendingHeadByEntryId}
              onPendingCleared={clearPendingForEntry}
              onJobCompletedForEntry={(entryId, filename, bucket, completedJobId = null) => {
                if (!filename || !bucket) {
                  clearPendingForEntry(entryId, completedJobId);
                  return;
                }
                // Optimistically append the new filename to the variation's
                // imageRefs[] so the row swaps from spinner → rendered image
                // without a roundtrip. Server already stamped this via the
                // collection hook; the next universe refetch will agree.
                setDraft((d) => {
                  const cat = d.categories?.[bucket];
                  if (!cat?.variations) return d;
                  const variations = cat.variations.map((v) => {
                    if (v.id !== entryId) return v;
                    const refs = Array.isArray(v.imageRefs) ? v.imageRefs : [];
                    if (refs.includes(filename)) return v;
                    return { ...v, imageRefs: capImageRefs([...refs, filename]) };
                  });
                  return { ...d, categories: { ...d.categories, [bucket]: { ...cat, variations } } };
                });
                clearPendingForEntry(entryId, completedJobId);
                // The new sidecar exists now — pull it into galleryByFilename
                // so the lightbox opens with the real prompt/settings rather
                // than label-only metadata.
                bumpGalleryRefresh();
              }}
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
            onPreviewVariation={openVariationPreview}
            onAssignBucketKind={assignBucketKind}
            onAutoSort={handleAutoSort}
            autoSorting={autoSorting}
            pendingByEntryId={pendingHeadByEntryId}
            onPendingCleared={clearPendingForEntry}
            onJobCompletedForEntry={(entryId, filename, bucket, completedJobId = null) => {
              if (!filename || !bucket) {
                clearPendingForEntry(entryId, completedJobId);
                return;
              }
              setDraft((d) => {
                const cat = d.categories?.[bucket];
                if (!cat?.variations) return d;
                const variations = cat.variations.map((v) => {
                  if (v.id !== entryId) return v;
                  const refs = Array.isArray(v.imageRefs) ? v.imageRefs : [];
                  if (refs.includes(filename)) return v;
                  return { ...v, imageRefs: capImageRefs([...refs, filename]) };
                });
                return { ...d, categories: { ...d.categories, [bucket]: { ...cat, variations } } };
              });
              clearPendingForEntry(entryId, completedJobId);
              // Pull the new sidecar into galleryByFilename so the lightbox
              // opens with the real prompt/settings (mirrors the Cast/Places
              // path's onJobCompletedForEntry above).
              bumpGalleryRefresh();
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

      {/* Single page-level lightbox for every thumb on the page: variation
          grids, composite sheets, canon imageRefs (characters / places /
          objects), and character reference sheets. UniverseCanonSection used
          to host its own MediaPreview with a reduced action set + character
          description in place of the prompt; that fork is gone — canon
          clicks now bubble up through `openPreviewByFilename` and hit this
          modal, so the canon surface matches History / Collections / ImageGen
          exactly (Refine / Remix / SendToVideo / Clean / AddToCollection /
          Download / notes, all hydrated from the gallery sidecar). URL-driven
          via `usePreviewRoute` so `?preview=<filename>` deep-links open the
          same modal on reload. */}
      {/* Character reference sheets live under /data/image-refs/, but
          Remix / Send-to-Video / Clean / Continue all resolve filenames
          under /data/images/ (the gallery). Suppress those handlers when
          the current preview is a canon-sheet item so the lightbox doesn't
          offer actions that would 404 on the bare filename. */}
      <MediaPreview
        preview={preview}
        setPreview={setPreview}
        items={previewItems}
        annotations={annotations}
        updateAnnotation={updateAnnotation}
        onRemix={preview?.key?.startsWith('canon-sheet:') ? undefined : previewActions.handleRemix}
        onSendToImage={preview?.key?.startsWith('canon-sheet:') ? undefined : previewActions.handleSendToImage}
        onSendToVideo={preview?.key?.startsWith('canon-sheet:') ? undefined : previewActions.handleSendToVideo}
        onClean={preview?.key?.startsWith('canon-sheet:') ? undefined : (item) => previewActions.handleClean(item?.raw || item)}
        onRemoveWatermark={preview?.key?.startsWith('canon-sheet:') ? undefined : (item) => previewActions.handleRemoveWatermark(item?.raw || item)}
        onContinue={preview?.key?.startsWith('canon-sheet:') ? undefined : (item) => previewActions.handleContinue(item?.raw || item)}
      />
    </div>
  );
}

function totalVariationCount(world) {
  return getCategoryKeys(world.categories).reduce((n, c) => n + (world.categories?.[c]?.variations?.length || 0), 0);
}

// Mirror the server's synthesizeCanonPrompt skip rule: entries with no
// identity-anchor (name / slugline / prompt) AND no descriptive content for
// the kind compile to an empty seed and get skipped at render time. The
// "Render N images" button count must not overshoot what the server will
// actually enqueue.
const hasNonBlankString = (v) => typeof v === 'string' && v.trim().length > 0;

const canonEntryHasContent = (e, kind) => {
  if (!e) return false;
  if (hasNonBlankString(e.prompt)) return true;
  // Identifier anchors per kind — places allow slugline-only entries (bible
  // sanitizer); characters/objects ignore stray slugline. Mirrors server
  // synthesizeCanonPrompt's identifier-seed rule.
  if (hasNonBlankString(e.name)) return true;
  if (kind === 'places' && hasNonBlankString(e.slugline)) return true;
  return hasCanonDescriptorContent(kind, e);
};

const countCanonWithContent = (world, kind) =>
  (Array.isArray(world?.[kind]) ? world[kind] : []).filter((e) => canonEntryHasContent(e, kind)).length;

function renderPromptCount(world, promptMode = 'variations') {
  if (promptMode === 'variations') return totalVariationCount(world);
  const sheets = world.compositeSheets?.length || 0;
  if (promptMode === 'sheets') return sheets;
  const canon = countCanonWithContent(world, 'characters')
    + countCanonWithContent(world, 'places')
    + countCanonWithContent(world, 'objects');
  if (promptMode === 'canon') return canon;
  return totalVariationCount(world) + sheets + canon;
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
      for (const trunk of ['characters', 'places', 'objects']) {
        const pick = scope.canonSelection[trunk];
        if (!pick) continue;
        const entries = Array.isArray(world[trunk]) ? world[trunk] : [];
        const withContent = entries.filter((e) => canonEntryHasContent(e, trunk));
        if (pick === 'all') n += withContent.length;
        else if (Array.isArray(pick)) {
          const needles = new Set(pick.map((p) => p.toLowerCase()));
          // Mirror server: slugline matching is places-only — name is the
          // shared anchor for characters/objects.
          n += withContent.filter((e) => {
            const name = (e.name || '').toLowerCase();
            if (needles.has(name)) return true;
            if (trunk === 'places') {
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
    // Stamp `locked: true` up front so the in-draft row matches the
    // lock-by-default contract before the next save round-trips through
    // sanitizeCompositeSheet — otherwise the bulk-toggle's locked-count
    // gate would treat freshly-added boards as unlocked.
    onChange([...sheets, { kind: newKind, label: label.slice(0, 120), prompt: prompt.slice(0, COMPOSITE_PROMPT_MAX), locked: true }]);
    setNewKind('reference_sheet');
    setNewLabel('');
    setNewPrompt('');
    setAdding(false);
  };

  const removeAt = (idx) => onChange(sheets.filter((_, i) => i !== idx));

  // Sheets default to locked at the sanitizer (locked-by-default contract);
  // persist an unlock as explicit `false` so it survives the next read.
  const toggleLockAt = (idx) => onChange(sheets.map((s, i) => {
    if (i !== idx) return s;
    return { ...s, locked: !s.locked };
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
    // Preserve `id`, `locked`, `imageRefs` — see VariationCard.saveEdit for
    // the rationale. The editor only owns kind/label/prompt.
    next[editIdx] = {
      ...next[editIdx],
      kind: editKind,
      label: label.slice(0, 120),
      prompt: prompt.slice(0, COMPOSITE_PROMPT_MAX),
    };
    onChange(next);
    setEditIdx(null);
  };

  const setAllSheetsLocked = (nextLocked) =>
    onChange(sheets.map((s) => (s?.locked === nextLocked ? s : { ...s, locked: nextLocked })));
  const sheetsLockedCount = sheets.filter((s) => s?.locked === true).length;
  const allSheetsLocked = sheets.length > 0 && sheetsLockedCount === sheets.length;

  return (
    <section className="bg-port-card border border-port-border rounded p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-white">
          Composite boards
          <span className="ml-2 text-xs text-gray-500">{sheets.length}</span>
        </h2>
        <div className="flex items-center gap-1">
          {sheets.length > 0 && (
            <button
              onClick={() => setAllSheetsLocked(!allSheetsLocked)}
              title={allSheetsLocked
                ? 'Unlock all composite boards — Expand may overwrite them'
                : 'Lock all composite boards — Expand will preserve them'}
              aria-label={allSheetsLocked ? 'Unlock all composite boards' : 'Lock all composite boards'}
              aria-pressed={allSheetsLocked}
              className={`p-1 rounded ${
                allSheetsLocked
                  ? 'text-port-accent hover:bg-port-accent/20'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {allSheetsLocked ? <Lock size={14} /> : <Unlock size={14} />}
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
  // Clicking the row's thumbnail opens the page-level MediaPreview lightbox
  // (same modal that the history / gallery uses). Receives the visible
  // filename so the modal lands on the exact ref the user saw, not a stale
  // primary that may have walked-back on a 404.
  onPreviewVariation = null,
  // Per-row render-pending plumbing — `pendingByEntryId[v.id]` returns the
  // in-flight jobId (or undefined). Completion / failure callbacks fire when
  // the row's MediaJobThumb settles.
  pendingByEntryId = {}, onJobCompleted = null, onJobFailed = null,
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
    // Stamp `locked: true` so the in-draft row matches the lock-by-default
    // contract before the next save round-trips through sanitizeVariation.
    // Without this, the bulk-toggle counts a freshly-added variation as
    // unlocked even though the user expects every new entry to land locked.
    onChange([...variations, { label: label.slice(0, 120), prompt: prompt.slice(0, 2000), locked: true }]);
    setNewLabel('');
    setNewPrompt('');
    setAdding(false);
  };

  const removeAt = (idx) => onChange(variations.filter((_, i) => i !== idx));

  // Variations default to locked at the sanitizer (locked-by-default contract),
  // so an unlock must persist as explicit `false` — not as an absent key —
  // otherwise the next read would re-lock the entry the user just unlocked.
  const toggleLockAt = (idx) => onChange(variations.map((v, i) => {
    if (i !== idx) return v;
    return { ...v, locked: !v.locked };
  }));

  // Bulk lock/unlock everything in this bucket. Same persistence contract:
  // unlock writes explicit `false` so it survives the round-trip.
  const setAllLocked = (nextLocked) =>
    onChange(variations.map((v) => (v?.locked === nextLocked ? v : { ...v, locked: nextLocked })));
  const lockedCount = variations.filter((v) => v?.locked === true).length;
  const allLocked = variations.length > 0 && lockedCount === variations.length;

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
    // Preserve `id`, `locked`, and `imageRefs` — only label + prompt are
    // editable in this row. A naive replacement would re-mint the variation's
    // id (breaking the link to its render history) and drop accrued imageRefs.
    // The server's stale-PATCH guard catches some of this via length + tail
    // comparison (variations with NEW renders in cur survive an empty patch),
    // but a stale variation whose history hasn't grown server-side since the
    // client loaded would still get its imageRefs cleared if we sent an empty
    // array. Echoing cur's array verbatim avoids relying on the guard.
    next[editIdx] = {
      ...next[editIdx],
      label: label.slice(0, 120),
      prompt: prompt.slice(0, 2000),
    };
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
              className="p-1 text-port-accent hover:bg-port-accent/20 disabled:opacity-30 disabled:cursor-not-allowed rounded"
              title={variations.length === 0 ? 'Add variations first' : 'Render this category'}
              aria-label="Render this category"
            >
              <Play size={14} />
            </button>
          )}
          {onAssignBucketKind && requiresTargetKind && (
            <div className="relative" ref={assignWrapRef}>
              <button
                onClick={() => setAssignOpen((v) => !v)}
                className="p-1 text-port-accent hover:bg-port-accent/20 rounded"
                title="Move this bucket into a canon trunk (variations stay in place)"
                aria-label="Assign bucket to a canon trunk"
                aria-haspopup="menu"
                aria-expanded={assignOpen}
              >
                <FolderTree size={14} />
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
                className="p-1 text-port-accent hover:bg-port-accent/20 disabled:opacity-30 disabled:cursor-not-allowed rounded"
                title="Ask the LLM for more variations in this category"
                aria-label="Generate more variations"
                aria-haspopup="menu"
                aria-expanded={genOpen}
              >
                {generating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
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
          {variations.length > 0 && (
            // Single toggle — mirrors the per-row lock button. Lock icon when
            // every variation is locked (click unlocks all); Unlock icon for
            // the all-unlocked + mixed cases so a click always locks the
            // holdouts.
            <button
              onClick={() => setAllLocked(!allLocked)}
              title={allLocked
                ? 'Unlock all variations — Expand / Generate may overwrite them'
                : 'Lock all variations — Expand / Generate will preserve them'}
              aria-label={allLocked ? 'Unlock all variations' : 'Lock all variations'}
              aria-pressed={allLocked}
              className={`p-1 rounded ${
                allLocked
                  ? 'text-port-accent hover:bg-port-accent/20'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {allLocked ? <Lock size={14} /> : <Unlock size={14} />}
            </button>
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
            <VariationCard
              key={`${v.label}-${idx}`}
              variation={v}
              idx={idx}
              editMode={editIdx === idx}
              editLabel={editLabel}
              editPrompt={editPrompt}
              setEditLabel={setEditLabel}
              setEditPrompt={setEditPrompt}
              saveEdit={saveEdit}
              cancelEdit={() => setEditIdx(null)}
              startEdit={() => startEdit(idx, v)}
              toggleLock={() => toggleLockAt(idx)}
              remove={() => removeAt(idx)}
              onPromote={onPromote}
              canPromote={canPromote}
              requiresTargetKind={requiresTargetKind}
              promotingIdx={promotingIdx}
              pickerIdx={pickerIdx}
              setPickerIdx={setPickerIdx}
              pickerWrapRef={pickerWrapRef}
              runPromote={runPromote}
              onRenderVariation={onRenderVariation}
              canRender={canRender}
              onPreviewVariation={onPreviewVariation}
              inFlightJobId={pendingByEntryId[v.id] || null}
              onJobCompleted={onJobCompleted}
              onJobFailed={onJobFailed}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// Renders through `EntryCard` so the locked accent + layout stay in
// lock-step with `CanonCard`.
function VariationCard({
  variation: v, idx, editMode,
  editLabel, editPrompt, setEditLabel, setEditPrompt,
  saveEdit, cancelEdit, startEdit, toggleLock, remove,
  onPromote, canPromote, requiresTargetKind, promotingIdx,
  pickerIdx, setPickerIdx, pickerWrapRef, runPromote,
  onRenderVariation, canRender,
  onPreviewVariation = null,
  inFlightJobId = null, onJobCompleted = null, onJobFailed = null,
}) {
  const locked = !!v.locked;
  // Hooks MUST run unconditionally and in stable order — calling them after
  // the editMode early-return below would change the hook count between
  // display ↔ edit toggles and crash React with "Rendered more hooks than
  // during the previous render". Subscribe to the row's in-flight job here
  // so completion / failure callbacks fire back up to the parent (which
  // clears pending state + appends the new filename to the variation's
  // imageRefs[] optimistically). settledRef prevents duplicate fires under
  // React 18 StrictMode's mount → cleanup → mount dev double-fire.
  const { status: jobStatus, filename: jobFilename, error: jobError } = useMediaJobProgress(inFlightJobId);
  const settledRef = useRef(null);
  useEffect(() => {
    if (!inFlightJobId) { settledRef.current = null; return; }
    if (settledRef.current === inFlightJobId) return;
    if (jobStatus === 'completed' && jobFilename) {
      settledRef.current = inFlightJobId;
      // Pass `inFlightJobId` back so the parent can shift exactly this jobId
      // out of its per-entry queue. Without the jobId, `clearPendingForEntry`
      // would drop every queued job for the row — wrong when `batchPerVariation
      // > 1` queues N siblings and only one has just finished.
      onJobCompleted?.(v.id, jobFilename, inFlightJobId);
    } else if (jobStatus === 'failed' || jobStatus === 'canceled') {
      settledRef.current = inFlightJobId;
      onJobFailed?.(v.id, jobError || jobStatus, inFlightJobId);
    }
  }, [inFlightJobId, jobStatus, jobFilename, jobError, v.id, onJobCompleted, onJobFailed]);

  if (editMode) {
    return (
      <EntryCard
        locked={locked}
        body={(
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
              <button onClick={cancelEdit} className="text-xs px-2 py-1 bg-port-bg text-gray-300 rounded min-h-[40px] sm:min-h-0">Cancel</button>
            </div>
          </div>
        )}
      />
    );
  }

  const promoteTitle = !canPromote
    ? 'Save the universe first to enable promote'
    : requiresTargetKind
      ? 'Promote to canon — pick a trunk'
      : 'Promote to canon — LLM expands this variation into a full canon entry';

  // Thumbnail slot is three-state (pending / empty / completed) — see
  // `EntryThumbSlot`. Hook subscription that drives this lives above the
  // editMode early-return so the hook order stays stable across toggles.
  const renders = Array.isArray(v.imageRefs) ? v.imageRefs : [];
  const thumbnail = (
    <EntryThumbSlot
      inFlightJobId={inFlightJobId}
      imageRefs={renders}
      alt={`${v.label} render`}
      canRender={!!onRenderVariation && canRender}
      onRender={onRenderVariation ? () => onRenderVariation(v) : null}
      onPreview={onPreviewVariation || null}
    />
  );

  const title = <div className="text-sm text-white font-medium truncate">{v.label}</div>;
  const body = <div className="text-xs text-gray-400 line-clamp-2 mt-1">{v.prompt}</div>;
  const actions = (
    <div className="flex items-center gap-1">
      {onPromote && (
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
      )}
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
        onClick={toggleLock}
        className={`p-1 rounded ${locked ? 'text-port-accent hover:bg-port-accent/20' : 'text-gray-500 hover:text-gray-300'}`}
        title={locked ? 'Locked — AI expand will preserve this variation' : 'Lock this variation against AI expand'}
        aria-pressed={locked}
      >
        {locked ? <Lock size={14} /> : <Unlock size={14} />}
      </button>
      <button
        onClick={startEdit}
        className="p-1 text-gray-400 hover:text-port-accent rounded"
        title="Edit"
      >
        <Edit3 size={14} />
      </button>
      <button
        onClick={remove}
        className="p-1 text-gray-400 hover:text-red-400 rounded"
        title="Remove"
      >
        <X size={14} />
      </button>
    </div>
  );

  return <EntryCard locked={locked} thumbnail={thumbnail} title={title} body={body} actions={actions} />;
}

function BibleTab({
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

function RenderTab({
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
