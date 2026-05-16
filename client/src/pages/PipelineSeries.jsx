/**
 * Pipeline — Series detail page.
 *
 * Two-pane layout (Phase 1 of the Story Arc Planning redesign):
 *   - Left  : bible sidebar (name, logline, premise, characters, style, world). Sticky,
 *             internally scrollable, collapsible into a hairline rail at lg+. State
 *             persists in localStorage under PIPELINE_SIDEBAR_KEY.
 *   - Right : structural canvas — today a card grid of issues/episodes; in subsequent
 *             phases it becomes the Arc → Season → Episode tree.
 * Mobile (< lg): single column, sidebar reflows above canvas.
 */

import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Plus, Save, Trash2, Loader2, Workflow as WorkflowIcon, Globe, NotebookPen,
  PanelLeftClose, PanelLeftOpen,
} from 'lucide-react';
import toast from '../components/ui/Toast';
import ArcCanvas from '../components/pipeline/ArcCanvas';
import VisualStylePicker from '../components/pipeline/VisualStylePicker';
import {
  getPipelineSeries, updatePipelineSeries,
  listPipelineIssues,
  listUniverses,
} from '../services/api';
import { recommendStructure, describeStructure } from '../lib/seasonStructure';

const PIPELINE_SIDEBAR_KEY = 'portos-pipeline-series-sidebar-collapsed';

