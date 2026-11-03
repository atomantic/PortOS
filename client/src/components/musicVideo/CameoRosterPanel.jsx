import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ImagePlus, Trash2, X } from 'lucide-react';
import GalleryImagePicker from '../imageGen/GalleryImagePicker';
import StageSection from './StageSection.jsx';
import ResearchSeedForm from './ResearchSeedForm.jsx';
import toast from '../ui/Toast';
import { formatCount } from '../../utils/formatters.js';
import { MUSIC_VIDEO_CAMEO_MAX_REFERENCES, MUSIC_VIDEO_CAMEO_MAX_VARIANTS, musicVideoCameoCoverage } from '../../../../server/lib/musicVideoCameos.js';
import { parseCameoLines } from '../../lib/musicVideoCameos.js';
import {
  addMusicVideoCameoReferences, addMusicVideoCameoVariant, createMusicVideoCameos, deleteMusicVideoCameo,
  deleteMusicVideoCameoVariant, linkMusicVideoCameoShots, removeMusicVideoCameoReference, startMusicVideoCameoResearch, unlinkMusicVideoCameoShots,
  updateMusicVideoCameo, updateMusicVideoCameoVariant,
} from '../../services/apiMusicVideo.js';

const FIELD = 'w-full min-h-[44px] rounded border border-port-border bg-port-bg px-2 py-1 text-sm sm:min-h-[32px]';
const BUTTON = 'inline-flex min-h-[44px] items-center gap-1 rounded border border-port-border bg-port-bg px-2 text-xs hover:bg-port-border/40 disabled:opacity-50 sm:min-h-[32px]';
const NEED_LABELS = { research: 'research', references: 'photos', still: 'still', variant: 'variant still' };
const FILTERS = [
  { id: '', label: 'All' },
  { id: 'research', label: 'Needs research' },
  { id: 'references', label: 'Needs photos' },
  { id: 'still', label: 'Needs a still' },
  { id: 'unlinked', label: 'No shots' },
];
const imageSrc = (imageId) => `/data/images/${encodeURIComponent(imageId)}`;

/** The roster's one-line summary: how many cameos and what they still need. */
export function cameosSummary(coverage) {
  const { totals } = coverage;
  if (!totals.cameos) return 'No cameos yet';
  return [
    `${formatCount(totals.cameos)} ${totals.cameos === 1 ? 'cameo' : 'cameos'} · ${formatCount(totals.linkedShots)} linked shots`,
    totals.research ? `${formatCount(totals.research)} need research` : null,
    totals.still ? `${formatCount(totals.still)} need a still` : null,
  ].filter(Boolean).join(' · ');
}

function Thumb({ imageId, label, className = 'h-12 w-12' }) {
  return imageId
    ? <img src={imageSrc(imageId)} alt={label} className={`${className} shrink-0 rounded border border-port-border bg-black object-cover`} />
    : <span className={`${className} flex shrink-0 items-center justify-center rounded border border-dashed border-port-border text-[10px] text-port-text-muted`}>No still</span>;
}

