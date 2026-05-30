/**
 * CatalogIngest — paste-extract-review-commit flow for the catalog. Three
 * phases gated by local state: paste → extracting (live stage checklist via
 * `catalog:extract:progress`) → review (per-kind checkboxes with editable
 * name + description). Full-width page; owns its own scroll.
 */

import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles, Loader2, CheckCircle2, AlertCircle, ArrowLeft, RotateCcw, Circle } from 'lucide-react';
import toast from '../components/ui/Toast';
import socket from '../services/socket';
import {
  createCatalogScrap,
  extractFromCatalogScrap,
  commitCatalogScrapDraft,
} from '../services/apiCatalog';

// One review section per ingredient type. The first three are bible-shaped
// (character/place/object) and use `physicalDescription`/`description` as the
// primary editable text; the last three are light-shaped (idea/scene/concept)
// and use `summary` — matching PRIMARY_CONTENT_KEY in Catalog.jsx.
const KIND_SECTIONS = [
  { key: 'characters', label: 'Characters', type: 'character' },
  { key: 'places',     label: 'Places',     type: 'place' },
  { key: 'objects',    label: 'Objects',    type: 'object' },
  { key: 'ideas',      label: 'Ideas',      type: 'idea' },
  { key: 'scenes',     label: 'Scenes',     type: 'scene' },
  { key: 'concepts',   label: 'Concepts',   type: 'concept' },
];

// Initial stage list, used until the server's `start` frame supplies the real
// one. Mirrors server-side EXTRACTION_STAGES — three bible passes plus one
// bundled light pass (`ideasScenesConcepts`) — so the panel never looks empty
// between click and first frame.
const INITIAL_STAGES = [
  { id: 'characters', label: 'Characters', status: 'pending', count: 0 },
  { id: 'places',     label: 'Places',     status: 'pending', count: 0 },
  { id: 'objects',    label: 'Objects',    status: 'pending', count: 0 },
  { id: 'ideasScenesConcepts', label: 'Ideas, scenes & concepts', status: 'pending', count: 0 },
];

function StageIcon({ status }) {
  if (status === 'completed' || status === 'done') {
    return <CheckCircle2 className="w-4 h-4 text-port-success flex-shrink-0" aria-hidden="true" />;
  }
  if (status === 'failed' || status === 'error') {
    return <AlertCircle className="w-4 h-4 text-port-error flex-shrink-0" aria-hidden="true" />;
  }
  if (status === 'running') {
    return <Loader2 className="w-4 h-4 text-port-accent animate-spin flex-shrink-0" aria-hidden="true" />;
  }
  return <Circle className="w-4 h-4 text-gray-500 flex-shrink-0" aria-hidden="true" />;
}

