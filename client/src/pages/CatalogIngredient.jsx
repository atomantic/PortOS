/**
 * CatalogIngredient — detail/editor for a single catalog ingredient. Loaded
 * via /catalog/:type/:id; the type from the loaded record is the source of
 * truth. Side panels surface source scraps and inbound refs (universes /
 * pipeline series / issues / writers-room). Full-width page; owns its scroll.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { Sparkles, Save, Trash2, ArrowLeft, Loader2, ExternalLink } from 'lucide-react';
import toast from '../components/ui/Toast';
import {
  getCatalogIngredient,
  updateCatalogIngredient,
  deleteCatalogIngredient,
} from '../services/apiCatalog';

// Per-type payload field list. Each entry is `[key, label, kind]` where `kind`
// is 'text' (single line) or 'textarea' (multi-line). idea/scene/concept all
// share the lightweight shape.
const LIGHT_FIELDS = [
  ['summary',     'Summary',     'textarea'],
  ['description', 'Description', 'textarea'],
  ['notes',       'Notes',       'textarea'],
];
const PAYLOAD_FIELDS = {
  character: [
    ['role',                'Role',                  'text'],
    // Canon character shape uses `physicalDescription` (matches
    // sanitizeCharacter and the writers-room/bible extractor). A plain
    // `description` here would render empty for backfill-promoted characters
    // and edits would land in a sibling field the canon doesn't read.
    ['physicalDescription', 'Physical Description',  'textarea'],
    ['personality',         'Personality',           'textarea'],
    ['background',          'Background',            'textarea'],
    ['motivations',         'Motivations',           'textarea'],
    ['notes',               'Notes',                 'textarea'],
  ],
  place: [
    ['slugline',     'Slugline',     'text'],
    ['era',          'Era',          'text'],
    ['description',  'Description',  'textarea'],
    ['notes',        'Notes',        'textarea'],
  ],
  object: [
    ['description',  'Description',  'textarea'],
    ['significance', 'Significance', 'textarea'],
    ['notes',        'Notes',        'textarea'],
  ],
  idea: LIGHT_FIELDS,
  scene: LIGHT_FIELDS,
  concept: LIGHT_FIELDS,
};

const TYPE_BADGE = {
  character: 'bg-blue-500/20 text-blue-300 border-blue-500/40',
  place:     'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  object:    'bg-amber-500/20 text-amber-300 border-amber-500/40',
  idea:      'bg-purple-500/20 text-purple-300 border-purple-500/40',
  scene:     'bg-pink-500/20 text-pink-300 border-pink-500/40',
  concept:   'bg-cyan-500/20 text-cyan-300 border-cyan-500/40',
};

// Map a refKind onto a click-through route. Returns null for kinds we don't
// know how to deep-link to, so callers can render the chip without a link.
function refPath(refKind, refId) {
  if (!refId) return null;
  switch (refKind) {
    case 'universe':       return `/universes/${encodeURIComponent(refId)}`;
    case 'series':         return `/pipeline/series/${encodeURIComponent(refId)}`;
    case 'issue':          return `/pipeline/issues/${encodeURIComponent(refId)}/concept`;
    case 'writers-room':
    case 'writersRoom':    return '/writers-room';
    default:               return null;
  }
}

function REFKIND_LABEL(kind) {
  if (kind === 'universe')   return 'Universes';
  if (kind === 'series')     return 'Series';
  if (kind === 'issue')      return 'Issues';
  if (kind === 'writers-room' || kind === 'writersRoom') return "Writers' Room";
  return kind;
}

export default function CatalogIngredient() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [record, setRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [payload, setPayload] = useState({});
  const [saving, setSaving] = useState(false);
  const [armedDelete, setArmedDelete] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getCatalogIngredient(id, { silent: true })
      .then((r) => {
        if (cancelled) return;
        if (!r) {
          toast.error('Ingredient not found');
          navigate('/catalog');
          return;
        }
        setRecord(r);
        setName(r.name || '');
        setTagsInput((r.tags || []).join(', '));
        setPayload(r.payload && typeof r.payload === 'object' ? { ...r.payload } : {});
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        toast.error(err?.message || 'Failed to load ingredient');
        navigate('/catalog');
      });
    return () => { cancelled = true; };
  }, [id, navigate]);

  const handleSave = async () => {
    if (!record) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error('Name is required');
      return;
    }
    const tags = tagsInput.split(',').map((t) => t.trim()).filter(Boolean);
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
    toast.success('Saved');
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

  const fields = PAYLOAD_FIELDS[record.type] || PAYLOAD_FIELDS.idea;
  const badgeClass = TYPE_BADGE[record.type] || 'bg-gray-500/20 text-gray-300 border-gray-500/40';

  // Group refs by kind for the "Appears in" panel. Tolerates either an array
  // of `{ refKind, refId, role }` or a server-grouped shape.
  const refs = Array.isArray(record.refs) ? record.refs : [];
  const refsByKind = refs.reduce((acc, r) => {
    const k = r.refKind || r.kind || 'other';
    (acc[k] ||= []).push(r);
    return acc;
  }, {});

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
              Tags <span className="text-gray-500 normal-case">(comma-separated)</span>
            </label>
            <input id="ingredient-tags" type="text" value={tagsInput} onChange={(e) => setTagsInput(e.target.value)}
              placeholder="mentor, antagonist, season-1"
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm focus:outline-none focus:border-port-accent" />
          </div>
          {fields.map(([key, label, kind]) => {
            const inputId = `ingredient-${key}`;
            const value = payload[key] ?? '';
            const shared = `w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm focus:outline-none focus:border-port-accent`;
            return (
              <div key={key}>
                <label htmlFor={inputId} className="block text-xs uppercase tracking-wider text-gray-500 mb-1">{label}</label>
                {kind === 'textarea'
                  ? <textarea id={inputId} rows={3} value={value} onChange={(e) => updatePayload(key, e.target.value)} className={shared} />
                  : <input id={inputId} type="text" value={value} onChange={(e) => updatePayload(key, e.target.value)} className={shared} />}
              </div>
            );
          })}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <SourcesPanel sources={record.sources} />
          <RefsPanel refsByKind={refsByKind} />
        </div>
      </div>
    </section>
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
              {s.extractedAt && <span className="text-gray-500 whitespace-nowrap">{new Date(s.extractedAt).toLocaleString()}</span>}
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
