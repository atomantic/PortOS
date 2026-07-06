/**
 * Pipeline — Series detail page.
 *
 * Two-pane layout (Phase 1 of the Story Arc Planning redesign):
 *   - Left  : bible sidebar (name, logline, premise, style, linked universe). Sticky,
 *             internally scrollable, collapsible into a hairline rail at lg+. State
 *             persists in localStorage under PIPELINE_SIDEBAR_KEY.
 *   - Right : structural canvas — today a card grid of issues/episodes; in subsequent
 *             phases it becomes the Arc → Season → Episode tree.
 * Mobile (< lg): single column, sidebar reflows above canvas.
 */

import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Save, Loader2, Workflow as WorkflowIcon, Globe, NotebookPen,
  PanelLeftClose, PanelLeftOpen, Sparkles, BookOpen, FileInput, Compass, BookMarked,
  Fingerprint, Plus, Trash2,
} from 'lucide-react';
import toast from '../components/ui/Toast';
import ArcCanvas from '../components/pipeline/ArcCanvas';
import AutopilotPanel from '../components/pipeline/AutopilotPanel';
import CatalogCastPanel from '../components/CatalogCastPanel';
import TabPills from '../components/ui/TabPills';
import {
  getPipelineSeries, updatePipelineSeries,
  listPipelineIssues,
  listUniverses,
  generateSeriesTitleLogo,
  SERIES_TITLE_LOGO_MAX,
} from '../services/api';
import AuthorPicker from '../components/pipeline/AuthorPicker';
import { buildImporterLink } from '../lib/importerDeepLink';
import { recommendStructure, describeStructure } from '../lib/seasonStructure';
import { useLocalStorageBool } from '../hooks/useLocalStorageBool';
import { useArcCanvasSync } from '../hooks/useArcCanvasSync';

const PIPELINE_SIDEBAR_KEY = 'portos-pipeline-series-sidebar-collapsed';

// Mirrors `STYLE_PROMPT_OVERRIDE_MODES` on the server (series.js). The
// default lives there too — keep this list in sync if a new mode lands.
const STYLE_OVERRIDE_MODE_DEFAULT = 'prepend';
const STYLE_OVERRIDE_MODE_TABS = [
  { id: 'prepend', label: 'Prepend' },
  { id: 'append', label: 'Append' },
  { id: 'override', label: 'Replace' },
];

// Bible fields the host flushes before an ArcCanvas generate/verify, plus the
// empty-value defaults the server expects for the optional ones. Module-level
// constants so the `useArcCanvasSync` callbacks keep a stable identity.
const ARC_FLUSH_FIELDS = [
  'name', 'logline', 'premise', 'styleNotes', 'factCritical', 'factReference', 'styleGuide',
  'titleLogo', 'author', 'authorId',
  'stylePromptOverride', 'stylePromptOverrideMode', 'issueCountTarget', 'universeId', 'characterArcs',
];
const ARC_PAYLOAD_DEFAULTS = {
  titleLogo: '',
  author: '',
  authorId: null,
  stylePromptOverride: '',
  stylePromptOverrideMode: STYLE_OVERRIDE_MODE_DEFAULT,
  // Fact-checking opt-in + author fact reference (#1588). false / '' are the
  // server-sanitizer defaults for "not fact-critical" / "no reference".
  factCritical: false,
  factReference: '',
  // Structured house style — null means "no style guide", which the server
  // sanitizer also produces from an all-empty guide.
  styleGuide: null,
  // Per-character story arcs (#1293) — [] means "no authored arcs"; the server
  // sanitizer drops empty arcs/beats and dedupes by character identity.
  characterArcs: [],
};

