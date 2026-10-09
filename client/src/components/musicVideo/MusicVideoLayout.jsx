import { useEffect, useRef } from 'react';
import {
  ArrowRight, Bot, Check, Clapperboard, Film, History, LayoutGrid, Music, Pencil, Play, Send, Settings, Users,
} from 'lucide-react';
import CancelRenderButton from './CancelRenderButton.jsx';
import TabPills from '../ui/TabPills.jsx';
import Pill from '../ui/Pill.jsx';
import { formatUsd } from '../../utils/formatters.js';

// One icon per step: the phone's bottom bar collapses to icons, and a repeated
// glyph would be a repeated destination.
const STAGE_ICONS = {
  setup: Music, 'cast-sets': Users, board: LayoutGrid, produce: Clapperboard, review: Film, publish: Send,
};

// The page's scroll body (the route is full-width, so the page owns its
// scroll): a new step scrolls it back to the top. On a phone the whole page
// (`MUSIC_VIDEO_PAGE_ID`, title bar included) scrolls instead, so neither
// header pins down a small screen.
export const MUSIC_VIDEO_SCROLL_ID = 'mv-scroll';
export const MUSIC_VIDEO_PAGE_ID = 'mv-page';

const TONE_CLASSES = {
  warn: 'border-port-warning/40 bg-port-warning/10 text-port-warning',
  ok: 'border-port-success/40 bg-port-success/10 text-port-success',
  muted: 'border-port-border bg-port-card text-port-text-muted',
};

/**
 * One state word per step, shared by the step list and the phone's bottom bar:
 * Done, Changed since approval (an approval whose inputs moved, #10141), Needs
 * you (stopped, or the step `describeProjectStatus` names as waiting on the
 * director), In progress, Not started.
 */
export function stepState(entry, { needsYouStage = null } = {}) {
  if (entry.state === 'done' && entry.id !== needsYouStage) return entry.stale ? { word: 'Changed since approval', tone: 'warn' } : { word: 'Done', tone: 'ok' };
  if (entry.state === 'blocked' || entry.id === needsYouStage) return { word: 'Needs you', tone: 'warn' };
  if (entry.stale) return { word: 'Changed since approval', tone: 'warn' };
  if (entry.state === 'active') return { word: 'In progress', tone: 'accent' };
  return { word: 'Not started', tone: 'muted' };
}

const WORD_CLASSES = { ok: 'text-port-success', warn: 'text-port-warning', accent: 'text-port-accent', muted: 'text-port-text-muted' };
const MARK_CLASSES = {
  ok: 'bg-port-success/20 text-port-success',
  warn: 'bg-port-warning text-port-on-warning',
  accent: 'bg-port-accent text-port-on-accent',
  muted: 'bg-port-border text-port-text-muted',
};

