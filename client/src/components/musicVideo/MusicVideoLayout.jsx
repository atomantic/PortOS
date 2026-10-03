import { useEffect, useRef } from 'react';
import {
  AlertTriangle, ArrowRight, CheckCircle2, CircleDot, Clapperboard, Film, Layers, LayoutGrid, Music, Play,
  Send, SlidersHorizontal, Users,
} from 'lucide-react';
import TabPills from '../ui/TabPills.jsx';
import Pill from '../ui/Pill.jsx';
import { formatUsd } from '../../utils/formatters.js';

// One icon per stage: the bottom tab bar collapses to icons on a phone, and a
// repeated glyph would be a repeated destination.
const STAGE_ICONS = {
  setup: SlidersHorizontal, 'cast-sets': Users, board: LayoutGrid, produce: Clapperboard, compose: Layers, review: Film,
  publish: Send,
};
// The tab bar is the one stage row, so each tab carries its own status mark. The
// quiet marks (done, in progress) drop out below `lg`, where the bar is icons
// only; "needs you" always shows.
const STAGE_TRAILING = {
  done: <CheckCircle2 size={12} className="shrink-0 text-port-success max-lg:hidden" aria-label="done" />,
  active: <CircleDot size={12} className="shrink-0 text-port-accent max-lg:hidden" aria-label="in progress" />,
  blocked: <AlertTriangle size={12} className="shrink-0 text-port-warning" aria-label="needs you" />,
};

// The page's scroll body (the route is full-width, so the page owns its
// scroll): a new tab scrolls it back to the top.
export const MUSIC_VIDEO_SCROLL_ID = 'mv-scroll';

const STATUS_TONES = { warn: 'text-port-warning', ok: 'text-port-success', muted: 'text-port-text-muted' };

// Below `lg` the preview is a mini-player pinned above the bottom tab bar (or
// the viewport edge once the tab bar is in the header); from `lg` it is a
// sticky right column that clears the header (the -0.75rem cancels the
// scroll container's md:p-6, which sticky offsets are measured inside of).
const DOCK_CLASSES = 'max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-30 max-lg:max-h-[70vh] max-lg:overflow-y-auto max-md:bottom-[calc(env(safe-area-inset-bottom)+3rem)] lg:sticky lg:top-[calc(var(--mv-header-h,9rem)-0.75rem)] lg:max-h-[calc(100vh-var(--mv-header-h,9rem)-2rem)] lg:overflow-y-auto';

/**
 * The Music Video project frame: a sticky header (name, track, spend and the
 * one next action for the project's stage), the stage tabs — the single stage
 * row, each tab marking its stage done / in progress / needs you — on top from
 * `md` up, a bottom tab bar on a phone — the active stage's
 * content, and the docked preview player beside it on every tab.
 *
 * `progress` is `deriveStages(project)`; `nextAction` is `deriveNextAction(…)`;
 * `status` is `describeProjectStatus(…)`, the one "where it stands" line under
 * the name. `dock` is the `PreviewDock` element (or null when there is nothing
 * to preview).
 */
export default function MusicVideoLayout({
  project, trackLabel, stage, onStageChange, progress, nextAction, onNextAction, spend, status = null,
  dock, projectPanels, children,
}) {
  const headerRef = useRef(null);
  const rootRef = useRef(null);
  const dockVisible = !!dock;

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
  const shownStage = useRef(stage);
  useEffect(() => {
    if (shownStage.current === stage) return;
    shownStage.current = stage;
    document.getElementById(MUSIC_VIDEO_SCROLL_ID)?.scrollTo?.({ top: 0 });
  }, [stage]);

  const tabs = progress.stages.map((entry) => ({
    id: entry.id,
    label: entry.label,
    icon: STAGE_ICONS[entry.id],
    trailing: STAGE_TRAILING[entry.state] || null,
  }));
  const showSpend = spend.spentUsd > 0 || spend.capUsd != null;
  const stageEntry = progress.stages.find((entry) => entry.id === stage);
  const ActionIcon = nextAction?.kind === 'goto' ? ArrowRight : Play;

  return (
    <div ref={rootRef} className={`space-y-3 ${dockVisible ? 'max-lg:pb-40' : 'max-md:pb-20'}`}>
      <header
        ref={headerRef}
        className="sticky top-[calc(env(safe-area-inset-top)-1rem)] z-30 -mx-4 space-y-2 border-b border-port-border bg-port-bg px-4 pt-2 md:top-[calc(env(safe-area-inset-top)-1.5rem)] md:-mx-6 md:px-6"
      >
        <div className="flex min-w-0 items-center gap-3">
          <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">{project.name}</h2>
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
        {status && (
          <p role="status" aria-label="Project status" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
            <span className={`font-medium ${STATUS_TONES[status.tone] || ''}`}>{status.headline}</span>
            {status.facts.map((fact) => (
              <span key={fact.id} className={`flex items-center gap-2 ${STATUS_TONES[fact.tone] || ''}`}>
                <span aria-hidden="true" className="text-port-text-muted">·</span>{fact.label}
              </span>
            ))}
          </p>
        )}
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
          <h3 className="text-base font-semibold">{stageEntry?.title || stageEntry?.label}</h3>
          {children}
        </div>
        {dockVisible ? <div className={DOCK_CLASSES}>{dock}</div> : null}
      </div>
      {/* Shared run/review forms stay mounted, but never obscure the stage
          selected from the phone's bottom navigation. */}
      {projectPanels}
    </div>
  );
}