export default function PipelineSeries() {
  const { seriesId } = useParams();
  const navigate = useNavigate();
  const [series, setSeries] = useState(null);
  const [issues, setIssues] = useState([]);
  const [universes, setWorlds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    return localStorage.getItem(PIPELINE_SIDEBAR_KEY) === 'true';
  });

  useEffect(() => {
    let canceled = false;
    Promise.all([
      getPipelineSeries(seriesId),
      listPipelineIssues(seriesId),
      listUniverses().catch(() => []),
    ])
      .then(([s, is, ws]) => {
        if (canceled) return;
        setSeries(s);
        setIssues(Array.isArray(is) ? is : []);
        setWorlds(Array.isArray(ws) ? ws : []);
      })
      .catch((err) => {
        if (canceled) return;
        toast.error(err.message || 'Failed to load series');
        navigate('/pipeline');
      })
      .finally(() => { if (!canceled) setLoading(false); });
    return () => { canceled = true; };
  }, [seriesId, navigate]);

  const toggleSidebar = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(PIPELINE_SIDEBAR_KEY, String(next));
      return next;
    });
  };

  // Track the last server-persisted snapshot so `flushPending` knows whether
  // the local draft has diverged. Ref instead of state — we don't want
  // re-renders, just up-to-date comparison data for the async LLM hooks below.
  const lastSavedRef = useRef(null);
  useEffect(() => { if (series && !lastSavedRef.current) lastSavedRef.current = series; }, [series]);

  const patchSeries = (patch) => setSeries((prev) => ({ ...prev, ...patch }));

  // Wrapped setter that ArcCanvas (and other LLM-flow children) use when the
  // server has just confirmed a save. Keeps the dirty-check ref aligned so a
  // subsequent flushPending() doesn't re-PATCH the same state.
  const updateSeriesFromServer = (next) => {
    setSeries(next);
    lastSavedRef.current = next;
  };

  // If local bible fields diverged from the last server snapshot, PATCH so
  // generate / verify / resolve work against the on-screen state. Returns
  // `true` if a save occurred so the caller can decide whether to surface a
  // confirmation toast.
  const flushPending = async () => {
    if (!series) return false;
    const saved = lastSavedRef.current || series;
    const fields = ['name', 'logline', 'premise', 'styleNotes', 'issueCountTarget', 'universeId'];
    const dirty = fields.some((k) => (series[k] ?? '') !== (saved[k] ?? ''))
      || JSON.stringify(series.characters || []) !== JSON.stringify(saved.characters || [])
      || JSON.stringify(series.llm || {}) !== JSON.stringify(saved.llm || {});
    if (!dirty) return false;
    const updated = await updatePipelineSeries(series.id, {
      name: series.name,
      logline: series.logline,
      premise: series.premise,
      universeId: series.universeId || null,
      styleNotes: series.styleNotes,
      issueCountTarget: series.issueCountTarget,
      characters: series.characters,
      llm: series.llm || { provider: null, model: null },
    }).catch((err) => {
      toast.error(`Pre-flush save failed: ${err.message}`);
      return null;
    });
    if (!updated) return false;
    setSeries(updated);
    lastSavedRef.current = updated;
    return true;
  };

  const handleSave = async () => {
    if (!series) return;
    setSaving(true);
    const didSave = await flushPending();
    setSaving(false);
    if (didSave) toast.success('Series saved');
  };

  const handleAddCharacter = () => {
    patchSeries({
      characters: [
        ...(series.characters || []),
        { name: '', role: '', physicalDescription: '', personality: '', background: '' },
      ],
    });
  };
  const handleUpdateCharacter = (i, patch) => {
    const next = [...series.characters];
    next[i] = { ...next[i], ...patch };
    patchSeries({ characters: next });
  };
  const handleRemoveCharacter = (i) => {
    patchSeries({ characters: series.characters.filter((_, j) => j !== i) });
  };

  // ArcCanvas mutates issues via a setter-style update (`setState(fn)`-shaped)
  // so child components can do prev-aware patches without parent intervention.
  // Plain array updates also work — flatten through `Array.isArray` to keep
  // both shapes supported.
  const handleIssuesUpdate = (update) => {
    setIssues((prev) => {
      if (typeof update === 'function') return update(prev);
      if (Array.isArray(update)) return update;
      return prev;
    });
  };

  if (loading) return <div className="p-6 text-gray-500 text-sm">Loading series…</div>;
  if (!series) return null;

  // Mobile = flex column (grid template ignored); lg+ = grid where the inline
  // `gridTemplateColumns` swap between collapsed/expanded widths takes effect.
  // Mirrors the UniverseBuilder full-bleed layout so the bible rail sits flush
  // against the main app sidebar instead of floating inside Layout padding.
  // Collapsed track is 0px (not a thin rail) — matches CoS pattern where a
  // floating expand button stands in for the rail.
  const desktopGridCols = sidebarCollapsed ? '0px minmax(0, 1fr)' : '360px minmax(0, 1fr)';

  return (
    <div className="flex flex-col h-full">
      <div
        className="relative flex-1 flex flex-col lg:grid min-h-0 transition-[grid-template-columns] duration-200"
        style={{ gridTemplateColumns: desktopGridCols }}
      >
        {sidebarCollapsed && (
          <button
            type="button"
            onClick={toggleSidebar}
            className="hidden lg:flex absolute left-0 top-2 z-20 p-1.5 text-gray-500 hover:text-white transition-colors rounded-r-md hover:bg-port-card bg-port-card/60 border border-l-0 border-port-border"
            title="Show series bible"
            aria-label="Expand series bible sidebar"
          >
            <PanelLeftOpen size={16} />
          </button>
        )}
        {sidebarCollapsed ? (
          <div className="hidden lg:block overflow-hidden min-w-0" />
        ) : (
          <aside className="border-b lg:border-b-0 lg:border-r border-port-border bg-port-card/40 lg:overflow-y-auto">
            <BibleSidebar
              series={series}
              universes={universes}
              patchSeries={patchSeries}
              onAddCharacter={handleAddCharacter}
              onUpdateCharacter={handleUpdateCharacter}
              onRemoveCharacter={handleRemoveCharacter}
              onCollapse={toggleSidebar}
            />
          </aside>
        )}

        <section className="flex flex-col gap-4 p-4 min-h-0 lg:overflow-y-auto">
          <header className="flex items-center gap-3 flex-wrap">
            <Link to="/pipeline" className="inline-flex items-center gap-1 text-sm text-gray-400 hover:text-white">
              <ArrowLeft size={14} /> All Series
            </Link>
            <WorkflowIcon className="w-5 h-5 text-port-accent ml-2" />
            <h1 className="text-xl font-bold text-white truncate">{series.name || 'Untitled series'}</h1>
            {series.writersRoomWorkId ? (
              <Link
                to={`/writers-room/works/${encodeURIComponent(series.writersRoomWorkId)}`}
                className="ml-2 inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-gray-400 hover:text-white border border-port-border bg-port-card"
                title="Open the Writers Room draft this series was promoted from"
              >
                <NotebookPen size={12} /> Writers Room
              </Link>
            ) : null}
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="ml-auto inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-accent text-white text-sm font-medium disabled:opacity-50"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Save series
            </button>
          </header>

          <ArcCanvas
            series={series}
            issues={issues}
            onSeriesUpdate={updateSeriesFromServer}
            onIssuesUpdate={handleIssuesUpdate}
            onFlushPending={flushPending}
          />
        </section>
      </div>
    </div>
  );
}

