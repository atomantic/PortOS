import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  BookOpen, Clapperboard, Clock, Columns3, ExternalLink, FileSignature, Film, GitCommit, History, Loader2,
  MapPin, Moon, MoreHorizontal, Pencil, Quote, Save, Sparkles, Sun, Timer, Users, Wand2, Zap,
} from 'lucide-react';
import useClickOutside from '../../hooks/useClickOutside';
import useMounted from '../../hooks/useMounted';
import { promoteWritersRoomWorkToPipeline } from '../../services/apiWritersRoom';
import { modKey } from '../../utils/platform';
import toast from '../ui/Toast';
import { STATUS_LABELS } from './labels';
import { ANALYSIS_KIND } from './useWorkAnalysisPipeline';

export const DRAWER = { VERSIONS: 'versions', HISTORY: 'history', POLISH: 'polish', VOICE: 'voice' };

// The three prose surfaces the header toggles between. Declared once so the
// toggle group stays a map instead of three hand-copied buttons.
const VIEW_MODES = [
  { id: 'edit', label: 'Edit', icon: Pencil, title: 'Edit prose (textarea)' },
  { id: 'read', label: 'Read', icon: BookOpen, title: 'Read view with scene anchors' },
  { id: 'review', label: 'Review', icon: Columns3, title: 'Synced prose · script · media review' },
];