export default function CatalogIngest() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState('paste'); // 'paste' | 'extracting' | 'review'
  const [title, setTitle] = useState('');
  const [rawText, setRawText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [scrapId, setScrapId] = useState(null);
  const [stages, setStages] = useState(INITIAL_STAGES);
  // The draft returned by extractFromCatalogScrap(): per-kind candidate arrays
  // editable inline + checkbox-gated. Defaults all to selected.
  const [draft, setDraft] = useState({ characters: [], places: [], objects: [], ideas: [], scenes: [], concepts: [] });
  const [selected, setSelected] = useState({ characters: new Set(), places: new Set(), objects: new Set(), ideas: new Set(), scenes: new Set(), concepts: new Set() });

  // Track active runId so a stale frame from an earlier scrap can't mutate the
  // current stage list (server fans these to all sockets — single-user trust
  // model still applies, but tab refresh + a slow extract overlap is real).
  const activeRunIdRef = useRef(null);
  useEffect(() => {
    const onProgress = (ev) => {
      if (!ev || typeof ev !== 'object') return;
      if (ev.type === 'start') {
        activeRunIdRef.current = ev.runId;
        const next = Array.isArray(ev.stages) && ev.stages.length > 0
          ? ev.stages.map((s) => ({ ...s, status: s.status || 'pending' }))
          : INITIAL_STAGES;
        setStages(next);
        return;
      }
      if (ev.runId && ev.runId !== activeRunIdRef.current) return;
      if (ev.type === 'stage') {
        setStages((prev) => prev.map((s) => (
          s.id === ev.id
            ? { ...s, status: ev.status || s.status, count: ev.count ?? s.count, error: ev.error || s.error }
            : s
        )));
      }
    };
    socket.on('catalog:extract:progress', onProgress);
    return () => socket.off('catalog:extract:progress', onProgress);
  }, []);

  const reset = () => {
    activeRunIdRef.current = null;
    setPhase('paste');
    setScrapId(null);
    setStages(INITIAL_STAGES);
    setDraft({ characters: [], places: [], objects: [], ideas: [], scenes: [], concepts: [] });
    setSelected({ characters: new Set(), places: new Set(), objects: new Set(), ideas: new Set(), scenes: new Set(), concepts: new Set() });
  };

  const handleIngest = async (e) => {
    e?.preventDefault?.();
    const text = rawText.trim();
    if (!text) { toast.error('Paste some text first.'); return; }
    setSubmitting(true);
    setPhase('extracting');
    setStages(INITIAL_STAGES);
    // silent: own error handling below — avoids double-toast.
    const created = await createCatalogScrap({ rawText: text, title: title.trim() || undefined }, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Failed to save scrap'); return null; });
    if (!created?.scrap?.id) { setSubmitting(false); setPhase('paste'); return; }
    setScrapId(created.scrap.id);
    const result = await extractFromCatalogScrap(created.scrap.id, {}, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Extraction failed'); return null; });
    setSubmitting(false);
    if (!result?.draft) { setPhase('paste'); return; }
    const d = Object.fromEntries(KIND_SECTIONS.map((s) => [
      s.key,
      Array.isArray(result.draft[s.key]) ? result.draft[s.key] : [],
    ]));
    setDraft(d);
    setSelected(Object.fromEntries(KIND_SECTIONS.map((s) => [s.key, new Set(d[s.key].map((_, i) => i))])));
    // Prefer server-supplied stage list; otherwise mark defaults completed.
    // The bundled `ideasScenesConcepts` stage has no matching `d[id]` array,
    // so its count is the sum of the three light kinds it backs.
    if (Array.isArray(result.draft.stages) && result.draft.stages.length > 0) {
      setStages(result.draft.stages.map((s) => ({ ...s, status: s.status || 'completed' })));
    } else {
      const countForStage = (id) => id === 'ideasScenesConcepts'
        ? d.ideas.length + d.scenes.length + d.concepts.length
        : d[id]?.length || 0;
      setStages((prev) => prev.map((s) => ({ ...s, status: 'completed', count: countForStage(s.id) })));
    }
    setPhase('review');
  };

  const toggle = (kind, idx) => {
    setSelected((prev) => {
      const next = new Set(prev[kind]);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return { ...prev, [kind]: next };
    });
  };

  const selectAll = (kind, on) => {
    setSelected((prev) => ({
      ...prev,
      [kind]: on ? new Set(draft[kind].map((_, i) => i)) : new Set(),
    }));
  };

  const patchCandidate = (kind, idx, patch) => {
    setDraft((prev) => ({
      ...prev,
      [kind]: prev[kind].map((c, i) => (i === idx ? { ...c, ...patch } : c)),
    }));
  };

  const handleCommit = async () => {
    if (!scrapId) return;
    // extractBible returns flat bible-shaped objects (role, personality,
    // background, motivations, slugline, era, significance, …); commit must
    // carry the whole shape minus the few keys catalog stores at the top
    // (name, tags, id — and `type` from the section, not the candidate).
    const accepted = [];
    for (const section of KIND_SECTIONS) {
      const arr = draft[section.key];
      const sel = selected[section.key];
      for (let i = 0; i < arr.length; i += 1) {
        if (!sel.has(i)) continue;
        const c = arr[i];
        const name = (c.name || '').trim();
        if (!name) continue;
        // eslint-disable-next-line no-unused-vars
        const { id: _id, type: _type, name: _name, tags: _tags, payload: nestedPayload, description, ...rest } = c;
        const payload = { ...rest, ...(nestedPayload && typeof nestedPayload === 'object' ? nestedPayload : {}) };
        if (description !== undefined) payload.description = description;
        accepted.push({ type: section.type, name, payload, tags: Array.isArray(c.tags) ? c.tags : [] });
      }
    }
    if (accepted.length === 0) {
      toast.error('Select at least one candidate to commit.');
      return;
    }
    setCommitting(true);
    const result = await commitCatalogScrapDraft(scrapId, accepted, { silent: true }).catch((err) => {
      toast.error(err?.message || 'Commit failed');
      return null;
    });
    setCommitting(false);
    if (!result) return;
    const n = Array.isArray(result.ingredients) ? result.ingredients.length : accepted.length;
    toast.success(`Added ${n} ingredient${n === 1 ? '' : 's'} to the catalog.`);
    navigate('/catalog');
  };

  return (
    <section className="h-full overflow-y-auto p-4 md:p-6">
      <div className="max-w-4xl mx-auto space-y-5">
        <header className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-start gap-3">
            <Sparkles className="w-7 h-7 text-port-accent mt-1" aria-hidden="true" />
            <div>
              <h1 className="text-2xl font-bold text-white">Catalog Ingest</h1>
              <p className="text-sm text-gray-400 mt-1">
                Paste prose, notes, or a synopsis. The LLM extracts characters, places, and objects
                alongside ideas, scenes, and concepts; review and commit only what you want to keep.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => navigate('/catalog')}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm text-gray-400 hover:text-white">
              <ArrowLeft size={14} aria-hidden="true" /> Back to Catalog
            </button>
            {phase !== 'paste' && (
              <button type="button" onClick={reset}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm border border-port-border text-gray-300 hover:text-white">
                <RotateCcw size={14} aria-hidden="true" /> Start Over
              </button>
            )}
          </div>
        </header>

        {phase === 'paste' && (
          <form onSubmit={handleIngest} className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6 space-y-4">
            <div>
              <label htmlFor="ingest-title" className="block text-sm font-medium mb-1 text-white">
                Title <span className="text-gray-500 font-normal">(optional)</span>
              </label>
              <input id="ingest-title" type="text" value={title} onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Chapter 3 notes" maxLength={200}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm focus:outline-none focus:border-port-accent" />
            </div>
            <div>
              <label htmlFor="ingest-text" className="block text-sm font-medium mb-1 text-white">Raw text</label>
              <textarea id="ingest-text" rows={12} value={rawText} onChange={(e) => setRawText(e.target.value)}
                placeholder="Paste prose, scene notes, character sketches — anything you want catalogued."
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm font-mono focus:outline-none focus:border-port-accent" />
              <p className="text-xs text-gray-500 mt-1">{rawText.length.toLocaleString()} chars</p>
            </div>
            <div className="flex items-center justify-end">
              <button type="submit" disabled={submitting || !rawText.trim()}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-port-accent hover:bg-port-accent/90 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium">
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                {submitting ? 'Ingesting…' : 'Ingest'}
              </button>
            </div>
          </form>
        )}

        {phase === 'extracting' && (
          <div className="bg-port-card border border-port-border rounded-lg p-6 space-y-3">
            <p className="text-sm font-medium text-white flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin text-port-accent" aria-hidden="true" />
              Extracting ingredients — this runs several AI passes.
            </p>
            <ul className="space-y-1.5 mt-2">
              {stages.map((s) => (
                <li key={s.id} className="flex items-center gap-2 text-sm">
                  <StageIcon status={s.status} />
                  <span className={s.status === 'running' ? 'text-white' : 'text-gray-400'}>
                    {s.label}
                  </span>
                  {Number.isFinite(s.count) && s.count > 0 && (
                    <span className="text-xs text-gray-500">({s.count})</span>
                  )}
                  {s.error && <span className="text-xs text-port-error">— {s.error}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {phase === 'review' && (
          <div className="space-y-5">
            <div className="bg-port-card border border-port-border rounded-lg p-4 text-sm text-gray-300">
              Review the candidates below. Uncheck anything you don&apos;t want, edit names and descriptions inline, then commit the rest.
            </div>
            {KIND_SECTIONS.map((section) => (
              <ReviewSection
                key={section.key}
                section={section}
                items={draft[section.key]}
                selected={selected[section.key]}
                onToggle={(idx) => toggle(section.key, idx)}
                onSelectAll={(on) => selectAll(section.key, on)}
                onPatch={(idx, patch) => patchCandidate(section.key, idx, patch)}
              />
            ))}
            <div className="sticky bottom-4 bg-port-card border border-port-border rounded-lg p-3 flex items-center justify-end gap-2 shadow-lg">
              <button type="button" onClick={reset} disabled={committing}
                className="px-3 py-2 rounded-lg text-gray-400 hover:text-white text-sm">
                Cancel
              </button>
              <button type="button" onClick={handleCommit} disabled={committing}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-port-success hover:bg-port-success/90 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium">
                {committing ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                {committing ? 'Committing…' : 'Commit Selected'}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function ReviewSection({ section, items, selected, onToggle, onSelectAll, onPatch }) {
  const total = items.length;
  const count = selected.size;
  if (total === 0) {
    return (
      <section className="bg-port-card border border-port-border rounded-lg p-4">
        <h2 className="text-lg font-semibold text-white mb-1">{section.label}</h2>
        <p className="text-xs text-gray-500">None extracted from this scrap.</p>
      </section>
    );
  }
  return (
    <section className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-lg font-semibold text-white">
          {section.label} <span className="text-sm font-normal text-gray-500">({count} / {total} selected)</span>
        </h2>
        <div className="flex items-center gap-1 text-xs">
          <button type="button" onClick={() => onSelectAll(true)} className="px-2 py-1 rounded border border-port-border text-gray-300 hover:text-white">
            Select All
          </button>
          <button type="button" onClick={() => onSelectAll(false)} className="px-2 py-1 rounded border border-port-border text-gray-300 hover:text-white">
            Deselect All
          </button>
        </div>
      </div>
      <ul className="space-y-2">
        {items.map((c, idx) => {
          const baseId = `${section.key}-${idx}`;
          // Each type's primary editable field matches PRIMARY_CONTENT_KEY in
          // Catalog.jsx: character → physicalDescription (canon shape from
          // sanitizeCharacter); place/object → description; idea/scene/concept
          // → summary. Without this an edit lands in a sibling key the
          // catalog editor doesn't read.
          let descField;
          if (section.type === 'character') descField = 'physicalDescription';
          else if (section.type === 'place' || section.type === 'object') descField = 'description';
          else descField = 'summary';
          return (
            <li key={baseId} className="border border-port-border rounded p-3 bg-port-bg/40 flex items-start gap-2">
              <input id={`${baseId}-check`} type="checkbox" checked={selected.has(idx)} onChange={() => onToggle(idx)}
                className="accent-port-accent mt-1" aria-label={`Include ${c.name || section.label}`} />
              <div className="flex-1 min-w-0 space-y-2">
                <label htmlFor={`${baseId}-name`} className="sr-only">Name</label>
                <input id={`${baseId}-name`} type="text" value={c.name || ''} onChange={(e) => onPatch(idx, { name: e.target.value })}
                  placeholder="Name" maxLength={200}
                  className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-sm text-white focus:outline-none focus:border-port-accent" />
                <label htmlFor={`${baseId}-desc`} className="sr-only">Description</label>
                <textarea id={`${baseId}-desc`} rows={2} value={c[descField] ?? ''}
                  onChange={(e) => onPatch(idx, { [descField]: e.target.value })} placeholder="Short description"
                  className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-xs text-gray-200 focus:outline-none focus:border-port-accent" />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
