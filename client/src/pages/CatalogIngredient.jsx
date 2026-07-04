/**
 * CatalogIngredient — detail/editor for a single catalog ingredient. Loaded
 * via /catalog/:type/:id; the type from the loaded record is the source of
 * truth. Side panels surface source scraps and inbound refs (universes /
 * pipeline series / issues / writers-room). Full-width page; owns its scroll.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { Sparkles, Save, Trash2, ArrowLeft, Loader2, ExternalLink, Plus, X, History, RotateCcw, Image as ImageIcon, Star, ChevronDown, Upload, Mic, Square } from 'lucide-react';
import toast from '../components/ui/Toast';
import {
  getCatalogIngredientDetails,
  updateCatalogIngredient,
  deleteCatalogIngredient,
  linkCatalogIngredientRelation,
  unlinkCatalogIngredientRelation,
  listCatalogIngredientRevisions,
  restoreCatalogIngredientRevision,
  listCatalogIngredientMedia,
  listCatalogIngredientMissingMedia,
  attachCatalogIngredientMedia,
  setCatalogIngredientPortrait,
  detachCatalogIngredientMedia,
  uploadCatalogIngredientMediaFile,
  recordCatalogIngredientVoiceMemo,
} from '../services/apiCatalog';
import { startMemoRecording, arrayBufferToBase64 } from '../lib/audioRecorder';
import { listImageGallery } from '../services/apiImageVideo';
import { generateImage } from '../services/apiSystem';
import { composeCanonStyledPrompt } from '../lib/composeStyledPrompt';
import { getUniverse } from '../services/apiUniverseBuilder';
import useMounted from '../hooks/useMounted';
import MediaJobThumb from '../components/pipeline/MediaJobThumb';
import IngredientPicker from '../components/IngredientPicker';
import MediaImage from '../components/MediaImage';
import CharacterLoraChip from '../components/loraTraining/CharacterLoraChip';
import TagPicker from '../components/TagPicker';
import GenericIngredientFields from '../components/GenericIngredientFields';
import { getCatalogType, CATALOG_BADGE_BY_ID, RELATION_KINDS, getRelationKind } from '../lib/catalogTypes';
import { useCatalogTypes } from '../hooks/useCatalogTypes.jsx';
import { timeAgo, formatDateTime } from '../utils/formatters';

// Per-type editor field list + badge color now come from the shared registry
// (`client/src/lib/catalogTypes.js`). Each editor entry is `[key, label, kind]`
// where `kind` is 'text' (single line) or 'textarea' (multi-line).

// Map a refKind onto a click-through route. Returns null for kinds we don't
// know how to deep-link to, so callers can render the chip without a link.
function refPath(refKind, refId) {
  if (!refId) return null;
  switch (refKind) {
    case 'universe':       return `/universes/${encodeURIComponent(refId)}`;
    case 'series':         return `/pipeline/series/${encodeURIComponent(refId)}`;
    case 'issue':          return `/pipeline/issues/${encodeURIComponent(refId)}/concept`;
    case 'creative-director': return `/media/creative-director/${encodeURIComponent(refId)}/overview`;
    case 'writers-room':
    case 'writersRoom':    return '/writers-room';
    default:               return null;
  }
}

function REFKIND_LABEL(kind) {
  if (kind === 'universe')   return 'Universes';
  if (kind === 'series')     return 'Series';
  if (kind === 'issue')      return 'Issues';
  if (kind === 'creative-director') return 'Creative Director';
  if (kind === 'writers-room' || kind === 'writersRoom') return "Writers' Room";
  return kind;
}

// Build the image-generation prompt source from the (live, editable) payload:
// the type's primary content field first, then a curated set of *visual*
// description fields, so a character renders from its full appearance and a
// place/object/idea from description/summary. The keys are the ones that DEPICT a
// subject — `role`/`notes`/`significance` describe the entity but don't depict it
// and would seed weak prompts, so they're excluded. Unlike the old single-field
// derive, this folds EVERY populated visual field together (#1809) so a character
// renders from physicalDescription PLUS visualNotes/visualIdentity/etc., and
// appends the ingredient's tags as extra prompt tokens. Capped so a verbose canon
// entry can't blow up the prompt. Returns '' when nothing usable is present (the
// editor prefill falls back to the name alone). Exported for unit tests.
export const GENERATION_VISUAL_KEYS = [
  'physicalDescription', 'visualNotes', 'visualIdentity',
  'silhouetteNotes', 'postureNotes', 'specialTraits',
  'description', 'summary',
];
const GENERATION_SEED_MAX = 700;
export function buildGenerationPromptSeed(payload, typeDef, tags = []) {
  const parts = [];
  if (payload && typeof payload === 'object') {
    const keys = [typeDef?.primaryContentKey, ...GENERATION_VISUAL_KEYS].filter(Boolean);
    const seen = new Set();
    for (const k of keys) {
      if (seen.has(k)) continue;
      seen.add(k);
      const v = payload[k];
      if (typeof v === 'string' && v.trim()) parts.push(v.trim());
    }
  }
  const tagList = Array.isArray(tags)
    ? tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim())
    : [];
  let seed = parts.join('. ');
  if (tagList.length) seed = seed ? `${seed}. ${tagList.join(', ')}` : tagList.join(', ');
  return seed.length > GENERATION_SEED_MAX
    ? `${seed.slice(0, GENERATION_SEED_MAX - 1).trimEnd()}…`
    : seed;
}

export default function CatalogIngredient() {
  const { id } = useParams();
  const navigate = useNavigate();
  // Merged type registry (system + user-defined). Falls back synchronously to
  // the static built-ins so the editor renders before the fetch resolves.
  const { getType: getMergedType } = useCatalogTypes();
  const [record, setRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [tags, setTags] = useState([]);
  const [payload, setPayload] = useState({});
  const [saving, setSaving] = useState(false);
  const [armedDelete, setArmedDelete] = useState(false);
  // { outbound: [...], inbound: [...] } — relations are loaded separately from
  // the ingredient record so the panel can refresh independently after add/
  // remove without re-fetching the whole detail payload.
  const [relations, setRelations] = useState({ outbound: [], inbound: [] });
  const [revisions, setRevisions] = useState([]);
  // Media attachments + the subset of their keys that don't resolve against the
  // local library (federated-in but asset not yet present). `missingMedia` is a
  // Set of media_keys driving the integrity badge on each thumbnail.
  const [media, setMedia] = useState([]);
  const [missingMedia, setMissingMedia] = useState(new Set());

  const refreshRevisions = useCallback(() => {
    if (!id) return;
    listCatalogIngredientRevisions(id, { limit: 50, silent: true })
      .then((r) => setRevisions(Array.isArray(r?.items) ? r.items : []))
      .catch(() => { /* history is non-critical — leave the panel empty */ });
  }, [id]);

  // One batched request hydrates the whole page on mount: ingredient + refs +
  // sources + relations + revisions + media + missing-media. Post-mutation
  // updates still use the granular refreshRevisions / refreshMedia callbacks +
  // optimistic relation state, so a single edit doesn't re-pull everything.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getCatalogIngredientDetails(id, { silent: true })
      .then((d) => {
        if (cancelled) return;
        if (!d?.ingredient) {
          setLoading(false);
          toast.error('Ingredient not found');
          navigate('/catalog');
          return;
        }
        const r = d.ingredient;
        setRecord({ ...r, refs: d.refs, sources: d.sources });
        setName(r.name || '');
        setTags(Array.isArray(r.tags) ? r.tags : []);
        setPayload(r.payload && typeof r.payload === 'object' ? { ...r.payload } : {});
        setRelations({
          outbound: Array.isArray(d.relations?.outbound) ? d.relations.outbound : [],
          inbound: Array.isArray(d.relations?.inbound) ? d.relations.inbound : [],
        });
        setRevisions(Array.isArray(d.revisions) ? d.revisions : []);
        setMedia(Array.isArray(d.media) ? d.media : []);
        setMissingMedia(new Set(Array.isArray(d.missingMedia) ? d.missingMedia.map((m) => m.mediaKey) : []));
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoading(false);
        toast.error(err?.message || 'Failed to load ingredient');
        navigate('/catalog');
      });
    return () => { cancelled = true; };
  }, [id, navigate]);

  // Add an outbound edge (this ingredient → picked target). Optimistically
  // appends to local state so the panel updates without a refetch.
  const handleAddRelation = async (target, kind) => {
    if (!record || !target?.id) return;
    if (target.id === record.id) { toast.error('Cannot relate an ingredient to itself'); return; }
    const ok = await linkCatalogIngredientRelation(record.id, { toId: target.id, kind }, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error(err?.message || 'Failed to add relation'); return false; });
    if (!ok) return;
    setRelations((prev) => {
      const exists = prev.outbound.some((r) => r.toId === target.id && r.kind === kind);
      if (exists) return prev;
      return {
        ...prev,
        outbound: [...prev.outbound, {
          fromId: record.id, toId: target.id, kind,
          createdAt: new Date().toISOString(),
          other: { id: target.id, name: target.name, type: target.type },
        }],
      };
    });
    toast.success('Relation added');
  };

  // Remove an outbound edge. Inbound edges are owned by the OTHER ingredient,
  // so the panel only deletes outbound ones (filter is by toId + kind).
  const handleRemoveRelation = async (toId, kind) => {
    if (!record) return;
    const ok = await unlinkCatalogIngredientRelation(record.id, { toId, kind }, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error(err?.message || 'Failed to remove relation'); return false; });
    if (!ok) return;
    setRelations((prev) => ({
      ...prev,
      outbound: prev.outbound.filter((r) => !(r.toId === toId && r.kind === kind)),
    }));
  };

  // Load media attachments + the integrity (missing-key) overlay. Both refresh
  // independently of the detail payload so attach/detach updates the panel
  // without re-fetching the whole record.
  const refreshMedia = useCallback(() => {
    if (!id) return;
    listCatalogIngredientMedia(id, { silent: true })
      .then((rows) => setMedia(Array.isArray(rows) ? rows : []))
      .catch(() => { /* media is non-critical — leave the panel empty */ });
    listCatalogIngredientMissingMedia(id, { silent: true })
      .then((r) => setMissingMedia(new Set(Array.isArray(r?.missing) ? r.missing.map((m) => m.mediaKey) : [])))
      .catch(() => { /* integrity overlay is best-effort */ });
  }, [id]);
  // Initial media/relations/revisions are seeded by the batched details load
  // above; refreshMedia / refreshRevisions only run after a mutation.

  // Attach a media key (gallery filename) as a typed attachment. `kind` defaults
  // to 'reference' for drag-drop / picker; the "set portrait" path routes
  // through handleSetPortrait instead. Optimistic — prepend then reconcile.
  const handleAttachMedia = async (mediaKey, kind = 'reference') => {
    if (!record || !mediaKey) return;
    const ok = await attachCatalogIngredientMedia(record.id, { mediaKey, kind }, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error(err?.message || 'Failed to attach media'); return false; });
    if (!ok) return;
    refreshMedia();
    toast.success('Media attached');
  };

  const handleSetPortrait = async (mediaKey) => {
    if (!record || !mediaKey) return;
    const ok = await setCatalogIngredientPortrait(record.id, { mediaKey }, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error(err?.message || 'Failed to set portrait'); return false; });
    if (!ok) return;
    refreshMedia();
    toast.success('Portrait set');
  };

  const handleDetachMedia = async (mediaKey, kind) => {
    if (!record) return;
    const ok = await detachCatalogIngredientMedia(record.id, { mediaKey, kind }, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error(err?.message || 'Failed to detach media'); return false; });
    if (!ok) return;
    setMedia((prev) => prev.filter((m) => !(m.mediaKey === mediaKey && m.kind === kind)));
  };

  // A freshly-generated image lands in the media library as `<jobId>.png`; wire
  // it onto this ingredient. First image becomes the portrait (so it shows as
  // the card thumbnail immediately); later ones attach as references.
  const handleGeneratedImage = useCallback(async (filename) => {
    if (!record || !filename) return;
    const hasPortrait = media.some((m) => m.kind === 'portrait');
    const ok = await (hasPortrait
      ? attachCatalogIngredientMedia(record.id, { mediaKey: filename, kind: 'reference' }, { silent: true })
      : setCatalogIngredientPortrait(record.id, { mediaKey: filename }, { silent: true })
    ).then(() => true).catch((err) => { toast.error(err?.message || 'Failed to attach generated image'); return false; });
    if (!ok) return;
    refreshMedia();
    toast.success(hasPortrait ? 'Generated image attached' : 'Generated portrait set');
  }, [record, media, refreshMedia]);

  // Upload a dropped/picked file straight onto the ingredient. The server picks
  // the media kind (image→reference, audio, video) from the MIME and stores the
  // bytes in the matching federating library dir. Reconcile via refreshMedia.
  const handleUploadFile = useCallback(async (file) => {
    if (!record || !file) return;
    const dataBase64 = arrayBufferToBase64(await file.arrayBuffer());
    const ok = await uploadCatalogIngredientMediaFile(
      record.id,
      { dataBase64, mimeType: file.type || 'application/octet-stream', filename: file.name },
      { silent: true },
    ).then(() => true).catch((err) => { toast.error(err?.message || 'Upload failed'); return false; });
    if (!ok) return;
    refreshMedia();
    toast.success('File attached');
  }, [record, refreshMedia]);

  // Attach a recorded voice memo — the server transcribes it via Whisper and
  // stores the transcript in the audio row's caption.
  const handleRecordVoiceMemo = useCallback(async (clip) => {
    if (!record || !clip?.audioBase64) return;
    const ok = await recordCatalogIngredientVoiceMemo(
      record.id,
      { audioBase64: clip.audioBase64, mimeType: clip.mimeType },
      { silent: true },
    ).then(() => true).catch((err) => { toast.error(err?.message || 'Voice memo failed'); return false; });
    if (!ok) return;
    refreshMedia();
    toast.success('Voice memo attached');
  }, [record, refreshMedia]);

  const handleSave = async () => {
    if (!record) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error('Name is required');
      return;
    }
    setSaving(true);
    const updated = await updateCatalogIngredient(record.id, {
      name: trimmedName,
      payload,
      tags,
    }, { silent: true }).catch((err) => {
      toast.error(err?.message || 'Save failed');
      return null;
    });
    setSaving(false);
    if (!updated) return;
    setRecord((prev) => ({ ...prev, ...updated }));
    // The server normalizes tags through the canonical table (casing/whitespace
    // collapse), so reflect the persisted set back into the chips.
    if (Array.isArray(updated.tags)) setTags(updated.tags);
    toast.success('Saved');
    refreshRevisions();
  };

  const handleRestore = async (revisionId) => {
    if (!record) return;
    const updated = await restoreCatalogIngredientRevision(record.id, revisionId, {}, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Restore failed'); return null; });
    if (!updated) return;
    // Re-apply the restored state into the editable form so the page reflects
    // the rollback without a full reload.
    setRecord((prev) => ({ ...prev, ...updated }));
    setName(updated.name || '');
    setTags(Array.isArray(updated.tags) ? updated.tags : []);
    setPayload(updated.payload && typeof updated.payload === 'object' ? { ...updated.payload } : {});
    toast.success('Restored');
    refreshRevisions();
  };

  const confirmDelete = async () => {
    if (!record) return;
    setArmedDelete(false);
    const ok = await deleteCatalogIngredient(record.id, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error(err?.message || 'Delete failed'); return false; });
    if (ok) {
      toast.success('Deleted');
      navigate('/catalog');
    }
  };

  const updatePayload = (key, value) => {
    setPayload((prev) => ({ ...prev, [key]: value }));
  };

  if (loading || !record) {
    return (
      <section className="h-full overflow-y-auto p-4 md:p-6">
        <div className="max-w-4xl mx-auto text-sm text-gray-400">Loading ingredient…</div>
      </section>
    );
  }

  // Resolve from the merged registry (system + user types) so a user-typed
  // ingredient picks up its declared fields; fall back to the static 'idea'
  // editor for an unknown/orphaned type.
  const typeDef = getMergedType(record.type) || getCatalogType(record.type) || getCatalogType('idea');
  const fields = typeDef.editorFields || getCatalogType('idea').editorFields;
  // Grouped "character sheet" sections for the rich canon types
  // (character/place/object); light types (idea/scene/concept) have none and
  // fall back to the flat field list below.
  const sections = typeDef.editorSections || null;
  // A user-defined type has no hardcoded editor sections and carries
  // generically-shaped editorFields ({ key, label, widget }); render the
  // generic field renderer for it. System types keep their existing branches.
  const isUserType = typeDef.system === false;
  const badgeClass = CATALOG_BADGE_BY_ID[record.type] || 'bg-gray-500/20 text-gray-300 border-gray-500/40';
  // Prompt source for the Media panel's "Generate" affordance — derived from the
  // currently-edited payload + the live `tags` state (NOT record.tags) so unsaved
  // tweaks to the description or tags feed the next render's default prompt. The
  // user can still edit the composed prompt before generating (#1809).
  const genDescription = buildGenerationPromptSeed(payload, typeDef, tags);

  // Group refs by kind for the "Appears in" panel. Tolerates either an array
  // of `{ refKind, refId, role }` or a server-grouped shape.
  const refs = Array.isArray(record.refs) ? record.refs : [];
  const refsByKind = refs.reduce((acc, r) => {
    const k = r.refKind || r.kind || 'other';
    (acc[k] ||= []).push(r);
    return acc;
  }, {});

  // First universe this ingredient belongs to — drives the "render reference
  // sheet" deep-link (the renderer needs the universe's full style data, which
  // lives on the Universe Builder surface). null when the ingredient isn't a
  // canon entry of any universe.
  const universeRef = (refsByKind.universe || [])[0] || null;

  return (
    <section className="h-full overflow-y-auto p-4 md:p-6">
      <div className="max-w-4xl mx-auto space-y-5">
        <header className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-start gap-3 min-w-0">
            <Sparkles className="w-6 h-6 text-port-accent mt-1 flex-shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-2xl font-bold text-white truncate">
                  {record.name || '(untitled)'}
                </h1>
                <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border ${badgeClass}`}>
                  {record.type}
                </span>
              </div>
              <p className="text-xs text-gray-500 mt-1 font-mono">{record.id}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link to="/catalog" className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm text-gray-400 hover:text-white">
              <ArrowLeft size={14} aria-hidden="true" /> Back
            </Link>
            <button type="button" onClick={handleSave} disabled={saving}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-port-accent hover:bg-port-accent/90 disabled:opacity-50 text-white text-sm font-medium">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
            </button>
            {armedDelete ? (
              <span className="inline-flex items-center gap-1 text-sm">
                <span className="text-gray-400 px-1">Delete this ingredient?</span>
                <button type="button" onClick={confirmDelete}
                  className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-port-error/20 text-port-error hover:bg-port-error/30 font-medium">
                  <Trash2 size={14} aria-hidden="true" /> Yes, delete
                </button>
                <button type="button" onClick={() => setArmedDelete(false)}
                  className="px-3 py-2 rounded-lg text-gray-400 hover:text-white">
                  Cancel
                </button>
              </span>
            ) : (
              <button type="button" onClick={() => setArmedDelete(true)}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm border border-port-border text-gray-400 hover:text-port-error"
                aria-label="Delete ingredient" title="Delete">
                <Trash2 size={14} /> Delete
              </button>
            )}
          </div>
        </header>

        <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6 space-y-4">
          <div>
            <label htmlFor="ingredient-name" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">Name</label>
            <input id="ingredient-name" type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={200}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm focus:outline-none focus:border-port-accent" />
          </div>
          <div>
            <label htmlFor="ingredient-tags" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">
              Tags
            </label>
            <TagPicker id="ingredient-tags" value={tags} onChange={setTags}
              placeholder="mentor, antagonist, season-1" />
          </div>
          {isUserType
            ? <GenericIngredientFields fields={fields} payload={payload} onChange={updatePayload} />
            : sections
            ? sections.map((section) => (
                <SheetSection key={section.title} title={section.title}
                  fields={section.fields} payload={payload} onChange={updatePayload} />
              ))
            : fields.map(([key, label, kind]) => (
                <SheetField key={key} fieldKey={key} label={label} kind={kind}
                  value={payload[key] ?? ''} onChange={updatePayload} />
              ))}

          {/* Structured array-field editors (aliases / color palette / stats).
              Driven by the type's registry-declared `editableListFields`; the
              same durable catalog row the Universe Builder canon surface edits.
              Light/user types declare none and skip this entirely. */}
          {!isUserType && Array.isArray(typeDef.editableListFields) && typeDef.editableListFields.length > 0 && (
            <EditableListFields fields={typeDef.editableListFields} payload={payload} onChange={updatePayload} />
          )}
        </div>

        {record.type === 'character' && (
          <>
            <ReferenceSheetPanel payload={payload} universeRef={universeRef} />
            {/* Trained-LoRA link + dataset entry point. The catalog id IS the
                ingredientId the trained sidecars carry; the universe entryId
                isn't known on this surface, so the chip links an existing
                dataset rather than offering find-or-create. */}
            <div className="bg-port-card border border-port-border rounded-lg p-4">
              <div className="text-xs uppercase tracking-wider text-gray-500 mb-2">Character LoRA</div>
              <CharacterLoraChip ingredientId={record.id} />
            </div>
          </>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <SourcesPanel sources={record.sources} />
          <RefsPanel refsByKind={refsByKind} />
        </div>

        <RelationsPanel
          record={record}
          relations={relations}
          onAdd={handleAddRelation}
          onRemove={handleRemoveRelation}
        />

        <MediaPanel
          media={media}
          missingMedia={missingMedia}
          onAttach={handleAttachMedia}
          onSetPortrait={handleSetPortrait}
          onDetach={handleDetachMedia}
          onUploadFile={handleUploadFile}
          onRecordVoice={handleRecordVoiceMemo}
          genIngredientId={record.id}
          genName={name}
          genDescription={genDescription}
          genUniverseId={universeRef?.refId || null}
          onGenerated={handleGeneratedImage}
        />

        <RevisionsPanel
          revisions={revisions}
          current={record}
          fields={fields}
          onRestore={handleRestore}
        />
      </div>
    </section>
  );
}

// One editable scalar field in the character sheet. `kind` is 'text' (single
// line) or 'textarea' (multi-line). Edits write straight through to the shared
// payload via `onChange(key, value)` — the same durable catalog row the
// Universe Builder canon surface edits.
function SheetField({ fieldKey, label, kind, value, onChange }) {
  const inputId = `ingredient-${fieldKey}`;
  const shared = 'w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm focus:outline-none focus:border-port-accent';
  return (
    <div>
      <label htmlFor={inputId} className="block text-xs uppercase tracking-wider text-gray-500 mb-1">{label}</label>
      {kind === 'textarea'
        ? <textarea id={inputId} rows={3} value={value} onChange={(e) => onChange(fieldKey, e.target.value)} className={shared} />
        : <input id={inputId} type="text" value={value} onChange={(e) => onChange(fieldKey, e.target.value)} className={shared} />}
    </div>
  );
}

// One collapsible "sheet section" — a labeled group of scalar fields. Open by
// default; collapsing keeps the long character sheet manageable above the fold.
function SheetSection({ title, fields, payload, onChange }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="border border-port-border rounded-lg overflow-hidden">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="w-full flex items-center justify-between px-3 py-2 bg-port-bg/60 hover:bg-port-bg text-left">
        <span className="text-xs font-semibold uppercase tracking-wider text-gray-300">{title}</span>
        <ChevronDown size={14} aria-hidden="true"
          className={`text-gray-500 transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>
      {open && (
        <div className="p-3 space-y-3">
          {fields.map(([key, label, kind]) => (
            <SheetField key={key} fieldKey={key} label={label} kind={kind}
              value={payload[key] ?? ''} onChange={onChange} />
          ))}
        </div>
      )}
    </div>
  );
}

