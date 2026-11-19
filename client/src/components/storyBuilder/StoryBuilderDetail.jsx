import { useId } from 'react';
import { Link } from 'react-router';
import {
  Sparkles, Lock, Unlock, Check, ChevronRight, ChevronLeft, AlertTriangle,
  RefreshCw, Loader2, Wand2, Cloud, CloudOff,
  Palette, GitBranch, Map as MapIcon, Users, BookOpen, Clapperboard, Lightbulb,
} from 'lucide-react';
import PageHeader from '../PageHeader';
import PageSkeleton from '../ui/PageSkeleton';
import Banner from '../ui/Banner';
import TabPills from '../ui/TabPills';
import ProviderModelPicker from './ProviderModelPicker';
import StepPanel from './StoryStepPanels';
import useStorySessionDetail, { RUN_OP_LABEL } from './useStorySessionDetail';

const STEP_ICONS = {
  idea: Lightbulb,
  universeAesthetic: Palette,
  plotArc: GitBranch,
  readerMap: MapIcon,
  characters: Users,
  issues: BookOpen,
  production: Clapperboard,
};

const STATUS_BADGE = {
  pending: { label: 'Not started', cls: 'text-gray-500' },
  'in-progress': { label: 'In progress', cls: 'text-port-warning' },
  ready: { label: 'Ready', cls: 'text-port-accent' },
  locked: { label: 'Locked', cls: 'text-port-success' },
};

