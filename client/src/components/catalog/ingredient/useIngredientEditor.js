// Load, draft, dirty, save, restore and delete state for one catalog
// ingredient visit, plus the shared-identity/primitive socket refresh that keeps
// the saved record current without discarding an unsaved draft.

import { useCallback, useEffect, useRef, useState } from 'react';
import toast from '../../ui/Toast';
import {
  getCatalogIngredientDetails,
  updateCatalogIngredient,
  deleteCatalogIngredient,
  linkCatalogIngredientRelation,
  unlinkCatalogIngredientRelation,
  listCatalogIngredientRevisions,
  restoreCatalogIngredientRevision,
} from '../../../services/apiCatalog';
import socket from '../../../services/socket';
import useMounted from '../../../hooks/useMounted';
import useUnsavedChangesGuard from '../../../hooks/useUnsavedChangesGuard';
import { resolveDetailTab } from '../../../lib/creativeLibraries';
import { changedMusicVideoDescriptionOverLimit, MUSIC_VIDEO_SUBJECT_DESCRIPTION_MAX } from '../../../../../server/lib/musicVideo/musicVideoSubjectLimits.js';
import { ingredientPayload, sameValue } from './ingredientDraft';

export default function useIngredientEditor({ id, tabParam, library, backPath, navigate }) {
  const detailView = library ? 'profile' : undefined;
  const mountedRef = useMounted();
  const activeVisitRef = useRef({ id, generation: 0 });
  if (activeVisitRef.current.id !== id) {
    activeVisitRef.current = { id, generation: activeVisitRef.current.generation + 1 };
  }
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
  const mediaSequence = useRef(0);
  const mediaReadyRef = useRef(false);
  mediaReadyRef.current = mediaReady;
  const refreshMediaRef = useRef(null);
  const [missingMedia, setMissingMedia] = useState(new Set());
  const videoDescriptionLimit = record?.refs?.some((ref) => ref.refKind === 'music-video') ? MUSIC_VIDEO_SUBJECT_DESCRIPTION_MAX : null;
  const overlongVideoDescription = videoDescriptionLimit ? changedMusicVideoDescriptionOverLimit(record.type, record.payload, payload) : null;
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
  const loadLatest = useCallback(() => {
    if (!externalDetails) return;
    applyDetails(externalDetails);
    setExternalDetails(null);
  }, [externalDetails, applyDetails]);

  // Re-read the record after a change made outside the draft. A dirty draft is
  // kept and the fresh details wait behind the external-change notice.
  const reloadDetails = useCallback(({ withMedia = false } = {}) => (
    getCatalogIngredientDetails(id, { silent: true, view: detailView }).then(details => {
      if (!mountedRef.current || details?.ingredient?.id !== editSnapshot.current.id) return;
      if (editSnapshot.current.dirty) setExternalDetails(details); else applyDetails(details);
      if (withMedia) refreshMediaRef.current?.();
      refreshRevisions();
    })
  ), [id, detailView, mountedRef, applyDetails, refreshRevisions]);

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

  const handleSave = async () => {
    if (!record || identityReadOnly || unlocking || characterActionBusy) return;
    if (overlongVideoDescription) { toast.error('Shorten the description for linked music videos before saving.'); return; }
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

  const handleDelete = async () => {
    if (!record || identityReadOnly) return;
    const ok = await deleteCatalogIngredient(record.id, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error(err?.message || 'Delete failed'); return false; });
    if (ok && mountedRef.current) {
      toast.success('Deleted');
      navigate(backPath);
    }
  };

  const updatePayload = useCallback((key, value) => {
    setPayload((prev) => ({ ...prev, [key]: value }));
  }, []);
  const patchPayload = useCallback((patch) => {
    setPayload((previous) => ({ ...previous, ...patch }));
  }, []);

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

  return {
    detailView, mountedRef, activeVisitRef, editSnapshot,
    record, setRecord, loading, identityReadOnly, identityReason,
    draft: { name, setName, tags, setTags, payload, setPayload, updatePayload, patchPayload },
    isDirty, routeGuard, videoDescriptionLimit, overlongVideoDescription,
    saving, unlocking, setUnlocking, lookSaving, setLookSaving, greyboxBusy, setGreyboxBusy,
    characterActionBusy, setCharacterActionBusy, mergeBusy, setMergeBusy,
    reloadAfterMerge: () => setMergeVersion((version) => version + 1),
    relations, handleAddRelation, handleRemoveRelation,
    revisions, revisionsLoading, revisionsError, refreshRevisions,
    media, setMedia, missingMedia, mediaReady, mediaLoading, mediaError, refreshMedia,
    externalDetails, setExternalDetails, loadLatest, applyDetails, reloadDetails,
    applyLock, applyUniverseContext,
    handleSave, handleRestore, handleDelete,
  };
}
