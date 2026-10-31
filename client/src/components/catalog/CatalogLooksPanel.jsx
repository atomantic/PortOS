import { useCallback, useState } from 'react';
import { ImagePlus, Loader2, Pencil, Pin, Plus, Shirt, Sparkles, Trash2, Undo2 } from 'lucide-react';
import toast from '../ui/Toast';
import ConfirmButtonPair from '../ui/ConfirmButtonPair.jsx';
import MediaJobThumb from '../pipeline/MediaJobThumb';
import ModelInputPreview from '../media/ModelInputPreview';
import UniverseMoodBoardPicker, { useStyleSourceLists, BOARD_FOLLOW_UNIVERSE, BOARD_NONE } from '../media/UniverseMoodBoardPicker';
import CatalogMediaTile from './CatalogMediaTile';
import useMounted from '../../hooks/useMounted';
import { useModelInputPreview } from '../../hooks/useModelInputPreview';
import { LOOK_ROLE_PREFIX, lookIdOf, isGoodReference } from '../../lib/creativeLibraries';
import { uuidv4 } from '../../lib/uuid';
import { previewCatalogSheet, renderCatalogSheet } from '../../services/apiCatalog';

// Mirrors BIBLE_LIMITS.WARDROBE_NAME_MAX / WARDROBE_DESCRIPTION_MAX.
const NAME_MAX = 120;
const DESCRIPTION_MAX = 800;

const inputClass = 'w-full px-2 py-2 bg-port-bg border border-port-border rounded text-sm text-white focus:outline-none focus:border-port-accent';
const smallButton = 'inline-flex items-center gap-1.5 min-h-[36px] px-2.5 py-1.5 rounded border border-port-border text-xs text-gray-300 hover:text-white hover:border-port-accent disabled:opacity-50 disabled:cursor-not-allowed';

function LookForm({ formId, initial, busy, onSubmit, onCancel }) {
  const [name, setName] = useState(initial?.name || '');
  const [description, setDescription] = useState(initial?.description || '');
  const submit = (e) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    onSubmit({ name: name.trim(), description });
  };
  return (
    <form onSubmit={submit} className="space-y-2 rounded border border-port-border bg-port-bg/40 p-3">
      <div>
        <label htmlFor={`${formId}-name`} className="block text-xs uppercase tracking-wider text-gray-500 mb-1">Look name</label>
        <input id={`${formId}-name`} type="text" value={name} maxLength={NAME_MAX} onChange={(e) => setName(e.target.value)}
          placeholder="Travel coat" className={inputClass} />
      </div>
      <div>
        <label htmlFor={`${formId}-description`} className="block text-xs uppercase tracking-wider text-gray-500 mb-1">Outfit description</label>
        <textarea id={`${formId}-description`} value={description} maxLength={DESCRIPTION_MAX} rows={3}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Long grey wool coat, red scarf, scuffed boots" className={inputClass} />
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <button type="submit" disabled={busy || !name.trim()}
          className="inline-flex items-center gap-1.5 min-h-[36px] px-3 py-1.5 rounded bg-port-accent hover:bg-port-accent/90 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium">
          {busy && <Loader2 size={12} className="animate-spin" aria-hidden="true" />} Save look
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className="px-3 py-1.5 text-xs text-gray-400 hover:text-white">Cancel</button>
      </div>
    </form>
  );
}