function CameoEditor({ project, cameo, coverage, onApply, onClose, disabled }) {
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState(null);
  const [variantLabel, setVariantLabel] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const id = (name) => `mv-cameo-${cameo.cameoId}-${name}`;
  const run = (call, failure) => {
    setBusy(true);
    return call().then(onApply).catch((err) => toast.error(err?.message || failure)).finally(() => setBusy(false));
  };
  const save = (patch) => run(() => updateMusicVideoCameo(project.id, cameo.cameoId, patch, { silent: true }), 'Failed to save the cameo');
  const blurSave = (key, value) => { if ((cameo[key] || '') !== value.trim()) save({ [key]: value.trim() }); };
  const research = cameo.research || {};
  const scenes = (project.scenes || []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const shotName = (scene) => `Shot ${scenes.indexOf(scene) + 1}${scene.label ? ` · ${scene.label}` : ''}`;
  const linked = scenes.filter((s) => s.cameoId === cameo.cameoId);
  const unlinked = scenes.filter((s) => s.cameoId !== cameo.cameoId);
  const variantName = (variantId) => (cameo.variants || []).find((v) => v.variantId === variantId)?.label;
  const onPicked = (item) => {
    const imageId = item?.filename;
    if (!imageId || !picker) return;
    if (picker.kind === 'reference') {
      run(() => addMusicVideoCameoReferences(project.id, cameo.cameoId, [{ imageId, source: item.uploaded ? 'upload' : 'gallery' }], { silent: true }), 'Failed to add the photo');
    } else if (picker.kind === 'still') save({ stillImageId: imageId });
    else if (picker.kind === 'variant') {
      run(() => updateMusicVideoCameoVariant(project.id, cameo.cameoId, picker.variantId, { imageId }, { silent: true }), 'Failed to set the variant still');
    }
  };
  const need = coverage?.needs || [];

  return (
    <fieldset disabled={disabled || busy} className="min-w-0 space-y-3 rounded border border-port-border p-2">
      <legend className="sr-only">{cameo.name}</legend>
      <div className="flex items-start gap-2">
        <Thumb imageId={cameo.stillImageId} label={`${cameo.name} still`} className="h-20 w-20" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium">{cameo.name}</p>
          <p className="text-[11px] text-port-text-muted">
            {formatCount(linked.length)} {linked.length === 1 ? 'shot' : 'shots'}{need.length ? ` · needs ${need.map((n) => NEED_LABELS[n]).join(', ')}` : ' · ready'}
          </p>
          <div className="flex flex-wrap gap-1">
            <button type="button" className={BUTTON} onClick={() => setPicker({ kind: 'still' })}><ImagePlus size={12} aria-hidden="true" /> Pick still</button>
            {cameo.stillImageId && <button type="button" className={BUTTON} onClick={() => save({ stillImageId: null })}>Clear still</button>}
          </div>
        </div>
        <button type="button" onClick={onClose} aria-label="Close cameo" className={BUTTON}><X size={14} aria-hidden="true" /></button>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <label htmlFor={id('name')} className="text-[11px] text-port-text-muted">Name</label>
          <input key={`name-${cameo.name}`} id={id('name')} defaultValue={cameo.name} maxLength={120} className={FIELD}
            onBlur={(e) => { if (e.target.value.trim()) blurSave('name', e.target.value); else e.target.value = cameo.name; }} />
        </div>
        <div>
          <label htmlFor={id('label')} className="text-[11px] text-port-text-muted">On-screen label (empty = name)</label>
          <input key={`label-${cameo.label}`} id={id('label')} defaultValue={cameo.label || ''} maxLength={120} className={FIELD}
            onBlur={(e) => blurSave('label', e.target.value)} />
        </div>
      </div>
      <div>
        <label htmlFor={id('description')} className="text-[11px] text-port-text-muted">Description (for a breed, its ancestry)</label>
        <textarea key={`desc-${cameo.description}`} id={id('description')} rows={2} defaultValue={cameo.description || ''} maxLength={4000} className={FIELD}
          onBlur={(e) => blurSave('description', e.target.value)} />
      </div>

      <div className="space-y-1">
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor={id('research')} className="text-[11px] text-port-text-muted">Research</label>
            <select id={id('research')} value={research.status || 'unverified'} className={FIELD}
              onChange={(e) => save({ research: { status: e.target.value } })}>
              <option value="unverified">Unverified</option>
              <option value="verified">Verified</option>
            </select>
          </div>
        </div>
        <label htmlFor={id('notes')} className="text-[11px] text-port-text-muted">Research notes</label>
        <textarea key={`notes-${research.notes}`} id={id('notes')} rows={2} defaultValue={research.notes || ''} maxLength={8000} className={FIELD}
          onBlur={(e) => { if ((research.notes || '') !== e.target.value.trim()) save({ research: { notes: e.target.value.trim() } }); }} />
        <label htmlFor={id('sources')} className="text-[11px] text-port-text-muted">Sources (one link per line)</label>
        <textarea key={`sources-${(research.sources || []).map((s) => s.url).join(' ')}`} id={id('sources')} rows={2} className={FIELD}
          defaultValue={(research.sources || []).map((s) => s.url).join('\n')}
          onBlur={(e) => {
            const urls = [...new Set(e.target.value.split(/\s+/).map((u) => u.trim()).filter(Boolean))];
            const before = (research.sources || []).map((s) => s.url);
            if (urls.join('\n') === before.join('\n')) return;
            const bad = urls.find((u) => !/^https?:\/\/\S+$/i.test(u));
            if (bad) { toast.error(`Not a web link: ${bad}`); return; }
            save({ research: { sources: urls.slice(0, 12).map((url) => (research.sources || []).find((s) => s.url === url) || { url }) } });
          }} />
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <h5 className="text-xs font-medium">Reference photos</h5>
          <button type="button" className={BUTTON} disabled={(cameo.references || []).length >= MUSIC_VIDEO_CAMEO_MAX_REFERENCES}
            onClick={() => setPicker({ kind: 'reference' })}><ImagePlus size={12} aria-hidden="true" /> Add photo</button>
        </div>
        {(cameo.references || []).length ? (
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {cameo.references.map((ref) => (
              <li key={ref.imageId} className="min-w-0 space-y-1">
                <img src={imageSrc(ref.imageId)} alt="" className="aspect-square w-full rounded border border-port-border bg-black object-cover" />
                <div className="flex flex-wrap gap-1">
                  <button type="button" className={BUTTON} onClick={() => save({ stillImageId: ref.imageId })} disabled={cameo.stillImageId === ref.imageId}>
                    {cameo.stillImageId === ref.imageId ? 'Still' : 'Use as still'}
                  </button>
                  <button type="button" className={BUTTON} aria-label="Remove photo"
                    onClick={() => run(() => removeMusicVideoCameoReference(project.id, cameo.cameoId, ref.imageId, { silent: true }), 'Failed to remove the photo')}>
                    <X size={12} aria-hidden="true" />
                  </button>
                </div>
                {ref.pageUrl && <a href={ref.pageUrl} target="_blank" rel="noreferrer noopener" className="block truncate text-[10px] text-port-accent">Source</a>}
              </li>
            ))}
          </ul>
        ) : <p className="text-[11px] text-port-text-muted">Photos of the real cameo. Every linked shot's frame renders send them as references.</p>}
        <ResearchSeedForm projectId={project.id} match={{ cameoId: cameo.cameoId }} disabled={disabled}
          start={(body) => startMusicVideoCameoResearch(project.id, cameo.cameoId, body, { silent: true })}
          onSaved={(saved) => onApply({ cameos: saved.cameos || [], scenes: saved.scenes || [], updatedAt: saved.updatedAt })}
          room={MUSIC_VIDEO_CAMEO_MAX_REFERENCES - (cameo.references || []).length} defaultSubject={cameo.name || ''}
          intro="PortOS adds them to this cameo's reference photos."
          limitNote={`A cameo keeps up to ${MUSIC_VIDEO_CAMEO_MAX_REFERENCES} reference photos. Remove one to research more.`} />
      </div>

      <div className="space-y-1">
        <h5 className="text-xs font-medium">Variants</h5>
        <p className="text-[11px] text-port-text-muted">To make one, link a shot to the variant, Refine its still on the shot (for example "dressed in a costume"), then tap "Use this still" there.</p>
        <ul className="space-y-1">
          {(cameo.variants || []).map((v) => (
            <li key={v.variantId} className="flex items-center gap-2">
              <Thumb imageId={v.imageId} label={`${v.label} still`} />
              <span className="min-w-0 flex-1 truncate text-xs">{v.label}</span>
              <button type="button" className={BUTTON} onClick={() => setPicker({ kind: 'variant', variantId: v.variantId })}>Pick still</button>
              <button type="button" className={BUTTON} aria-label={`Remove variant ${v.label}`}
                onClick={() => run(() => deleteMusicVideoCameoVariant(project.id, cameo.cameoId, v.variantId, { silent: true }), 'Failed to remove the variant')}>
                <Trash2 size={12} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
        {(cameo.variants || []).length < MUSIC_VIDEO_CAMEO_MAX_VARIANTS && (
          <form className="flex items-end gap-2" onSubmit={(e) => {
            e.preventDefault();
            const label = variantLabel.trim();
            if (!label) return;
            run(() => addMusicVideoCameoVariant(project.id, cameo.cameoId, { label }, { silent: true }), 'Failed to add the variant')
              .then(() => setVariantLabel(''));
          }}>
            <div className="min-w-0 flex-1">
              <label htmlFor={id('variant')} className="text-[11px] text-port-text-muted">New variant</label>
              <input id={id('variant')} value={variantLabel} onChange={(e) => setVariantLabel(e.target.value)} maxLength={80} placeholder="Costume" className={FIELD} />
            </div>
            <button type="submit" className={BUTTON} disabled={!variantLabel.trim()}>Add</button>
          </form>
        )}
      </div>

      <div className="space-y-1">
        <h5 className="text-xs font-medium">Shots</h5>
        {linked.length > 0 && (
          <ul className="space-y-1">
            {linked.map((scene) => (
              <li key={scene.sceneId} className="flex items-center gap-2">
                <Thumb imageId={scene.referenceImageId} label="" className="h-8 w-12" />
                <span className="min-w-0 flex-1 truncate text-xs">{shotName(scene)}{scene.cameoVariantId ? ` · ${variantName(scene.cameoVariantId) || 'variant'}` : ''}</span>
                <button type="button" className={BUTTON} aria-label={`Unlink ${shotName(scene)}`}
                  onClick={() => run(() => unlinkMusicVideoCameoShots(project.id, [scene.sceneId], { silent: true }), 'Failed to unlink the shot')}>
                  <X size={12} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {unlinked.length > 0 && (
          <div>
            <label htmlFor={id('link')} className="text-[11px] text-port-text-muted">Link a shot</label>
            <select id={id('link')} value="" className={FIELD}
              onChange={(e) => e.target.value && run(() => linkMusicVideoCameoShots(project.id, cameo.cameoId, { sceneIds: [e.target.value] }, { silent: true }), 'Failed to link the shot')}>
              <option value="">Pick a shot…</option>
              {unlinked.map((scene) => <option key={scene.sceneId} value={scene.sceneId}>{shotName(scene)}{scene.cameoId ? ' (linked elsewhere)' : ''}</option>)}
            </select>
          </div>
        )}
      </div>

      <div className="flex justify-end">
        <button type="button" className={`${BUTTON} text-port-error`}
          onClick={() => (confirmDelete
            ? run(() => deleteMusicVideoCameo(project.id, cameo.cameoId, { silent: true }), 'Failed to remove the cameo').then(onClose)
            : setConfirmDelete(true))}>
          <Trash2 size={12} aria-hidden="true" /> {confirmDelete ? 'Tap again to remove' : 'Remove cameo'}
        </button>
      </div>
      <GalleryImagePicker open={Boolean(picker)} onClose={() => setPicker(null)} allowUpload onSelect={onPicked} />
    </fieldset>
  );
}

/**
 * Look › Cameos (#14821): the researched cameos the video shows, beyond the
 * capped cast. Each keeps its research, reference photos, one chosen still and
 * its variants; linked shots with no still of their own show that still. The
 * open cameo is `?cameo=<id>` so it can be linked to.
 */
export default function CameoRosterPanel({ project, onApply, disabled = false }) {
  const [params, setParams] = useSearchParams();
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [query, setQuery] = useState('');
  const roster = useMemo(() => project.cameos || [], [project.cameos]);
  const coverage = useMemo(() => musicVideoCameoCoverage(project), [project]);
  const coverageById = useMemo(() => new Map(coverage.cameos.map((c) => [c.cameoId, c])), [coverage]);
  const openId = params.get('cameo');
  const open = roster.find((s) => s.cameoId === openId) || null;
  const setOpen = (cameoId) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    if (cameoId) next.set('cameo', cameoId); else next.delete('cameo');
    return next;
  }, { replace: true });
  const q = query.trim().toLowerCase();
  const shown = roster.filter((s) => {
    const c = coverageById.get(s.cameoId);
    if (filter === 'unlinked' ? c?.shots : filter && !c?.needs.includes(filter)) return false;
    return !q || `${s.name} ${s.label || ''}`.toLowerCase().includes(q);
  });
  const add = (e) => {
    e.preventDefault();
    const cameos = parseCameoLines(adding);
    if (!cameos.length) return;
    setBusy(true);
    createMusicVideoCameos(project.id, cameos, { silent: true })
      .then((answer) => { onApply(answer); setAdding(''); })
      .catch((err) => toast.error(err?.message || 'Failed to add cameos'))
      .finally(() => setBusy(false));
  };

  return (
    <StageSection id="mv-look-cameos" title="Cameos" summary={cameosSummary(coverage)} defaultOpen={Boolean(open)}>
      <p className="text-[11px] text-port-text-muted">
        Things the video shows in many shots, like each dog in a roll call. Research each one, add photos of the real thing, and pick one still: every linked shot without its own still shows it.
      </p>
      {open && <CameoEditor key={open.cameoId} project={project} cameo={open} coverage={coverageById.get(open.cameoId)} onApply={onApply} onClose={() => setOpen(null)} disabled={disabled} />}
      {roster.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1" role="group" aria-label="Show cameos">
            {FILTERS.map((f) => (
              <button key={f.id || 'all'} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}
                className={`${BUTTON} ${filter === f.id ? 'border-port-accent text-port-accent' : ''}`}>{f.label}</button>
            ))}
          </div>
          <label htmlFor={`mv-cameos-${project.id}-search`} className="sr-only">Search cameos</label>
          <input id={`mv-cameos-${project.id}-search`} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search cameos" className={FIELD} />
          <ul className="max-h-[28rem] divide-y divide-port-border overflow-y-auto rounded border border-port-border">
            {shown.map((s) => {
              const c = coverageById.get(s.cameoId);
              return (
                <li key={s.cameoId}>
                  <button type="button" onClick={() => setOpen(s.cameoId)} aria-current={openId === s.cameoId || undefined}
                    className="flex min-h-[44px] w-full items-center gap-2 px-2 py-1 text-left hover:bg-port-border/30">
                    <Thumb imageId={s.stillImageId} label="" className="h-10 w-10" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{s.name}{s.label && s.label !== s.name ? ` (${s.label})` : ''}</span>
                      <span className="block truncate text-[11px] text-port-text-muted">
                        {formatCount(c?.shots || 0)} {c?.shots === 1 ? 'shot' : 'shots'}{c?.needs.length ? ` · needs ${c.needs.map((n) => NEED_LABELS[n]).join(', ')}` : ' · ready'}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
            {!shown.length && <li className="px-2 py-2 text-[11px] text-port-text-muted">No cameos match.</li>}
          </ul>
        </div>
      )}
      <form onSubmit={add} className="space-y-1">
        <label htmlFor={`mv-cameos-${project.id}-add`} className="text-[11px] text-port-text-muted">Add cameos, one per line (Name, or Name | on-screen label)</label>
        <textarea id={`mv-cameos-${project.id}-add`} rows={3} value={adding} onChange={(e) => setAdding(e.target.value)} className={FIELD}
          placeholder={'Cockapoo\nCockapoo | Spoodle'} />
        <button type="submit" className={BUTTON} disabled={disabled || busy || !adding.trim()}>Add</button>
      </form>
    </StageSection>
  );
}
