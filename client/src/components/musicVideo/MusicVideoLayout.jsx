import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowRight, CheckCircle2, Circle, CircleDot, Clapperboard, Film, Layers, LayoutGrid, Music, Play,
  SlidersHorizontal, Users,
} from 'lucide-react';
import TabPills from '../ui/TabPills.jsx';
import Pill from '../ui/Pill.jsx';
import { PREVIEW_STAGES } from '../../lib/musicVideoStages.js';
import { formatUsd } from '../../utils/formatters.js';

// One icon per stage: the bottom tab bar collapses to icons on a phone, and a
// repeated glyph would be a repeated destination.
const STAGE_ICONS = {
  setup: SlidersHorizontal, 'cast-sets': Users, board: LayoutGrid, produce: Clapperboard, compose: Layers, review: Film,
};
const STATE_MARKS = {
  done: { Icon: CheckCircle2, cls: 'text-port-success', label: 'done' },
  active: { Icon: CircleDot, cls: 'text-port-accent', label: 'in progress' },
  blocked: { Icon: AlertTriangle, cls: 'text-port-warning', label: 'needs you' },
  todo: { Icon: Circle, cls: 'text-port-text-muted', label: 'not started' },
};

// Below `lg` the preview is a mini-player pinned above the bottom tab bar (or
// the viewport edge once the tab bar is in the header); from `lg` it is a
// sticky right column that clears the header (the -0.75rem cancels the
// scroll container's md:p-6, which sticky offsets are measured inside of).
const DOCK_CLASSES = 'max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-30 max-lg:max-h-[70vh] max-lg:overflow-y-auto max-md:bottom-[calc(env(safe-area-inset-bottom)+3rem)] lg:sticky lg:top-[calc(var(--mv-header-h,9rem)-0.75rem)] lg:max-h-[calc(100vh-var(--mv-header-h,9rem)-2rem)] lg:overflow-y-auto';

