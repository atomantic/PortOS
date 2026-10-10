import { useEffect, useRef, useState } from 'react';
import { ImagePlus, Trash2, Sparkles, Download } from 'lucide-react';
import useMounted from '../../hooks/useMounted.js';
import { isOutsideReference, MAX_CONDITIONING_REFERENCES } from '../../hooks/useMusicVideoSceneMedia.js';
import { getMoodBoard } from '../../services/apiMoodBoard.js';
import { getUniverse } from '../../services/apiUniverseBuilder.js';
import { uploadGalleryImage } from '../../services/apiSystem.js';
import { IMAGE_ACCEPT, readFileAsBase64, validateImageFile } from '../../utils/fileUpload.js';
import { moodBoardItemAnalysisSource } from '../../lib/moodBoardItemSrc.js';
import { MUSIC_VIDEO_MAX_REFERENCES, pullUniverseCanonReferences } from '../../lib/musicVideoUniverseRefs.js';
import { uuidv4 } from '../../lib/uuid.js';
import MoodBoardReferenceStrip from '../moodBoard/MoodBoardReferenceStrip.jsx';
import toast from '../ui/Toast';

const ROLES = [
  ['mood', 'Mood'], ['character', 'Character'], ['wardrobe', 'Wardrobe'],
  ['set', 'Set'], ['prop', 'Prop'], ['style', 'Style'],
];
// How the asset is meant to be used (#8980): a look reference, media that
// appears in the final video as-is, or motion-reference scaffolding only.
const USES = [['reference', 'Look reference'], ['final-visible', 'Final visible'], ['motion-reference', 'Motion reference only']];
const MAX_UPLOADS = 8;

const controlCls = 'min-w-0 max-w-full rounded border border-port-border bg-port-bg px-1.5 py-0.5 text-[11px] min-h-[44px] sm:min-h-0';
const fieldCls = `block w-full ${controlCls}`;
const actionCls = 'flex max-w-full items-center gap-1 rounded bg-port-border px-2 py-1 text-xs min-h-[44px] hover:bg-port-border/70 disabled:opacity-50 sm:min-h-0';
// Column count follows this panel. On Look, the preview dock leaves a narrow
// center column at xl, and a viewport 3-up grid clips the role, use and label.
const cardListCls = 'grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))] gap-2';
const cardCls = '@container/look-ref min-w-0 rounded border border-port-border';
const cardBodyCls = 'flex min-w-0 flex-col gap-2 p-1.5 @min-[16rem]:flex-row @min-[16rem]:items-start';
const thumbCls = 'h-20 w-full rounded bg-black object-cover @min-[16rem]:h-16 @min-[16rem]:w-16 @min-[16rem]:shrink-0';

const optionLabel = (options, value) => options.find(([id]) => id === value)?.[1] || '';

/**
 * The one list of look references for a Music Video project (#10223), in
 * Creative direction. Everything that tells the generators how the video
 * should look lives here:
 *
 *  - the linked mood board (pick one, or import its gallery images as rows);
 *  - the canon of the linked universe ("Pull from universe") and gallery picks
 *    ("Add reference") — `visualSpec.references`, each with a role, a use and a
 *    per-reference "Condition frames" toggle (autosaved through `onSaveSpec`);
 *  - project uploads — `styleReferences`, captioned style images that fill a
 *    model's spare reference slots after the identities (saved explicitly
 *    through `onSave`, and held pending so generation does not start on a
 *    half-edited set). Uploads do not invoke an AI provider.
 */
