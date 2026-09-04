import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { ImageIcon, Loader2, Plus, Save, Sparkles, Trash2, X } from 'lucide-react';
import BrailleSpinner from '../BrailleSpinner';
import GalleryImagePicker from '../imageGen/GalleryImagePicker';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import Field from '../ui/FormField';
import toast from '../ui/Toast';
import { useConfirmDelete } from '../../hooks/useConfirmDelete';
import useMediaJobProgress from '../../hooks/useMediaJobProgress';
import { DEFAULT_NEGATIVE_PROMPT } from '../../lib/imageGenDefaults';

const PERSONA_IMAGE_MAX_BYTES = 12 * 1024 * 1024;
const byName = (a, b) => (a.name || '').localeCompare(b.name || '');

export default function PersonaMasterDetail({
  basePath, selectedId, title, titleIcon: TitleIcon, intro, singular, plural, fields,
  listSecondaryKey, portrait, listRecords, createRecord, updateRecord, deleteRecord, generateImage,
}) {
  const navigate = useNavigate();
  const emptyForm = useMemo(
    () => Object.fromEntries([...fields.map(({ key }) => key), portrait.imageKey].map((key) => [key, ''])),
    [fields, portrait.imageKey],
  );
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const { isConfirming: isConfirmingDelete, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [startingGeneration, setStartingGeneration] = useState(false);
  const [generationJobId, setGenerationJobId] = useState(null);
  const generationRequestRef = useRef(0);
  const hydratedRef = useRef(null);

  const generation = useMediaJobProgress(generationJobId);
  const isGenerating = startingGeneration || !!generationJobId;
  const isCreate = selectedId === 'new';
  const selected = useMemo(
    () => (isCreate || !selectedId ? null : records.find((record) => record.id === selectedId) || null),
    [records, selectedId, isCreate],
  );
  const notFound = !isCreate && !!selectedId && !loading && !selected;
  const canGenerate = !!(form[portrait.descriptionKey]?.trim() || form[portrait.styleKey]?.trim());

  const setImage = (url) => setForm((current) => ({ ...current, [portrait.imageKey]: url }));
  const clearGeneration = () => {
    generationRequestRef.current += 1;
    setGenerationJobId(null);
    setStartingGeneration(false);
  };

  useEffect(() => {
    listRecords({ silent: true })
      .then((list) => setRecords(Array.isArray(list) ? list : []))
      .catch((err) => toast.error(err.message || `Failed to load ${plural.toLowerCase()}`))
      .finally(() => setLoading(false));
  }, [listRecords, plural]);

  useEffect(() => {
    if (!generationJobId) return;
    if (generation.status === 'completed' && generation.filename) {
      setForm((current) => ({
        ...current,
        [portrait.imageKey]: generation.path || `/data/images/${generation.filename}`,
      }));
      setGenerationJobId(null);
      toast.success(`${portrait.label} generated`);
    } else if (generation.status === 'failed' || generation.status === 'canceled') {
      setGenerationJobId(null);
      toast.error(generation.error || `${portrait.label} generation failed`);
    }
  }, [generationJobId, generation.status, generation.filename, generation.path, generation.error, portrait]);

  useEffect(() => {
    if (loading || hydratedRef.current === selectedId) return;
    hydratedRef.current = selectedId;
    cancelDelete();
    clearGeneration();
    if (isCreate) setForm(emptyForm);
    else if (selected) {
      setForm(Object.fromEntries(
        [...fields.map(({ key }) => key), portrait.imageKey].map((key) => [key, selected[key] || '']),
      ));
    }
  }, [selectedId, isCreate, selected, loading, emptyForm, fields, portrait.imageKey]);

  const handleGenerate = async () => {
    if (isGenerating) return;
    if (!canGenerate) {
      toast.error(`Add a physical description or ${portrait.styleLabel.toLowerCase()} to generate from`);
      return;
    }
    const requestId = generationRequestRef.current;
    setStartingGeneration(true);
    const queued = await generateImage({
      prompt: portrait.buildPrompt(form),
      negativePrompt: `${DEFAULT_NEGATIVE_PROMPT}, extra limbs, nsfw, nude`,
      width: 768,
      height: 1024,
    }, { silent: true }).catch((err) => ({ error: err }));
    if (generationRequestRef.current !== requestId) return;
    setStartingGeneration(false);
    if (queued?.error) {
      toast.error(queued.error.message || `${portrait.label} generation failed`);
      return;
    }
    if (queued.jobId) {
      setGenerationJobId(queued.jobId);
      toast.success(`Generating ${portrait.label.toLowerCase()}…`);
      return;
    }
    const path = queued.path || (queued.filename ? `/data/images/${queued.filename}` : '');
    if (path) {
      setImage(path);
      toast.success(`${portrait.label} generated`);
    } else {
      toast.error(`${portrait.label} generation returned no image`);
    }
  };

  const handleImagePick = (item) => {
    setGalleryOpen(false);
    const url = item?.previewUrl || (item?.filename ? `/data/images/${item.filename}` : '');
    if (url) setImage(url);
  };

  const handleSave = async () => {
    const name = form.name.trim();
    if (!name) {
      toast.error(`${singular} name is required`);
      return;
    }
    setSaving(true);
    const payload = { ...form, name };
    const saved = await (isCreate
      ? createRecord(payload, { silent: true })
      : updateRecord(selectedId, payload, { silent: true }))
      .catch((err) => {
        toast.error(err.message || `Failed to ${isCreate ? 'create' : 'save'} ${singular.toLowerCase()}`);
        return null;
      });
    setSaving(false);
    if (!saved) return;
    setRecords((current) => (isCreate
      ? [...current, saved].sort(byName)
      : current.map((record) => (record.id === saved.id ? saved : record)).sort(byName)));
    if (isCreate) {
      navigate(`${basePath}/${encodeURIComponent(saved.id)}`);
      toast.success(`Created "${saved.name}"`);
    } else {
      toast.success('Saved');
    }
  };

  const handleDelete = async () => {
    if (!selected) return;
    const prior = records;
    setRecords((current) => current.filter((record) => record.id !== selected.id));
    navigate(basePath);
    await deleteRecord(selected.id, { silent: true }).catch((err) => {
      toast.error(err.message || 'Delete failed');
      setRecords(prior);
    });
  };

  const introBlock = <p className="text-sm text-gray-400 max-w-2xl">{intro}</p>;

  return (
    <div>
      {title ? (
        <>
          <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
            <div className="flex items-center gap-3">
              {TitleIcon ? <TitleIcon className="w-6 h-6 text-port-accent" /> : null}
              <h1 className="text-2xl font-bold text-white">{title}</h1>
            </div>
            <CreateButton singular={singular} onClick={() => navigate(`${basePath}/new`)} />
          </div>
          <div className="mb-6">{introBlock}</div>
        </>
      ) : (
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          {introBlock}
          <CreateButton singular={singular} onClick={() => navigate(`${basePath}/new`)} />
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-[260px_1fr] gap-4">
        <div className="bg-port-card border border-port-border rounded-lg p-2">
          {loading ? (
            <div className="text-sm p-2"><BrailleSpinner text="Loading…" /></div>
          ) : records.length === 0 ? (
            <div className="text-gray-500 text-sm p-2">
              No {plural.toLowerCase()} yet.{' '}
              <button type="button" onClick={() => navigate(`${basePath}/new`)} className="text-port-accent hover:underline">New {singular}</button>
            </div>
          ) : (
            <ul className="space-y-1">
              {records.map((record) => (
                <li key={record.id}>
                  <button
                    type="button"
                    onClick={() => navigate(`${basePath}/${encodeURIComponent(record.id)}`)}
                    className={`w-full text-left px-3 py-2 rounded text-sm truncate ${record.id === selectedId ? 'bg-port-accent/20 text-white' : 'text-gray-300 hover:bg-port-bg'}`}
                  >
                    {record.name}
                    {listSecondaryKey && record[listSecondaryKey] ? <span className="block text-[11px] text-gray-500 truncate">{record[listSecondaryKey]}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="bg-port-card border border-port-border rounded-lg p-4">
          {notFound ? (
            <div className="text-gray-500 text-sm">
              That {singular.toLowerCase()} could not be found — it may have been deleted.{' '}
              <button type="button" onClick={() => navigate(basePath)} className="text-port-accent hover:underline">Back to {plural.toLowerCase()}</button>
            </div>
          ) : !isCreate && !selected ? (
            <div className="text-gray-500 text-sm">
              <p>Select a {singular.toLowerCase()} to edit, or create a new one.</p>
              <CreateButton singular={singular} onClick={() => navigate(`${basePath}/new`)} />
            </div>
          ) : (
            <div className="space-y-3">
              {fields.map((field) => (
                <Field key={field.key} compact label={field.label} hint={field.hint}>
                  {field.type === 'textarea' ? (
                    <textarea
                      value={form[field.key]}
                      onChange={(event) => setForm((current) => ({ ...current, [field.key]: event.target.value }))}
                      rows={field.rows}
                      maxLength={field.maxLength}
                      placeholder={field.placeholder}
                      className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
                    />
                  ) : (
                    <input
                      value={form[field.key]}
                      onChange={(event) => setForm((current) => ({ ...current, [field.key]: event.target.value }))}
                      placeholder={field.placeholder}
                      maxLength={field.maxLength}
                      className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
                      autoFocus={field.key === 'name'}
                    />
                  )}
                </Field>
              ))}

              <Field compact label={portrait.fieldLabel} hint={portrait.hint}>
                <div className="flex items-start gap-3">
                  {isGenerating ? (
                    <div className="relative w-20 h-20 rounded border border-port-border bg-port-bg overflow-hidden flex items-center justify-center shrink-0">
                      {generation.currentImage ? (
                        <img src={`data:image/png;base64,${generation.currentImage}`} alt={`Generating ${portrait.label.toLowerCase()} preview`} className="w-full h-full object-cover opacity-70" />
                      ) : <Loader2 size={20} className="animate-spin text-port-accent" aria-hidden="true" />}
                      {generation.totalSteps ? <div className="absolute bottom-0 inset-x-0 port-media-overlay text-[9px] text-center py-0.5 font-mono">{Math.round((generation.step / generation.totalSteps) * 100)}%</div> : null}
                    </div>
                  ) : form[portrait.imageKey] ? (
                    <div className="relative shrink-0">
                      <img src={form[portrait.imageKey]} alt={`${singular} ${portrait.label.toLowerCase()}`} className="w-20 h-20 rounded object-cover border border-port-border bg-port-bg" />
                      <button type="button" onClick={() => setImage('')} title={`Remove ${portrait.label.toLowerCase()}`} aria-label={`Remove ${portrait.label.toLowerCase()}`} className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center absolute -top-2 -right-2 p-1 rounded-full bg-port-bg border border-port-border text-gray-400 hover:text-port-error"><X size={12} /></button>
                    </div>
                  ) : (
                    <div className="w-20 h-20 rounded border border-dashed border-port-border bg-port-bg flex items-center justify-center text-gray-600 shrink-0"><ImageIcon size={20} aria-hidden="true" /></div>
                  )}
                  <div className="flex-1 space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <button type="button" onClick={handleGenerate} disabled={isGenerating || !canGenerate} title={canGenerate ? portrait.generateTitle : `Add a physical description or ${portrait.styleLabel.toLowerCase()} first`} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-bg border border-port-border text-white text-sm hover:border-port-accent disabled:opacity-50">
                        {isGenerating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Generate
                      </button>
                      <button type="button" onClick={() => setGalleryOpen(true)} disabled={isGenerating} title="Pick a gallery image, or upload one from this device" className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-bg border border-port-border text-white text-sm hover:border-port-accent disabled:opacity-50"><ImageIcon size={14} /> Choose or upload</button>
                    </div>
                    <input aria-label={`${portrait.label} image URL`} value={form[portrait.imageKey]} onChange={(event) => setImage(event.target.value)} disabled={isGenerating} placeholder="/images/…  or  https://…" maxLength={portrait.maxLength} className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm disabled:opacity-50" />
                  </div>
                </div>
              </Field>

              <div className="flex items-center gap-2 pt-1 flex-wrap">
                <button type="button" onClick={handleSave} disabled={saving || !form.name.trim()} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-accent text-white text-sm font-medium disabled:opacity-50">
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} {isCreate ? 'Create' : 'Save'}
                </button>
                {!isCreate && selected ? (
                  isConfirmingDelete(selected.id) ? (
                    <ConfirmButtonPair prompt={`Delete this ${singular.toLowerCase()}?`} confirmText="Yes, delete" ariaLabel={`Confirm delete ${singular.toLowerCase()}`} tone="error" onConfirm={() => confirmDelete(handleDelete)} onCancel={cancelDelete} />
                  ) : (
                    <button type="button" onClick={() => requestDelete(selected.id)} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-gray-400 hover:text-port-error text-sm"><Trash2 size={14} /> Delete</button>
                  )
                ) : null}
              </div>
            </div>
          )}
        </div>
      </div>

      <GalleryImagePicker open={galleryOpen} onClose={() => setGalleryOpen(false)} onSelect={handleImagePick} allowUpload maxBytes={PERSONA_IMAGE_MAX_BYTES} />
    </div>
  );
}

function CreateButton({ singular, onClick }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-accent hover:bg-port-accent/90 text-white text-sm font-medium shrink-0">
      <Plus size={16} aria-hidden="true" /> New {singular}
    </button>
  );
}