// Structured array-field editors (aliases / color palette / stats). Each field
// is declared on the type registry as `{ key, label, kind, itemMax, listMax }`
// and dispatched to the matching editor below. Edits write the WHOLE array back
// through `onChange(key, nextArray)` into the shared payload state, so the
// page's existing `handleSave` persists them — no new endpoint. The server's
// storyBible sanitizer re-caps/normalizes on save (it owns the durable shape);
// these editors mirror its caps so the add-button disables at the limit rather
// than silently dropping rows on save.
function EditableListFields({ fields, payload, onChange }) {
  return (
    <div className="space-y-4 pt-1">
      {fields.map((f) => {
        const value = Array.isArray(payload[f.key]) ? payload[f.key] : [];
        const set = (next) => onChange(f.key, next);
        if (f.kind === 'colorPalette') {
          return <ColorPaletteEditor key={f.key} field={f} value={value} onChange={set} />;
        }
        if (f.kind === 'kv') {
          return <StatListEditor key={f.key} field={f} value={value} onChange={set} />;
        }
        return <AliasListEditor key={f.key} field={f} value={value} onChange={set} />;
      })}
    </div>
  );
}

// Shared section header for the array editors. `atCap` toggles the add-button
// disabled state + a small "(max N)" hint so the cap is discoverable.
function ListEditorHeader({ label, count, listMax, onAdd, addLabel = 'Add' }) {
  const atCap = count >= listMax;
  return (
    <div className="flex items-center justify-between gap-2 mb-1.5">
      <span className="text-xs uppercase tracking-wider text-gray-500">
        {label} <span className="text-gray-600 normal-case tracking-normal">({count}/{listMax})</span>
      </span>
      <button type="button" onClick={onAdd} disabled={atCap}
        className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-port-border text-gray-300 hover:text-white hover:border-port-accent disabled:opacity-40 disabled:cursor-not-allowed"
        title={atCap ? `Maximum ${listMax} reached` : addLabel}>
        <Plus size={12} aria-hidden="true" /> {addLabel}
      </button>
    </div>
  );
}

