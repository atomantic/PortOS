import { Activity, Clapperboard, FileCode, RefreshCw, Scissors, SlidersHorizontal } from 'lucide-react';
import TabPills from '../ui/TabPills';
import Pill from '../ui/Pill';
import useDrawerTab from '../../hooks/useDrawerTab.js';
import BlenderShotsTab from './blender/BlenderShotsTab.jsx';
import BlenderCutTab from './blender/BlenderCutTab.jsx';
import BlenderSettingsTab from './blender/BlenderSettingsTab.jsx';
import BlenderFilesTab from './blender/BlenderFilesTab.jsx';
import BlenderJobsTab from './blender/BlenderJobsTab.jsx';
import { buttonCls } from './blender/blenderStyles.js';
import { BLENDER_TAB_IDS, BLENDER_TAB_PARAM, blenderFilmSummary, isBlenderJobActive } from '../../lib/musicVideoBlender.js';
import { formatCount } from '../../utils/formatters.js';

export { BLENDER_TAB_PARAM };
export const BLENDER_FILM_ANCHOR = 'mv-blender-film';
export const FILM_LOOK_ANCHOR = 'mv-film-look';

const TABS = [
  { id: 'shots', label: 'Shots', icon: Clapperboard },
  { id: 'cut', label: 'Cut', icon: Scissors },
  { id: 'settings', label: 'Settings', icon: SlidersHorizontal },
  { id: 'files', label: 'Files', icon: FileCode },
  { id: 'jobs', label: 'Jobs', icon: Activity, runningKind: 'jobs' },
];

/**
 * The Blender film render style: a music video whose every shot is built and
 * animated by Python in Blender. The scripts are the source of truth for the
 * shot list; this panel drives and reviews them — Shots (timeline, list,
 * player, renders, notes), Cut (work-in-progress cuts), Settings (render
 * settings, sync, workspace, Blender setup), Files (the source) and Jobs.
 * The open tab is `?btab=`. Its state is `board.blender`
 * (`useMusicVideoBlender`), read once and pushed over the socket.
 */
export default function BlenderFilmPanel({ board }) {
  const { project, blender, audioUrl } = board;
  const [tab, setTab] = useDrawerTab(BLENDER_TAB_PARAM, 'shots', BLENDER_TAB_IDS);
  if (!blender) return null;
  const { state, status, error } = blender;
  const activeJobs = (state?.jobs || []).filter(isBlenderJobActive).length;
  const progress = blenderFilmSummary(state);
  const toolReady = !!state?.tool?.ready && (!state.tool.executionMode || state.tool.executionMode === 'trusted-local');
  const tabs = TABS.map((entry) => (entry.id === 'jobs' ? { ...entry, count: activeJobs } : entry));

  return (
    <section id={BLENDER_FILM_ANCHOR} tabIndex={-1} aria-label="Blender film" className="min-w-0 space-y-2 rounded-lg border border-port-border bg-port-card p-3 focus:outline-none">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <h3 className="text-sm font-medium">Blender film</h3>
        {/* The tabs share the title row: on a laptop every row above the shot player counts. */}
        {state && (
          <TabPills tabs={tabs} activeTab={tab} onChange={setTab} variant="pills" size="sm" mobileCompact ariaLabel="Blender film"
            runningKind={activeJobs > 0 ? 'jobs' : null} className="min-w-0 max-w-full" />
        )}
        {state?.manifest?.title && <span className="min-w-0 truncate text-xs text-port-text-muted">{state.manifest.title}</span>}
        {state && progress.total > 0 && (
          <span className="text-xs text-port-text-muted">
            {formatCount(progress.total)} {progress.total === 1 ? 'shot' : 'shots'} · {formatCount(progress.previewReady)} previews · {formatCount(progress.finalReady)} finals current
          </span>
        )}
        {state && <Pill size="xs" tone={toolReady ? 'success' : 'warning'}>{toolReady ? `Blender${state.tool.version ? ` ${state.tool.version}` : ''} ready` : 'Blender not ready'}</Pill>}
        {activeJobs > 0 && <Pill size="xs" tone="accent">{formatCount(activeJobs)} {activeJobs === 1 ? 'job' : 'jobs'} at work</Pill>}
        {state && (
          <button type="button" className={`${buttonCls} ml-auto`} onClick={blender.refresh} title="Re-read the film: scripts edited on disk change what is out of date">
            <RefreshCw size={14} aria-hidden="true" /> Refresh
          </button>
        )}
      </div>

      {!state && status !== 'error' && <p role="status" className="text-xs text-port-text-muted">Loading the Blender film…</p>}
      {!state && status === 'error' && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded border border-port-error/30 bg-port-error/5 p-2 text-xs text-port-error">
          <span className="min-w-0">Could not load the Blender film{error ? `: ${error}` : ''}</span>
          <button type="button" className={buttonCls} onClick={blender.refresh}>Retry</button>
        </div>
      )}
      {state && error && (
        <p role="status" className="flex flex-wrap items-center gap-2 text-xs text-port-warning">
          <span className="min-w-0">Could not refresh: {error}. What is shown may be out of date.</span>
          <button type="button" className={buttonCls} onClick={blender.refresh}>Retry</button>
        </p>
      )}

      {state && (
        <>
          <div role="tabpanel" aria-label={`Blender film: ${TABS.find((entry) => entry.id === tab)?.label}`} className="min-w-0">
            {tab === 'shots' && (
              <BlenderShotsTab blender={blender} project={project} audioUrl={audioUrl} onOpenPreview={board.openPreview} onOpenTab={setTab} />
            )}
            {tab === 'cut' && <BlenderCutTab blender={blender} onGoToFinalRender={() => board.goToStage('review', 'mv-final-video')} />}
            {tab === 'settings' && <BlenderSettingsTab blender={blender} />}
            {tab === 'files' && <BlenderFilesTab blender={blender} />}
            {tab === 'jobs' && <BlenderJobsTab blender={blender} />}
          </div>
          <p className="flex min-w-0 flex-wrap items-center gap-x-2 border-t border-port-border pt-2 text-xs text-port-text-muted">
            <span className="min-w-0">Grain, gate weave, halation and tape effects are applied when the final renders — set them in Film look.</span>
            <button type="button" className={buttonCls} onClick={() => board.goToStage('produce', FILM_LOOK_ANCHOR)}>Open Film look</button>
          </p>
        </>
      )}
    </section>
  );
}