/** Progress through the pipeline. Status only — the tabs below are the navigation. */
function ProgressStrip({ stages, current }) {
  return (
    <ol aria-label="Progress" className="flex min-w-0 items-center gap-x-3 gap-y-1 overflow-hidden text-xs">
      {stages.map((stage) => {
        const { Icon, cls, label } = STATE_MARKS[stage.state];
        const isCurrent = stage.id === current;
        return (
          <li
            key={stage.id}
            aria-current={isCurrent ? 'step' : undefined}
            data-state={stage.state}
            className={`flex shrink-0 items-center gap-1 ${isCurrent ? 'font-medium text-port-text' : 'text-port-text-muted'}`}
          >
            <Icon size={13} className={`shrink-0 ${cls}`} aria-hidden="true" />
            <span className={isCurrent ? '' : 'max-sm:sr-only'}>{stage.title}</span>
            <span className="sr-only">({label})</span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The Music Video project frame: a sticky header (name, track, spend, the
 * progress strip and the one next action for the project's stage), the stage
 * tabs — on top from `md` up, a bottom tab bar on a phone — the active stage's
 * content, and the docked preview player beside it on the Board, Compose and
 * Review tabs.
 *
 * `progress` is `deriveStages(project)`; `nextAction` is `deriveNextAction(…)`.
 * `dock` is the `PreviewDock` element (or null when there is nothing to preview).
 */
export default function MusicVideoLayout({
  project, trackLabel, stage, onStageChange, progress, nextAction, onNextAction, spend,
  dock, children,
}) {
  const headerRef = useRef(null);
  const rootRef = useRef(null);
  const dockVisible = !!dock && PREVIEW_STAGES.has(stage);
  // The preview loads media, so it mounts the first time a stage shows it and
  // then stays mounted — hidden on the other tabs — to keep its playhead.
  const [dockMounted, setDockMounted] = useState(false);
  useEffect(() => { if (dockVisible) setDockMounted(true); }, [dockVisible]);

  // The dock sticks just under the header, whose height depends on wrapping.
  useEffect(() => {
    const header = headerRef.current;
    const root = rootRef.current;
    if (!header || !root || typeof ResizeObserver === 'undefined') return undefined;
    const apply = () => root.style.setProperty('--mv-header-h', `${Math.round(header.getBoundingClientRect().height)}px`);
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  // A new tab starts at its top, not wherever the last one was scrolled to.
  const firstStage = useRef(true);
  useEffect(() => {
    if (firstStage.current) { firstStage.current = false; return; }
    document.getElementById('main-content')?.scrollTo?.({ top: 0 });
  }, [stage]);

  const tabs = progress.stages.map((entry) => ({
    id: entry.id,
    label: entry.label,
    icon: STAGE_ICONS[entry.id],
    trailing: entry.state === 'blocked'
      ? <AlertTriangle size={12} className="shrink-0 text-port-warning" aria-label="needs you" />
      : entry.state === 'done' ? <CheckCircle2 size={12} className="shrink-0 text-port-success max-lg:hidden" aria-label="done" /> : null,
  }));
  const showSpend = spend.spentUsd > 0 || spend.capUsd != null;
  const ActionIcon = nextAction?.kind === 'goto' ? ArrowRight : Play;

  return (
    <div ref={rootRef} className={`space-y-3 ${dockVisible ? 'max-lg:pb-40' : 'max-md:pb-20'}`}>
      <header
        ref={headerRef}
        className="sticky top-[calc(env(safe-area-inset-top)-1rem)] z-30 -mx-4 space-y-2 border-b border-port-border bg-port-bg px-4 pt-2 md:top-[calc(env(safe-area-inset-top)-1.5rem)] md:-mx-6 md:px-6"
      >
        <div className="flex min-w-0 items-center gap-3">
          <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">{project.name}</h2>
          {nextAction && (
            <button
              type="button"
              onClick={onNextAction}
              disabled={nextAction.disabled}
              title={nextAction.reason}
              className="flex min-h-[44px] shrink-0 items-center gap-1 rounded bg-port-accent px-3 py-1.5 text-sm text-white disabled:opacity-50 sm:min-h-0"
            >
              <ActionIcon size={14} aria-hidden="true" /> {nextAction.label}
            </button>
          )}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <ProgressStrip stages={progress.stages} current={progress.current} />
          <span className="flex min-w-0 items-center gap-1 text-xs text-port-text-muted max-sm:hidden">
            <Music size={12} className="shrink-0" aria-hidden="true" />
            <span className="truncate">{trackLabel}</span>
          </span>
          {showSpend && (
            <Pill size="xs" tone={spend.capUsd != null && spend.spentUsd >= spend.capUsd ? 'warning' : 'muted'}>
              <span title="Paid generation used across this project's production runs, against the cap">
                {formatUsd(spend.spentUsd)}{spend.capUsd != null ? ` / ${formatUsd(spend.capUsd)}` : ' · no cap'}
              </span>
            </Pill>
          )}
        </div>
        <nav
          aria-label="Stages"
          className="max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:z-40 max-md:border-t max-md:border-port-border max-md:bg-port-bg max-md:pb-[env(safe-area-inset-bottom)]"
        >
          <TabPills
            tabs={tabs}
            activeTab={stage}
            onChange={onStageChange}
            variant="underline"
            size="sm"
            stretch
            mobileCompact
            ariaLabel="Music video stages"
            controlsIdPrefix="mv-stage"
          />
        </nav>
      </header>

      <div className={`grid items-start gap-4 ${dockVisible ? 'lg:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)]' : ''}`}>
        <div
          role="tabpanel"
          id={`mv-stage-${stage}`}
          aria-labelledby={`tab-${stage}`}
          className="min-w-0 space-y-3"
        >
          {children}
        </div>
        {dockMounted && dock ? <div className={dockVisible ? DOCK_CLASSES : 'hidden'}>{dock}</div> : null}
      </div>
    </div>
  );
}