function BibleSidebar({ series, universes, patchSeries, onAddCharacter, onUpdateCharacter, onRemoveCharacter, onCollapse }) {
  return (
    <section className="px-3 py-3 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xs uppercase tracking-wider text-gray-500">Bible</h2>
        <button
          type="button"
          onClick={onCollapse}
          className="hidden lg:inline-flex p-1.5 rounded text-gray-500 hover:text-white hover:bg-port-bg"
          title="Collapse bible sidebar"
          aria-label="Collapse bible sidebar"
        >
          <PanelLeftClose size={14} />
        </button>
      </div>

      <Field label="Name">
        <input
          value={series.name || ''}
          onChange={(e) => patchSeries({ name: e.target.value })}
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
          maxLength={200}
        />
      </Field>
      <Field label="Logline">
        <input
          value={series.logline || ''}
          onChange={(e) => patchSeries({ logline: e.target.value })}
          placeholder="One-sentence pitch"
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
          maxLength={500}
        />
      </Field>
      <Field label="Target issues / episodes">
        <div className="flex items-center gap-3 flex-wrap">
          <input
            type="number"
            min={0}
            max={999}
            value={series.issueCountTarget || 0}
            onChange={(e) => patchSeries({ issueCountTarget: parseInt(e.target.value, 10) || 0 })}
            className="w-32 px-3 py-2 bg-port-bg border border-port-border rounded text-white"
          />
          <StructureHint total={series.issueCountTarget || 0} />
        </div>
      </Field>

      <Field label="Premise (the bible — fed into every stage's prompt context)">
        <textarea
          value={series.premise || ''}
          onChange={(e) => patchSeries({ premise: e.target.value })}
          rows={5}
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
          maxLength={8000}
          placeholder="Longer free-form premise. World, tone, central conflict, hooks. Fed verbatim into every issue's stage prompts."
        />
      </Field>

      <Field label="Style notes (tonal / visual)">
        <textarea
          value={series.styleNotes || ''}
          onChange={(e) => patchSeries({ styleNotes: e.target.value })}
          rows={3}
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
          maxLength={4000}
          placeholder="moebius linework, washed sepia, slow zooms, ambient drones. Reused as the visual prefix for every image-gen call from this series."
        />
      </Field>

      <Field label="Visual style preset">
        <div className="flex items-center gap-2">
          <VisualStylePicker
            value={series.visualStyleDefault || null}
            onChange={(next) => patchSeries({ visualStyleDefault: next })}
          />
          <span className="text-xs text-gray-500">
            Applied to comic pages, storyboards, and episode video unless a stage overrides it.
          </span>
        </div>
      </Field>

      <Field label="Linked World (from Universe Builder)">
        <div className="flex items-center gap-2">
          <select
            value={series.universeId || ''}
            onChange={(e) => patchSeries({ universeId: e.target.value || null })}
            className="flex-1 px-3 py-2 bg-port-bg border border-port-border rounded text-white"
          >
            <option value="">— None —</option>
            {universes.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <Link
            to={series.universeId ? `/universe-builder` : '/universe-builder'}
            className="inline-flex items-center gap-1 text-xs text-port-accent hover:underline whitespace-nowrap"
          >
            <Globe size={12} />
            {series.universeId ? 'Open' : 'Create'}
          </Link>
        </div>
      </Field>

      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs uppercase tracking-wider text-gray-500">Characters</h3>
          <button
            type="button"
            onClick={onAddCharacter}
            className="inline-flex items-center gap-1 text-xs text-port-accent hover:underline"
          >
            <Plus size={12} /> Add
          </button>
        </div>
        {(series.characters || []).length === 0 ? (
          <p className="text-xs text-gray-600 italic">No characters yet — the bible has more bite once a few are defined.</p>
        ) : (
          <ul className="space-y-2">
            {series.characters.map((c, i) => (
              <li key={i} className="space-y-1 pb-2 border-b border-port-border/40 last:border-b-0 last:pb-0">
                <div className="flex gap-2 items-center">
                  <input
                    value={c.name || ''}
                    onChange={(e) => onUpdateCharacter(i, { name: e.target.value })}
                    placeholder="Name"
                    className="flex-1 px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm"
                    maxLength={200}
                  />
                  <input
                    value={c.role || ''}
                    onChange={(e) => onUpdateCharacter(i, { role: e.target.value })}
                    placeholder="Role"
                    className="w-24 px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-xs"
                    maxLength={200}
                  />
                  <button
                    type="button"
                    onClick={() => onRemoveCharacter(i)}
                    className="text-gray-500 hover:text-port-error p-1.5"
                    aria-label="Remove character"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
                <textarea
                  value={c.physicalDescription || ''}
                  onChange={(e) => onUpdateCharacter(i, { physicalDescription: e.target.value })}
                  placeholder="Physical description — age, build, hair, eyes, wardrobe; drives image-gen"
                  rows={3}
                  className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-xs resize-y"
                  maxLength={2000}
                />
                <textarea
                  value={c.personality || ''}
                  onChange={(e) => onUpdateCharacter(i, { personality: e.target.value })}
                  placeholder="Personality — temperament, voice, quirks"
                  rows={2}
                  className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-xs resize-y"
                  maxLength={2000}
                />
                <textarea
                  value={c.background || ''}
                  onChange={(e) => onUpdateCharacter(i, { background: e.target.value })}
                  placeholder="Background — who they are, where they come from"
                  rows={2}
                  className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-xs resize-y"
                  maxLength={2000}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="block text-xs uppercase tracking-wider text-gray-500 mb-1">{label}</span>
      {children}
    </label>
  );
}

function StructureHint({ total }) {
  const structure = recommendStructure(total);
  if (!structure) {
    return (
      <span className="text-xs text-gray-500 italic">
        Enter total issues — we'll suggest a volume/season split (norm: 6–10 per volume).
      </span>
    );
  }
  return (
    <span className="text-xs text-gray-400">
      Suggested: <span className="text-port-accent">{describeStructure(structure)}</span>
    </span>
  );
}