export default function LookReferencesPanel({ project, onSave, onSaveSpec, onAddReference, onPendingChange }) {
  const mounted = useMounted();
  const spec = project.visualSpec || {};
  const references = spec.references || [];
  const [uploads, setUploads] = useState(project.styleReferences || []);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [working, setWorking] = useState(false); // a board import / universe pull is reading
  const idFor = (suffix) => `mv-look-${project.id}-${suffix}`;
  const flagged = references.filter((r) => r.condition && !isOutsideReference(r)).length;
  const full = references.length >= MUSIC_VIDEO_MAX_REFERENCES;

  useEffect(() => {
    onPendingChange?.(dirty || busy);
    return () => onPendingChange?.(false);
  }, [dirty, busy, onPendingChange]);
  useEffect(() => {
    if (!dirty && !busy) setUploads(project.styleReferences || []);
  }, [project.styleReferences, dirty, busy]);

  // An async import must not clobber an edit made while it was reading: read the
  // base list through a ref that tracks every render, not the click-time closure.
  const referencesRef = useRef(references);
  referencesRef.current = references;
  const saveReferences = (next) => onSaveSpec({ references: next });
  const updateRef = (id, patch) => saveReferences(references.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const readThenAdd = (read, { from, empty, duplicate }) => {
    if (working) return;
    setWorking(true);
    read()
      .then(({ next, added, skipped }) => {
        if (added > 0) {
          saveReferences(next);
          toast.success(`Pulled ${added} reference${added === 1 ? '' : 's'} from ${from}${skipped ? ` (${skipped} skipped)` : ''}`);
        } else toast.error(skipped ? duplicate : empty);
      })
      .catch((err) => toast.error(err?.message || 'Could not read the source'))
      .finally(() => { if (mounted.current) setWorking(false); });
  };
  const pullFromUniverse = () => readThenAdd(
    () => getUniverse(project.concept.universeId, { silent: true }).then((universe) => pullUniverseCanonReferences(universe, referencesRef.current)),
    { from: 'the universe', empty: 'This universe has no canon images to pull yet', duplicate: 'Every canon image is already a reference' },
  );
  const importBoard = () => readThenAdd(async () => {
    const board = await getMoodBoard(spec.moodBoardId, { silent: true });
    const known = new Set(referencesRef.current.map((r) => r.imageId));
    const base = referencesRef.current;
    const fresh = [];
    let skipped = 0;
    for (const item of Array.isArray(board?.items) ? board.items : []) {
      const filename = moodBoardItemAnalysisSource(item)?.filename;
      if (!filename || item.type !== 'image') continue;
      if (known.has(filename) || base.length + fresh.length >= MUSIC_VIDEO_MAX_REFERENCES) { skipped += 1; continue; }
      known.add(filename);
      fresh.push({ id: `mvr-board-${uuidv4()}`, imageId: filename, role: 'mood', label: '', condition: false });
    }
    return { next: [...base, ...fresh], added: fresh.length, skipped };
  }, { from: 'the mood board', empty: 'This mood board has no gallery images to import', duplicate: 'Every mood board image is already a reference' });

  const changeUploads = (next) => { setUploads(next); setDirty(true); };
  const upload = async (files) => {
    if (busy || !files.length) return;
    if (uploads.length + files.length > MAX_UPLOADS) { toast.error('Choose at most eight style uploads'); return; }
    const error = files.map((file) => !IMAGE_ACCEPT.split(',').includes(file.type)
      ? 'Use PNG, JPEG or WebP style images' : validateImageFile(file)).find(Boolean);
    if (error) { toast.error(error); return; }
    setBusy(true);
    let next = [...uploads];
    try {
      for (const file of files) {
        const encoded = await readFileAsBase64(file);
        const { filename } = await uploadGalleryImage(encoded, { silent: true });
        if (!mounted.current) return;
        next = [...next, { imageId: filename, caption: '' }];
        changeUploads(next);
      }
    } catch (err) {
      toast.error(err?.message || 'Style upload failed');
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const saveUploads = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onSave({ styleReferences: uploads });
      if (mounted.current) setDirty(false);
    } catch (err) {
      toast.error(err?.message || 'Style uploads save failed');
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <section aria-label="Look references" className="rounded-lg border border-port-border bg-port-card p-3 space-y-2 min-w-0">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Look references</h3>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {spec.moodBoardId && (
            <button type="button" onClick={importBoard} disabled={working || full} className={actionCls}
              title="Add the linked mood board's gallery images as references">
              <Download size={13} /> Import board images
            </button>
          )}
          {project.concept?.universeId && (
            <button type="button" onClick={pullFromUniverse} disabled={working || full} className={actionCls}
              title="Add the linked universe's canon character/place/object images as references">
              <Sparkles size={13} /> {working ? 'Reading…' : 'Pull from universe'}
            </button>
          )}
          <button type="button" onClick={onAddReference} disabled={full} className={actionCls}>
            <ImagePlus size={13} /> Add reference
          </button>
        </div>
      </div>
      <p className="text-xs text-port-text-muted">
        One list for the video&rsquo;s look: a mood board, gallery images and your own uploads. Identity references take priority; tick &ldquo;Condition frames&rdquo; to send an image to every reference-frame render, and models use as many style uploads as their remaining slots allow, or caption text when references are unsupported.
      </p>
      <MoodBoardReferenceStrip value={spec.moodBoardId || ''} onChange={(id) => onSaveSpec({ moodBoardId: id || null })} newBoardName={project.name} />

      {references.length === 0 && uploads.length === 0 && (
        <p className="text-[11px] text-port-text-muted">No look references yet. Import a mood board, add gallery images or upload style images below.</p>
      )}
      <ul className={cardListCls}>
        {references.map((ref) => {
          const roleLabel = optionLabel(ROLES, ref.role || 'mood');
          const useLabel = optionLabel(USES, ref.use || 'reference');
          return (
            <li key={ref.id} className={cardCls}>
              <div className={cardBodyCls}>
                <img src={`/data/images/${encodeURIComponent(ref.imageId)}`} alt="" loading="lazy" className={thumbCls} />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex min-w-0 items-center gap-1">
                    <label htmlFor={idFor(`role-${ref.id}`)} className="sr-only">Reference role</label>
                    {/* The wrapper, not the select, is the flex item. A native select
                        will not shrink below its option text, which pushed Remove
                        outside the card. */}
                    <div className="min-w-0 flex-1">
                      <select id={idFor(`role-${ref.id}`)} value={ref.role || 'mood'} title={roleLabel} onChange={(e) => updateRef(ref.id, { role: e.target.value })} className={fieldCls}>
                        {ROLES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </select>
                    </div>
                    <button type="button" onClick={() => saveReferences(references.filter((r) => r.id !== ref.id))}
                      aria-label="Remove reference" title="Remove reference"
                      className="inline-flex min-h-[32px] min-w-[32px] shrink-0 items-center justify-center text-port-error">
                      <Trash2 size={12} />
                    </button>
                  </div>
                  <label htmlFor={idFor(`use-${ref.id}`)} className="sr-only">Reference use</label>
                  <select id={idFor(`use-${ref.id}`)} value={ref.use || 'reference'} title={useLabel} onChange={(e) => updateRef(ref.id, { use: e.target.value })} className={fieldCls}>
                    {USES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                  <label htmlFor={idFor(`label-${ref.id}`)} className="sr-only">Reference label</label>
                  <input id={idFor(`label-${ref.id}`)} defaultValue={ref.label || ''} maxLength={120} placeholder="Label (e.g. lead singer)"
                    title={ref.label || 'Label (e.g. lead singer)'}
                    onBlur={(e) => { if (e.target.value !== (ref.label || '')) updateRef(ref.id, { label: e.target.value }); }}
                    className={fieldCls} />
                  {isOutsideReference(ref) ? (
                    <p className="break-words text-[11px] text-port-text-muted">Mood board image: shapes the look as text, never sent to the generator</p>
                  ) : (
                    <label className="flex min-h-[44px] min-w-0 items-start gap-1.5 text-[11px] sm:min-h-0">
                      <input type="checkbox" className="mt-0.5 shrink-0" checked={!!ref.condition}
                        disabled={!ref.condition && flagged >= MAX_CONDITIONING_REFERENCES}
                        onChange={(e) => updateRef(ref.id, { condition: e.target.checked })} />
                      <span className="break-words">Condition frames</span>
                    </label>
                  )}
                </div>
              </div>
            </li>
          );
        })}
        {uploads.map((ref, index) => (
          <li key={ref.imageId} className={cardCls}>
            <div className={cardBodyCls}>
              <img src={`/data/images/${encodeURIComponent(ref.imageId)}`} alt={`Style upload ${index + 1}`} className={thumbCls} />
              <div className="min-w-0 flex-1 space-y-1">
                <span className="block text-[11px] text-port-text-muted">Style upload</span>
                <label htmlFor={idFor(`caption-${index}`)} className="sr-only">Style caption {index + 1}</label>
                <textarea id={idFor(`caption-${index}`)} value={ref.caption || ''} maxLength={500} rows={2}
                  placeholder="Palette, lighting, lens, grain"
                  onChange={(e) => changeUploads(uploads.map((item, i) => (i === index ? { ...item, caption: e.target.value } : item)))}
                  className="block w-full min-w-0 max-w-full rounded border border-port-border bg-port-bg p-1 text-sm" />
                <button type="button" aria-label={`Remove style upload ${index + 1}`} onClick={() => changeUploads(uploads.filter((_, i) => i !== index))}
                  className="min-h-[44px] text-xs text-port-error sm:min-h-0">Remove</button>
              </div>
            </div>
          </li>
        ))}
      </ul>
      {flagged > 0 && (
        <p className="text-[11px] text-port-text-muted">
          Conditioning needs an image backend that accepts reference images (local FLUX.2 or Qwen Image 2.1, or a cloud image CLI); others refuse the render and say so. At most {MAX_CONDITIONING_REFERENCES} per frame.
        </p>
      )}
      <fieldset disabled={busy} className="space-y-2">
        <label htmlFor={idFor('upload')} className="block text-xs">Upload style images
          <input id={idFor('upload')} type="file" aria-label="Upload style images" accept={IMAGE_ACCEPT} multiple disabled={uploads.length >= MAX_UPLOADS || busy}
            onChange={(e) => { const files = Array.from(e.target.files || []); e.target.value = ''; upload(files); }}
            className="block w-full min-w-0 max-w-full text-sm min-h-[44px]" />
        </label>
        <button type="button" disabled={!dirty || busy} onClick={saveUploads} className="min-h-[44px] rounded bg-port-accent px-3 text-sm text-white disabled:opacity-50">{busy ? 'Saving…' : 'Save style uploads'}</button>
      </fieldset>
      {dirty && <p className="text-xs text-port-warning">Save the style uploads before starting generation.</p>}
    </section>
  );
}