// Style-guide option lists — mirror the enums in server/lib/styleGuide.js. Each
// select carries a blank ("—") option so a field can be left unset (null).
const STYLE_GUIDE_FIELDS = [
  { key: 'tense', label: 'Tense', options: [['past', 'Past'], ['present', 'Present']] },
  { key: 'povPerson', label: 'POV person', options: [['first', 'First person'], ['third-limited', 'Third — limited'], ['third-omniscient', 'Third — omniscient'], ['second', 'Second person']] },
  { key: 'targetAudience', label: 'Target audience', options: [['children', 'Children'], ['middle-grade', 'Middle-grade'], ['YA', 'YA'], ['adult', 'Adult']] },
  { key: 'contentRating', label: 'Content rating', options: [['G', 'G'], ['PG', 'PG'], ['PG-13', 'PG-13'], ['R', 'R'], ['custom', 'Custom']] },
  { key: 'profanity', label: 'Profanity', options: [['none', 'None'], ['mild', 'Mild'], ['moderate', 'Moderate'], ['strong', 'Strong']] },
];
// Voice exemplar caps — mirror STYLE_GUIDE_LIMITS in server/lib/styleGuide.js
// so the editor bounds match the server sanitizer (#2179).
const STYLE_GUIDE_EXEMPLARS_MAX = 3;
const STYLE_GUIDE_EXEMPLAR_PASSAGE_MAX = 2000;
const STYLE_GUIDE_EXEMPLAR_NOTE_MAX = 200;
// Tri-state boolean conventions rendered as —/Yes/No selects so "unset" stays
// distinct from "No" (matches the server's tri-state sanitizer).
const STYLE_GUIDE_TRISTATE = [
  { key: 'oxfordComma', label: 'Oxford comma' },
  { key: 'italicizeThoughts', label: 'Italicize thoughts' },
];