export default function WorkEditorToolbar({
  work, ownerKeyRef, publishMetadata, headerCollapsed, title, setTitle, commitTitle, status, commitStatus, viewMode, setViewMode,
  dirty, saving, switchingDraft, polishBusy, exercisePending, handleSave, handleSnapshot,
  runningKind, runAnalysis, setDrawer, liveEnabled, toggleLiveMode, readingTheme, toggleReadingTheme,
  onToggleExercise, exerciseOpen,
}) {
  const navigate = useNavigate();
  const mountedRef = useMounted();
  const [promoting, setPromoting] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef(null);
  useClickOutside(overflowRef, overflowOpen, () => setOverflowOpen(false));

  const handlePromoteToPipeline = async () => {
    if (dirty) {
      toast('Save before promoting', { icon: '⚠️' });
      return;
    }
    const startOwner = ownerKeyRef.current;
    setPromoting(true);
    const result = await promoteWritersRoomWorkToPipeline(work.id, {}, { silent: true }).catch((err) => {
      if (mountedRef.current && ownerKeyRef.current === startOwner) {
        toast.error(err.message || 'Promote failed');
      }
      return null;
    });
    if (mountedRef.current) setPromoting(false);
    if (!result) return;
    // The promotion can finish after a version change or a newer draft save.
    // Merge just the link fields into the original owner before navigating.
    const updated = { ...work, pipelineSeriesId: result.series.id, pipelineIssueId: result.issue.id };
    if (!publishMetadata(updated, ['pipelineSeriesId', 'pipelineIssueId'], startOwner)) return;
    toast.success(result.reused ? 'Opening existing pipeline issue' : 'Pipeline series + issue created');
    navigate(`/pipeline/issues/${encodeURIComponent(result.issue.id)}/prose`);
  };

  const handleOpenInPipeline = () => {
    if (!work.pipelineIssueId) return;
    navigate(`/pipeline/issues/${encodeURIComponent(work.pipelineIssueId)}/prose`);
  };

  const handleOpenInCreativeDirector = () => {
    if (!work.cdProjectId) return;
    navigate(`/creative-director/${encodeURIComponent(work.cdProjectId)}/overview`);
  };

  const closeOverflowAnd = (fn) => () => { setOverflowOpen(false); fn?.(); };

  const needsSavedDraft = dirty || saving || switchingDraft || polishBusy || exercisePending;
  const analysisTitle = dirty ? 'Save first' : undefined;
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-port-border bg-port-card">
      {headerCollapsed && <span className="flex-1 min-w-0 truncate text-sm font-semibold text-white">{title}</span>}
      <input
        hidden={headerCollapsed}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={commitTitle}
        onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
        className="bg-transparent text-base font-semibold text-white border-none focus:outline-none focus:bg-port-bg/50 px-1 rounded flex-1 min-w-0 w-0 sm:w-auto sm:min-w-[180px] min-h-[44px] pointer-fine:sm:min-h-0"
        aria-label="Work title"
      />
      {/* Secondary controls. `w-full order-last` gives them their own compact
          row below the primary actions under `sm`; `sm:contents` dissolves the
          wrapper so they sit inline — in this DOM order — on desktop. */}
      <div className={headerCollapsed ? 'hidden' : 'w-full order-last flex items-center gap-2 sm:contents'} data-testid="work-header-secondary">
        <select
          value={status}
          onChange={(e) => commitStatus(e.target.value)}
          className="bg-port-bg border border-port-border rounded px-2 py-1 min-h-[44px] pointer-fine:sm:min-h-0 text-[11px] text-gray-300"
          aria-label="Status"
        >
          {Object.entries(STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        {/* Not a true tablist (no separate panels keyed off tab id, no roving
            tabindex, no arrow-key cycling). aria-pressed is the semantically
            correct primitive for a toggle group. The text labels collapse to
            icon-only under `sm` to keep this row single-line at ~375px, so
            each button carries an explicit aria-label. */}
        <div className="flex items-center bg-port-bg border border-port-border rounded p-0.5" role="group" aria-label="View mode">
          {VIEW_MODES.map(({ id, label, icon: Icon, title: viewTitle }) => (
            <button
              key={id}
              type="button"
              aria-pressed={viewMode === id}
              aria-label={label}
              onClick={() => setViewMode(id)}
              className={`flex items-center gap-1 px-3 sm:px-2 py-2 sm:py-0.5 min-h-[40px] sm:min-h-0 text-[11px] rounded ${
                viewMode === id ? 'bg-port-card text-white' : 'text-gray-400 hover:text-gray-200'
              }`}
              title={viewTitle}
            >
              <Icon size={11} /> <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>
      </div>
      <button
        onClick={handleSave}
        disabled={!dirty || saving || switchingDraft || polishBusy || exercisePending}
        className={`flex shrink-0 items-center justify-center gap-1 w-24 px-3 py-1 min-h-[44px] pointer-fine:sm:min-h-0 text-xs rounded ${
          dirty ? 'bg-port-accent text-white hover:bg-port-accent/80' : 'bg-port-bg text-gray-500'
        }`}
        aria-busy={saving}
        title={saving ? 'Saving draft…' : dirty ? `Save (${modKey}+S)` : 'Up to date'}
      >
        <Save size={12} className="shrink-0" />
        <span key={saving ? 'saving' : dirty ? 'dirty' : 'saved'}>{saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}</span>
      </button>
      <button
        onClick={handleSnapshot}
        disabled={needsSavedDraft}
        aria-label="Snapshot"
        className={`${headerCollapsed ? 'hidden' : 'flex'} items-center gap-1 px-3 py-1 min-h-[44px] pointer-fine:sm:min-h-0 text-xs rounded bg-port-bg border border-port-border text-gray-300 hover:text-white disabled:text-gray-600 disabled:cursor-not-allowed`}
        title="Snapshot the active draft as a new version"
      >
        <GitCommit size={12} /> <span className="hidden sm:inline">Snapshot</span>
      </button>
      <div className={headerCollapsed ? 'hidden' : 'relative'} ref={overflowRef}>
        <button
          onClick={() => setOverflowOpen((v) => !v)}
          className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 flex items-center justify-center px-3 sm:px-2 py-1 min-h-[44px] sm:min-h-0 text-xs rounded bg-port-bg border border-port-border text-gray-300 hover:text-white"
          aria-label="Work menu"
          aria-expanded={overflowOpen}
          title="Work menu"
        >
          <MoreHorizontal size={14} />
        </button>
        {overflowOpen && (
          <div className="absolute right-0 top-full mt-1 z-30 w-60 rounded-md border border-port-border bg-port-card shadow-xl py-1 text-xs">
            <MenuSection label="AI">
              <MenuItem icon={Clapperboard} label="Run Adapt (rebuild storyboard)" running={runningKind === ANALYSIS_KIND.SCRIPT} disabled={needsSavedDraft} title={analysisTitle} onClick={closeOverflowAnd(() => runAnalysis(ANALYSIS_KIND.SCRIPT))} />
              <MenuItem icon={Users} label="Refresh characters" running={runningKind === ANALYSIS_KIND.CHARACTERS} disabled={needsSavedDraft} title={analysisTitle} onClick={closeOverflowAnd(() => runAnalysis(ANALYSIS_KIND.CHARACTERS))} />
              <MenuItem icon={MapPin} label="Refresh places" running={runningKind === ANALYSIS_KIND.PLACES} disabled={needsSavedDraft} title={analysisTitle} onClick={closeOverflowAnd(() => runAnalysis(ANALYSIS_KIND.PLACES))} />
              <MenuItem icon={Sparkles} label="Editorial pass" running={runningKind === ANALYSIS_KIND.EVALUATE} disabled={needsSavedDraft} title={analysisTitle} onClick={closeOverflowAnd(() => runAnalysis(ANALYSIS_KIND.EVALUATE))} />
              <MenuItem icon={FileSignature} label="Format pass" running={runningKind === ANALYSIS_KIND.FORMAT} disabled={needsSavedDraft} title={analysisTitle} onClick={closeOverflowAnd(() => runAnalysis(ANALYSIS_KIND.FORMAT))} />
              <MenuItem icon={Wand2} label="Polish (cut → revise)" onClick={closeOverflowAnd(() => setDrawer(DRAWER.POLISH))} />
              <MenuItem icon={Quote} label="Voice exemplars" onClick={closeOverflowAnd(() => setDrawer(DRAWER.VOICE))} />
              <MenuItem icon={Zap} label={liveEnabled ? 'Disable live director' : 'Enable live director'} active={liveEnabled} onClick={closeOverflowAnd(toggleLiveMode)} />
            </MenuSection>
            <MenuSection label="Open">
              <MenuItem icon={Clock} label="Versions" onClick={closeOverflowAnd(() => setDrawer(DRAWER.VERSIONS))} />
              <MenuItem icon={History} label="Analysis history" onClick={closeOverflowAnd(() => setDrawer(DRAWER.HISTORY))} />
              {work.pipelineSeriesId ? (
                <MenuItem icon={ExternalLink} label="Open in pipeline" onClick={closeOverflowAnd(handleOpenInPipeline)} />
              ) : (
                <MenuItem icon={Film} label={promoting ? 'Promoting…' : 'Promote to pipeline'} running={promoting} onClick={closeOverflowAnd(handlePromoteToPipeline)} />
              )}
              {work.cdProjectId && (
                <MenuItem icon={ExternalLink} label="Open in Creative Director" onClick={closeOverflowAnd(handleOpenInCreativeDirector)} />
              )}
            </MenuSection>
            <MenuSection label="View">
              <MenuItem
                icon={readingTheme === 'dark' ? Sun : Moon}
                label={readingTheme === 'dark' ? 'Light reading theme' : 'Dark reading theme'}
                onClick={closeOverflowAnd(toggleReadingTheme)}
              />
              {onToggleExercise && (
                <MenuItem
                  icon={Timer}
                  label={exerciseOpen ? 'Hide Write for 10' : 'Write for 10'}
                  onClick={closeOverflowAnd(onToggleExercise)}
                  active={exerciseOpen}
                />
              )}
            </MenuSection>
          </div>
        )}
      </div>
    </div>
  );
}

function MenuSection({ label, children }) {
  return (
    <div className="py-1 border-b border-port-border last:border-b-0">
      <div className="px-3 pt-1 pb-0.5 text-[9px] uppercase tracking-wider text-gray-500">{label}</div>
      {children}
    </div>
  );
}

function MenuItem({ icon: Icon, label, onClick, running = false, active = false, badge = null, disabled = false, title }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={running || disabled}
      title={title}
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-[11px] hover:bg-port-bg disabled:opacity-50 ${
        active ? 'text-port-accent' : 'text-gray-300'
      }`}
    >
      {running
        ? <Loader2 size={11} className="animate-spin text-port-accent" />
        : <Icon size={11} className={active ? 'text-port-accent' : 'text-gray-500'} />
      }
      <span className="flex-1">{label}</span>
      {badge != null && <span className="text-[10px] text-gray-500">{badge}</span>}
    </button>
  );
}
