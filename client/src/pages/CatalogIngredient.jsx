/**
 * CatalogIngredient — detail/editor for a single catalog ingredient. Loaded
 * via /catalog/:type/:id (one untabbed scroll) or a library route
 * (/casting/:id/:tab?, /environments/…, /objects/…) where the library's
 * `detailTabs` split it into Profile / Sheets / Looks|Plates / References|Images.
 * The tab lives in the URL; form state lives here so switching tabs keeps an
 * unsaved draft. Full-width page; owns its scroll.
 */

import CatalogReferenceLibrary from '../components/catalog/CatalogReferenceLibrary.jsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useLocation, Link } from 'react-router';
import { Save, Trash2, ArrowLeft, Loader2, Plus, X, History, RotateCcw, Image as ImageIcon, ChevronDown, Upload, Mic, Square, UserRound, LayoutGrid, Images, Clapperboard, Shirt, Box, Wand2 } from 'lucide-react';
import toast from '../components/ui/Toast';
import FilePickerButton from '../components/ui/FilePickerButton';
import ConfirmButtonPair from '../components/ui/ConfirmButtonPair.jsx';
import UnsavedChangesConfirm from '../components/ui/UnsavedChangesConfirm.jsx';
import PageSkeleton from '../components/ui/PageSkeleton';
import TabPills from '../components/ui/TabPills';
import {
  getCatalogIngredientDetails,
  updateCatalogIngredient,
  deleteCatalogIngredient,
  linkCatalogIngredient,
  linkCatalogIngredientRelation,
  unlinkCatalogIngredientRelation,
  listCatalogIngredientRevisions,
  restoreCatalogIngredientRevision,
  attachCatalogIngredientMedia,
  setCatalogIngredientPortrait,
  attachCatalogIngredientGeneratedImage,
  detachCatalogIngredientMedia,
  uploadCatalogIngredientMediaFile,
  recordCatalogIngredientVoiceMemo,
  updateCatalogIngredientMediaLibrary,
  removeCatalogPointerSheet,
} from '../services/apiCatalog';
import { arrayBufferToBase64 } from '../lib/audioRecorder';
import useMemoRecorder from '../hooks/useMemoRecorder';
import socket from '../services/socket';
import AddToThreadButton from '../components/threads/AddToThreadButton';
import { getCanonCatalogContext } from '../services/canonCatalogContext';
import { getUniverse } from '../services/apiUniverseBuilder';
import useMounted from '../hooks/useMounted';
import IngredientPicker from '../components/IngredientPicker';
import GalleryImagePicker from '../components/imageGen/GalleryImagePicker';
import GenerateImageControl from '../components/catalog/GenerateImageControl';
import MediaJobThumb from '../components/pipeline/MediaJobThumb';
import { buildGenerationPromptSeed } from '../lib/catalogImagePrompt';
import CatalogMediaTile from '../components/catalog/CatalogMediaTile';
import CatalogImagePreview from '../components/catalog/CatalogImagePreview';
import { CatalogImagePreviewProvider } from '../components/catalog/CatalogImagePreviewProvider';
import CatalogRelatedImages from '../components/catalog/CatalogRelatedImages';
import CatalogSheetsPanel, { ReferenceSheetPanel } from '../components/catalog/CatalogSheetsPanel';
import CatalogUnlockNotice from '../components/catalog/CatalogUnlockNotice';
import CatalogPlatesPanel from '../components/catalog/CatalogPlatesPanel';
import GreyboxPanel from '../components/catalog/GreyboxPanel';
import CatalogLooksPanel from '../components/catalog/CatalogLooksPanel';
import CatalogDesignPanel from '../components/catalog/CatalogDesignPanel';
import CharacterDetailEditor from '../components/universe/CharacterDetailEditor';
import { RevealTimingField } from '../components/pipeline/CanonCard';
import CanonReferenceRemoval from '../components/catalog/CanonReferenceRemoval';
import CatalogLockButton from '../components/catalog/CatalogLockButton';
import CharacterCanonActions from '../components/catalog/CharacterCanonActions';
import ObjectAttachmentsEditor from '../components/universe/ObjectAttachmentsEditor';
import CatalogRedesign from '../components/catalog/CatalogRedesign';
import CatalogUniversePanel from '../components/catalog/CatalogUniversePanel';
import CatalogFormsEditor from '../components/catalog/CatalogFormsEditor';
import CatalogFamilyPicker from '../components/catalog/CatalogFamilyPicker';
import CatalogMergePanel from '../components/catalog/CatalogMergePanel';
import CatalogIdentityPanel from '../components/catalog/CatalogIdentityPanel';
import CatalogIdentityNotice from '../components/catalog/CatalogIdentityNotice';
import CharacterLoraChip from '../components/loraTraining/CharacterLoraChip';
import TagPicker from '../components/TagPicker';
import GenericIngredientFields from '../components/GenericIngredientFields';
import useUnsavedChangesGuard from '../hooks/useUnsavedChangesGuard';
import { getCatalogType, CATALOG_BADGE_BY_ID, RELATION_KINDS, getRelationKind, isFamilyRelationKind } from '../lib/catalogTypes';
import {
  libraryForPathname, ingredientPath, ingredientCoverUrl, resolveDetailTab, detailTabPath,
  isSheetMedia, isPlateMedia, isDesignMedia, isReferenceTabMedia, lookIdOf,
} from '../lib/creativeLibraries';
import { useCatalogTypes } from '../hooks/useCatalogTypes.jsx';
import { timeAgo, formatDateTime } from '../utils/formatters';
import { humanizeIntegrityField } from '../lib/characterIntegrity';
import { listSheetPointers } from '../lib/sheetPointers';
import { formsOf } from '../lib/catalogForms';
import { safeReadJsonSession, safeWriteJsonSession, safeRemoveSession } from '../lib/safeStorage';

// Per-type editor field list + badge color now come from the shared registry
// (`client/src/lib/catalogTypes.js`). Each editor entry is `[key, label, kind]`
// where `kind` is 'text' (single line) or 'textarea' (multi-line).

// Compare JSON-shaped editor values by value while ignoring object-key order.
// A catalog payload can arrive from a peer with the same fields in a different
// order; that is not an edit the user needs to save.
const DETAIL_TAB_ICONS = {
  profile: UserRound,
  design: Wand2,
  sheets: LayoutGrid,
  looks: Shirt,
  plates: Clapperboard,
  greybox: Box,
  references: Images,
  images: ImageIcon,
};

// Canon types whose records carry alternate ages/looks (`payload.forms`).
const FORM_TYPES = new Set(['character', 'place', 'object']);

// Payload fields the universe sheet renderer writes (via the canon→catalog
// projection); see lib/sheetPointers.js.
const SHEET_POINTER_KEYS = ['referenceSheetImageRef', 'referenceSheets'];

function stableSerialize(value) {
  return JSON.stringify(value, (_key, current) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return current;
    return Object.keys(current).sort().reduce((sorted, key) => {
      sorted[key] = current[key];
      return sorted;
    }, {});
  });
}

function sameValue(left, right) {
  return stableSerialize(left) === stableSerialize(right);
}