export default function PipelineSeries() {
  const { seriesId } = useParams();
  const navigate = useNavigate();
  const [series, setSeries] = useState(null);
  const [issues, setIssues] = useState([]);
  const [universes, setWorlds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorageBool(
    PIPELINE_SIDEBAR_KEY,
    false,
    { format: 'true' },
  );

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

  const toggleSidebar = () => setSidebarCollapsed((prev) => !prev);

  const patchSeries = (patch) => setSeries((prev) => ({ ...prev, ...patch }));

  // Host-side ArcCanvas wiring (lastSavedRef dirty-check + server-confirmed
  // setters). Flushes the full bible field-set; the API helper's auto-toast is
  // suppressed (silent) so `onFlushError` emits the single failure toast that
  // tells the user their edits didn't persist.
  const { updateSeriesFromServer, handleIssuesUpdate, flushPending } = useArcCanvasSync({
    series,
    setSeries,
    setIssues,
    flushFields: ARC_FLUSH_FIELDS,
    payloadDefaults: ARC_PAYLOAD_DEFAULTS,
    silent: true,
    onFlushError: (err) => toast.error(`Pre-flush save failed: ${err.message}`),
  });

  const handleSave = async () => {
    if (!series) return;
    setSaving(true);
    const didSave = await flushPending();
    setSaving(false);
    if (didSave) toast.success('Series saved');
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
              onSeriesUpdate={updateSeriesFromServer}
              onFlushPending={flushPending}
              onCollapse={toggleSidebar}
            />
          </aside>
        )}

        <section className="@container flex flex-col gap-4 p-4 min-h-0 lg:overflow-y-auto">
          <header className={`flex items-center gap-3 flex-wrap ${sidebarCollapsed ? 'lg:pl-8' : ''}`}>
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
            <Link
              to={`/pipeline/series/${series.id}/manuscript`}
              className="ml-2 inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-gray-400 hover:text-white border border-port-border bg-port-card"
              title="Open the full manuscript editor"
            >
              <BookOpen size={12} /> Manuscript
            </Link>
            <Link
              to={`/pipeline/series/${series.id}/reverse-outline`}
              className="ml-2 inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-gray-400 hover:text-white border border-port-border bg-port-card"
              title="Map the drafted manuscript into a color-coded scene-by-plotline reverse outline"
            >
              <Compass size={12} /> Reverse Outline
            </Link>
            <Link
              to={`/pipeline/series/${series.id}/continuity-bible`}
              className="ml-2 inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-gray-400 hover:text-white border border-port-border bg-port-card"
              title="Browse the established-facts ledger — physical traits, ages, dates, places, possessions, world rules, and who knows what"
            >
              <BookMarked size={12} /> Continuity
            </Link>
            <Link
              to={`/pipeline/series/${series.id}/voice-fingerprint`}
              className="ml-2 inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-gray-400 hover:text-white border border-port-border bg-port-card"
              title="See every issue's statistical prose fingerprint (sentence rhythm, register, dialogue ratio…) with drift outliers highlighted"
            >
              <Fingerprint size={12} /> Voice Fingerprint
            </Link>
            <Link
              to={buildImporterLink({ universeId: series.universeId, seriesId: series.id })}
              className="ml-2 inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-gray-400 hover:text-white border border-port-border bg-port-card"
              title="Import an existing manuscript, novel, screenplay, or comic script into this series"
            >
              <FileInput size={12} /> Import
            </Link>
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

          <AutopilotPanel
            series={series}
            onSeriesUpdate={updateSeriesFromServer}
            onIssuesUpdate={handleIssuesUpdate}
          />

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

function BibleSidebar({ series, universes, patchSeries, onSeriesUpdate, onFlushPending, onCollapse }) {
  const [generatingLogo, setGeneratingLogo] = useState(false);
  const handleGenerateLogo = async () => {
    // Server reads from disk — flush dirty edits so the LLM sees fresh fields.
    if (onFlushPending) await onFlushPending();
    setGeneratingLogo(true);
    const result = await generateSeriesTitleLogo(series.id).catch((err) => {
      toast.error(err.message || 'Failed to design logo');
      return null;
    });
    setGeneratingLogo(false);
    if (!result) return;
    onSeriesUpdate?.(result.series);
    toast.success('Logo concept designed');
  };

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
      <Field label="Author (cover byline + title screen)">
        <AuthorPicker
          value={series.authorId}
          byline={series.author}
          onChange={(authorId, name) => patchSeries({ authorId: authorId || null, author: name })}
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

      <Field label="Primary manuscript format (source of truth)">
        <div className="flex items-center gap-2">
          <select
            id="series-primary-manuscript"
            value={series.primaryManuscriptType || ''}
            onChange={async (e) => {
              const value = e.target.value || null;
              patchSeries({ primaryManuscriptType: value });
              const updated = await updatePipelineSeries(series.id, { primaryManuscriptType: value }, { silent: true })
                .catch((err) => { toast.error(err.message || 'Failed to set primary format'); return null; });
              if (updated) onSeriesUpdate?.(updated);
            }}
            className="flex-1 px-3 py-2 bg-port-bg border border-port-border rounded text-white"
          >
            <option value="">— Auto-detect —</option>
            <option value="comicScript">Comic</option>
            <option value="teleplay">Teleplay</option>
            <option value="prose">Prose</option>
          </select>
          <Link
            to={`/pipeline/series/${series.id}/manuscript`}
            className="inline-flex items-center gap-1 text-xs text-port-accent hover:underline whitespace-nowrap"
            title="Open the full manuscript editor"
          >
            <NotebookPen size={12} /> Editor
          </Link>
        </div>
        <p className="text-[11px] text-gray-500 mt-1">
          The format you finalize first — the other two are generated from it. The manuscript editor opens this format by default.
        </p>
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

      <StyleGuideSection series={series} patchSeries={patchSeries} />

      <FactReferenceSection series={series} patchSeries={patchSeries} />

      <CharacterArcsSection series={series} patchSeries={patchSeries} />

      <div className="block">
        <div className="flex items-center justify-between mb-1">
          <label
            htmlFor="series-title-logo"
            className="block text-xs uppercase tracking-wider text-gray-500"
          >
            Title / logo design
          </label>
          <button
            type="button"
            onClick={handleGenerateLogo}
            disabled={generatingLogo}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] text-port-accent hover:bg-port-bg disabled:opacity-50"
            title="Design the masthead/logo with an LLM, using the series name + logline + style notes + universe influences"
          >
            {generatingLogo ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
            {series.titleLogo ? 'Regenerate' : 'Design'}
          </button>
        </div>
        <textarea
          id="series-title-logo"
          value={series.titleLogo || ''}
          onChange={(e) => patchSeries({ titleLogo: e.target.value })}
          rows={4}
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
          maxLength={SERIES_TITLE_LOGO_MAX}
          placeholder="A description of the series masthead — letterform, finish, color, motifs. Injected into every cover prompt and TV title screen. Click Design to generate from the bible + universe."
        />
        <p className="text-[11px] text-gray-500 mt-1">
          Generated once on series creation from a universe; edit freely. Used by issue covers, volume covers, and TV title screens.
        </p>
      </div>

      <Field label="Linked Universe">
        <div className="flex items-center gap-2">
          <select
            value={series.universeId || ''}
            onChange={(e) => patchSeries({ universeId: e.target.value })}
            className="flex-1 px-3 py-2 bg-port-bg border border-port-border rounded text-white"
          >
            {/* Legacy / imported series may still carry `universeId: null` —
                offer a sentinel option so the picker doesn't auto-snap them
                to whatever the first universe in the list happens to be. */}
            {!series.universeId ? <option value="">— Pick a universe —</option> : null}
            {universes.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <Link
            to={series.universeId ? `/universes/${encodeURIComponent(series.universeId)}` : '/universes'}
            className="inline-flex items-center gap-1 text-xs text-port-accent hover:underline whitespace-nowrap"
          >
            <Globe size={12} /> Open
          </Link>
        </div>
      </Field>

      <Field label="Universe style override (this series only)">
        <div className="mb-2">
          <TabPills
            variant="pills"
            size="xs"
            tabs={STYLE_OVERRIDE_MODE_TABS}
            activeTab={series.stylePromptOverrideMode || STYLE_OVERRIDE_MODE_DEFAULT}
            onChange={(id) => {
              if (id === (series.stylePromptOverrideMode || STYLE_OVERRIDE_MODE_DEFAULT)) return;
              patchSeries({ stylePromptOverrideMode: id });
            }}
            ariaLabel="Universe style override mode"
          />
        </div>
        <textarea
          value={series.stylePromptOverride || ''}
          onChange={(e) => patchSeries({ stylePromptOverride: e.target.value })}
          rows={2}
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
          maxLength={1000}
          placeholder="moody noir lighting, high contrast monochrome. Composed with the universe's style for every image-gen call from this series."
        />
        <p className="text-[11px] text-gray-500 mt-1">
          <strong>Prepend</strong> (default) puts the override ahead of the universe's <em>stylePrompt</em>; <strong>Append</strong> trails it; <strong>Replace</strong> drops the universe style entirely. Leave the box blank to use the universe style verbatim.
        </p>
      </Field>

      <CatalogCastPanel refKind="series" refId={series.id} refLabel={series.name || 'this series'} />

      <div>
        <h3 className="text-xs uppercase tracking-wider text-gray-500 mb-2">Canon</h3>
        {series.universeId ? (
          // `#canon` scrolls to the embedded canon section (id="canon" on
          // UniverseCanonSection) so users land on the folded-in canon UI
          // instead of the bible at the top of the builder.
          <Link
            to={`/universes/${encodeURIComponent(series.universeId)}#canon`}
            className="block text-xs text-port-accent hover:underline"
          >
            Manage characters, places, and objects on the linked Universe →
          </Link>
        ) : (
          <p className="text-xs text-gray-600 italic">
            Link a universe above to author characters, places, and objects shared
            across this series' issues.
          </p>
        )}
      </div>
    </section>
  );
}

// Per-series house style (#1303). Structured tense/POV/audience/rating/reading-
// level/tone/conventions, edited into local series state via patchSeries and
// persisted on Save (styleGuide is in ARC_FLUSH_FIELDS). Picking the blank
// option clears a field to null; the server collapses an all-empty guide to
// null. Each control is htmlFor/id paired for screen readers + click-to-focus.
function StyleGuideSection({ series, patchSeries }) {
  const sg = series.styleGuide || {};
  const conv = sg.conventions || {};
  const setSG = (patch) => patchSeries({ styleGuide: pruneEmpty({ ...sg, ...patch }) });
  const setConv = (patch) => setSG({ conventions: pruneEmpty({ ...conv, ...patch }) });

  return (
    <div className="block">
      <h3 className="text-xs uppercase tracking-wider text-gray-500 mb-2">Style guide (house style)</h3>
      <p className="text-[11px] text-gray-500 mb-3 -mt-1">
        Structured tense / POV / audience / rating fed into generation and checked by the editorial conformance checks.
      </p>
      <div className="grid grid-cols-2 gap-2">
        {STYLE_GUIDE_FIELDS.map(({ key, label, options }) => (
          <SgSelect
            key={key}
            id={`sg-${key}`}
            label={label}
            value={sg[key] || ''}
            options={options}
            onChange={(e) => setSG({ [key]: e.target.value || null })}
          />
        ))}
        <div className="block">
          <label htmlFor="sg-readingLevel" className="block text-[11px] text-gray-500 mb-1">Reading level (grade)</label>
          <input
            id="sg-readingLevel"
            type="number"
            min={1}
            max={18}
            value={Number.isFinite(sg.readingLevel) ? sg.readingLevel : ''}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              setSG({ readingLevel: Number.isFinite(n) ? n : null });
            }}
            className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm"
          />
        </div>
      </div>

      <div className="mt-2">
        <label htmlFor="sg-tone" className="block text-[11px] text-gray-500 mb-1">Tone (comma-separated)</label>
        <input
          id="sg-tone"
          value={Array.isArray(sg.tone) ? sg.tone.join(', ') : ''}
          onChange={(e) => {
            const tone = e.target.value.split(',').map((t) => t.trim()).filter(Boolean);
            setSG({ tone: tone.length ? tone : null });
          }}
          placeholder="noir, hopeful, wry"
          className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm"
        />
      </div>

      <div className="grid grid-cols-3 gap-2 mt-2">
        <SgSelect
          id="sg-spelling"
          label="Spelling"
          value={conv.spelling || ''}
          options={[['US', 'US'], ['UK', 'UK']]}
          onChange={(e) => setConv({ spelling: e.target.value || null })}
        />
        {STYLE_GUIDE_TRISTATE.map(({ key, label }) => (
          <SgSelect
            key={key}
            id={`sg-${key}`}
            label={label}
            value={triValue(conv[key])}
            options={TRISTATE_OPTIONS}
            onChange={(e) => setConv({ [key]: triParse(e.target.value) })}
          />
        ))}
      </div>

      <VoiceExemplarEditor
        idPrefix="sg-voice-exemplar"
        title="Voice exemplars (the tuning fork)"
        hint="1–3 short passages (~150–300 words) that nail the series' voice. Injected into every draft/revision prompt as “MATCH this voice”. A concrete anchor beats any adjective list."
        notePlaceholder="what this demonstrates (e.g. spare, close-psychic)"
        entries={Array.isArray(sg.voiceExemplars) ? sg.voiceExemplars : []}
        onChange={(next) => setSG({ voiceExemplars: next.length ? next : null })}
      />

      <VoiceExemplarEditor
        idPrefix="sg-voice-anti"
        title="Anti-exemplars (never drift toward this)"
        hint="Passages in the wrong register, kept as negative examples. Injected as “NEVER drift toward this”."
        notePlaceholder="what's wrong (e.g. too ornate, wrong temperature)"
        entries={Array.isArray(sg.voiceAntiExemplars) ? sg.voiceAntiExemplars : []}
        onChange={(next) => setSG({ voiceAntiExemplars: next.length ? next : null })}
      />
    </div>
  );
}