export default function StoryBuilderDetail({ storyId, stepParam }) {
  const nextHintId = useId();
  const {
    steps, manifestError, sessionError, sessionMissing, readBusy,
    session, staleSteps, syncDrift, universe, setUniverse, series, issues,
    issuesResource, loading, syncBusy, activeRuns,
    reload, loadDetail, applyUniverseCharRef, applySessionFields,
    updateSeriesFromServer, handleIssuesUpdate, flushPending, registerDraftFlush,
    stepIds, activeStepId, activeIdx, activeStep, stepState, isStale,
    nextBlocked, nextReason, firstUnmetUpstream, lock, goToStep, saveLlm,
    toggleSync, reconcile,
  } = useStorySessionDetail({ storyId, stepParam });

  const readError = manifestError || sessionError;
  const readNotice = readError && (
    <Banner tone="warning" role="alert" size="md" icon={AlertTriangle} className="mb-4">
      <div>
        <p>{manifestError ? 'Couldn’t load story steps' : 'Couldn’t load the story session'}</p>
        <p className="text-sm">{readError}</p>
        {session && <p className="text-sm">Showing the last loaded story. Your edits and running work are preserved.</p>}
        <button type="button" onClick={manifestError ? loadDetail : reload} disabled={readBusy}
          className="mt-2 px-3 py-2 rounded border border-port-border text-port-accent disabled:opacity-50">
          {readBusy ? 'Retrying…' : 'Retry'}
        </button>
      </div>
    </Banner>
  );

  if (loading && !readError) {
    return (
      <div className="h-full overflow-y-auto p-4 md:p-6">
        <div className="max-w-5xl mx-auto">
          <PageSkeleton label="Loading story session" titleWidthClass="w-64" cards={3} sidebar={false} />
        </div>
      </div>
    );
  }
  if (sessionMissing) {
    return (
      <div className="h-full overflow-y-auto p-6 text-gray-400">
        Session not found. <Link to="/story-builder" className="text-port-accent">Back to Story Builder</Link>
      </div>
    );
  }

  if (!session || !steps) return (
    <div className="h-full overflow-y-auto p-4 md:p-6">
      <div className="max-w-5xl mx-auto">{readNotice}</div>
    </div>
  );

  return (
    <div className="story-builder-workspace flex h-full min-h-0 flex-col">
      <PageHeader
        icon={Wand2}
        title={session.title}
        actions={(
          <Link to="/story-builder" aria-label="All stories" className="inline-flex items-center py-2 text-xs text-gray-500 hover:text-port-accent">
            ← All stories
          </Link>
        )}
      />
      <div className="flex-1 min-h-0 overflow-hidden">
        <div className="max-w-5xl mx-auto w-full min-w-0 min-h-0 h-full flex flex-col p-3">
        {readNotice}

        {/* Live runs — own kickoffs and ones adopted after a reload / second tab —
            stay visible whichever step is open, with a way back to the step. */}
        {activeRuns.length > 0 && (
          <div role="status" aria-live="polite" className="mb-4 space-y-2">
            {activeRuns.map((run) => {
              const label = steps.find((st) => st.id === run.stepId)?.label || run.stepId;
              return (
                <div key={run.stepId} className="flex items-center flex-wrap gap-x-3 gap-y-1 text-sm bg-port-card border border-port-accent/40 rounded-lg px-3 py-2">
                  <Loader2 className="w-4 h-4 animate-spin text-port-accent shrink-0" aria-hidden="true" />
                  <span className="min-w-0 break-words">
                    <span className="font-medium">{RUN_OP_LABEL[run.op]?.active || 'Running'} {label}</span>
                    {run.phase ? <span className="text-gray-400"> — {run.phase}</span> : null}
                    {run.adopted ? <span className="text-xs text-gray-500"> (resumed monitoring)</span> : null}
                  </span>
                  {run.stepId !== activeStepId && (
                    <button type="button" onClick={() => goToStep(run.stepId)} className="ml-auto text-xs text-port-accent hover:underline">
                      Go to step
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="story-stage-layout min-h-0 flex-1 gap-3">
          <nav className="story-stage-nav min-w-0 min-h-0" aria-label="Story stages">
            <TabPills
              tabs={steps.map((s, idx) => {
                const st = session.steps?.[s.id] || { status: 'pending', locked: false };
                const stale = staleSteps.includes(s.id);
                const unmet = firstUnmetUpstream(idx);
                return {
                  id: s.id, label: s.label, icon: STEP_ICONS[s.id] || Sparkles,
                  trailing: (stale || unmet)
                    ? <AlertTriangle aria-hidden="true" className="w-3.5 h-3.5 shrink-0 text-port-warning" title={stale ? 'Stale — re-review' : 'Earlier step not locked yet'} />
                    : st.locked ? <Lock aria-hidden="true" className="w-3.5 h-3.5 shrink-0 text-port-success" /> : null,
                };
              })}
              activeTab={activeStepId}
              onChange={goToStep}
              ariaLabel="Story stages"
              mobileCompact
              variant="pills"
              className="story-stage-tabs"
            />
          </nav>

          {/* Active step: the header stays put while generated work scrolls. */}
          <section className="min-w-0 min-h-0 flex flex-col bg-port-card border border-port-border rounded-lg" aria-label="Current story stage">
            <header className="shrink-0 min-w-0 story-stage-actions border-b border-port-border p-2 space-y-2" aria-label="Stage actions">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="min-w-0 break-words text-lg font-semibold">{activeStep?.label}</h2>
                <span className={`text-xs ${STATUS_BADGE[stepState.status]?.cls}`}>
                  {isStale ? 'Stale — re-review' : stepState.locked ? 'Locked' : STATUS_BADGE[stepState.status]?.label}
                </span>
              </div>
              {/* Existing lock and navigation handlers stay outside the scrolling work. */}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => lock.toggle(stepState.locked)} disabled={lock.busy}
                  className={`inline-flex max-w-full min-w-0 items-center gap-2 min-h-[44px] px-2 py-2 rounded text-sm disabled:opacity-50 ${
                    stepState.locked ? 'bg-port-card border border-port-success text-port-success' : 'bg-port-success hover:bg-port-success/80 text-white'
                  }`}
                >
                  {lock.busy ? <Loader2 className="w-4 h-4 shrink-0 animate-spin" /> : (stepState.locked ? <Unlock className="w-4 h-4 shrink-0" /> : <Check className="w-4 h-4 shrink-0" />)}
                  <span className="min-w-0 [overflow-wrap:anywhere]">{stepState.locked ? 'Unlock to revise' : 'Lock & continue'}</span>
                </button>

                <div className="flex flex-wrap items-center gap-2">
                  {activeIdx > 0 && (
                    <button onClick={() => goToStep(stepIds[activeIdx - 1])} className="inline-flex min-w-[44px] min-h-[44px] justify-center items-center gap-1 text-sm text-gray-400 hover:text-white">
                      <ChevronLeft className="w-4 h-4 shrink-0" /><span className="story-direction-label">Back</span>
                    </button>
                  )}
                  {activeIdx < steps.length - 1 && (
                    <>
                      {/* `aria-disabled` (not `disabled`) keeps the button focusable so
                          keyboard/screen-reader users can reach it and hear the reason via
                          the sr-only hint; `title` covers the mouse case. Same pattern as
                          ExtractCanonButton.jsx. */}
                      <button
                        type="button"
                        onClick={nextBlocked ? undefined : () => goToStep(stepIds[activeIdx + 1])}
                        aria-disabled={nextBlocked || undefined}
                        aria-describedby={nextHintId}
                        title={nextReason}
                        className={`inline-flex min-w-[44px] min-h-[44px] justify-center items-center gap-1 text-sm bg-port-accent text-white px-2 py-2 rounded ${
                          nextBlocked ? 'opacity-40 cursor-not-allowed' : 'hover:bg-port-accent/80'
                        }`}
                      >
                        <span className="story-direction-label">Next</span><ChevronRight className="w-4 h-4 shrink-0" />
                      </button>
                      <span id={nextHintId} className="sr-only">{nextReason}</span>
                    </>
                  )}
                </div>
              </div>
            </header>
            <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-3 space-y-3" aria-label="Stage work" role="region" key={activeStepId}>
              <p className="text-sm text-gray-400">{activeStep?.description}</p>
              {isStale && (
                <Banner tone="warning" size="md" icon={AlertTriangle} align="center">
                  An earlier step changed after you locked this — re-review and re-lock to continue.
                </Banner>
              )}
              <details className="min-w-0">
                <summary className="cursor-pointer text-sm text-gray-400 min-h-[44px]">AI: {session.llm?.model || session.llm?.provider || 'stage default'} · Story settings</summary>
                <div className="mt-2 min-w-0 space-y-3">
                  {/* Applies to every operation in this story. */}
                  <ProviderModelPicker
                    value={{ provider: session.llm?.provider || '', model: session.llm?.model || '' }}
                    onChange={saveLlm}
                  />
                  {/* Cross-machine resume (#730): opt this session into peer sync so it can
                      resume on another federated machine, and re-baseline its staleness
                      against the current machine's live records. Local-only is the default. */}
                  <div className="mb-4 flex items-center flex-wrap gap-x-3 gap-y-2 text-sm bg-port-card border border-port-border rounded-lg px-3 py-2">
                    <button
                      type="button"
                      onClick={toggleSync}
                      disabled={syncBusy}
                      aria-pressed={session.sync === true}
                      className={`inline-flex items-center gap-2 px-3 py-1.5 rounded border disabled:opacity-50 ${
                        session.sync === true
                          ? 'border-port-accent text-port-accent bg-port-bg'
                          : 'border-port-border text-gray-400 hover:text-white'
                      }`}
                      title="Toggle whether this session resumes across your federated machines"
                    >
                      {syncBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : (session.sync === true ? <Cloud className="w-4 h-4" /> : <CloudOff className="w-4 h-4" />)}
                      {session.sync === true ? 'Cross-machine resume on' : 'Cross-machine resume off'}
                    </button>

                    {session.sync === true && (
                      <>
                        <span className="text-xs text-gray-500">
                          {syncDrift
                            ? 'This machine’s records have drifted from the synced baseline.'
                            : 'Baseline matches this machine.'}
                        </span>
                        <button
                          type="button"
                          onClick={reconcile}
                          disabled={syncBusy || !syncDrift}
                          className={`inline-flex items-center gap-2 px-3 py-1.5 rounded border disabled:opacity-40 ${
                            syncDrift
                              ? 'border-port-warning text-port-warning hover:bg-port-bg'
                              : 'border-port-border text-gray-500'
                          }`}
                          title={syncDrift
                            ? 'Adopt this machine’s current records as the new staleness baseline'
                            : 'Nothing to reconcile — the baseline already matches this machine'}
                        >
                          {syncBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                          Reconcile
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </details>
              <StepPanel
                session={session} universe={universe} series={series} issues={issues}
                issuesState={session?.seriesId ? issuesResource.state : 'ready'} issuesError={issuesResource.error} retryIssues={issuesResource.retry}
                stepId={activeStepId} locked={stepState.locked} onChanged={reload}
                onSeriesUpdate={updateSeriesFromServer}
                onIssuesUpdate={handleIssuesUpdate}
                onFlushPending={flushPending}
                onRegisterDraftFlush={registerDraftFlush}
                onUniverseCharRef={applyUniverseCharRef}
                onSessionFields={applySessionFields}
                onUniverseUpdate={setUniverse}
              />
            </div>
          </section>
        </div>
        </div>
      </div>
    </div>
  );
}