function ingredientPayload(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export default function CatalogIngredient() {
  const { id } = useParams();
  // One owner per ingredient visit: late mutations and child-local drafts must
  // never migrate to another record. Tabs keep the same owner and unsaved form.
  return <IngredientEditor key={id} />;
}

function IngredientEditor() {
  const { id, tab: tabParam } = useParams();
  const mountedRef = useMounted();
  const activeVisitRef = useRef({ id, generation: 0 });
  if (activeVisitRef.current.id !== id) {
    activeVisitRef.current = { id, generation: activeVisitRef.current.generation + 1 };
  }
  const navigate = useNavigate();
  // Opened from Casting / Environments / Objects → Back and post-delete return
  // there; otherwise to the catalog.
  const { pathname, search } = useLocation();
  const library = libraryForPathname(pathname);
  const detailView = library ? 'profile' : undefined;
  const requestedBack = new URLSearchParams(search).get('returnTo') || '';
  // A music video's Cast & Sets links here to revise a look and comes back to its stage.
  const backToVideo = /^\/music-video\/[^/?#]+(?:\/[^/?#]+)?(?:\?|#|$)/.test(requestedBack);
  const backPath = backToVideo || /^\/(?:casting(?:\?|$)|universes\/[^/?#]+(?:\?|$))/.test(requestedBack) ? requestedBack : library?.path || '/catalog';
  const profileActive = !library || resolveDetailTab(library, tabParam) === 'profile';
  const [profileVisited, setProfileVisited] = useState(profileActive);
  useEffect(() => { if (profileActive) setProfileVisited(true); }, [profileActive]);
  // Merged type registry (system + user-defined). Falls back synchronously to
  // the static built-ins so the editor renders before the fetch resolves.
  const { getType: getMergedType } = useCatalogTypes();
  const [record, setRecord] = useState(null);
  const [mergeVersion, setMergeVersion] = useState(0);
  const [mergeBusy, setMergeBusy] = useState(false);
  const identityReadOnly = record?.sharedIdentity?.writable === false;
  const identityReason = identityReadOnly ? 'This shared identity is read-only here. Inspect its ownership notice and agreement.' : null;
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [tags, setTags] = useState([]);
  const [payload, setPayload] = useState({});
  const [saving, setSaving] = useState(false);
  // A Greybox-tab write in flight; the profile Save waits so its whole-payload
  // PATCH cannot replace the layout being saved.
  const [greyboxBusy, setGreyboxBusy] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [characterActionBusy, setCharacterActionBusy] = useState(false);
  // A Looks-tab wardrobe save in flight; the profile Save waits for it so its
  // draft payload can't write back the previous wardrobes.
  const [lookSaving, setLookSaving] = useState(false);
  const [armedDelete, setArmedDelete] = useState(false);
  // { outbound: [...], inbound: [...] } — relations are loaded separately from
  // the ingredient record so the panel can refresh independently after add/
  // remove without re-fetching the whole detail payload.
  const [relations, setRelations] = useState({ outbound: [], inbound: [] });
  const [revisions, setRevisions] = useState(null);
  const [revisionsLoading, setRevisionsLoading] = useState(false);
  const [revisionsError, setRevisionsError] = useState(null);
  const historyRequested = useRef(false);
  const historySequence = useRef(0);
  // Media attachments + the subset of their keys that don't resolve against the
  // local library (federated-in but asset not yet present). `missingMedia` is a
  // Set of media_keys driving the integrity badge on each thumbnail.
  const [media, setMedia] = useState([]);
  const [mediaReady, setMediaReady] = useState(false);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaError, setMediaError] = useState(null);
  // A redesign-assistant proposal waiting to be saved onto a new fork.
  const [redesignFork, setRedesignFork] = useState(null);
  const mediaSequence = useRef(0);
  const sheetPointerSequence = useRef(0);
  const mediaReadyRef = useRef(false);
  mediaReadyRef.current = mediaReady;
  const refreshMediaRef = useRef(null);
  const [missingMedia, setMissingMedia] = useState(new Set());
  const [ownerEntryId, setOwnerEntryId] = useState(null);
  const [ownerUniverse, setOwnerUniverse] = useState(null);
  const [ownerContextError, setOwnerContextError] = useState(null);
  // Owned by a universe but not in its cast: re-reading the context cannot help,
  // so the page offers to add the record to that cast instead of a retry.
  const [ownerCanonMissing, setOwnerCanonMissing] = useState(false);
  const [joiningCanon, setJoiningCanon] = useState(false);
  const [contextVersion, setContextVersion] = useState(0);
  const [contextRequested, setContextRequested] = useState(false);
  const onCharacterPageChange = useCallback(page => { if (page === 'story' || page === 'voice') setContextRequested(true); }, []);
  const ownerUniverseId = record?.universeContext?.owner?.refId || null;
  useEffect(() => {
    let active = true;
    setOwnerUniverse(null); setOwnerEntryId(null); setOwnerContextError(null); setOwnerCanonMissing(false);
    if (!ownerUniverseId || !contextRequested && record?.type !== 'object') return;
    const load = record.type === 'character'
      ? getCanonCatalogContext(ownerUniverseId, record.id, record.type, { silent: true })
      : getUniverse(ownerUniverseId, { silent: true }).then(universe => ({ universe }));
    load.then(({ universe, entry }) => { if (active) { setOwnerUniverse(universe); setOwnerEntryId(entry?.id || null);
      if (record.type === 'character' && !entry) setOwnerCanonMissing(true); } })
      .catch(error => { if (active) setOwnerContextError(error.message || 'Could not load the owning universe’s character context.'); });
    return () => { active = false; };
  }, [ownerUniverseId, contextRequested, contextVersion, record?.type, record?.id]);
  const joinOwnerCanon = useCallback(() => {
    if (!record?.id || !ownerUniverseId) return;
    setJoiningCanon(true);
    linkCatalogIngredient(record.id, { refKind: 'universe', refId: ownerUniverseId, role: `canon-${record.type}` })
      .then(() => setContextVersion(previous => previous + 1))
      .catch(() => {})
      .finally(() => setJoiningCanon(false));
  }, [record?.id, record?.type, ownerUniverseId]);
  const applyUniverseContext = useCallback((context) => {
    setRecord((current) => current ? { ...current, universeContext: context, refs: context.refs } : current);
  }, []);

  const refreshRevisions = useCallback((force = false) => {
    if (!id || !force && !historyRequested.current) return;
    historyRequested.current = true;
    const sequence = ++historySequence.current;
    setRevisionsLoading(true); setRevisionsError(null);
    listCatalogIngredientRevisions(id, { limit: 50, silent: true }).then((result) => {
      if (!Array.isArray(result?.items)) throw new Error('Revision history response is unavailable');
      if (mountedRef.current && sequence === historySequence.current) setRevisions(result.items);
    }).catch((error) => { if (mountedRef.current && sequence === historySequence.current) setRevisionsError(error.message); })
      .finally(() => { if (mountedRef.current && sequence === historySequence.current) setRevisionsLoading(false); });
  }, [id, mountedRef]);

  const [externalDetails, setExternalDetails] = useState(null);
  const editSnapshot = useRef(null);
  editSnapshot.current = { id: record?.id, updatedAt: record?.updatedAt, dirty: saving || lookSaving || Boolean(record && (
    name !== (record.name || '') || !sameValue(tags, record.tags || []) || !sameValue(payload, ingredientPayload(record.payload))
  )) };
  const applyDetails = useCallback((d) => {
    const r = d.ingredient;
    setRecord({ ...r, refs: d.refs, universeContext: d.universeContext, sources: d.sources, sharedIdentity: d.sharedIdentity || null, coverMedia: d.coverMedia || null });
    setName(r.name || '');
    setTags(Array.isArray(r.tags) ? r.tags : []);
    setPayload(r.payload && typeof r.payload === 'object' ? { ...r.payload } : {});
    setRelations({
      outbound: Array.isArray(d.relations?.outbound) ? d.relations.outbound : [],
      inbound: Array.isArray(d.relations?.inbound) ? d.relations.inbound : [],
    });
    if (Array.isArray(d.revisions)) { setRevisions(d.revisions); historyRequested.current = true; }
    if (Array.isArray(d.media)) { setMedia(d.media); setMediaReady(true); }
    if (Array.isArray(d.missingMedia)) setMissingMedia(new Set(d.missingMedia.map((m) => m.mediaKey)));
  }, []);
  useEffect(() => {
    if (externalDetails?.ingredient?.updatedAt && record?.updatedAt
      && Date.parse(externalDetails.ingredient.updatedAt) <= Date.parse(record.updatedAt)) setExternalDetails(null);
  }, [record?.updatedAt, externalDetails]);

  const applyLock = useCallback(updated => {
    setRecord(current => current?.id === updated.id ? { ...current, updatedAt: updated.updatedAt,
      payload: { ...current.payload, locked: updated.payload.locked } } : current);
    setPayload(previous => ({ ...previous, locked: updated.payload.locked }));
    refreshRevisions();
  }, [refreshRevisions]);

  // Library profiles load the editable record and direct context first. Media,
  // history and derived story usage have separate reads after first render.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSaving(false);
    setUnlocking(false);
    getCatalogIngredientDetails(id, { silent: true, view: detailView })
      .then((d) => {
        if (cancelled) return;
        if (!d?.ingredient) {
          setLoading(false);
          toast.error('Ingredient not found');
          navigate(backPath);
          return;
        }
        applyDetails(d);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoading(false);
        toast.error(err?.message || 'Failed to load ingredient');
        navigate(backPath);
      });
    return () => { cancelled = true; };
  }, [id, navigate, backPath, mergeVersion, applyDetails, detailView]);

  // Keep ownership fences current without discarding an unsaved creative draft.
  // The original route ID is intentional: a retained-source URL must stay read-only.
  useEffect(() => {
    let active = true;
    let request = 0;
    const refreshIdentity = () => {
      if (mediaReadyRef.current) refreshMediaRef.current?.();
      const current = ++request;
      getCatalogIngredientDetails(id, { silent: true, view: detailView }).then(details => {
        if (!active || current !== request || !details?.ingredient) return;
        setRecord(previous => previous ? { ...previous, sharedIdentity: details.sharedIdentity || null } : previous);
        if (details.ingredient.id === editSnapshot.current.id && details.ingredient.updatedAt
          && details.ingredient.updatedAt !== editSnapshot.current.updatedAt) {
          if (editSnapshot.current.dirty) setExternalDetails(details);
          else applyDetails(details);
          refreshRevisions();
        }
      }).catch(() => { if (active) toast.error('Unable to refresh shared identity status. Reload before editing.'); });
    };
    const changed = event => {
      if ([event?.sourceId, event?.survivorId].includes(id)) refreshIdentity();
    };
    const primitiveChanged = (event) => { if (event?.ingredientId === editSnapshot.current.id) refreshIdentity(); };
    socket.on('catalog:primitive-changed', primitiveChanged);
    socket.on('catalog:identity-changed', changed);
    socket.on('connect', refreshIdentity);
    return () => { active = false; socket.off('catalog:identity-changed', changed); socket.off('catalog:primitive-changed', primitiveChanged); socket.off('connect', refreshIdentity); };
  }, [id, applyDetails, detailView, refreshRevisions]);

  // Add an outbound edge (this ingredient → picked target). Optimistically
  // appends to local state so the panel updates without a refetch.
  const handleAddRelation = async (target, kind) => {
    if (!record || identityReadOnly || !target?.id) return;
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
    if (!record || identityReadOnly) return;
    const ok = await unlinkCatalogIngredientRelation(record.id, { toId, kind }, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error(err?.message || 'Failed to remove relation'); return false; });
    if (!ok) return;
    setRelations((prev) => ({
      ...prev,
      outbound: prev.outbound.filter((r) => !(r.toId === toId && r.kind === kind)),
    }));
  };

  // One secondary read supplies attachments and integrity together. Reusing its
  // rows avoids a second media query and filesystem scan on every refresh.
  const refreshMedia = useCallback(() => {
    if (!id) return;
    const sequence = ++mediaSequence.current;
    setMediaLoading(true); setMediaError(null);
    getCatalogIngredientDetails(id, { view: 'media', silent: true }).then((result) => {
      if (!Array.isArray(result?.media) || !Array.isArray(result?.missingMedia)) throw new Error('Media response is unavailable');
      if (!mountedRef.current || sequence !== mediaSequence.current) return;
      setMedia(result.media); setMissingMedia(new Set(result.missingMedia.map((item) => item.mediaKey))); setMediaReady(true);
    }).catch((error) => { if (mountedRef.current && sequence === mediaSequence.current) setMediaError(error.message); })
      .finally(() => { if (mountedRef.current && sequence === mediaSequence.current) setMediaLoading(false); });
  }, [id, mountedRef]);
  refreshMediaRef.current = refreshMedia;
  const mediaTab = library && record?.type === library.type ? resolveDetailTab(library, tabParam) : 'references';
  useEffect(() => {
    if (record?.id && mediaTab !== 'profile' && !mediaReady) refreshMedia();
  }, [record?.id, mediaTab, mediaReady, refreshMedia]);

  // Attach a media key (gallery filename) as a typed attachment. `kind` defaults
  // to 'reference' for drag-drop / picker; the "set portrait" path routes
  // through handleSetPortrait instead. Optimistic — prepend then reconcile.
  const handleAttachMedia = async (mediaKey, kind = 'reference') => {
    if (!record || identityReadOnly || !mediaKey) return;
    const ok = await attachCatalogIngredientMedia(record.id, { mediaKey, kind }, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error(err?.message || 'Failed to attach media'); return false; });
    if (!ok) return;
    refreshMedia();
    toast.success('Media attached');
  };

  const handleSetPortrait = async (mediaKey) => {
    if (!record || identityReadOnly || !mediaKey) return;
    const ok = await setCatalogIngredientPortrait(record.id, { mediaKey }, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error(err?.message || 'Failed to set portrait'); return false; });
    if (!ok) return;
    refreshMedia();
    toast.success('Canonical image set');
  };

  const handleDetachMedia = async (mediaKey, kind) => {
    if (!record || identityReadOnly) return;
    const ok = await detachCatalogIngredientMedia(record.id, { mediaKey, kind }, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error(err?.message || 'Failed to detach media'); return false; });
    if (!ok) return;
    setMedia((prev) => prev.filter((m) => !(m.mediaKey === mediaKey && m.kind === kind)));
  };

  // A freshly-generated image lands in the media library as `<jobId>.png`; wire
  // it onto this ingredient. The server decides under the ingredient lock: the
  // first image becomes the portrait (so it shows as the card thumbnail
  // immediately), later ones references, and a render the completion hook
  // already filed is left as is (#13833).
  const handleGeneratedImage = useCallback(async (filename) => {
    if (!record || identityReadOnly || !filename) return;
    const result = await attachCatalogIngredientGeneratedImage(record.id, { mediaKey: filename }, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Failed to attach generated image'); return null; });
    if (!result) return;
    refreshMedia();
    toast.success(result.kind === 'portrait' ? 'Generated portrait set' : 'Generated image attached');
  }, [record, refreshMedia, identityReadOnly]);

  // A film-look copy saved from one of this record's images joins its
  // references, carrying the source's form, age and tags so library filters
  // keep it beside the original. Images from elsewhere stay gallery-only.
  const handleVariantSaved = useCallback(async (variant, source) => {
    if (!record || identityReadOnly || !variant?.filename) return;
    const rows = media.filter((m) => !m.deleted && m.mediaKey === source?.filename && (m.kind === 'reference' || m.kind === 'portrait'));
    if (rows.length === 0) return;
    const ok = await attachCatalogIngredientMedia(record.id, { mediaKey: variant.filename, kind: 'reference' }, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error(err?.message || 'Could not add the copy to references'); return false; });
    if (!ok) return;
    const library = (rows.find((m) => m.kind === 'reference') || rows[0]).library || {};
    const variantFields = Object.fromEntries(['age', 'era', 'wardrobeId', 'formId', 'label']
      .filter((field) => library.variant?.[field] !== undefined).map((field) => [field, library.variant[field]]));
    const carried = {
      ...(Object.keys(variantFields).length > 0 ? { variant: variantFields } : {}),
      ...(library.tags?.length ? { tags: library.tags } : {}),
    };
    if (Object.keys(carried).length > 0) {
      await updateCatalogIngredientMediaLibrary(record.id, { mediaKey: variant.filename, kind: 'reference', ...carried }, { silent: true })
        .catch((err) => toast.error(err?.message || 'Could not copy the reference details'));
    }
    refreshMedia();
    toast.success('Filtered copy added to references');
  }, [record, media, refreshMedia, identityReadOnly]);

  const [pendingRenders, setPendingRenders] = useState(() => (
    id ? (safeReadJsonSession(`catalog_pending_renders_${id}`, []) || []) : []
  ));

  useEffect(() => {
    if (!id) return;
    if (pendingRenders.length > 0) {
      safeWriteJsonSession(`catalog_pending_renders_${id}`, pendingRenders);
    } else {
      safeRemoveSession(`catalog_pending_renders_${id}`);
    }
  }, [id, pendingRenders]);

  const handleQuickEditQueued = useCallback((result, { item, instruction } = {}) => {
    if (!result) return;
    if (result.jobId) {
      setPendingRenders((prev) => [
        ...prev.filter(p => p.jobId !== result.jobId),
        {
          jobId: result.jobId,
          ingredientId: record?.id || id,
          instruction: instruction || '',
          sourceFilename: item?.filename || '',
          startedAt: Date.now(),
        },
      ]);
    } else if (result.filename) {
      handleGeneratedImage(result.filename);
    }
  }, [record?.id, id, handleGeneratedImage]);

  const handlePendingRenderComplete = useCallback(async (jobId, filename) => {
    setPendingRenders((prev) => prev.filter(p => p.jobId !== jobId));
    if (filename) {
      await handleGeneratedImage(filename);
    }
  }, [handleGeneratedImage]);

  const handlePendingRenderFailed = useCallback((jobId, status, error) => {
    setPendingRenders((prev) => prev.filter(p => p.jobId !== jobId));
    if (error) toast.error(error);
    else if (status === 'canceled') toast.error('Render canceled');
    else toast.error('Render failed');
  }, []);

  // Upload a dropped/picked file straight onto the ingredient. The server picks
  // the media kind (image→reference, audio, video) from the MIME and stores the
  // bytes in the matching federating library dir. Reconcile via refreshMedia.
  const handleUploadFile = useCallback(async (file) => {
    if (!record || identityReadOnly || !file) return false;
    try {
      const dataBase64 = arrayBufferToBase64(await file.arrayBuffer());
      await uploadCatalogIngredientMediaFile(
        record.id,
        { dataBase64, mimeType: file.type || 'application/octet-stream', filename: file.name },
        { silent: true },
      );
      refreshMedia();
      toast.success('File attached');
      return true;
    } catch (err) {
      toast.error(err?.message || 'Upload failed');
      return false;
    }
  }, [record, refreshMedia, identityReadOnly]);

  // Attach a recorded voice memo — the server transcribes it via Whisper and
  // stores the transcript in the audio row's caption.
  const handleRecordVoiceMemo = useCallback(async (clip) => {
    if (!record || identityReadOnly || !clip?.audioBase64) return;
    const ok = await recordCatalogIngredientVoiceMemo(
      record.id,
      { audioBase64: clip.audioBase64, mimeType: clip.mimeType },
      { silent: true },
    ).then(() => true).catch((err) => { toast.error(err?.message || 'Voice memo failed'); return false; });
    if (!ok) return;
    refreshMedia();
    toast.success('Voice memo attached');
  }, [record, refreshMedia, identityReadOnly]);

  // Re-attach an existing media row under a new role (mark/unmark a plate, add
  // an image to a look). The attach endpoint upserts role/caption on the
  // (ingredient, key, kind) row, so the caption is passed back unchanged.
  const handleSetMediaRole = useCallback(async (m, role, message) => {
    if (!record || identityReadOnly || m?.readOnly || !m?.mediaKey) return false;
    // A role never goes on the portrait row: using the portrait for a look
    // files a reference copy of the same image and leaves the portrait as is.
    const copyPortrait = m.kind === 'portrait';
    const updated = await attachCatalogIngredientMedia(
      record.id,
      { mediaKey: m.mediaKey, kind: copyPortrait ? 'reference' : m.kind, role, caption: m.caption ?? null },
      { silent: true },
    ).catch((err) => { toast.error(err?.message || 'Failed to update media'); return null; });
    if (!updated) return false;
    if (copyPortrait) refreshMedia();
    else setMedia((prev) => prev.map((row) => (
      row.mediaKey === m.mediaKey && row.kind === m.kind ? { ...row, ...updated, role } : row
    )));
    toast.success(message || (role ? 'Marked as plate' : 'Plate unmarked'));
    return true;
  }, [record, identityReadOnly, refreshMedia]);

  // A finished catalog-only sheet render: attach it under its `sheet:<variant>`
  // role right away (the server-side attach hook files the same row and is
  // idempotent against this), then reconcile the media list.
  const handleSheetFile = useCallback(async (filename, role, readyMessage = 'Reference sheet ready') => {
    if (!record || identityReadOnly || !filename) return;
    const ok = await attachCatalogIngredientMedia(record.id, { mediaKey: filename, kind: 'reference', role }, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error(err?.message || 'Failed to attach the rendered image'); return false; });
    refreshMedia();
    if (ok) toast.success(readyMessage);
  }, [record, refreshMedia, identityReadOnly]);
  const handleLookFile = useCallback((filename, role) => handleSheetFile(filename, role, 'Look ready'), [handleSheetFile]);

  // Save the Looks tab's wardrobe list straight onto the SAVED payload, then
  // copy just `wardrobes` into the draft so unsaved profile edits stay intact
  // and exactly as dirty as they were.
  const handleSaveWardrobes = useCallback(async (wardrobes) => {
    if (!record || identityReadOnly) return false;
    const submittedId = record.id;
    const nextPayload = { ...ingredientPayload(record.payload), wardrobes };
    setLookSaving(true);
    const updated = await updateCatalogIngredient(submittedId, { payload: nextPayload }, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Failed to save looks'); return null; });
    setLookSaving(false);
    if (activeVisitRef.current.id !== submittedId || !updated) return false;
    const persisted = Object.hasOwn(updated, 'payload') ? ingredientPayload(updated.payload) : nextPayload;
    setRecord((prev) => (prev?.id === submittedId ? { ...prev, ...updated, payload: persisted } : prev));
    setPayload((cur) => ({ ...cur, wardrobes: persisted.wardrobes }));
    refreshRevisions();
    return true;
  }, [record, refreshRevisions, identityReadOnly]);

  // The Greybox tab saves straight onto the SAVED payload; copy just `greybox`
  // into the draft so the next profile Save does not write the old layout back.
  const handleGreyboxSaved = useCallback((updated) => {
    const persisted = ingredientPayload(updated.payload);
    setRecord((prev) => (prev?.id === updated.id ? { ...prev, ...updated, payload: persisted } : prev));
    setPayload((cur) => {
      const { greybox: _previous, ...rest } = cur;
      return persisted.greybox ? { ...rest, greybox: persisted.greybox } : rest;
    });
    refreshRevisions();
  }, [refreshRevisions]);

  // A universe-delegated sheet landed as a canon pointer, which the canon→catalog
  // projection already copied onto this row. Pull just the pointer fields into
  // both the saved record and the draft, so an unsaved edit stays intact and
  // stays exactly as dirty as it was.
  // `updatedAt` is the row's clock after the change, so its own
  // catalog:primitive-changed echo is not mistaken for an external edit.
  const applySheetPointers = useCallback((recordId, fresh, updatedAt) => {
    const pointers = {};
    for (const key of SHEET_POINTER_KEYS) {
      if (Object.hasOwn(fresh, key)) pointers[key] = fresh[key];
    }
    setRecord((prev) => (prev?.id === recordId
      ? { ...prev, ...(updatedAt ? { updatedAt } : {}), payload: { ...ingredientPayload(prev.payload), ...pointers } }
      : prev));
    setPayload((cur) => ({ ...cur, ...pointers }));
  }, []);
  const refreshSheetPointers = useCallback(() => {
    if (!id) return;
    const requestedId = id;
    const sequence = ++sheetPointerSequence.current;
    const isCurrentRequest = () => mountedRef.current && activeVisitRef.current.id === requestedId
      && sequence === sheetPointerSequence.current;
    getCatalogIngredientDetails(id, { silent: true, view: detailView })
      .then((d) => {
        if (!isCurrentRequest() || !d?.ingredient) return;
        applySheetPointers(requestedId, ingredientPayload(d.ingredient.payload));
        toast.success('Reference sheet ready');
      })
      .catch(() => { if (isCurrentRequest()) toast.error('Reference sheet rendered — reload to see it'); });
  }, [id, detailView, mountedRef, applySheetPointers]);
  // Removing a universe sheet runs here, not in the Sheets tab, so the
  // one-at-a-time flag and the answer survive the tab unmounting. The answer's
  // clock is adopted only when this page held the row's clock from just before
  // the removal. Otherwise the record changed elsewhere too: the pointers still
  // apply, and the full record is re-read and goes through the same
  // external-change check as a socket refresh.
  const [removingPointerSheet, setRemovingPointerSheet] = useState(null);
  const removingPointerSheetRef = useRef(null);
  const handleRemovePointerSheet = useCallback(async (variant, filename) => {
    if (!id || removingPointerSheetRef.current) return;
    const recordId = id;
    removingPointerSheetRef.current = filename;
    setRemovingPointerSheet(filename);
    const result = await removeCatalogPointerSheet(recordId, variant, filename, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Could not remove the sheet'); return null; });
    removingPointerSheetRef.current = null;
    if (!mountedRef.current) return;
    setRemovingPointerSheet(null);
    if (!result?.pointers || activeVisitRef.current.id !== recordId) return;
    toast.success('Reference sheet removed');
    ++sheetPointerSequence.current;
    const adopt = !!result.priorUpdatedAt && result.priorUpdatedAt === editSnapshot.current?.updatedAt;
    applySheetPointers(recordId, result.pointers, adopt ? result.updatedAt : undefined);
    if (adopt) return;
    const details = await getCatalogIngredientDetails(recordId, { silent: true, view: detailView }).catch(() => null);
    if (!mountedRef.current || activeVisitRef.current.id !== recordId || !details?.ingredient) return;
    if (details.ingredient.updatedAt === editSnapshot.current?.updatedAt) return;
    if (editSnapshot.current?.dirty) setExternalDetails(details);
    else applyDetails(details);
  }, [id, applySheetPointers, applyDetails, detailView, mountedRef]);

  const handleSave = async () => {
    if (!record || identityReadOnly || unlocking || characterActionBusy) return;
    const submittedId = record.id;
    const submittedGeneration = activeVisitRef.current.generation;
    const submittedName = name;
    const submittedTags = tags;
    const submittedPayload = payload;
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error('Name is required');
      return;
    }
    if (record.type === 'character') {
      const required = { stats: ['label', 'stat label'], colorPalette: ['name', 'swatch name'], props: ['name', 'prop name'],
        expressions: ['name', 'expression name'], handGestures: ['name', 'gesture name'] };
      const incomplete = Object.entries(required).find(([key, [field]]) => (Array.isArray(payload[key]) ? payload[key] : []).some(row =>
        row && typeof row === 'object' && !String(row[field] || '').trim()
        && Object.entries(row).some(([name, value]) => name !== 'id' && typeof value === 'string' && value.trim())));
      if (incomplete) { toast.error(`Complete the ${incomplete[1][1]} or remove its unfinished row before saving.`); return; }
    }
    setSaving(true);
    const updated = await updateCatalogIngredient(submittedId, {
      name: trimmedName,
      payload: submittedPayload,
      tags: submittedTags,
    }, { silent: true }).catch((err) => {
      toast.error(err?.message || 'Save failed');
      return null;
    });
    const isCurrentVisit = () => activeVisitRef.current.id === submittedId
      && activeVisitRef.current.generation === submittedGeneration;
    if (!isCurrentVisit()) return;
    setSaving(false);
    if (!updated) return;
    const persistedName = typeof updated.name === 'string' ? updated.name : trimmedName;
    const persistedTags = Array.isArray(updated.tags) ? updated.tags : submittedTags;
    const persistedPayload = Object.hasOwn(updated, 'payload')
      ? ingredientPayload(updated.payload)
      : ingredientPayload(submittedPayload);
    setRecord((prev) => isCurrentVisit() && prev?.id === submittedId ? ({
      ...prev, ...updated, name: persistedName, tags: persistedTags, payload: persistedPayload,
    }) : prev);
    setName((current) => isCurrentVisit() && current === submittedName ? persistedName : current);
    // The server normalizes tags through the canonical table (casing/whitespace
    // collapse), so reflect the persisted set back into the chips.
    setTags((current) => isCurrentVisit() && sameValue(current, submittedTags) ? persistedTags : current);
    setPayload((current) => isCurrentVisit() && sameValue(current, submittedPayload) ? { ...persistedPayload } : current);
    toast.success('Saved');
    refreshRevisions();
  };

  const handleRestore = async (revisionId) => {
    if (!record || identityReadOnly) return false;
    const updated = await restoreCatalogIngredientRevision(record.id, revisionId, {}, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Restore failed'); return null; });
    if (!updated) return false;
    // Re-apply the restored state into the editable form so the page reflects
    // the rollback without a full reload.
    setRecord((prev) => ({ ...prev, ...updated }));
    setName(updated.name || '');
    setTags(Array.isArray(updated.tags) ? updated.tags : []);
    setPayload(updated.payload && typeof updated.payload === 'object' ? { ...updated.payload } : {});
    toast.success('Restored');
    refreshRevisions();
    return true;
  };

  const confirmDelete = async () => {
    if (!record || identityReadOnly) return;
    setArmedDelete(false);
    const ok = await deleteCatalogIngredient(record.id, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error(err?.message || 'Delete failed'); return false; });
    if (ok && mountedRef.current) {
      toast.success('Deleted');
      navigate(backPath);
    }
  };

  const updatePayload = (key, value) => {
    setPayload((prev) => ({ ...prev, [key]: value }));
  };

  const isDirty = Boolean(record && (
    name !== (record.name || '')
    || !sameValue(tags, Array.isArray(record.tags) ? record.tags : [])
    || !sameValue(payload, ingredientPayload(record.payload))
  ));
  // Tab switches within this record change the pathname but not the editor;
  // scope the guard to the record so only a real exit asks to discard.
  const routeGuard = useUnsavedChangesGuard(isDirty, {
    scopePath: library ? `${library.path}/${encodeURIComponent(id || '')}` : undefined,
  });
  const discardAndExit = useCallback(() => {
    // The parked route is leaving, so unmounting discards the local draft. Do
    // not clear isDirty before proceeding: the shared guard auto-proceeds when
    // a parked draft settles, which would race this explicit proceed call.
    routeGuard.proceed();
  }, [routeGuard]);

  if (loading || !record) {
    return (
      <PageSkeleton
        header="none"
        label="Loading ingredient"
        padded
        fullHeight
        cards={3}
        sidebar={false}
      />
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
  const editableLists = typeDef.editableListFields || [];
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

  // Ownership, rather than usage-list order, supplies the style context.
  const universeRef = record.universeContext?.owner || null;
  const ownerCharacter = ownerUniverse?.characters?.find((entry) => entry.id === ownerEntryId);

  // Library routes split the page into the library's tabs; the plain
  // /catalog/:type/:id route (and a record opened under the wrong library)
  // keeps the single untabbed scroll, which renders as the 'profile' tab plus
  // its media panel.
  const tabs = library && library.type === record.type
    ? library.detailTabs.map((t) => ({ ...t, icon: DETAIL_TAB_ICONS[t.id] }))
    : null;
  const activeTab = tabs ? resolveDetailTab(library, tabParam) : 'profile';
  const wardrobes = record.type === 'character' && Array.isArray(ingredientPayload(record.payload).wardrobes)
    ? record.payload.wardrobes
    : [];
  const protectMedia = (item) => ({ ...item, readOnly: identityReadOnly || item.retained === true || !!record.sharedIdentity && (item.ingredientId === record.sharedIdentity.sourceId || item.role?.startsWith('archive:identity')) });
  const liveLookIds = new Set(wardrobes.map((w) => w?.id).filter(Boolean));
  const liveShotIds = new Set((ingredientPayload(record.payload).greybox?.shots || []).map((s) => s.id));
  const isReferenceTabRow = (m) => isReferenceTabMedia(m, liveLookIds, liveShotIds);
  // The References tab shows the portrait beside the references, so the look
  // picker offers it too unless the same image already has a reference row.
  const referenceKeys = new Set(media.filter((m) => m.kind === 'reference').map((m) => m.mediaKey));
  const lookCandidates = media.filter((m) => (m.kind === 'reference' && isReferenceTabRow(m))
    || (m.kind === 'portrait' && !referenceKeys.has(m.mediaKey)));
  const savedPayload = ingredientPayload(record.payload);
  const forkSeed = { candidates: [...media.filter((m) => !m.deleted && (m.kind === 'portrait' || (m.kind === 'reference' && isReferenceTabRow(m)))),
    ...[savedPayload.primaryImageRef, ...(Array.isArray(savedPayload.imageRefs) ? savedPayload.imageRefs : [])]
      .filter((ref) => typeof ref === 'string' && ref.trim()).map((mediaKey) => ({ mediaKey, kind: 'reference' }))],
    forms: Array.isArray(savedPayload.forms) ? savedPayload.forms : [], ready: mediaReady, error: mediaError, load: refreshMedia };
  const coverUrl = ingredientCoverUrl({
    ...record,
    thumbnailKey: media.find((m) => m.kind === 'portrait')?.mediaKey || (!mediaReady && record.coverMedia?.portraitKey) || record.thumbnailKey,
    payload,
  }) || ingredientCoverUrl({ thumbnailKey: media.find((m) => m.kind === 'reference' && !m.role?.startsWith('archive:') && (!isDesignMedia(m) || m.library?.guide === true))?.mediaKey || (!mediaReady && record.coverMedia?.referenceKey) });
  const renderBlockedReason = (subject) => identityReason || (record.payload?.locked === true
    ? 'Unlock this record above before rendering.'
    : saving || lookSaving || characterActionBusy || unlocking
    ? `Saving — the ${subject} renders from the saved record.`
    : isDirty ? `Save your profile edits first — the ${subject} renders from the saved record.` : null);

  return (
    <CatalogImagePreviewProvider
      key={record.id}
      ingredientId={record.id}
      onQuickEditQueued={handleQuickEditQueued}
      onVariantSaved={handleVariantSaved}
    >
    <fieldset disabled={mergeBusy} className="flex h-full min-h-0 min-w-0 flex-col">
      <UnsavedChangesConfirm
        guard={routeGuard}
        when={!saving}
        question="Discard your unsaved changes to this ingredient?"
        label={`Discard unsaved changes to ${record.name || 'this ingredient'}`}
        onDiscard={discardAndExit}
      />
      {/* Same flush header + sub-nav as PageHeader/RouteTabsHeader pages:
          edge to edge under the app nav, only the content below scrolls. */}
      <header className="shrink-0 px-3 py-2 sm:px-4 sm:py-3 border-b border-port-border">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <Link to={backPath} aria-label={`Back to ${backToVideo ? 'music video' : library?.label || 'Catalog'}`} title="Back"
              className="shrink-0 inline-flex items-center justify-center min-w-[40px] min-h-[40px] -ml-2 rounded-lg text-gray-400 hover:text-white">
              <ArrowLeft size={18} aria-hidden="true" />
            </Link>
            <div className="min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <h1
                  className="min-w-0 truncate text-lg sm:text-xl font-bold text-white leading-tight"
                  title={record.name || '(untitled)'}
                >
                  {record.name || '(untitled)'}
                </h1>
                <span className={`shrink-0 text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border ${badgeClass}`}>
                  {record.type}
                </span>
              </div>
              <p className="hidden sm:block text-xs text-gray-500 font-mono truncate leading-tight" title={record.id}>{record.id}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            {FORM_TYPES.has(record.type) && <CatalogLockButton key={record.id} record={record}
              disabled={saving || lookSaving || unlocking || characterActionBusy || mergeBusy} onPendingChange={setUnlocking} onChanged={applyLock} />}
            {isDirty && <span className="text-xs text-port-warning" role="status">Unsaved changes</span>}
            <button type="button" onClick={handleSave} disabled={saving || lookSaving || greyboxBusy || unlocking || characterActionBusy || mergeBusy || identityReadOnly || !!externalDetails}
              className="inline-flex items-center gap-1.5 min-h-[40px] px-3 py-2 rounded-lg bg-port-accent hover:bg-port-accent/90 disabled:opacity-50 text-white text-sm font-medium">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
            </button>
            <AddToThreadButton
              refItem={{
                kind: 'catalog.ingredient',
                id: record.id,
                label: name || record.name || record.id
              }}
              buttonText="Thread"
              className="inline-flex items-center gap-1.5 min-h-[40px] px-3 py-2 rounded-lg text-sm border border-port-border text-gray-300 hover:text-white hover:border-port-accent/40 transition-colors"
            />
            {armedDelete ? (
              <span className="inline-flex items-center gap-1 text-sm">
                <span className="text-gray-400 px-1">Delete?</span>
                <button type="button" onClick={confirmDelete} disabled={identityReadOnly}
                  className="inline-flex items-center gap-1 min-h-[40px] px-3 py-2 rounded-lg bg-port-error/20 text-port-error hover:bg-port-error/30 font-medium">
                  <Trash2 size={14} aria-hidden="true" /> Yes, delete
                </button>
                <button type="button" onClick={() => setArmedDelete(false)}
                  className="min-h-[40px] px-3 py-2 rounded-lg text-gray-400 hover:text-white">
                  Cancel
                </button>
              </span>
            ) : (
              <button type="button" onClick={() => setArmedDelete(true)} disabled={identityReadOnly}
                className="inline-flex items-center justify-center gap-1.5 min-w-[40px] min-h-[40px] px-2.5 sm:px-3 py-2 rounded-lg text-sm border border-port-border text-gray-400 hover:text-port-error"
                aria-label="Delete ingredient" title="Delete">
                <Trash2 size={14} aria-hidden="true" /> <span className="hidden sm:inline">Delete</span>
              </button>
            )}
          </div>
        </div>
      </header>

      {tabs && (
        <TabPills
          tabs={tabs}
          activeTab={activeTab}
          onChange={(tabId) => navigate(`${detailTabPath(library, record.id, tabId)}${search}`)}
          ariaLabel={`${library.label} record sections`}
          className="w-full min-w-0 shrink-0"
        />
      )}

      <div className="flex-1 min-h-0 overflow-y-auto p-4 md:p-6">
      <div className="w-full min-w-0 space-y-5">
        <CatalogIdentityNotice identity={record.sharedIdentity} type={record.type} />
        {externalDetails && <div role="status" className="rounded border border-port-warning/40 bg-port-warning/10 p-3 text-sm text-gray-300">
          This primitive changed in another view. Your draft is preserved; inspect the latest version before saving.
          <button type="button" onClick={() => { applyDetails(externalDetails); setExternalDetails(null); }}
            className="ml-2 text-port-accent hover:underline">Discard local edits and load latest</button>
        </div>}
        <CatalogUniversePanel key={`universe-${record.id}`} ingredient={record} context={record.universeContext}
          onContextChange={applyUniverseContext} readOnly={identityReadOnly} forkBlocked={record.sharedIdentity?.reason === 'CATALOG_IDENTITY_FENCED'} unsaved={isDirty || saving || lookSaving}
          seed={forkSeed} redesign={redesignFork ? { fields: redesignFork, clear: () => setRedesignFork(null) } : null} />

        <CatalogRedesign ingredient={record} payload={payload} disabled={identityReadOnly || payload.locked === true || saving || lookSaving || !!externalDetails}
          onApply={patch => setPayload(previous => ({ ...previous, ...patch }))} onFork={setRedesignFork} />

        {profileVisited && (
          <div hidden={activeTab !== 'profile'} className="space-y-4">
            {record.type !== 'character' && <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6 space-y-4">
              <div className={coverUrl ? 'grid grid-cols-1 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] gap-5 items-start' : ''}>
                {coverUrl && (
                  <figure className="min-w-0 rounded-lg border border-port-border bg-port-bg overflow-hidden">
                    <CatalogImagePreview key={coverUrl} src={coverUrl} fallbackSrc={coverUrl.replace('/data/images/', '/data/image-refs/')}
                      alt={`${record.name || 'Ingredient'} cover`} className="w-full max-h-80 object-contain" loading="eager" />
                    <figcaption className="text-xs text-gray-400 p-2">Cover image · select to enlarge</figcaption>
                  </figure>
                )}
                <fieldset disabled={identityReadOnly} className="min-w-0 space-y-4">
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
                </fieldset>
              </div>
              <fieldset disabled={identityReadOnly} className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
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
              </fieldset>

              {/* Structured array-field editors (aliases / color palette / stats).
                  Driven by the type's registry-declared `editableListFields`; the
                  same durable catalog row the Universe Builder canon surface edits.
                  Light/user types declare none and skip this entirely. */}
              {!isUserType && Array.isArray(typeDef.editableListFields) && typeDef.editableListFields.length > 0 && (
                <fieldset disabled={identityReadOnly}><EditableListFields fields={editableLists} payload={payload} onChange={updatePayload} /></fieldset>
              )}
            </div>}

            {record.type !== 'character' && FORM_TYPES.has(record.type) && (
              <fieldset disabled={identityReadOnly} className="min-w-0">
                <CatalogFormsEditor type={record.type} payload={payload} onChange={updatePayload} />
              </fieldset>
            )}
            {record.type !== 'character' && FORM_TYPES.has(record.type) && <RevealTimingField entry={{ ...payload, id: record.id }}
              editable={!identityReadOnly && payload.locked !== true} onPatch={(patch) => setPayload((previous) => ({ ...previous, ...patch }))} />}

            {record.type === 'character' && <CharacterDetailEditor
              draftMode="change" navigationId={record.id} onPageChange={onCharacterPageChange}
              entry={{ ...payload, id: ownerCharacter?.id || record.id, name }}
              universeId={ownerCharacter ? ownerUniverseId : null} characters={ownerUniverse?.characters || []}
              contextLoading={!!ownerUniverseId && !ownerUniverse && !ownerContextError}
              disabled={identityReadOnly || characterActionBusy} actionsDisabled={payload.locked === true || isDirty || saving || unlocking || lookSaving}
              onPatch={(patch) => setPayload((previous) => ({ ...previous, ...patch }))}
              saveHint="Use Save to save your character edits"
              portrait={coverUrl ? <CatalogImagePreview key={coverUrl} src={coverUrl} fallbackSrc={coverUrl.replace('/data/images/', '/data/image-refs/')}
                alt={`${record.name || 'Character'} cover`} className="w-full max-h-64 object-contain rounded" loading="eager" /> : null}
              identityControls={<div className="space-y-3">
                <div><label htmlFor="ingredient-name" className="block text-xs text-gray-400 mb-1">Name</label>
                  <input id="ingredient-name" value={name} maxLength={200} disabled={identityReadOnly || characterActionBusy} onChange={event => setName(event.target.value)}
                    className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm" /></div>
                <div><label htmlFor="ingredient-tags" className="block text-xs text-gray-400 mb-1">Tags</label>
                  <fieldset disabled={identityReadOnly || characterActionBusy}><TagPicker id="ingredient-tags" value={tags} onChange={setTags} /></fieldset></div>
                {ownerUniverseId && !contextRequested && <button type="button" onClick={() => setContextRequested(true)}
                  className="min-h-11 text-xs text-port-accent">Load universe creative tools</button>}
                {ownerCanonMissing && <p role="alert" className="text-xs text-port-warning">
                  {name || 'This character'} isn’t in {ownerUniverse?.name || 'its universe'}’s cast, so its story, voice and sheet tools are off.
                  {!identityReadOnly && <button type="button" disabled={joiningCanon} onClick={joinOwnerCanon}
                    className="ml-1 min-h-11 underline disabled:opacity-50">{joiningCanon ? 'Adding…' : 'Add to cast'}</button>}</p>}
                {ownerContextError && <p role="alert" className="text-xs text-port-warning">{ownerContextError}
                  <button type="button" onClick={() => setContextVersion(previous => previous + 1)} className="ml-1 underline">Retry context</button></p>}
                {ownerCharacter && <CharacterCanonActions key={ownerCharacter.id} universe={ownerUniverse} entry={ownerCharacter}
                  applyDisabled={identityReadOnly || payload.locked === true}
                  disabled={identityReadOnly || payload.locked === true || isDirty || saving || unlocking || lookSaving || !!externalDetails}
                  onPendingChange={setCharacterActionBusy} onPatch={patch => setPayload(previous => ({ ...previous, ...patch }))}
                  onChanged={updated => {
                    if (updated) setOwnerUniverse(updated);
                    getCatalogIngredientDetails(id, { silent: true, view: detailView }).then(details => {
                      if (!mountedRef.current || details?.ingredient?.id !== editSnapshot.current.id) return;
                      if (editSnapshot.current.dirty) setExternalDetails(details); else applyDetails(details);
                      refreshRevisions();
                    }).catch(error => toast.error(error.message || 'Could not refresh the character.'));
                  }} />}
              </div>}
              storyExtra={<fieldset disabled={identityReadOnly || characterActionBusy}><EditableListFields fields={editableLists.filter(field => field.key === 'aliases')} payload={payload} onChange={updatePayload} /></fieldset>}
            >
              <div className="bg-port-card border border-port-border rounded-lg p-4">
                <CatalogFamilyPicker selfName={name} excludeIds={[record.id]} disabled={identityReadOnly || characterActionBusy}
                  items={relations.outbound.filter((r) => isFamilyRelationKind(r.kind)).map((r) => ({ kind: r.kind, id: r.toId, name: r.other?.name }))}
                  inbound={relations.inbound.filter((r) => isFamilyRelationKind(r.kind)).map((r) => ({ kind: r.kind, id: r.fromId, name: r.other?.name }))}
                  onAdd={(kind, target) => handleAddRelation(target, kind)} onRemove={(item) => handleRemoveRelation(item.id, item.kind)} />
              </div>
              <fieldset disabled={identityReadOnly || characterActionBusy}><CatalogFormsEditor type={record.type} payload={payload} onChange={updatePayload} /></fieldset>
              <RevealTimingField entry={{ ...payload, id: record.id }} editable={!identityReadOnly && !characterActionBusy && payload.locked !== true}
                onPatch={patch => setPayload(previous => ({ ...previous, ...patch }))} />
              {!tabs && <ReferenceSheetPanel payload={payload} universeRef={universeRef} />}
              <div className="bg-port-card border border-port-border rounded-lg p-3">
                <div className="text-xs uppercase tracking-wider text-gray-500 mb-2">Character LoRA</div>
                <CharacterLoraChip ingredientId={record.id} />
              </div>
            </CharacterDetailEditor>}

            {record.type === 'object' && <ObjectAttachmentsEditor entry={{ ...payload, id: record.id, name }}
              characters={ownerUniverse?.characters || []} disabled={identityReadOnly || payload.locked === true}
              onPatch={(patch) => setPayload((previous) => ({ ...previous, ...patch }))} />}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <SourcesPanel sources={record.sources} evidence={payload?.evidence} />
            </div>

            <RelationsPanel
              record={record}
              relations={relations}
              evidence={payload?.evidence}
              readOnly={identityReadOnly} retainedSourceId={record.sharedIdentity?.sourceId}
              onAdd={handleAddRelation}
              onRemove={handleRemoveRelation}
            />
          </div>
        )}

        <div hidden={activeTab !== 'sheets' && activeTab !== 'looks' && activeTab !== 'design'}>
          <CatalogUnlockNotice key={record.id} record={record} disabled={saving || lookSaving || unlocking || characterActionBusy || identityReadOnly} onPendingChange={setUnlocking}
            onUnlocked={applyLock} />
        </div>

        {mediaTab !== 'profile' && (mediaError || !mediaReady) && <div role="status" className="text-sm text-gray-400">
          {mediaError || 'Loading media…'}{mediaError && <button type="button" onClick={refreshMedia} disabled={mediaLoading} className="ml-2 text-port-accent underline">Retry media</button>}
        </div>}
        {activeTab === 'sheets' && mediaReady && (
          <CatalogSheetsPanel
            ingredientId={record.id}
            payload={payload}
            universeRef={universeRef}
            sheetMedia={media.filter(isSheetMedia).map(protectMedia)}
            missingMedia={missingMedia}
            onDetach={identityReadOnly ? undefined : handleDetachMedia}
            blockedReason={renderBlockedReason('sheet')}
            savedStamp={record.updatedAt || null}
            onSheetFile={handleSheetFile}
            onPointerSheetReady={refreshSheetPointers}
            onRemovePointerSheet={identityReadOnly ? undefined : handleRemovePointerSheet}
            removingPointerSheet={removingPointerSheet}
            onMediaChanged={identityReadOnly ? undefined : refreshMedia}
          />
        )}

        {activeTab === 'design' && mediaReady && (
          <CatalogDesignPanel
            key={record.id}
            ingredientId={record.id}
            name={name}
            forms={formsOf(record.payload)}
            media={media.map(protectMedia)}
            blockedReason={renderBlockedReason('design round')}
            onChanged={refreshMedia}
            onSetPortrait={handleSetPortrait}
          />
        )}

        {activeTab === 'looks' && mediaReady && (
          <CatalogLooksPanel
            key={record.id}
            ingredientId={record.id}
            initialUniverseId={universeRef?.refId || ''}
            wardrobes={wardrobes}
            lookMedia={media.filter((m) => liveLookIds.has(lookIdOf(m))).map(protectMedia)}
            candidates={lookCandidates.map(protectMedia)}
            missingMedia={missingMedia}
            editLocked={saving || unlocking || identityReadOnly}
            blockedReason={renderBlockedReason('look')}
            savedStamp={record.updatedAt || null}
            onSaveWardrobes={handleSaveWardrobes}
            onSetRole={identityReadOnly ? undefined : handleSetMediaRole}
            onDetach={identityReadOnly ? undefined : handleDetachMedia}
            onLookFile={handleLookFile}
          />
        )}

        {activeTab === 'plates' && mediaReady && (
          <CatalogPlatesPanel
            plates={media.filter(isPlateMedia).map(protectMedia)}
            candidates={media.filter((m) => m.kind === 'reference' && isReferenceTabRow(m)).map(protectMedia)}
            missingMedia={missingMedia}
            onSetRole={identityReadOnly ? undefined : handleSetMediaRole}
            onDetach={identityReadOnly ? undefined : handleDetachMedia}
          />
        )}

        {activeTab === 'greybox' && mediaReady && (
          <GreyboxPanel
            key={record.id}
            record={record}
            media={media}
            readOnly={identityReadOnly}
            disabled={saving}
            onBusyChange={setGreyboxBusy}
            onSaved={handleGreyboxSaved}
            onCaptured={refreshMedia}
          />
        )}

        {mediaReady && (activeTab === 'profile' ? !tabs : activeTab === 'references' || activeTab === 'images') && (
          <MediaPanel
            readOnly={identityReadOnly}
            referenceLibrary={record.type === 'character' ? { ingredientId: record.id, forms: formsOf(record.payload), media: media.map(protectMedia), onChanged: refreshMedia,
              revision: record.updatedAt, blockedReason: renderBlockedReason('reference'),
              pendingRenders: pendingRenders.filter(p => !p.ingredientId || p.ingredientId === record.id),
              onPendingRenderComplete: handlePendingRenderComplete,
              onPendingRenderFailed: handlePendingRenderFailed,
              onMediaUpdated: updated => setMedia(previous => previous.map(row => {
                if (row.mediaKey !== updated.mediaKey || (row.ingredientId || record.id) !== (updated.ingredientId || record.id)) return row;
                if (row.kind === updated.kind) return updated;
                return ['bad', 'rejected'].includes(updated.library?.review?.status)
                  ? { ...row, library: { ...(row.library || {}), guide: false } } : row;
              })) } : null}
            pendingRenders={pendingRenders.filter(p => !p.ingredientId || p.ingredientId === record.id)}
            onPendingRenderComplete={handlePendingRenderComplete}
            onPendingRenderFailed={handlePendingRenderFailed}
            media={(tabs ? media.filter(isReferenceTabRow) : media).map(protectMedia)}
            canonImageRefs={[payload.primaryImageRef, ...(Array.isArray(payload.imageRefs) ? payload.imageRefs : [])].filter((ref) =>
              !media.some((m) => (m.kind === 'portrait' || m.kind === 'reference') && m.mediaKey === ref))}
            primaryImageRef={payload.primaryImageRef}
            canonRemoval={universeRef && FORM_TYPES.has(record.type) ? {
              recordId: record.id, universeId: universeRef.refId, kind: record.type,
              disabled: identityReadOnly || saving || isDirty || lookSaving || unlocking,
              onRemoved: () => {
                getCatalogIngredientDetails(id, { silent: true, view: detailView }).then(details => {
                  if (!mountedRef.current || details?.ingredient?.id !== editSnapshot.current.id) return;
                  if (editSnapshot.current.dirty) setExternalDetails(details); else applyDetails(details);
                  refreshMediaRef.current?.(); refreshRevisions();
                }).catch(error => toast.error(error.message));
              },
            } : null}
            missingMedia={missingMedia}
            onAttach={handleAttachMedia}
            onSetPortrait={handleSetPortrait}
            onDetach={identityReadOnly ? undefined : handleDetachMedia}
            onUploadFile={handleUploadFile}
            onRecordVoice={handleRecordVoiceMemo}
            genIngredientId={record.id}
            genName={name}
            genDescription={genDescription}
            genUniverseId={universeRef?.refId || null}
            onGenerated={handleGeneratedImage}
          />
        )}

        {mediaReady && (activeTab === 'references' || activeTab === 'images' || (!tabs && activeTab === 'profile')) && (
          <CatalogRelatedImages key={record.id} ingredientId={record.id} name={record.name}
            excludedFilenames={[
              payload.primaryImageRef,
              ...listSheetPointers(payload).map(({ filename }) => filename),
              ...(Array.isArray(payload.imageRefs) ? payload.imageRefs : []),
              ...media.filter((m) => m.kind === 'portrait' || m.kind === 'reference').map((m) => m.mediaKey),
            ]} />
        )}

        {activeTab === 'profile' && (
          <CatalogMergePanel record={record}
            disabledReason={identityReason || (saving || lookSaving || unlocking ? 'Wait for the current save to finish.' : isDirty ? 'Save or discard profile edits before consolidating.' : null)}
            onPendingChange={setMergeBusy} onChanged={() => setMergeVersion((version) => version + 1)} />
        )}

        {activeTab === 'profile' && <CatalogIdentityPanel record={record}
          disabledReason={saving || lookSaving || unlocking ? 'Wait for the current save to finish.' : isDirty ? 'Save or discard profile edits before managing identity.' : null}
          onPendingChange={setMergeBusy} onChanged={() => setMergeVersion((version) => version + 1)} />}

        {activeTab === 'profile' && (
          <RevisionsPanel
            readOnly={identityReadOnly}
            retainedSourceId={record.sharedIdentity?.sourceId}
            revisions={revisions} loading={revisionsLoading} error={revisionsError} onLoad={() => refreshRevisions(true)}
            current={record}
            fields={fields}
            onRestore={handleRestore}
          />
        )}
      </div>
      </div>
    </fieldset>
    </CatalogImagePreviewProvider>
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
      {['intExt', 'timeOfDay'].includes(kind)
        ? <select id={inputId} value={value || ''} onChange={(event) => onChange(fieldKey, event.target.value || null)} className={shared}>
            <option value="">Not specified</option>
            {(kind === 'intExt' ? ['INT', 'EXT'] : ['dawn', 'day', 'dusk', 'night']).map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        : kind === 'textarea'
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

// "Relations" panel — ingredient↔ingredient edges. Outbound edges (this
// ingredient → other) are user-editable here; inbound edges (other → this
// ingredient) are read-only because the owning ingredient is the other end.
function RelationsPanel({ record, relations, evidence, onAdd, onRemove, readOnly = false, retainedSourceId }) {
  // A character's family ties live in its Family picker.
  const shown = (r) => record.type !== 'character' || !isFamilyRelationKind(r.kind ?? r.id);
  const kinds = RELATION_KINDS.filter(shown);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [kind, setKind] = useState(kinds[0].id);
  const [armedRelation, setArmedRelation] = useState(null);
  const [removingRelation, setRemovingRelation] = useState(null);
  const outbound = Array.isArray(relations.outbound) ? relations.outbound.filter(shown) : [];
  const inbound = Array.isArray(relations.inbound) ? relations.inbound.filter(shown) : [];
  const evidenceList = Array.isArray(evidence)
    ? evidence.filter((item) => typeof item === 'string' && item.trim())
    : typeof evidence === 'string' && evidence.trim()
    ? evidence.split('\n').map((s) => s.trim()).filter(Boolean)
    : [];

  // Hide the current record + everything already linked outbound from the
  // picker so the user can't double-link or self-link.
  const excludeIds = [record.id, ...outbound.map((r) => r.toId)];

  const chip = (other) => {
    const badge = CATALOG_BADGE_BY_ID[other?.type] || 'bg-gray-500/20 text-gray-300 border-gray-500/40';
    return (
      <Link to={ingredientPath({ type: other?.type, id: other?.id })}
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
          <select id="relation-kind" disabled={readOnly} value={kind} onChange={(e) => setKind(e.target.value)}
            className="px-2 py-1.5 bg-port-bg border border-port-border rounded text-xs text-white focus:outline-none focus:border-port-accent">
            {kinds.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
          <button type="button" onClick={() => setPickerOpen(true)} disabled={readOnly}
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
              <ul className="space-y-2">
                {outbound.map((r) => {
                  const relationKey = `${r.toId}-${r.kind}`;
                  const relationName = r.other?.name || r.toId;
                  // Extraction stores exact directed kind/target prefixes in
                  // the source payload. A name mention cannot prove an edge.
                  const evidencePrefix = `${r.kind} → ${relationName}: `.replace(/\s+/g, ' ');
                  const matchedEvidence = evidenceList.find((item) => item.startsWith(evidencePrefix));
                  const evidenceSnippet = matchedEvidence?.slice(evidencePrefix.length);
                  return (
                    <li key={relationKey} className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs text-gray-400">{getRelationKind(r.kind)?.label || r.kind}</span>
                        {chip(r.other)}
                        {!readOnly && !(retainedSourceId && [r.fromId, r.toId].includes(retainedSourceId)) && (armedRelation === relationKey ? (
                          <ConfirmButtonPair
                            prompt="Remove?"
                            confirmText="Remove"
                            busyText="Removing"
                            busy={removingRelation === relationKey}
                            ariaLabel={`Confirm removal of relation to ${relationName}`}
                            onCancel={() => setArmedRelation(null)}
                            onConfirm={async () => {
                              setRemovingRelation(relationKey);
                              await onRemove(r.toId, r.kind);
                              setRemovingRelation(null);
                              setArmedRelation(null);
                            }}
                          />
                        ) : (
                          <button type="button" onClick={() => setArmedRelation(relationKey)}
                            aria-label={`Remove relation to ${relationName}`}
                            className="text-gray-500 hover:text-port-error">
                            <X size={12} aria-hidden="true" />
                          </button>
                        ))}
                      </div>
                      {retainedSourceId && [r.fromId, r.toId].includes(retainedSourceId) && <p className="text-xs text-gray-500">Retained source relation · read-only</p>}
                      {evidenceSnippet && (
                        <p className="text-[11px] text-gray-400 italic pl-3 border-l border-port-border">
                          “{evidenceSnippet}”
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {inbound.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">Inbound</div>
              <ul className="space-y-2">
                {inbound.map((r) => {
                  const inboundKey = `${r.fromId}-${r.kind}`;
                  // Incoming evidence belongs to the other ingredient and is
                  // not included in this detail response.
                  return (
                    <li key={inboundKey} className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs text-gray-400">{getRelationKind(r.kind)?.inverseLabel || r.kind}</span>
                        {chip(r.other)}
                      </div>
                    </li>
                  );
                })}
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
function MediaPanel({ canonRemoval = null, readOnly = false, referenceLibrary = null, media, canonImageRefs = [], primaryImageRef, missingMedia, onAttach, onSetPortrait, onDetach, onUploadFile, onRecordVoice, genIngredientId, genName, genDescription, genUniverseId, onGenerated, pendingRenders = [], onPendingRenderComplete, onPendingRenderFailed }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false); // upload or transcription in flight
  const { recording, starting, start: startMemo, stop: stopMemo } = useMemoRecorder();
  const [armedDetach, setArmedDetach] = useState(null);
  const list = Array.isArray(media) ? media : [];
  const portrait = list.find((m) => m.kind === 'portrait');
  const seenImageKeys = new Set(portrait ? [portrait.mediaKey] : []);
  const others = list.filter((m) => {
    if (m.kind === 'portrait') return false;
    if (m.kind !== 'reference') return true;
    if (seenImageKeys.has(m.mediaKey)) return false;
    seenImageKeys.add(m.mediaKey);
    return true;
  });
  const tileMedia = referenceLibrary ? others.filter((m) => !['reference', 'video'].includes(m.kind)) : others;
  const canonImages = [...new Set(canonImageRefs.filter((ref) => typeof ref === 'string' && ref.trim()))];

  const doUpload = async (file) => {
    if (!file || busy || readOnly) return;
    setBusy(true);
    try {
      await onUploadFile(file);
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    if (readOnly) return;
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
    if (file) doUpload(file);
  };

  const startRecording = async () => {
    await startMemo().catch((err) => {
      toast.error(err?.message || 'Microphone unavailable');
    });
  };

  const stopRecording = async () => {
    const pendingClip = stopMemo();
    if (!pendingClip) return;
    const clip = await pendingClip.catch((err) => { toast.error(err?.message || 'Recording failed'); return null; });
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
        {!readOnly && <div className="flex items-center gap-2 flex-wrap">
          <GenerateImageControl key={genIngredientId} ingredientId={genIngredientId} name={genName} description={genDescription} universeId={genUniverseId} onComplete={onGenerated} />
          <button type="button" onClick={() => setPickerOpen(true)}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-port-border text-gray-300 hover:text-white hover:border-port-accent">
            <Plus size={12} aria-hidden="true" /> Pick from gallery
          </button>
          <FilePickerButton accept="image/*,audio/*,video/*" onChange={onFilePicked} disabled={busy || recording}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-port-border text-gray-300 hover:text-white hover:border-port-accent">
            <Upload size={12} aria-hidden="true" /> Upload file
          </FilePickerButton>
          {!recording ? (
            <button type="button" onClick={startRecording} disabled={busy || starting}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-port-border text-gray-300 hover:text-white hover:border-port-accent disabled:opacity-40">
              <Mic size={12} aria-hidden="true" /> Record memo
            </button>
          ) : (
            <button type="button" onClick={stopRecording}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-port-error text-port-error hover:bg-port-error/10 animate-pulse">
              <Square size={12} aria-hidden="true" /> Stop &amp; transcribe
            </button>
          )}
        </div>}
      </div>

      {!readOnly && <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`mb-3 rounded-lg border border-dashed p-3 text-center text-xs transition-colors ${dragOver ? 'border-port-accent bg-port-accent/10 text-white' : 'border-port-border text-gray-500'}`}
      >
        {busy
          ? (<span className="inline-flex items-center gap-1"><Loader2 size={12} className="animate-spin" aria-hidden="true" /> Working…</span>)
          : 'Drag a gallery image or a file here to attach it (image, audio, or video).'}
      </div>}

      {referenceLibrary && <CatalogReferenceLibrary {...referenceLibrary} referenceMedia={list} readOnly={readOnly}
        missingMedia={missingMedia} onSetPortrait={onSetPortrait} onDetach={onDetach} />}

      {!referenceLibrary && portrait && (
        <div className="mb-3">
          <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Portrait</div>
          <CatalogMediaTile m={portrait} missing={missingMedia.has(portrait.mediaKey)} isPortrait
            onSetPortrait={onSetPortrait} onDetach={onDetach} armedDetach={armedDetach}
            onArmDetach={setArmedDetach} />
        </div>
      )}

      {!referenceLibrary && (tileMedia.length > 0 || pendingRenders.length > 0) && (
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
          {pendingRenders.map((pending) => (
            <div key={pending.jobId} data-testid="pending-media-tile" className="rounded-lg border border-port-accent/40 bg-port-bg shadow-sm overflow-hidden flex flex-col">
              <div className="relative aspect-square w-full bg-port-card/40 flex items-center justify-center overflow-hidden">
                <MediaJobThumb
                  jobId={pending.jobId}
                  label={pending.instruction || 'Refined reference'}
                  size="fill"
                  onFilename={(filename) => onPendingRenderComplete?.(pending.jobId, filename)}
                  onStatus={(status, err) => {
                    if (status === 'failed' || status === 'canceled') onPendingRenderFailed?.(pending.jobId, status, err);
                  }}
                />
              </div>
              <div className="p-2 border-t border-port-border text-xs flex items-center justify-between">
                <span className="truncate text-gray-300 font-medium">{pending.instruction || 'Edited reference'}</span>
                <span className="text-[10px] text-port-accent uppercase animate-pulse">Rendering</span>
              </div>
            </div>
          ))}
          {tileMedia.map((m) => (
            <CatalogMediaTile key={`${m.mediaKey}:${m.kind}`} m={m} missing={missingMedia.has(m.mediaKey)}
              onSetPortrait={onSetPortrait} onDetach={onDetach} armedDetach={armedDetach}
              onArmDetach={setArmedDetach} />
          ))}
        </div>
      )}

      {canonImages.length > 0 && (
        <div className="mt-3 space-y-2">
          <h3 className="text-xs font-semibold text-gray-300">Canon images</h3>
          <p className="text-xs text-gray-500">Existing canon references. Removing a reference keeps its image asset.</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
            {canonImages.map((filename) => (
              <figure key={filename} className="min-w-0 rounded border border-port-border overflow-hidden bg-port-bg">
                <CatalogImagePreview src={`/data/images/${encodeURIComponent(filename)}`} alt={`${genName} canon reference`}
                  fallbackSrc={`/data/image-refs/${encodeURIComponent(filename)}`}
                  className="w-full aspect-square object-contain" />
                <figcaption className="text-xs text-gray-400 p-2 break-words">
                  {filename === primaryImageRef ? 'Primary canon reference' : 'Canon reference'}
                  {!readOnly && onSetPortrait && <button type="button" onClick={() => onSetPortrait(filename)} className="block min-h-11 text-port-accent">Set as canonical image</button>}
                  {canonRemoval && <CanonReferenceRemoval key={filename} {...canonRemoval} filename={filename} />}
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      )}

      {!referenceLibrary && list.length === 0 && canonImages.length === 0 && (
        <p className="text-xs text-gray-500">No media yet. Attach a generated portrait, a mood/reference image, an uploaded file, or a recorded voice memo.</p>
      )}

      <GalleryImagePicker open={pickerOpen} allowUpload onClose={() => setPickerOpen(false)}
        onSelect={(item) => { if (item?.filename) onAttach(item.filename, 'reference'); }} />
    </section>
  );
}

// Source scraps + "From the same source" siblings (#7617). Each source scrap's
// TITLE is the click-through to `/catalog?scrap=<id>` — every other extraction
// from that piece, one click, one shareable link (selection lives in the URL
// per client/src/AGENTS.md). The scrap's id is a fallback label only for a
// scrap whose title didn't come through (e.g. hard-deleted; `scrapTitle` is
// null via the route's LEFT JOIN). A scrap with no OTHER live extractions
// renders no "From the same source" stub — an empty list is not useful chrome.
function SourcesPanel({ sources, evidence }) {
  const list = Array.isArray(sources) ? sources : [];
  const evidenceList = Array.isArray(evidence)
    ? evidence.filter((item) => typeof item === 'string' && item.trim())
    : typeof evidence === 'string' && evidence.trim()
    ? evidence.split('\n').map((s) => s.trim()).filter(Boolean)
    : [];
  return (
    <section className="bg-port-card border border-port-border rounded-lg p-4">
      <h2 className="text-sm font-semibold text-white mb-2">Source scraps</h2>
      {list.length === 0 ? (
        <p className="text-xs text-gray-500">Created manually — no source scrap.</p>
      ) : (
        <ul className="space-y-3">
          {list.map((s, i) => {
            const siblings = Array.isArray(s.siblings) ? s.siblings : [];
            return (
              <li key={s.scrapId || i} className="text-xs text-gray-300">
                <div className="flex items-center justify-between gap-2">
                  {s.scrapId ? (
                    <Link to={`/catalog?scrap=${encodeURIComponent(s.scrapId)}`}
                      state={{ scrapTitle: s.scrapTitle || undefined }}
                      className="truncate hover:text-port-accent hover:underline"
                      title={s.scrapTitle || s.scrapId}>
                      {s.scrapTitle || s.scrapId}
                    </Link>
                  ) : (
                    <span className="font-mono truncate">(unknown source)</span>
                  )}
                  {s.extractedAt && <span className="text-gray-500 whitespace-nowrap">{formatDateTime(s.extractedAt)}</span>}
                </div>
                {siblings.length > 0 && (
                  <div className="mt-1.5 pl-2 border-l border-port-border">
                    <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">From the same source</div>
                    <div className="flex flex-wrap gap-1.5">
                      {siblings.map((sib) => {
                        const badge = CATALOG_BADGE_BY_ID[sib.type] || 'bg-gray-500/20 text-gray-300 border-gray-500/40';
                        return (
                          <Link key={sib.id} to={ingredientPath(sib)}
                            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded border border-port-border bg-port-bg text-gray-200 hover:opacity-80">
                            <span className="truncate max-w-[12rem]">{sib.name || sib.id}</span>
                            <span className={`text-[9px] uppercase tracking-wider px-1 py-0.5 rounded border ${badge}`}>{sib.type}</span>
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {evidenceList.length > 0 && (
        <div className="mt-4 pt-3 border-t border-port-border">
          <h3 className="text-xs font-semibold text-gray-300 mb-2">Grounded evidence</h3>
          <ul className="space-y-1.5 text-xs text-gray-400">
            {evidenceList.map((item, idx) => (
              <li key={idx} className="italic pl-2 border-l border-port-border">
                “{item}”
              </li>
            ))}
          </ul>
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
  // Array editors and read-only/forward-compatible canon fields are not in
  // editorFields. Their changes must never make a revision look identical.
  const displayed = new Set(out.map((change) => change.key));
  const additional = [...new Set([...Object.keys(revPayload), ...Object.keys(curPayload)])]
    .filter((key) => !displayed.has(key) && !sameValue(revPayload[key], curPayload[key]));
  if (additional.length > 0) out.push({
    key: '__additional', label: 'Additional fields changed',
    summary: additional.map(humanizeIntegrityField).join(', '),
  });
  return out;
}

function RevisionsPanel({ revisions, loading, error, onLoad, current, fields, onRestore, readOnly = false, retainedSourceId }) {
  const [openId, setOpenId] = useState(null);
  const [restoring, setRestoring] = useState(null);
  const [pendingRestore, setPendingRestore] = useState(null);

  const list = Array.isArray(revisions) ? revisions : [];

  const handleRestore = async (id) => {
    setRestoring(id);
    try {
      if (await onRestore(id)) setPendingRestore(null);
    } finally {
      setRestoring(null);
    }
  };

  return (
    <section className="bg-port-card border border-port-border rounded-lg p-4">
      <h2 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
        <History size={15} className="text-port-accent" aria-hidden="true" /> Revision history
        {list.length > 0 && <span className="text-xs text-gray-500 font-normal">({list.length})</span>}
      </h2>
      {error && <p role="alert" className="text-xs text-port-error">{error} <button type="button" onClick={onLoad} disabled={loading} className="underline">Retry history</button></p>}
      {loading && revisions !== null && <p role="status" className="text-xs text-gray-400">Refreshing history…</p>}
      {revisions === null ? <button type="button" onClick={onLoad} disabled={loading} className="min-h-[44px] px-3 py-2 text-xs text-port-accent border border-port-border rounded">{loading ? 'Loading history…' : 'Load revision history'}</button> : list.length === 0 ? (
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
                  {!isLatest && !readOnly && !(retainedSourceId && rev.ingredientId === retainedSourceId) && (
                    pendingRestore === rev.id ? (
                      <ConfirmButtonPair
                        prompt="Replace current form?"
                        confirmText="Restore"
                        confirmIcon={RotateCcw}
                        tone="warning"
                        busy={restoring === rev.id}
                        busyText="Restoring"
                        onConfirm={() => handleRestore(rev.id)}
                        onCancel={() => setPendingRestore(null)}
                        ariaLabel={`Confirm restore of ${rev.name || 'revision'}`}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => setPendingRestore(rev.id)}
                        disabled={restoring === rev.id}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] border border-port-border text-gray-400 hover:text-white disabled:opacity-50"
                        title="Restore this revision"
                      >
                        <RotateCcw size={11} aria-hidden="true" /> Restore
                      </button>
                    )
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
                            {d.summary ? <dd className="text-gray-300 break-words">{d.summary}</dd> : <dd className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                              <span className="px-1.5 py-0.5 rounded bg-port-error/10 text-port-error/90 break-words">
                                {d.from || <em className="text-gray-600">empty</em>}
                              </span>
                              <span className="px-1.5 py-0.5 rounded bg-port-success/10 text-port-success/90 break-words">
                                {d.to || <em className="text-gray-600">empty</em>}
                              </span>
                            </dd>}
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