// Editor for the voice exemplar / anti-exemplar passage lists (#2179). Each row
// is `{ passage, note }`; the passage textarea is required (an empty passage
// prunes the row), the note is an optional one-liner. Capped at
// STYLE_GUIDE_EXEMPLARS_MAX rows. All labels are htmlFor/id paired.
function VoiceExemplarEditor({ idPrefix, title, hint, notePlaceholder, entries, onChange }) {
  const setEntry = (i, patch) => onChange(entries.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));
  const removeEntry = (i) => onChange(entries.filter((_, idx) => idx !== i));
  const addEntry = () => onChange([...entries, { passage: '', note: '' }]);

  return (
    <div className="mt-3">
      <h4 className="text-[11px] uppercase tracking-wider text-gray-500 mb-1">{title}</h4>
      <p className="text-[11px] text-gray-500 mb-2 -mt-0.5">{hint}</p>
      <div className="space-y-2">
        {entries.map((entry, i) => (
          <div key={i} className="border border-port-border rounded p-2 bg-port-bg/50">
            <label htmlFor={`${idPrefix}-passage-${i}`} className="block text-[11px] text-gray-500 mb-1">Passage {i + 1}</label>
            <textarea
              id={`${idPrefix}-passage-${i}`}
              value={entry.passage || ''}
              onChange={(e) => setEntry(i, { passage: e.target.value })}
              rows={4}
              maxLength={STYLE_GUIDE_EXEMPLAR_PASSAGE_MAX}
              placeholder="Paste a short prose passage that captures the voice."
              className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm font-mono"
            />
            <div className="flex items-center gap-2 mt-1">
              <label htmlFor={`${idPrefix}-note-${i}`} className="sr-only">Note for passage {i + 1}</label>
              <input
                id={`${idPrefix}-note-${i}`}
                value={entry.note || ''}
                onChange={(e) => setEntry(i, { note: e.target.value })}
                maxLength={STYLE_GUIDE_EXEMPLAR_NOTE_MAX}
                placeholder={notePlaceholder}
                className="flex-1 px-2 py-1 bg-port-bg border border-port-border rounded text-white text-xs"
              />
              <button
                type="button"
                onClick={() => removeEntry(i)}
                className="px-2 py-1 text-xs text-port-error hover:bg-port-error/10 rounded"
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
      {entries.length < STYLE_GUIDE_EXEMPLARS_MAX && (
        <button
          type="button"
          onClick={addEntry}
          className="mt-2 px-2 py-1 text-xs text-port-accent hover:bg-port-accent/10 rounded border border-port-border"
        >
          + Add passage
        </button>
      )}
    </div>
  );
}

// The change-beat kinds the arc.transitions editorial check recognizes — mirror
// TRANSITION_KINDS in server/lib/seriesCharacterArc.js.
const TRANSITION_KIND_OPTIONS = [
  ['decision', 'Decision'],
  ['realization', 'Realization'],
  ['point-of-no-return', 'Point of no return'],
  ['relapse', 'Relapse'],
  ['sacrifice', 'Sacrifice'],
];

// Fact-checking opt-in + author fact reference (#1588). When the series is flagged
// fact-critical AND a non-empty reference is supplied, the gated research.fact-accuracy
// editorial check reconciles the prose against these documented real-world facts.
// Both fields persist on Save (factCritical / factReference are in ARC_FLUSH_FIELDS).
// The toggle is htmlFor/id paired; the textarea is only meaningful (and shown
// prominently) once the toggle is on, so it stays collapsed for pure-fantasy series.
function FactReferenceSection({ series, patchSeries }) {
  const factCritical = series.factCritical === true;
  return (
    <div className="block">
      <h3 className="text-xs uppercase tracking-wider text-gray-500 mb-2">Fact accuracy (grounded series)</h3>
      <label htmlFor="fact-critical" className="flex items-start gap-2 cursor-pointer mb-2">
        <input
          id="fact-critical"
          type="checkbox"
          checked={factCritical}
          onChange={(e) => patchSeries({ factCritical: e.target.checked })}
          className="mt-0.5 accent-port-accent"
        />
        <span className="text-xs text-gray-300">
          Fact-critical series
          <span className="block text-[11px] text-gray-500">
            Enable the real-world fact-accuracy editorial check. Leave off for pure fantasy, where the check would second-guess deliberate invention.
          </span>
        </span>
      </label>
      {factCritical && (
        <label htmlFor="fact-reference" className="block">
          <span className="block text-xs uppercase tracking-wider text-gray-500 mb-1">Fact reference (real-world ground truth)</span>
          <textarea
            id="fact-reference"
            value={series.factReference || ''}
            onChange={(e) => patchSeries({ factReference: e.target.value })}
            rows={5}
            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
            maxLength={8000}
            placeholder="Documented real-world facts the prose must respect: geography, dates, technology timelines, physical/physiological limits. The fact-accuracy check flags prose claims that contradict what you write here."
          />
        </label>
      )}
    </div>
  );
}

// Per-character story arcs (#1293). Authored want/need, start → end state, and
// explicit transition beats, edited into local series state via patchSeries and
// persisted on Save (characterArcs is in ARC_FLUSH_FIELDS). The server sanitizer
// drops empty arcs/beats and dedupes by character identity, so the editor stays
// permissive — a freshly-added blank arc simply doesn't persist until named. The
// arc.transitions editorial check reconciles its detected change moments against
// what's authored here and flags characters with no transition scenes (flat arcs).
function CharacterArcsSection({ series, patchSeries }) {
  const arcs = Array.isArray(series.characterArcs) ? series.characterArcs : [];
  const setArcs = (next) => patchSeries({ characterArcs: next });
  const setArc = (i, patch) => setArcs(arcs.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));
  const addArc = () => setArcs([...arcs, { characterName: '', want: '', need: '', startState: '', endState: '', transitions: [] }]);
  const removeArc = (i) => setArcs(arcs.filter((_, idx) => idx !== i));

  const setTransitions = (i, next) => setArc(i, { transitions: next });
  const addTransition = (i) => {
    const cur = Array.isArray(arcs[i]?.transitions) ? arcs[i].transitions : [];
    setTransitions(i, [...cur, { kind: 'decision', label: '', atIssue: null }]);
  };
  const setTransition = (i, j, patch) => {
    const cur = Array.isArray(arcs[i]?.transitions) ? arcs[i].transitions : [];
    setTransitions(i, cur.map((t, idx) => (idx === j ? { ...t, ...patch } : t)));
  };
  const removeTransition = (i, j) => {
    const cur = Array.isArray(arcs[i]?.transitions) ? arcs[i].transitions : [];
    setTransitions(i, cur.filter((_, idx) => idx !== j));
  };

  const inputCls = 'w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm';

  return (
    <div className="block">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-xs uppercase tracking-wider text-gray-500">Character arcs</h3>
        <button
          type="button"
          onClick={addArc}
          className="flex items-center gap-1 text-[11px] text-port-accent hover:text-port-accent/80"
        >
          <Plus size={12} /> Add arc
        </button>
      </div>
      <p className="text-[11px] text-gray-500 mb-3 -mt-1">
        Each cast member&apos;s want / need, start → end transformation, and the transition beats
        where they actually change. The editorial &ldquo;Character-arc transitions&rdquo; check reconciles
        these against the manuscript and flags characters with no change scenes.
      </p>

      {arcs.length === 0 && (
        <p className="text-[11px] text-gray-600 italic mb-2">No character arcs yet.</p>
      )}

      <div className="space-y-3">
        {arcs.map((arc, i) => {
          const transitions = Array.isArray(arc.transitions) ? arc.transitions : [];
          return (
            <div key={i} className="border border-port-border rounded p-2 bg-port-bg/40">
              <div className="flex items-center gap-2 mb-2">
                <input
                  aria-label="Character name"
                  value={arc.characterName || ''}
                  onChange={(e) => setArc(i, { characterName: e.target.value })}
                  placeholder="Character name"
                  className={`${inputCls} font-medium`}
                />
                <button
                  type="button"
                  onClick={() => removeArc(i)}
                  className="text-gray-500 hover:text-port-error shrink-0"
                  title="Remove this character arc"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input aria-label="Want" value={arc.want || ''} onChange={(e) => setArc(i, { want: e.target.value })} placeholder="Wants (external goal)" className={inputCls} />
                <input aria-label="Need" value={arc.need || ''} onChange={(e) => setArc(i, { need: e.target.value })} placeholder="Needs (internal lesson)" className={inputCls} />
                <input aria-label="Start state" value={arc.startState || ''} onChange={(e) => setArc(i, { startState: e.target.value })} placeholder="Starts as…" className={inputCls} />
                <input aria-label="End state" value={arc.endState || ''} onChange={(e) => setArc(i, { endState: e.target.value })} placeholder="Ends as…" className={inputCls} />
              </div>

              <div className="mt-2">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] uppercase tracking-wider text-gray-600">Transitions</span>
                  <button
                    type="button"
                    onClick={() => addTransition(i)}
                    className="flex items-center gap-1 text-[11px] text-port-accent hover:text-port-accent/80"
                  >
                    <Plus size={11} /> Add beat
                  </button>
                </div>
                <div className="space-y-1.5">
                  {transitions.map((t, j) => (
                    <div key={j} className="flex items-center gap-1.5">
                      <select
                        aria-label="Transition kind"
                        value={t.kind || 'decision'}
                        onChange={(e) => setTransition(i, j, { kind: e.target.value })}
                        className="px-1.5 py-1 bg-port-bg border border-port-border rounded text-white text-xs shrink-0"
                      >
                        {TRANSITION_KIND_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                      <input
                        aria-label="Transition label"
                        value={t.label || ''}
                        onChange={(e) => setTransition(i, j, { label: e.target.value })}
                        placeholder="What changes"
                        className="flex-1 px-2 py-1 bg-port-bg border border-port-border rounded text-white text-xs"
                      />
                      <input
                        aria-label="At issue"
                        type="number"
                        min={0}
                        value={Number.isFinite(t.atIssue) ? t.atIssue : ''}
                        onChange={(e) => {
                          const n = parseInt(e.target.value, 10);
                          setTransition(i, j, { atIssue: Number.isFinite(n) ? n : null });
                        }}
                        placeholder="#"
                        className="w-14 px-1.5 py-1 bg-port-bg border border-port-border rounded text-white text-xs"
                      />
                      <button
                        type="button"
                        onClick={() => removeTransition(i, j)}
                        className="text-gray-500 hover:text-port-error shrink-0"
                        title="Remove this transition"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Merge helper: drop keys cleared to null/undefined/empty-array, then collapse
// an all-empty object to null so the style guide round-trips to null (matching
// the server's empty-collapse) instead of an object full of nulls.
function pruneEmpty(obj) {
  const out = { ...obj };
  for (const k of Object.keys(out)) {
    const v = out[k];
    if (v == null || (Array.isArray(v) && v.length === 0)) delete out[k];
  }
  return Object.keys(out).length ? out : null;
}

// Tri-state boolean <-> select-value mapping for the convention toggles, so
// "unset" stays distinct from "No".
const TRISTATE_OPTIONS = [['yes', 'Yes'], ['no', 'No']];
const triValue = (v) => (v === true ? 'yes' : v === false ? 'no' : '');
const triParse = (v) => (v === 'yes' ? true : v === 'no' ? false : null);

// A blank-first labeled <select> — the single render path for every style-guide
// dropdown (enums, spelling, tri-state) so the markup + Tailwind classes live
// once.
function SgSelect({ id, label, value, options, onChange }) {
  return (
    <div className="block">
      <label htmlFor={id} className="block text-[11px] text-gray-500 mb-1">{label}</label>
      <select
        id={id}
        value={value}
        onChange={onChange}
        className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm"
      >
        <option value="">—</option>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
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