/** The six steps as a vertical list (md and up): number or check, name, state word and one fact. */
function StepRail({ stages, stage, onStageChange, needsYouStage, notes }) {
  return (
    <nav aria-label="Steps" className="hidden md:block">
      <ol className="space-y-1">
        {stages.map((entry, index) => {
          const state = stepState(entry, { needsYouStage });
          const selected = entry.id === stage;
          return (
            <li key={entry.id}>
              <button
                type="button"
                onClick={() => onStageChange(entry.id)}
                aria-current={selected ? 'step' : undefined}
                className={`flex w-full min-h-[44px] items-start gap-2 rounded-lg border px-2 py-2 text-left ${selected ? 'border-port-accent bg-port-accent/10' : 'border-transparent hover:bg-port-card'}`}
              >
                <span aria-hidden="true" className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${MARK_CLASSES[state.tone]}`}>
                  {state.word === 'Done' ? <Check size={13} /> : state.word === 'Changed since approval' ? <History size={13} /> : index + 1}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-port-text">{entry.label}</span>
                  <span className={`block text-xs ${WORD_CLASSES[state.tone]}`}>{state.word}</span>
                  {notes?.[entry.id] && <span className="block truncate text-xs text-port-text-muted">{notes[entry.id]}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// From `xl` the preview is a sticky right column under the header. Below it,
// it sits in the page above the step, one folded row until opened, rather than
// a bar pinned over the content.
const DOCK_CLASSES = 'min-w-0 max-xl:order-first max-xl:col-span-full xl:sticky xl:top-[calc(var(--mv-header-h,9rem)-0.75rem)] xl:max-h-[calc(100vh-var(--mv-header-h,9rem)-2rem)] xl:overflow-y-auto';

/**
 * The Music Video project frame. A sticky header says where the project stands
 * in one line (`status.headline`) beside the one next action, with the spend,
 * the autopilot control and Project settings. The six steps run down the left
 * from `md` (a bottom icon bar on a phone), each with its state word and one
 * fact; the open step shows its title and what "done" means, then its content;
 * the preview is docked on the right from `xl` (a mini-player below that).
 *
 * `progress` is `deriveStages(project)`; `nextAction` is `deriveNextAction(…)`;
 * `status` is `describeProjectStatus(…)`; `notes` is `stepNotes(…)`.
 * `attention` is the `NeedsAttentionBanner` element (or null): work the server
 * holds that needs a Resume or Cancel, visible on every step. `autopilot` is
 * `autopilotStatus(…)` (`{ label, short, tone }`) for the header's Autopilot
 * button (or null to hide it);
 * `onOpenSettings(tab)` opens Project settings. `dock` is the `PreviewDock`.
 * `onRename` opens the title editor, which the page hands back as `renameForm`
 * to show in place of the title. `cancelRender` (`{ onCancel, cancelling }`, or
 * null) puts a stop control beside a running final render's progress.
 * `lead` (the step checklist) opens the step; `review` is the step's approval.
 * With `playerFirst` the player and the approval sit together at the top of the
 * step; otherwise the player docks at the side and the approval closes the step.
 */
export default function MusicVideoLayout({
  project, trackLabel, stage, onStageChange, progress, nextAction, onNextAction, spend, status = null,
  attention = null, dock = null, notes = null, autopilot = null, onOpenSettings = null,
  playerFirst = false, lead = null, review = null, onRename = null, renameForm = null, cancelRender = null, children,
}) {
  const headerRef = useRef(null);
  const rootRef = useRef(null);
  // On a step reviewed by watching (Storyboard, Make, Final render) the player is the main
  // element: full width at the top of the step with the approval beside it, not a side column.
  const sideDock = !!dock && !playerFirst;

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

  // A new step starts at its top, not wherever the last one was scrolled to.
  const shownStage = useRef(stage);
  useEffect(() => {
    if (shownStage.current === stage) return;
    shownStage.current = stage;
    for (const id of [MUSIC_VIDEO_SCROLL_ID, MUSIC_VIDEO_PAGE_ID]) document.getElementById(id)?.scrollTo?.({ top: 0 });
  }, [stage]);

  const needsYouStage = status?.needsYouStage || null;
  const tabs = progress.stages.map((entry) => {
    const state = stepState(entry, { needsYouStage });
    return {
      id: entry.id,
      label: entry.label,
      icon: STAGE_ICONS[entry.id],
      // The phone bar is icons only: the state word rides along for screen readers, a dot marks "needs you".
      trailing: (
        <>
          <span className="sr-only">, {state.word}</span>
          {state.tone === 'warn' && <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-port-warning" />}
        </>
      ),
    };
  });
  const showSpend = spend.spentUsd > 0 || spend.capUsd > 0;
  const stageEntry = progress.stages.find((entry) => entry.id === stage);
  // Play runs something; an arrow goes somewhere (a step, or a Project settings tab).
  const ActionIcon = nextAction?.kind === 'run' ? Play : ArrowRight;

  return (
    <div ref={rootRef} className="space-y-3 max-md:pb-[calc(5rem+env(safe-area-inset-bottom))]">
      <header
        ref={headerRef}
        className="z-30 -mx-4 -mt-4 space-y-2 border-b border-port-border bg-port-bg px-4 py-2 md:sticky md:top-[calc(env(safe-area-inset-top)-1.5rem)] md:-mx-6 md:-mt-6 md:px-6"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1 basis-full sm:basis-auto">
            {renameForm || (
              <div className="flex min-w-0 items-center gap-1">
                <h2 className="truncate text-lg font-semibold max-sm:whitespace-normal max-sm:break-words" title={project.name}>{project.name}</h2>
                {onRename && (
                  <button
                    type="button"
                    onClick={onRename}
                    aria-label={`Rename v${project.version || 1}`}
                    title="Rename this version"
                    className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded text-port-text-muted hover:text-port-text sm:min-h-[32px] sm:min-w-[32px]"
                  >
                    <Pencil size={14} aria-hidden="true" />
                  </button>
                )}
              </div>
            )}
            <p className="flex min-w-0 items-center gap-1 text-xs text-port-text-muted">
              <span>v{project.version || 1}</span>
              {trackLabel && (
                <>
                  <span aria-hidden="true">·</span>
                  <Music size={12} className="shrink-0" aria-hidden="true" />
                  <span className="truncate">{trackLabel}</span>
                </>
              )}
            </p>
          </div>
          {status && (
            <p role="status" aria-label="Project status" className={`flex min-h-[36px] min-w-0 items-center rounded-lg border px-2.5 text-xs font-medium sm:text-sm ${TONE_CLASSES[status.tone] || TONE_CLASSES.muted}`}>
              {status.headline}
            </p>
          )}
          {nextAction && (
            <button
              type="button"
              onClick={onNextAction}
              disabled={nextAction.disabled}
              title={nextAction.reason}
              aria-label={nextAction.label}
              className="flex min-h-[44px] shrink-0 items-center gap-1 rounded-lg bg-port-accent px-3 text-sm font-medium text-white disabled:opacity-50"
            >
              <ActionIcon size={14} aria-hidden="true" />
              <span className="sm:hidden">{nextAction.shortLabel || nextAction.label}</span>
              <span className="hidden sm:inline">{nextAction.label}</span>
            </button>
          )}
          {cancelRender && nextAction?.id === 'render-progress' && (
            <CancelRenderButton onCancel={cancelRender.onCancel} cancelling={cancelRender.cancelling} />
          )}
          {autopilot && onOpenSettings && (
            <button
              type="button"
              onClick={() => onOpenSettings('autopilot')}
              aria-label={autopilot.label}
              // An idle autopilot is one tap away in Project settings; a phone shows the button only for a run.
              className={`flex min-h-[44px] shrink-0 items-center gap-1 rounded-lg border px-2.5 text-sm ${autopilot.tone === 'warn' ? 'border-port-warning/50 text-port-warning' : 'border-port-border text-port-text'} ${autopilot.label === 'Autopilot' ? 'max-sm:hidden' : ''}`}
            >
              <Bot size={15} aria-hidden="true" />
              <span className="sm:hidden">{autopilot.short || autopilot.label}</span>
              <span className="hidden sm:inline">{autopilot.label}</span>
            </button>
          )}
          {showSpend && (
            <Pill size="xs" tone={spend.capUsd != null && spend.spentUsd >= spend.capUsd ? 'warning' : 'muted'}>
              <span title={`Paid generation used, against the cap. Autopilot ${formatUsd(spend.autopilot ?? 0)} · manual takes ${formatUsd(spend.manual ?? 0)} · auto-review ${formatUsd(spend.autoReview ?? 0)} (estimates)`}>
                {formatUsd(spend.spentUsd)}{spend.capUsd != null ? ` / ${formatUsd(spend.capUsd)}` : ' · no cap'}
              </span>
            </Pill>
          )}
          {onOpenSettings && (
            <button
              type="button"
              onClick={() => onOpenSettings('project')}
              aria-label="Project settings"
              title="Project settings"
              className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg border border-port-border text-port-text-muted hover:text-port-text"
            >
              <Settings size={16} aria-hidden="true" />
            </button>
          )}
        </div>
        {nextAction?.disabled && nextAction.reason && <p role="status" className="text-xs text-port-text-muted">{nextAction.reason}</p>}
        {attention}
        <nav
          aria-label="Steps"
          className="md:hidden max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:z-40 max-md:border-t max-md:border-port-border max-md:bg-port-bg max-md:pb-[env(safe-area-inset-bottom)]"
        >
          <TabPills
            tabs={tabs}
            activeTab={stage}
            onChange={onStageChange}
            variant="underline"
            size="sm"
            stretch
            mobileCompact
            ariaLabel="Music video steps"
            controlsIdPrefix="mv-stage"
          />
        </nav>
      </header>

      {/* One column on a phone, capped at the screen width so a wide control can't push the step off screen. */}
      <div className={`grid grid-cols-[minmax(0,1fr)] items-start gap-4 md:grid-cols-[13rem_minmax(0,1fr)] ${sideDock ? 'xl:grid-cols-[13rem_minmax(0,1fr)_minmax(20rem,24rem)]' : ''}`}>
        <div className="hidden md:block md:sticky md:top-[calc(var(--mv-header-h,9rem)-0.75rem)]">
          <StepRail stages={progress.stages} stage={stage} onStageChange={onStageChange} needsYouStage={needsYouStage} notes={notes} />
        </div>
        {/* Labelled by its own heading: from md the phone tab bar is hidden and the step list drives it. */}
        <div
          role="tabpanel"
          id={`mv-stage-${stage}`}
          aria-labelledby={`mv-step-title-${stage}`}
          className="min-w-0 space-y-3"
        >
          <div className="space-y-0.5">
            <h3 id={`mv-step-title-${stage}`} className="text-xl font-semibold">{stageEntry?.title || stageEntry?.label}</h3>
            {stageEntry?.doneWhen && <p className="text-sm text-port-text-muted">{stageEntry.doneWhen}</p>}
          </div>
          {lead}
          {playerFirst && (dock || review) && (
            <div className={`grid min-w-0 items-start gap-3 ${dock && review ? 'xl:grid-cols-[minmax(0,3fr)_minmax(20rem,2fr)]' : ''}`}>
              {dock && <div className="min-w-0">{dock}</div>}
              {review}
            </div>
          )}
          {children}
          {!playerFirst && review}
        </div>
        {sideDock ? <div className={DOCK_CLASSES}>{dock}</div> : null}
      </div>
    </div>
  );
}
