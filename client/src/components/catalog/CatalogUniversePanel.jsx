import { useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Copy, Globe, Loader2 } from 'lucide-react';
import { getCatalogUniverseContext, setCatalogUniverseOwner, forkCatalogIngredient, linkCatalogIngredient, unlinkCatalogIngredient } from '../../services/apiCatalog';
import { listUniverseNames } from '../../services/apiUniverseBuilder';
import socket from '../../services/socket';
import { ingredientPath } from '../../lib/creativeLibraries';
import { threadRefUrl } from '../../lib/threadRefKinds';
import ThreadRefChip from '../brain/ThreadRefChip';
import toast from '../ui/Toast';
import { uuidv4 } from '../../lib/uuid';
import useMounted from '../../hooks/useMounted';

const roleLabel = (role = '') => ({ owner: 'Owning universe', 'canon-character': 'Character canon', 'canon-place': 'Environment canon',
  'canon-object': 'Object canon', cast: 'Cast', set: 'Set', prop: 'Prop', reference: 'Reference', mentioned: 'Mentioned' }[role] || role.replaceAll('-', ' '));

export default function CatalogUniversePanel({ ingredient, context, onContextChange, readOnly = false, forkBlocked = false, unsaved = false }) {
  const fieldId = useId();
  const navigate = useNavigate();
  const mounted = useMounted();
  const contextSequence = useRef(0);
  const applyContext = (updated) => { contextSequence.current += 1; onContextChange(updated); };
  const [open, setOpen] = useState(false);
  const [universes, setUniverses] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [target, setTarget] = useState('');
  const [forkName, setForkName] = useState(ingredient.name);
  const [copyImages, setCopyImages] = useState(false);
  const [busy, setBusy] = useState(false);
  const operation = useRef(null);
  useEffect(() => {
    if (!open) return;
    let active = true;
    listUniverseNames({ silent: true }).then((data) => {
      if (!Array.isArray(data)) throw new Error('Invalid universe names response');
      if (active) { setUniverses(data); setLoadError(false); }
    }).catch(() => { if (active) setLoadError(true); });
    return () => { active = false; };
  }, [open]);
  useEffect(() => {
    let active = true;
    const refresh = (event) => {
      if (event && event.ingredientId !== ingredient.id) return;
      const sequence = ++contextSequence.current;
      getCatalogUniverseContext(ingredient.id, { silent: true }).then((data) => { if (active && sequence === contextSequence.current) onContextChange(data); })
        .catch(() => { if (active) toast.error('Unable to refresh universe ownership. Reload before changing it.'); });
    };
    socket.on('catalog:primitive-changed', refresh);
    socket.on('connect', refresh);
    return () => { active = false; socket.off('catalog:primitive-changed', refresh); socket.off('connect', refresh); };
  }, [ingredient.id, onContextChange]);

  const owner = context?.owner;
  const own = async () => {
    if (readOnly || busy || unsaved || !target) return;
    setBusy(true);
    const result = await setCatalogUniverseOwner(ingredient.id, target, { silent: true })
      .catch((err) => { toast.error(err.message || 'Could not set owning universe'); return null; });
    if (!mounted.current) return;
    setBusy(false);
    if (result) { applyContext(result); setTarget(''); setOpen(false); toast.success('Owning universe set'); }
  };
  const fork = async () => {
    if (forkBlocked || busy || unsaved || !target || !forkName.trim()) return;
    const submission = JSON.stringify({ universeId: target, name: forkName.trim(), copyImages });
    if (operation.current?.submission !== submission) operation.current = { submission, key: uuidv4() };
    setBusy(true);
    const result = await forkCatalogIngredient(ingredient.id, { universeId: target, name: forkName.trim(), copyImages, operationKey: operation.current.key }, { silent: true })
      .catch((err) => { toast.error(err.message || 'Could not create fork'); return null; });
    if (!mounted.current) return;
    setBusy(false);
    if (result) navigate(ingredientPath(result));
  };
  const addToCanon = async () => {
    if (!owner || busy || unsaved) return;
    setBusy(true);
    const role = ['character', 'place', 'object'].includes(ingredient.type) ? `canon-${ingredient.type}` : 'reference';
    const result = await linkCatalogIngredient(ingredient.id, { refKind: 'universe', refId: owner.refId, role }, { silent: true })
      .catch((err) => { toast.error(err.message || 'Could not add primitive to universe'); return null; });
    if (result) {
      const updated = await getCatalogUniverseContext(ingredient.id, { silent: true }).catch(() => null);
      if (updated && mounted.current) applyContext(updated);
    }
    if (mounted.current) setBusy(false);
  };
  const removeUse = async (ref) => {
    if (busy || unsaved || ref.derived || ref.retained) return;
    setBusy(true);
    const ok = await unlinkCatalogIngredient(ingredient.id, { refKind: ref.refKind, refId: ref.refId, role: ref.role }, { silent: true })
      .then(() => true).catch((error) => { toast.error(error.message || 'Could not remove membership'); return false; });
    if (ok) {
      const updated = await getCatalogUniverseContext(ingredient.id, { silent: true }).catch(() => null);
      if (updated && mounted.current) applyContext(updated);
    }
    if (mounted.current) setBusy(false);
  };
  const refs = (context?.refs || []).filter((ref) => ref.role !== 'owner');
  return (
    <section aria-label="Universe ownership and usage" className="rounded-lg border border-port-border bg-port-card p-3 space-y-3 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 text-sm">
          <span className="inline-flex items-center gap-1.5 font-semibold text-white"><Globe size={15} /> Owning universe &amp; style</span>
          {owner ? <Link to={threadRefUrl('universe', owner.refId)} className="ml-2 text-port-accent hover:underline break-words">{owner.refName || owner.refId}</Link>
            : <span className="ml-2 text-port-warning">{context?.status === 'conflict' ? 'Conflicting owners — review required' : 'Ownership needs review'}</span>}
        </div>
        <button type="button" onClick={() => setOpen((value) => !value)} className="text-xs text-port-accent hover:underline">{open ? 'Close' : owner || readOnly ? 'Fork into another universe…' : 'Resolve ownership / fork…'}</button>
      </div>
      {!owner && <p className="text-xs text-gray-400">Existing references are preserved. Select an owning universe explicitly to establish story and style context.</p>}
      {owner && !refs.some((ref) => ref.refKind === 'universe' && ref.refId === owner.refId) && !readOnly && <button type="button"
        onClick={addToCanon} disabled={busy || unsaved} className="text-xs text-port-accent hover:underline disabled:opacity-40">Add to owning universe</button>}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-gray-400">Used in</span>
        {refs.length === 0 && <span className="text-gray-500">No linked containers</span>}
        {refs.map((ref, index) => <ThreadRefChip key={`${ref.refKind}:${ref.refId}:${ref.role}:${index}`} kind={ref.refKind} id={ref.refId}
          label={`${ref.refName || ref.refId} · ${roleLabel(ref.role)}`} resolved={ref.resolved} reason={ref.reason}
          url={ref.resolved === false ? null : threadRefUrl(ref.refKind, ref.refId)} showKind
          onRemove={!readOnly && !busy && !unsaved && !ref.derived && !ref.retained && ref.role !== 'retained-owner' ? () => removeUse(ref) : null} />)}
        {refs.some((ref) => ref.derived) && <span className="text-gray-500">Story mentions are inferred; FableLoom and voice links use exact canon IDs.</span>}
      </div>
      {open && <div className="border-t border-port-border pt-3 space-y-3">
        {forkBlocked && <p className="text-xs text-port-warning">Wait for the shared identity transition to complete before creating a fork.</p>}
        {unsaved && <p className="text-xs text-port-warning">Save your edits before changing ownership or creating a fork.</p>}
        {loadError ? <p role="alert" className="text-sm text-port-error">Could not load universes. Close and reopen to retry.</p> : universes === null ? <p className="text-xs text-gray-400">Loading universes…</p> : <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-2xl">
            <div><label htmlFor={`${fieldId}-universe`} className="block text-xs text-gray-400 mb-1">Destination universe</label>
              <select id={`${fieldId}-universe`} value={target} onChange={(event) => setTarget(event.target.value)} disabled={busy}
                className="w-full rounded border border-port-border bg-port-bg px-2 py-2 text-sm text-white">
                <option value="">Choose a universe…</option>
                {universes.filter((universe) => universe.id !== owner?.refId).map((universe) => <option key={universe.id} value={universe.id}>{universe.name}</option>)}
              </select></div>
            <div><label htmlFor={`${fieldId}-name`} className="block text-xs text-gray-400 mb-1">Fork name</label>
              <input id={`${fieldId}-name`} value={forkName} maxLength={200} onChange={(event) => setForkName(event.target.value)} disabled={busy}
                className="w-full rounded border border-port-border bg-port-bg px-2 py-2 text-sm text-white" /></div>
          </div>
          <label htmlFor={`${fieldId}-images`} className="flex items-center gap-2 text-xs text-gray-300">
            <input id={`${fieldId}-images`} type="checkbox" checked={copyImages} onChange={(event) => setCopyImages(event.target.checked)} disabled={busy} />
            Reuse image files as independent references on the fork
          </label>
          <p className="text-xs text-gray-500">A fork gets a new identity and provenance. Production uses, character links, voice bindings and approvals stay with the original. Image files stay in the library when a reference is removed.</p>
          <div className="flex flex-wrap gap-2">
            {!owner && !readOnly && <button type="button" disabled={busy || unsaved || !target} onClick={own} className="px-3 py-2 text-xs rounded border border-port-accent text-port-accent disabled:opacity-40">Set owning universe</button>}
            <button type="button" disabled={forkBlocked || busy || unsaved || !target || !forkName.trim()} onClick={fork} className="inline-flex items-center gap-1.5 px-3 py-2 text-xs rounded bg-port-accent text-white disabled:opacity-40">
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Copy size={13} />} Create fork
            </button>
          </div>
        </>}
      </div>}
    </section>
  );
}
