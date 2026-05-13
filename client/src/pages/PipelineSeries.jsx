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

import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Plus, Save, Trash2, Loader2, Workflow as WorkflowIcon, Globe, NotebookPen,
  PanelLeftClose, PanelLeftOpen,
} from 'lucide-react';
import toast from '../components/ui/Toast';
import ArcCanvas from '../components/pipeline/ArcCanvas';
import {
  getPipelineSeries, updatePipelineSeries,
  listPipelineIssues,
  listWorlds,
  PIPELINE_TARGET_FORMATS,
} from '../services/api';

const PIPELINE_SIDEBAR_KEY = 'portos-pipeline-series-sidebar-collapsed';

export default function PipelineSeries() {
  const { seriesId } = useParams();
  const navigate = useNavigate();
  const [series, setSeries] = useState(null);
  const [issues, setIssues] = useState([]);
  const [worlds, setWorlds] = useState([]);
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
      listWorlds().catch(() => []),
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

  const patchSeries = (patch) => setSeries((prev) => ({ ...prev, ...patch }));

  const handleSave = async () => {
    if (!series) return;
    setSaving(true);
    const updated = await updatePipelineSeries(series.id, {
      name: series.name,
      logline: series.logline,
      premise: series.premise,
      worldId: series.worldId || null,
      styleNotes: series.styleNotes,
      targetFormat: series.targetFormat,
      issueCountTarget: series.issueCountTarget,
      characters: series.characters,
    }).catch((err) => {
      toast.error(err.message || 'Save failed');
      return null;
    });
    setSaving(false);
    if (updated) {
      setSeries(updated);
      toast.success('Series saved');
    }
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

  // Tailwind doesn't accept arbitrary classes via interpolation, so the grid
  // template flips between collapsed-rail (48px) and expanded (360px) via two
  // explicit class strings. `minmax(0,1fr)` is required on the canvas column
  // so long titles in cards don't push the layout horizontally.
  const gridCls = sidebarCollapsed
    ? 'grid grid-cols-1 lg:grid-cols-[48px_minmax(0,1fr)] gap-4 lg:gap-6'
    : 'grid grid-cols-1 lg:grid-cols-[360px_minmax(0,1fr)] gap-4 lg:gap-6';

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
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
      </div>

      <div className={gridCls}>
        <aside className="lg:sticky lg:top-4 lg:self-start lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
          {sidebarCollapsed ? (
            <button
              type="button"
              onClick={toggleSidebar}
              className="hidden lg:flex w-12 h-12 items-center justify-center rounded-lg border border-port-border bg-port-card text-gray-400 hover:text-white hover:border-port-accent/40"
              title="Show series bible"
              aria-label="Expand series bible sidebar"
            >
              <PanelLeftOpen size={16} />
            </button>
          ) : (
            <BibleSidebar
              series={series}
              worlds={worlds}
              patchSeries={patchSeries}
              onAddCharacter={handleAddCharacter}
              onUpdateCharacter={handleUpdateCharacter}
              onRemoveCharacter={handleRemoveCharacter}
              onCollapse={toggleSidebar}
            />
          )}
        </aside>

        <main className="min-w-0">
          <ArcCanvas
            series={series}
            issues={issues}
            onSeriesUpdate={setSeries}
            onIssuesUpdate={handleIssuesUpdate}
          />
        </main>
      </div>
    </div>
  );
}

function BibleSidebar({ series, worlds, patchSeries, onAddCharacter, onUpdateCharacter, onRemoveCharacter, onCollapse }) {
  return (
    <section className="p-4 bg-port-card border border-port-border rounded-lg space-y-4">
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
      <Field label="Target format">
        <select
          value={series.targetFormat || 'comic+tv'}
          onChange={(e) => patchSeries({ targetFormat: e.target.value })}
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
        >
          {PIPELINE_TARGET_FORMATS.map((tf) => <option key={tf} value={tf}>{tf}</option>)}
        </select>
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
      <Field label="Target issue count">
        <input
          type="number"
          min={0}
          max={999}
          value={series.issueCountTarget || 0}
          onChange={(e) => patchSeries({ issueCountTarget: parseInt(e.target.value, 10) || 0 })}
          className="w-32 px-3 py-2 bg-port-bg border border-port-border rounded text-white"
        />
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

      <Field label="Linked World (from World Builder)">
        <div className="flex items-center gap-2">
          <select
            value={series.worldId || ''}
            onChange={(e) => patchSeries({ worldId: e.target.value || null })}
            className="flex-1 px-3 py-2 bg-port-bg border border-port-border rounded text-white"
          >
            <option value="">— None —</option>
            {worlds.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <Link
            to={series.worldId ? `/world-builder` : '/world-builder'}
            className="inline-flex items-center gap-1 text-xs text-port-accent hover:underline whitespace-nowrap"
          >
            <Globe size={12} />
            {series.worldId ? 'Open' : 'Create'}
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