// The server's preview of exactly what this look's render sends (prompt plus
// labeled style/negative additions), then Render. Mounted only while open so
// the preview is fetched on demand.
function LookGenerate({ ingredientId, wardrobe, initialUniverseId, blockedReason, savedStamp, onLookFile, onClose }) {
  const mountedRef = useMounted();
  const [starting, setStarting] = useState(false);
  const [pending, setPending] = useState(null); // { jobId, role }
  const lists = useStyleSourceLists();
  const [universeId, setUniverseId] = useState(initialUniverseId || '');
  const [moodBoardChoice, setMoodBoardChoice] = useState(BOARD_FOLLOW_UNIVERSE);
  const [visualDirection, setVisualDirection] = useState({ style: '', camera: '', lighting: '', environment: '' });
  const body = {
    variant: 'look', wardrobeId: wardrobe.id, universeId,
    ...(moodBoardChoice !== BOARD_FOLLOW_UNIVERSE ? { moodBoardId: moodBoardChoice === BOARD_NONE ? '' : moodBoardChoice } : {}),
    visualDirection,
  };
  const previewBody = { ...body, savedStamp };
  const requestKey = JSON.stringify(previewBody);
  const fetchPreview = useCallback(({ savedStamp: stamp, ...optionsBody }, options) =>
    previewCatalogSheet(ingredientId, optionsBody, options).then((r) => r?.preview
      ? { ...r.preview, requestKey: JSON.stringify({ ...optionsBody, savedStamp: stamp }) } : null), [ingredientId]);
  const loadedPreview = useModelInputPreview(fetchPreview, previewBody);
  // Only a response for the current direction may enable generation.
  const current = loadedPreview.preview?.requestKey === requestKey;
  const preview = current ? loadedPreview : { preview: null, error: loadedPreview.error };
  const direction = preview.preview?.visualDirection;
  const renderBlocked = blockedReason || preview.error || (!current ? 'Updating visual direction preview…'
    : !direction?.ready ? `Define before rendering: ${direction?.missing?.join(', ') || 'visual direction'}` : null);

  const role = pending?.role;
  const handleFilename = useCallback((filename) => {
    if (!filename) return;
    setPending(null);
    onLookFile?.(filename, role);
  }, [role, onLookFile]);
  const handleStatus = useCallback((status) => {
    if (status !== 'failed' && status !== 'canceled') return;
    setPending(null);
    if (status === 'failed') toast.error('Look render failed');
  }, []);

  const handleRender = async () => {
    if (renderBlocked || starting || pending) return;
    setStarting(true);
    const queued = await renderCatalogSheet(ingredientId, body, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Look render failed'); return null; });
    if (!mountedRef.current) return;
    setStarting(false);
    if (!queued?.jobId) {
      if (queued) toast.error('Look render returned no job');
      return;
    }
    setPending({ jobId: queued.jobId, role: queued.role || `${LOOK_ROLE_PREFIX}${wardrobe.id}` });
    toast.success(`Rendering ${wardrobe.name}…`);
  };

  const busy = starting || !!pending;
  return (
    <div className="space-y-2 rounded border border-port-border bg-port-bg/40 p-3">
      <fieldset disabled={busy} className="space-y-3">
        <legend className="text-sm font-medium text-white">Look visual direction</legend>
        <p className="text-xs text-gray-400">Choose the world this look belongs to, then define its photography. These choices apply to this render. No illustration or animation style is assumed.</p>
        <UniverseMoodBoardPicker lists={lists} universeId={universeId} moodBoardChoice={moodBoardChoice}
          onUniverseChange={setUniverseId} onBoardChoiceChange={setMoodBoardChoice}
          idPrefix={`look-${wardrobe.id}-style`} labelClass="block text-xs text-gray-400 mb-1" inputClass={inputClass} />
        {!universeId && <p className="text-xs text-port-warning">No universe selected. Choose a mood board or describe an overall style below.</p>}
        {direction?.moodBoard && <p className="text-xs text-gray-400">Mood board: {direction.moodBoard.name}{!direction.moodBoard.hasStyle && ' — no composed style yet. Compose its style on the board or enter an overall style below.'}</p>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[
            ['style', 'Overall style / medium', 'Optional with a defined source style. Otherwise specify photography, illustration or another deliberate medium.'],
            ['camera', 'Camera', 'Lens, framing, perspective and film or camera treatment.'],
            ['lighting', 'Lighting', 'Light sources, softness, contrast, color and time of day.'],
            ['environment', 'Environment', 'The world, era and backdrop — including a plain backdrop if intended.'],
          ].map(([key, label, placeholder]) => (
            <div key={key}>
              <label htmlFor={`look-${wardrobe.id}-${key}`} className="block text-xs text-gray-400 mb-1">{label}</label>
              <textarea id={`look-${wardrobe.id}-${key}`} value={visualDirection[key]} rows={2} maxLength={1200}
                placeholder={placeholder} className={inputClass}
                onChange={(e) => setVisualDirection((prev) => ({ ...prev, [key]: e.target.value }))} />
            </div>
          ))}
        </div>
      </fieldset>
      <ModelInputPreview preview={preview} prompt="" />
      {renderBlocked && <p className="text-xs text-port-warning" role="status">{renderBlocked}</p>}
      <div className="flex items-center gap-2 flex-wrap">
        <button type="button" onClick={handleRender} disabled={busy || !!renderBlocked} title={renderBlocked || undefined}
          className="inline-flex items-center gap-1.5 min-h-[36px] px-3 py-1.5 rounded bg-port-accent hover:bg-port-accent/90 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium">
          {busy ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Sparkles size={12} aria-hidden="true" />}
          {pending ? 'Rendering…' : 'Render look'}
        </button>
        {pending && (
          <MediaJobThumb jobId={pending.jobId} label={`${wardrobe.name} look`} size="xs"
            onFilename={handleFilename} onStatus={handleStatus} />
        )}
        {!busy && <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs text-gray-400 hover:text-white">Close</button>}
      </div>
    </div>
  );
}

function LookCard({
  ingredientId, wardrobe, initialUniverseId, images, candidates, missingMedia, editLocked, savingList,
  blockedReason, savedStamp, onSave, onDelete, onSetRole, onDetach, onLookFile,
}) {
  const [mode, setMode] = useState(null); // 'edit' | 'generate' | 'attach' | 'delete'
  const [armedDetach, setArmedDetach] = useState(null);
  const [busyKey, setBusyKey] = useState(null);
  const toggle = (next) => setMode((cur) => (cur === next ? null : next));
  const role = `${LOOK_ROLE_PREFIX}${wardrobe.id}`;
  const candidateList = Array.isArray(candidates) ? candidates : [];
  const goodCandidates = candidateList.filter(isGoodReference);

  const setRole = async (m, nextRole, message) => {
    if (busyKey || editLocked || !onSetRole || m.readOnly) return;
    setBusyKey(m.mediaKey);
    const ok = await onSetRole(m, nextRole, message);
    setBusyKey(null);
    if (ok && nextRole) setMode(null);
  };
  const roleButton = (m, nextRole, label, message, Icon) => (
    <button type="button" onClick={() => setRole(m, nextRole, message)} disabled={!!busyKey || editLocked || !onSetRole || m.readOnly}
      title={label} aria-label={label}
      className="port-media-overlay-item p-2 sm:p-1 rounded hover:text-port-accent disabled:opacity-50">
      {busyKey === m.mediaKey
        ? <Loader2 size={12} className="animate-spin" aria-hidden="true" />
        : <Icon size={12} aria-hidden="true" />}
    </button>
  );

  return (
    <article className="rounded border border-port-border p-3 space-y-3" aria-label={`Look: ${wardrobe.name}`}>
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-white break-words">{wardrobe.name}</h3>
          {wardrobe.description && <p className="text-xs text-gray-400 whitespace-pre-wrap break-words mt-0.5">{wardrobe.description}</p>}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <button type="button" onClick={() => toggle('generate')} disabled={editLocked} className={smallButton} aria-expanded={mode === 'generate'}>
            <Sparkles size={12} aria-hidden="true" /> Generate
          </button>
          <button type="button" onClick={() => toggle('attach')} disabled={editLocked} className={smallButton} aria-expanded={mode === 'attach'}>
            <ImagePlus size={12} aria-hidden="true" /> Attach image
          </button>
          <button type="button" onClick={() => toggle('edit')} disabled={editLocked} className={smallButton}
            aria-label={`Edit ${wardrobe.name}`} title="Edit">
            <Pencil size={12} aria-hidden="true" />
          </button>
          <button type="button" onClick={() => toggle('delete')} disabled={editLocked}
            className={`pointer-coarse:min-h-11 pointer-coarse:min-w-11 ${smallButton} hover:text-port-error`} aria-label={`Delete ${wardrobe.name}`} title="Delete">
            <Trash2 size={12} aria-hidden="true" />
          </button>
        </div>
      </div>

      {mode === 'delete' && (
        <ConfirmButtonPair
          prompt={images.length ? 'Delete this look? Its images move to References.' : 'Delete this look?'}
          confirmText="Delete look" ariaLabel={`Confirm deleting ${wardrobe.name}`} busy={savingList || editLocked}
          onConfirm={async () => { if (await onDelete(wardrobe)) setMode(null); }}
          onCancel={() => setMode(null)} largeTouchTargets />
      )}
      {mode === 'edit' && (
        <LookForm formId={`look-${wardrobe.id}`} initial={wardrobe} busy={savingList || editLocked}
          onSubmit={async (fields) => { if (await onSave({ ...wardrobe, ...fields })) setMode(null); }}
          onCancel={() => setMode(null)} />
      )}
      {mode === 'generate' && (
        <LookGenerate ingredientId={ingredientId} wardrobe={wardrobe} blockedReason={blockedReason}
          initialUniverseId={initialUniverseId} savedStamp={savedStamp} onLookFile={onLookFile} onClose={() => setMode(null)} />
      )}
      {mode === 'attach' && (
        <div className="rounded border border-port-border bg-port-bg/40 p-3">
          <h4 className="text-xs uppercase tracking-wider text-gray-500 mb-2">Use a reference image for this look</h4>
          {goodCandidates.length > 0 ? (
            <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2">
              {goodCandidates.map((m) => (
                <CatalogMediaTile key={`${m.mediaKey}:${m.kind}`} m={m} missing={missingMedia?.has?.(m.mediaKey)}
                  extraActions={roleButton(m, role, `Use for ${wardrobe.name}`, `Added to ${wardrobe.name}`, Pin)} />
              ))}
            </div>
          ) : candidateList.length > 0 ? (
            <p className="text-xs text-gray-500">No reference images marked &quot;good&quot; to use. Mark some as good on the References tab.</p>
          ) : (
            <p className="text-xs text-gray-500">No reference images to use. Attach or generate some on the References tab.</p>
          )}
        </div>
      )}

      {images.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {images.map((m) => (
            <CatalogMediaTile key={`${m.mediaKey}:${m.kind}`} m={m} label={wardrobe.name} contain
              missing={missingMedia?.has?.(m.mediaKey)} onDetach={onDetach}
              armedDetach={armedDetach} onArmDetach={setArmedDetach}
              extraActions={roleButton(m, null, 'Move to References', 'Moved to References', Undo2)} />
          ))}
        </div>
      ) : (
        <p className="text-xs text-gray-500">No images for this look yet.</p>
      )}
    </article>
  );
}

// The Looks tab for a character: its `payload.wardrobes`, each with the images
// whose catalog media role is `look:<wardrobe id>`. Looks are saved straight to
// the record (`onSaveWardrobes(next)` resolves true on success) so a render can
// use them at once; renders read the SAVED record, so Render is gated by
// `blockedReason` while the profile has unsaved edits. Ids are stamped here in
// the `wd-<uuid>` shape the canon sanitizer uses, because a catalog save stores
// the payload as sent. Deleting a look leaves its images attached; they then
// show on References.
export default function CatalogLooksPanel({
  ingredientId, initialUniverseId, wardrobes, lookMedia, candidates, missingMedia, editLocked = false,
  blockedReason = null, savedStamp = null, onSaveWardrobes, onSetRole, onDetach, onLookFile,
}) {
  const [adding, setAdding] = useState(false);
  const [savingList, setSavingList] = useState(false);
  const list = Array.isArray(wardrobes) ? wardrobes.filter((w) => w && typeof w === 'object' && w.id) : [];
  const media = Array.isArray(lookMedia) ? lookMedia : [];
  const candidateList = Array.isArray(candidates) ? candidates : [];

  const save = async (next) => {
    if (editLocked) return false;
    setSavingList(true);
    const ok = await onSaveWardrobes(next);
    setSavingList(false);
    return ok;
  };
  const now = () => new Date().toISOString();
  const handleAdd = async ({ name, description }) => {
    const stamp = now();
    if (await save([...list, { id: `wd-${uuidv4()}`, name, description, createdAt: stamp, updatedAt: stamp }])) setAdding(false);
  };
  const handleUpdate = (updated) => save(list.map((w) => (w.id === updated.id ? { ...updated, updatedAt: now() } : w)));
  const handleDelete = (wardrobe) => save(list.filter((w) => w.id !== wardrobe.id));

  return (
    <section className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-sm font-semibold text-white flex items-center gap-1.5">
          <Shirt size={14} aria-hidden="true" /> Looks
        </h2>
        {!adding && (
          <button type="button" onClick={() => setAdding(true)} disabled={editLocked} className={smallButton}>
            <Plus size={12} aria-hidden="true" /> Add look
          </button>
        )}
      </div>
      {editLocked && <p className="text-xs text-gray-500" role="status">{blockedReason || 'Saving the profile — looks can be edited once it finishes.'}</p>}
      {adding && (
        <LookForm formId="look-new" busy={savingList || editLocked} onSubmit={handleAdd} onCancel={() => setAdding(false)} />
      )}
      {list.length === 0 && !adding && (
        <p className="text-xs text-gray-500">No looks yet. Add one to describe an outfit, then generate or attach its images.</p>
      )}
      {list.map((w) => (
        <LookCard key={w.id} ingredientId={ingredientId} wardrobe={w} initialUniverseId={initialUniverseId}
          images={media.filter((m) => lookIdOf(m) === w.id)} candidates={candidateList}
          missingMedia={missingMedia} editLocked={editLocked || savingList} savingList={savingList}
          blockedReason={blockedReason} savedStamp={savedStamp}
          onSave={handleUpdate} onDelete={handleDelete} onSetRole={onSetRole} onDetach={onDetach} onLookFile={onLookFile} />
      ))}
    </section>
  );
}