const listInput = 'px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-xs focus:outline-none focus:border-port-accent';

// String-array chips editor (e.g. aliases). Each row is a single-line input
// with a remove button; the add-button is disabled at `listMax`.
function AliasListEditor({ field, value, onChange }) {
  const { label, itemMax, listMax } = field;
  const items = value.map((v) => (typeof v === 'string' ? v : String(v ?? '')));
  const add = () => { if (items.length < listMax) onChange([...items, '']); };
  const update = (i, next) => onChange(items.map((v, idx) => (idx === i ? next : v)));
  const remove = (i) => onChange(items.filter((_, idx) => idx !== i));
  return (
    <div>
      <ListEditorHeader label={label} count={items.length} listMax={listMax} onAdd={add} addLabel="Add alias" />
      {items.length === 0 ? (
        <p className="text-[11px] text-gray-600">None yet.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {items.map((v, i) => {
            const inputId = `${field.key}-${i}`;
            return (
              <span key={i} className="inline-flex items-center gap-1">
                <label htmlFor={inputId} className="sr-only">{label} {i + 1}</label>
                <input id={inputId} type="text" value={v} maxLength={itemMax}
                  onChange={(e) => update(i, e.target.value)} className={`${listInput} w-40`} />
                <button type="button" onClick={() => remove(i)} aria-label={`Remove ${label} ${i + 1}`}
                  className="text-gray-500 hover:text-port-error"><X size={12} aria-hidden="true" /></button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Color-palette editor — rows of `{ name, hex, role }`. A native color swatch
// sits beside the hex text input so the user can pick OR type a value (the
// sanitizer tolerates non-hex names like "off-white", so the text input is the
// source of truth and the swatch is a convenience).
function ColorPaletteEditor({ field, value, onChange }) {
  const { label, listMax } = field;
  const rows = value.map((c) => (c && typeof c === 'object' ? c : {}));
  const add = () => { if (rows.length < listMax) onChange([...rows, { name: '', hex: '', role: '' }]); };
  const update = (i, key, next) => onChange(rows.map((c, idx) => (idx === i ? { ...c, [key]: next } : c)));
  const remove = (i) => onChange(rows.filter((_, idx) => idx !== i));
  // A native <input type=color> needs a 7-char #rrggbb; a blank/short/named
  // value falls back to a neutral swatch so the picker doesn't error.
  const swatchVal = (hex) => (/^#[0-9a-fA-F]{6}$/.test(hex || '') ? hex : '#888888');
  return (
    <div>
      <ListEditorHeader label={label} count={rows.length} listMax={listMax} onAdd={add} addLabel="Add color" />
      {rows.length === 0 ? (
        <p className="text-[11px] text-gray-600">None yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((c, i) => (
            <li key={i} className="flex items-center gap-1.5 flex-wrap">
              <label htmlFor={`${field.key}-hex-${i}`} className="sr-only">{label} {i + 1} hex</label>
              <input type="color" aria-label={`${label} ${i + 1} swatch`} value={swatchVal(c.hex)}
                onChange={(e) => update(i, 'hex', e.target.value)}
                className="w-7 h-7 rounded border border-port-border bg-port-bg p-0.5 cursor-pointer" />
              <input type="text" placeholder="name" value={c.name || ''} maxLength={80}
                aria-label={`${label} ${i + 1} name`}
                onChange={(e) => update(i, 'name', e.target.value)} className={`${listInput} w-32`} />
              <input id={`${field.key}-hex-${i}`} type="text" placeholder="#hex / value" value={c.hex || ''} maxLength={10}
                onChange={(e) => update(i, 'hex', e.target.value)} className={`${listInput} w-28 font-mono`} />
              <input type="text" placeholder="role (e.g. skin)" value={c.role || ''} maxLength={120}
                aria-label={`${label} ${i + 1} role`}
                onChange={(e) => update(i, 'role', e.target.value)} className={`${listInput} w-32`} />
              <button type="button" onClick={() => remove(i)} aria-label={`Remove ${label} ${i + 1}`}
                className="text-gray-500 hover:text-port-error"><X size={12} aria-hidden="true" /></button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Key/value stat editor — rows of `{ label, value }`. NOTE the field shape: the
// storyBible sanitizer (`sanitizeStat`) stores `{ label, value }`, NOT
// `{ key, value }`. The prior read-only renderer read `s.key`, which silently
// rendered blank for every real stat — this editor + the durable shape now
// standardize on `.label`.
function StatListEditor({ field, value, onChange }) {
  const { label, itemMax, listMax } = field;
  const rows = value.map((s) => (s && typeof s === 'object' ? s : {}));
  const add = () => { if (rows.length < listMax) onChange([...rows, { label: '', value: '' }]); };
  const update = (i, key, next) => onChange(rows.map((s, idx) => (idx === i ? { ...s, [key]: next } : s)));
  const remove = (i) => onChange(rows.filter((_, idx) => idx !== i));
  return (
    <div>
      <ListEditorHeader label={label} count={rows.length} listMax={listMax} onAdd={add} addLabel="Add stat" />
      {rows.length === 0 ? (
        <p className="text-[11px] text-gray-600">None yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((s, i) => (
            <li key={i} className="flex items-center gap-1.5 flex-wrap">
              <label htmlFor={`${field.key}-label-${i}`} className="sr-only">{label} {i + 1} label</label>
              <input id={`${field.key}-label-${i}`} type="text" placeholder="label" value={s.label || ''} maxLength={80}
                onChange={(e) => update(i, 'label', e.target.value)} className={`${listInput} w-36`} />
              <label htmlFor={`${field.key}-value-${i}`} className="sr-only">{label} {i + 1} value</label>
              <input id={`${field.key}-value-${i}`} type="text" placeholder="value" value={s.value || ''} maxLength={itemMax}
                onChange={(e) => update(i, 'value', e.target.value)} className={`${listInput} w-40`} />
              <button type="button" onClick={() => remove(i)} aria-label={`Remove ${label} ${i + 1}`}
                className="text-gray-500 hover:text-port-error"><X size={12} aria-hidden="true" /></button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// "Reference sheet" panel — shows the rendered character turnaround sheet when
// one exists (payload.referenceSheetImageRef / referenceSheets[]), served from
// the /data/image-refs/ static prefix. When no sheet exists but the character
// belongs to a universe, surfaces a deep-link to render one on the Universe
// Builder surface, which carries the universe's full style data (styleNotes,
// influences, palette, render settings) the renderer needs. Rendering inline
// here would duplicate that heavy pipeline — the deep-link keeps one render
// path. The link targets the universe's `#canon` section (the anchor the
// Universe Builder hash-scroll resolves).
function ReferenceSheetPanel({ payload, universeRef }) {
  const sheets = payload?.referenceSheets && typeof payload.referenceSheets === 'object'
    ? Object.entries(payload.referenceSheets).filter(([, v]) => typeof v === 'string' && v)
    : [];
  const legacy = typeof payload?.referenceSheetImageRef === 'string' ? payload.referenceSheetImageRef : '';
  // De-dup: the legacy 'standard' pointer often duplicates a referenceSheets entry.
  const variants = [
    ...(legacy ? [['standard', legacy]] : []),
    ...sheets.filter(([, v]) => v !== legacy),
  ];
  const hasSheet = variants.length > 0;

  // Deep-link to the universe's canon section (`id="canon"`, the one anchor the
  // Universe Builder hash-scroll handler resolves) — a per-character anchor
  // isn't rendered there, so #canon lands the user on the canon surface where
  // the character + its render controls live.
  const universePath = universeRef?.refId
    ? `/universes/${encodeURIComponent(universeRef.refId)}#canon`
    : null;

  return (
    <section className="bg-port-card border border-port-border rounded-lg p-4">
      <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <h2 className="text-sm font-semibold text-white flex items-center gap-1.5">
          <ImageIcon size={14} aria-hidden="true" /> Reference sheet
        </h2>
        {universePath && (
          <Link to={universePath}
            className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded border border-port-border text-gray-300 hover:text-white hover:border-port-accent">
            <Sparkles size={12} aria-hidden="true" />
            {hasSheet ? 'Re-render in Universe Builder' : 'Render in Universe Builder'}
            <ExternalLink size={11} aria-hidden="true" />
          </Link>
        )}
      </div>
      {hasSheet ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {variants.map(([variant, filename]) => (
            <figure key={variant} className="rounded border border-port-border overflow-hidden bg-port-bg">
              <MediaImage src={`/data/image-refs/${filename}`} alt={`${variant} reference sheet`}
                className="w-full object-contain max-h-[420px]" />
              <figcaption className="text-[10px] uppercase tracking-wider text-gray-500 px-2 py-1 border-t border-port-border">
                {variant}
              </figcaption>
            </figure>
          ))}
        </div>
      ) : (
        <p className="text-xs text-gray-500">
          No reference sheet rendered yet.
          {universePath
            ? ' Render one from the linked universe (it carries the style data the renderer needs).'
            : ' Link this character to a universe to render a reference sheet from its style data.'}
        </p>
      )}
    </section>
  );
}

// "Relations" panel — ingredient↔ingredient edges. Outbound edges (this
// ingredient → other) are user-editable here; inbound edges (other → this
// ingredient) are read-only because the owning ingredient is the other end.
function RelationsPanel({ record, relations, onAdd, onRemove }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [kind, setKind] = useState(RELATION_KINDS[0].id);
  const outbound = Array.isArray(relations.outbound) ? relations.outbound : [];
  const inbound = Array.isArray(relations.inbound) ? relations.inbound : [];

  // Hide the current record + everything already linked outbound from the
  // picker so the user can't double-link or self-link.
  const excludeIds = [record.id, ...outbound.map((r) => r.toId)];

  const chip = (other) => {
    const badge = CATALOG_BADGE_BY_ID[other?.type] || 'bg-gray-500/20 text-gray-300 border-gray-500/40';
    return (
      <Link to={`/catalog/${encodeURIComponent(other?.type || 'idea')}/${encodeURIComponent(other?.id)}`}
        className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded border border-port-border bg-port-bg text-gray-200 hover:opacity-80">
        <span className="truncate max-w-[16rem]">{other?.name || other?.id || '(unnamed)'}</span>
        <span className={`text-[9px] uppercase tracking-wider px-1 py-0.5 rounded border ${badge}`}>{other?.type}</span>
      </Link>
    );
  };

  return (
    <section className="bg-port-card border border-port-border rounded-lg p-4">
      <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <h2 className="text-sm font-semibold text-white">Relations</h2>
        <div className="flex items-center gap-2">
          <label htmlFor="relation-kind" className="sr-only">Relation kind</label>
          <select id="relation-kind" value={kind} onChange={(e) => setKind(e.target.value)}
            className="px-2 py-1.5 bg-port-bg border border-port-border rounded text-xs text-white focus:outline-none focus:border-port-accent">
            {RELATION_KINDS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
          <button type="button" onClick={() => setPickerOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-port-accent hover:bg-port-accent/90 text-white text-xs font-medium">
            <Plus size={12} aria-hidden="true" /> Add relation
          </button>
        </div>
      </div>

      {outbound.length === 0 && inbound.length === 0 ? (
        <p className="text-xs text-gray-500">No relations yet. Link this ingredient to another (a character to the place they live, a scene to its cast, …).</p>
      ) : (
        <div className="space-y-3">
          {outbound.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">Outbound</div>
              <ul className="space-y-1.5">
                {outbound.map((r) => (
                  <li key={`${r.toId}-${r.kind}`} className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-gray-400">{getRelationKind(r.kind)?.label || r.kind}</span>
                    {chip(r.other)}
                    <button type="button" onClick={() => onRemove(r.toId, r.kind)}
                      aria-label={`Remove relation to ${r.other?.name || r.toId}`}
                      className="text-gray-500 hover:text-port-error">
                      <X size={12} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {inbound.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">Inbound</div>
              <ul className="space-y-1.5">
                {inbound.map((r) => (
                  <li key={`${r.fromId}-${r.kind}`} className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-gray-400">{getRelationKind(r.kind)?.inverseLabel || r.kind}</span>
                    {chip(r.other)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <IngredientPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(picked) => onAdd(picked, kind)}
        excludeIds={excludeIds}
      />
    </section>
  );
}

// "Media" panel — typed image/audio/video/document attachments. Each row
// stores a `media_key` REFERENCE into the media library (never the bytes), so
// the panel scopes its picker to the existing gallery/history. The portrait
// (one per ingredient) renders large at the head; other attachments tile below.
// Drag-and-drop accepts an in-app gallery filename dragged as text (the
// dashboard/gallery tiles set `dataTransfer.setData('text/plain', filename)`) OR
// a real file dropped from the OS. "Upload file" (image/audio/video) and "Record
// memo" (MediaRecorder → WAV → Whisper transcript) persist through the catalog
// media-upload/voice routes into the federating library dirs, then attach via
// the same media-refs seam gallery picks use.
// "Generate" affordance for the Media panel — turns the ingredient's
// description into an image via the same image-gen queue the Universe canon
// renders use. The generated file lands in the media library as `<jobId>.png`;
// `MediaJobThumb` surfaces the live diffusion preview and fires `onFilename`
// once complete, which routes to `onComplete` to attach it onto the ingredient.
// Disabled when the description is blank — there's nothing to render from.
function GenerateImageControl({ ingredientId, name, description, universeId, onComplete }) {
  const mountedRef = useMounted();
  const [jobId, setJobId] = useState(null);
  const [starting, setStarting] = useState(false);
  // Editable-prompt panel state (#1809): the user opens an inline editor,
  // tweaks the auto-composed prompt, then renders — instead of firing a fixed
  // prompt on the first click.
  const [editing, setEditing] = useState(false);
  const [prefilling, setPrefilling] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');

  // Open the editor and prefill the prompt with the composed default: the
  // ingredient's visual seed + tags, layered on the linked universe's style
  // preset (fetched lazily — the page deliberately doesn't load the universe up
  // front). A failed/missing universe just omits the preset; the seed still
  // renders. Don't clobber a prompt the user already edited (re-open keeps it).
  const openEditor = async () => {
    setEditing(true);
    if (prompt.trim()) return; // keep prior edits when re-opening
    setPrefilling(true);
    let universe = null;
    if (universeId) {
      universe = await getUniverse(universeId, { silent: true }).catch(() => null);
    }
    const styled = composeCanonStyledPrompt({
      name: name || 'Subject',
      description: description || '',
      universe,
    });
    if (!mountedRef.current) return;
    // The textarea is editable during the (awaited) universe fetch, so the user
    // may have started typing before it resolved — apply the composed prefill
    // only when the field is still empty, via a functional updater that reads
    // the latest state (the closure's `prompt` is stale across the await).
    // Trim a dangling "Name:" when the ingredient had no visual description yet.
    setPrompt((cur) => (cur.trim() ? cur : (styled.prompt || name || '').replace(/:\s*$/, '')));
    setNegativePrompt((cur) => (cur.trim() ? cur : (styled.negativePrompt || '')));
    setPrefilling(false);
  };

  const handleRender = async () => {
    const finalPrompt = prompt.trim();
    if (!finalPrompt) {
      toast.error('Enter a prompt before generating an image');
      return;
    }
    setStarting(true);
    const queued = await generateImage(
      {
        prompt: finalPrompt,
        negativePrompt: negativePrompt.trim() || undefined,
        // Durable attach (#1359): tag the queued job with the target ingredient
        // so the server-side completion hook files the render even if this page
        // unmounts before a long local/Codex render finishes. The onComplete
        // callback below stays as the optimistic/immediate-refresh path; the
        // hook is idempotent so the two never double-attach.
        ...(ingredientId ? { catalogIngredientId: ingredientId } : {}),
      },
      { silent: true },
    ).catch((err) => { toast.error(err?.message || 'Image generation failed'); return null; });
    if (!mountedRef.current) return;
    setStarting(false);
    if (!queued) return;
    setEditing(false);
    if (queued.jobId) {
      // Local/Codex modes enqueue a job — track it live via MediaJobThumb,
      // which fires onFilename on completion to attach the result optimistically.
      // If this page unmounts before the render finishes the server-side
      // catalogImageAttachHook still attaches it durably (#1359).
      setJobId(queued.jobId);
      toast.success('Generating image…');
    } else if (queued.filename) {
      // External SD-API mode renders synchronously and returns the finished
      // filename with no jobId — attach it directly.
      onComplete?.(queued.filename);
    } else {
      toast.error('Image generation returned no result');
    }
  };

  // Fires once when the in-flight job completes (MediaJobThumb forwards the
  // rendered filename). Clear the job so the thumb unmounts, then hand the
  // filename up to be attached as portrait/reference.
  const handleFilename = useCallback((filename) => {
    if (!filename) return;
    setJobId(null);
    onComplete?.(filename);
  }, [onComplete]);

  // A failed/canceled render never fires onFilename, so without this the button
  // would stay disabled+"Generating…" with no retry path. Clear the job on a
  // terminal non-success status to re-enable Generate.
  const handleStatus = useCallback((status) => {
    if (status === 'failed' || status === 'canceled') {
      setJobId(null);
      if (status === 'failed') toast.error('Image generation failed');
    }
  }, []);

  return (
    <span className="relative inline-flex items-center gap-2">
      {jobId && (
        <MediaJobThumb jobId={jobId} label="Generated image" size="xs"
          onFilename={handleFilename} onStatus={handleStatus} />
      )}
      {!editing && (
        <button
          type="button"
          onClick={openEditor}
          disabled={starting || !!jobId}
          title="Compose a prompt and generate an image for this item"
          className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-port-border text-gray-300 hover:text-white hover:border-port-accent disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {jobId
            ? <Loader2 size={12} className="animate-spin" aria-hidden="true" />
            : <Sparkles size={12} aria-hidden="true" />}
          {jobId ? 'Generating…' : 'Generate'}
        </button>
      )}

      {editing && (
        <div className="absolute right-0 z-20 mt-2 w-80 max-w-[90vw] rounded-lg border border-port-border bg-port-card p-3 shadow-xl space-y-2"
          style={{ top: '100%' }}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-white">Generate image</span>
            {prefilling && <Loader2 size={12} className="animate-spin text-gray-400" aria-hidden="true" />}
          </div>
          <label className="block">
            <span className="text-[11px] text-gray-400">Prompt</span>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder="Describe the image to render…"
              className="mt-1 w-full text-xs bg-port-bg border border-port-border rounded px-2 py-1 text-gray-200 resize-y"
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-gray-400">Negative prompt (optional)</span>
            <textarea
              value={negativePrompt}
              onChange={(e) => setNegativePrompt(e.target.value)}
              rows={2}
              className="mt-1 w-full text-xs bg-port-bg border border-port-border rounded px-2 py-1 text-gray-200 resize-y"
            />
          </label>
          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={() => setEditing(false)}
              className="text-xs px-2 py-1 rounded border border-port-border text-gray-400 hover:text-white">
              Cancel
            </button>
            <button type="button" onClick={handleRender} disabled={starting || prefilling || !prompt.trim()}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50 disabled:cursor-not-allowed">
              {starting
                ? <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                : <Sparkles size={12} aria-hidden="true" />}
              Render
            </button>
          </div>
        </div>
      )}
    </span>
  );
}

function MediaPanel({ media, missingMedia, onAttach, onSetPortrait, onDetach, onUploadFile, onRecordVoice, genIngredientId, genName, genDescription, genUniverseId, onGenerated }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false); // upload or transcription in flight
  const [recording, setRecording] = useState(false);
  const fileInputRef = useRef(null);
  const recorderRef = useRef(null);
  const list = Array.isArray(media) ? media : [];
  const portrait = list.find((m) => m.kind === 'portrait');
  const others = list.filter((m) => m.kind !== 'portrait');

  // Release the mic if the panel unmounts mid-recording (navigating away).
  useEffect(() => () => { recorderRef.current?.cancel?.(); }, []);

  const doUpload = async (file) => {
    if (!file || busy) return;
    setBusy(true);
    await onUploadFile(file);
    setBusy(false);
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    // In-app gallery DnD: the dragged tile carries its filename as text.
    const key = (e.dataTransfer.getData('text/plain') || '').trim();
    if (key) { onAttach(key, 'reference'); return; }
    const file = e.dataTransfer.files?.[0];
    if (file) { doUpload(file); return; }
    toast.error('Drop a gallery image, a file, or use “Pick from gallery”.');
  };

  const onFilePicked = (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (file) doUpload(file);
  };

  const startRecording = async () => {
    const handle = await startMemoRecording().catch((err) => {
      toast.error(err?.message || 'Microphone unavailable');
      return null;
    });
    if (!handle) return;
    recorderRef.current = handle;
    setRecording(true);
  };

  const stopRecording = async () => {
    const handle = recorderRef.current;
    if (!handle) return;
    recorderRef.current = null;
    setRecording(false);
    const clip = await handle.stop().catch((err) => { toast.error(err?.message || 'Recording failed'); return null; });
    if (!clip?.audioBase64) return;
    if (clip.peak !== undefined && clip.peak < 0.01) {
      toast.error('That memo was silent — check your microphone and try again.');
      return;
    }
    setBusy(true);
    await onRecordVoice(clip);
    setBusy(false);
  };

  return (
    <section className="bg-port-card border border-port-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <h2 className="text-sm font-semibold text-white flex items-center gap-1.5">
          <ImageIcon size={14} aria-hidden="true" /> Media
        </h2>
        <div className="flex items-center gap-2 flex-wrap">
          <GenerateImageControl ingredientId={genIngredientId} name={genName} description={genDescription} universeId={genUniverseId} onComplete={onGenerated} />
          <button type="button" onClick={() => setPickerOpen(true)}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-port-border text-gray-300 hover:text-white hover:border-port-accent">
            <Plus size={12} aria-hidden="true" /> Pick from gallery
          </button>
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={busy || recording}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-port-border text-gray-300 hover:text-white hover:border-port-accent disabled:opacity-40">
            <Upload size={12} aria-hidden="true" /> Upload file
          </button>
          {!recording ? (
            <button type="button" onClick={startRecording} disabled={busy}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-port-border text-gray-300 hover:text-white hover:border-port-accent disabled:opacity-40">
              <Mic size={12} aria-hidden="true" /> Record memo
            </button>
          ) : (
            <button type="button" onClick={stopRecording}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-port-error text-port-error hover:bg-port-error/10 animate-pulse">
              <Square size={12} aria-hidden="true" /> Stop &amp; transcribe
            </button>
          )}
          <input ref={fileInputRef} type="file" accept="image/*,audio/*,video/*" onChange={onFilePicked} className="hidden" />
        </div>
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`mb-3 rounded-lg border border-dashed p-3 text-center text-xs transition-colors ${dragOver ? 'border-port-accent bg-port-accent/10 text-white' : 'border-port-border text-gray-500'}`}
      >
        {busy
          ? (<span className="inline-flex items-center gap-1"><Loader2 size={12} className="animate-spin" aria-hidden="true" /> Working…</span>)
          : 'Drag a gallery image or a file here to attach it (image, audio, or video).'}
      </div>

      {portrait && (
        <div className="mb-3">
          <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Portrait</div>
          <MediaTile m={portrait} missing={missingMedia.has(portrait.mediaKey)} isPortrait
            onSetPortrait={onSetPortrait} onDetach={onDetach} />
        </div>
      )}

      {others.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {others.map((m) => (
            <MediaTile key={`${m.mediaKey}:${m.kind}`} m={m} missing={missingMedia.has(m.mediaKey)}
              onSetPortrait={onSetPortrait} onDetach={onDetach} />
          ))}
        </div>
      )}

      {list.length === 0 && (
        <p className="text-xs text-gray-500">No media yet. Attach a generated portrait, a mood/reference image, an uploaded file, or a recorded voice memo.</p>
      )}

      {pickerOpen && (
        <GalleryPickerModal
          onClose={() => setPickerOpen(false)}
          onPick={(filename, asPortrait) => {
            if (asPortrait) onSetPortrait(filename);
            else onAttach(filename, 'reference');
            setPickerOpen(false);
          }}
        />
      )}
    </section>
  );
}

// One media attachment tile. Images render via <MediaImage> (gracefully shows a
// "syncing" placeholder when the asset hasn't arrived — the same surface the
// `missing` integrity flag warns about). Audio/video render inline players
// (their bytes are served from /data/audio and /data/videos); a voice memo's
// transcript rides in `caption`. Other kinds render a labeled chip.
function MediaTile({ m, missing, isPortrait = false, onSetPortrait, onDetach }) {
  const isImage = m.kind === 'portrait' || m.kind === 'reference';
  const isAudio = m.kind === 'audio';
  const isVideo = m.kind === 'video';
  return (
    <div className="relative group rounded border border-port-border overflow-hidden bg-port-bg">
      {isImage && (
        <MediaImage src={`/data/images/${m.mediaKey}`} alt={m.caption || m.kind}
          className={isPortrait ? 'w-full max-w-[180px] aspect-square object-cover' : 'w-full aspect-square object-cover'} />
      )}
      {isAudio && (
        <div className="p-2 flex flex-col gap-1">
          <div className="text-[10px] uppercase tracking-wider text-gray-400 flex items-center gap-1">
            <Mic size={10} aria-hidden="true" /> {m.role === 'voice-memo' ? 'voice memo' : 'audio'}
          </div>
          <audio controls preload="none" src={`/data/audio/${m.mediaKey}`} className="w-full" />
          {m.caption && <p className="text-[11px] text-gray-300 whitespace-pre-wrap line-clamp-4">{m.caption}</p>}
        </div>
      )}
      {isVideo && (
        <video controls preload="none" src={`/data/videos/${m.mediaKey}`} className="w-full aspect-square object-cover bg-black" />
      )}
      {!isImage && !isAudio && !isVideo && (
        <div className="w-full aspect-square flex items-center justify-center text-[10px] uppercase tracking-wider text-gray-400 px-1 text-center">
          {m.kind}<br />{m.mediaKey}
        </div>
      )}
      {missing && (
        <span className="absolute top-1 left-1 text-[9px] px-1 py-0.5 rounded bg-port-warning/20 text-port-warning border border-port-warning/40"
          title="This asset isn't in your media library yet (received from a peer before the file arrived).">
          missing
        </span>
      )}
      <div className="absolute top-1 right-1 flex gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        {!isPortrait && isImage && (
          <button type="button" onClick={() => onSetPortrait(m.mediaKey)} title="Set as portrait"
            className="p-2 sm:p-1 rounded bg-black/60 text-gray-200 hover:text-port-warning">
            <Star size={12} aria-hidden="true" />
          </button>
        )}
        <button type="button" onClick={() => onDetach(m.mediaKey, m.kind)} title="Detach"
          className="p-2 sm:p-1 rounded bg-black/60 text-gray-200 hover:text-port-error">
          <X size={12} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

// Modal that lists the existing media gallery (history) so the user can attach
// or set-portrait from already-generated assets — the "scoped to existing media
// history" requirement. Never uploads; it only references library keys.
function GalleryPickerModal({ onClose, onPick }) {
  const [items, setItems] = useState(null); // null = loading, [] = loaded-empty
  const closeRef = useRef(null);

  useEffect(() => {
    listImageGallery()
      .then((rows) => setItems(Array.isArray(rows) ? rows : []))
      .catch(() => setItems([]));
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="bg-port-card border border-port-border rounded-lg w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-3 border-b border-port-border">
          <h3 className="text-sm font-semibold text-white">Pick from media gallery</h3>
          <button ref={closeRef} type="button" onClick={onClose} className="text-gray-400 hover:text-white" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="p-3 overflow-y-auto">
          {items === null && <p className="text-xs text-gray-500">Loading gallery…</p>}
          {items?.length === 0 && <p className="text-xs text-gray-500">No images in the gallery yet. Generate one in Image Gen first.</p>}
          {items && items.length > 0 && (
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
              {items.map((it) => (
                <div key={it.filename} className="relative group rounded border border-port-border overflow-hidden">
                  <MediaImage src={it.path || `/data/images/${it.filename}`} alt={it.filename}
                    className="w-full aspect-square object-cover" />
                  <div className="absolute inset-x-0 bottom-0 flex opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    <button type="button" onClick={() => onPick(it.filename, false)}
                      className="flex-1 text-[10px] py-2.5 sm:py-1 bg-black/70 text-gray-200 hover:text-white">Attach</button>
                    <button type="button" onClick={() => onPick(it.filename, true)}
                      className="flex-1 text-[10px] py-2.5 sm:py-1 bg-black/70 text-gray-200 hover:text-port-warning">Portrait</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SourcesPanel({ sources }) {
  const list = Array.isArray(sources) ? sources : [];
  return (
    <section className="bg-port-card border border-port-border rounded-lg p-4">
      <h2 className="text-sm font-semibold text-white mb-2">Source scraps</h2>
      {list.length === 0 ? (
        <p className="text-xs text-gray-500">Created manually — no source scrap.</p>
      ) : (
        <ul className="space-y-1.5">
          {list.map((s, i) => (
            <li key={s.scrapId || i} className="text-xs text-gray-300 flex items-center justify-between gap-2">
              <span className="font-mono truncate" title={s.scrapId}>{s.scrapId}</span>
              {s.extractedAt && <span className="text-gray-500 whitespace-nowrap">{formatDateTime(s.extractedAt)}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RefsPanel({ refsByKind }) {
  const kinds = Object.keys(refsByKind);
  return (
    <section className="bg-port-card border border-port-border rounded-lg p-4">
      <h2 className="text-sm font-semibold text-white mb-2">Appears in</h2>
      {kinds.length === 0 ? (
        <p className="text-xs text-gray-500">Not yet linked to any universe, series, or issue.</p>
      ) : (
        <div className="space-y-3">
          {kinds.map((kind) => (
            <div key={kind}>
              <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">
                {REFKIND_LABEL(kind)}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {refsByKind[kind].map((r, i) => {
                  const path = refPath(kind, r.refId);
                  const label = r.refName || r.refId || '(unnamed)';
                  const role = r.role ? ` · ${r.role}` : '';
                  const chip = (
                    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded border border-port-border bg-port-bg text-gray-200">
                      {label}{role}
                      {path && <ExternalLink size={10} aria-hidden="true" />}
                    </span>
                  );
                  return path ? (
                    <Link key={`${kind}-${r.refId}-${i}`} to={path} className="hover:opacity-80">
                      {chip}
                    </Link>
                  ) : (
                    <span key={`${kind}-${r.refId}-${i}`}>{chip}</span>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

const SOURCE_BADGE = {
  user:    'bg-port-accent/20 text-port-accent border-port-accent/40',
  extract: 'bg-port-accent-2/20 text-port-accent-2 border-port-accent-2/40',
  refine:  'bg-port-warning/20 text-port-warning border-port-warning/40',
  sync:    'bg-port-success/20 text-port-success border-port-success/40',
};

// Build the label set for diffing: the editor fields plus name + tags. Used to
// render a field-by-field "what changed" diff between a revision and the
// currently-saved record.
function diffRevisionAgainstCurrent(revision, current, fields) {
  const out = [];
  const curName = current?.name || '';
  if ((revision.name || '') !== curName) {
    out.push({ key: '__name', label: 'Name', from: revision.name || '', to: curName });
  }
  const curTags = (current?.tags || []).join(', ');
  const revTags = (revision.tags || []).join(', ');
  if (revTags !== curTags) {
    out.push({ key: '__tags', label: 'Tags', from: revTags, to: curTags });
  }
  const curPayload = current?.payload || {};
  const revPayload = revision.payload || {};
  // `fields` is either the system tuple form `[key, label, kind]` or the
  // user-type object form `{ key, label, widget }` — normalize to [key, label].
  const fieldPairs = (fields || []).map((f) => (Array.isArray(f) ? [f[0], f[1]] : [f.key, f.label]));
  for (const [key, label] of fieldPairs) {
    const from = revPayload[key] ?? '';
    const to = curPayload[key] ?? '';
    if (String(from) !== String(to)) out.push({ key, label, from: String(from), to: String(to) });
  }
  return out;
}

function RevisionsPanel({ revisions, current, fields, onRestore }) {
  const [openId, setOpenId] = useState(null);
  const [restoring, setRestoring] = useState(null);

  const list = Array.isArray(revisions) ? revisions : [];

  const handleRestore = async (id) => {
    setRestoring(id);
    await onRestore(id);
    setRestoring(null);
  };

  return (
    <section className="bg-port-card border border-port-border rounded-lg p-4">
      <h2 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
        <History size={15} className="text-port-accent" aria-hidden="true" /> Revision history
        {list.length > 0 && <span className="text-xs text-gray-500 font-normal">({list.length})</span>}
      </h2>
      {list.length === 0 ? (
        <p className="text-xs text-gray-500">No revisions recorded yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {list.map((rev, i) => {
            const open = openId === rev.id;
            const isLatest = i === 0;
            const diff = open ? diffRevisionAgainstCurrent(rev, current, fields) : [];
            const badge = SOURCE_BADGE[rev.source] || 'bg-gray-500/20 text-gray-300 border-gray-500/40';
            return (
              <li key={rev.id} className="border border-port-border rounded bg-port-bg">
                <div className="flex items-center justify-between gap-2 px-2.5 py-1.5">
                  <button
                    type="button"
                    onClick={() => setOpenId(open ? null : rev.id)}
                    className="flex items-center gap-2 min-w-0 text-left flex-1 hover:opacity-90"
                    aria-expanded={open}
                  >
                    <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${badge}`}>
                      {rev.source}
                    </span>
                    <span className="text-xs text-gray-300 truncate">{rev.name || '(untitled)'}</span>
                    {rev.actor && <span className="text-[10px] text-gray-500 truncate">· {rev.actor}</span>}
                    <span className="text-[10px] text-gray-500 whitespace-nowrap ml-auto">{timeAgo(rev.createdAt)}</span>
                  </button>
                  {!isLatest && (
                    <button
                      type="button"
                      onClick={() => handleRestore(rev.id)}
                      disabled={restoring === rev.id}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] border border-port-border text-gray-400 hover:text-white disabled:opacity-50"
                      title="Restore this revision"
                    >
                      {restoring === rev.id
                        ? <Loader2 size={11} className="animate-spin" />
                        : <RotateCcw size={11} aria-hidden="true" />} Restore
                    </button>
                  )}
                  {isLatest && (
                    <span className="text-[10px] text-gray-500 px-1 whitespace-nowrap">current</span>
                  )}
                </div>
                {open && (
                  <div className="px-2.5 pb-2 pt-0.5 border-t border-port-border">
                    {diff.length === 0 ? (
                      <p className="text-[11px] text-gray-500 mt-1.5">Identical to the current saved state.</p>
                    ) : (
                      <dl className="mt-1.5 space-y-1.5">
                        {diff.map((d) => (
                          <div key={d.key} className="text-[11px]">
                            <dt className="text-gray-500 uppercase tracking-wider text-[9px] mb-0.5">{d.label}</dt>
                            <dd className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                              <span className="px-1.5 py-0.5 rounded bg-port-error/10 text-port-error/90 break-words">
                                {d.from || <em className="text-gray-600">empty</em>}
                              </span>
                              <span className="px-1.5 py-0.5 rounded bg-port-success/10 text-port-success/90 break-words">
                                {d.to || <em className="text-gray-600">empty</em>}
                              </span>
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
