import { Link } from 'react-router';
import { providerDisplayName, providerModelLabel } from '../../utils/providers';
import ProviderModelSelector from '../ProviderModelSelector';

/**
 * The Options popover: which AI a run uses (run default + optional separate
 * judge route) and the per-run / saved toggles. Presentational only — every
 * value and setter is owned by AutopilotPanel.
 */
export default function AutopilotOptionsPanel({
  providers, activeProviderId, seriesProviderId, opt, options, modelMetrics,
  effProviderId, effModel, effectiveEffort, effProviderUnavailable, providerModels, inheritedModel,
  providerOverride, setProviderOverride, modelOverride, setModelOverride, effortOverride, setEffortOverride,
  separateJudgeLlm, setSeparateJudgeLlm, judgeProviderId, judgeModel, judgeEffort, judgeModels,
  judgeProviderOverride, setJudgeProviderOverride, judgeModelOverride, setJudgeModelOverride,
  judgeEffortOverride, setJudgeEffortOverride,
  includeVisual, setIncludeVisual, fileGaps, setFileGaps, unlockForRun, setUnlockForRun,
}) {
  return (
    <div className="px-3 pb-3 flex flex-col gap-2 border-t border-port-border pt-3">
      {/* Which AI actually runs. The panel used to name none of this, so the
          only way to know what a run would spend on was to read the code. */}
      <div className="rounded-lg border border-port-border bg-port-bg/60 p-2.5 flex flex-col gap-2">
        <p className="text-[11px] text-gray-400 leading-relaxed">
          Creation and repair call{' '}
          <span className="text-gray-200 font-medium">{providerModelLabel(providers, effProviderId, effModel)}</span>
          {effectiveEffort ? (
            <> at <span className="text-gray-200 font-medium">{effectiveEffort}</span> reasoning effort</>
          ) : null}
          {separateJudgeLlm ? (
            <>
              ; judging and verification call{' '}
              <span className="text-gray-200 font-medium">{providerModelLabel(providers, judgeProviderId, judgeModel)}</span>
              {judgeEffort ? (
                <> at <span className="text-gray-200 font-medium">{judgeEffort}</span> reasoning effort</>
              ) : null}
            </>
          ) : null}
          . Stages pinned in{' '}
          <Link to="/prompts" className="text-port-accent hover:underline">Prompts</Link>{' '}
          {opt.overrideStagePins ? 'are overridden for this run' : 'keep their own provider/model/effort'}
          {effectiveEffort ? '.' : (
            <>; reasoning effort comes from the provider&apos;s config on{' '}
              <Link to="/ai" className="text-port-accent hover:underline">AI Providers</Link>.
            </>
          )}
        </p>
        {effProviderUnavailable ? (
          <p className="text-[11px] text-port-warning">
            That provider is disabled or missing — the run falls back to{' '}
            {providerDisplayName(providers, activeProviderId, 'the active provider')}.
          </p>
        ) : null}
        <div className="max-w-md">
          <ProviderModelSelector
            providers={providers}
            selectedProviderId={providerOverride}
            effectiveProviderId={effProviderId}
            selectedModel={modelOverride}
            availableModels={providerModels}
            onProviderChange={(id) => { setProviderOverride(id); setModelOverride(''); setEffortOverride(''); }}
            onModelChange={setModelOverride}
            effort={effortOverride}
            onEffortChange={setEffortOverride}
            label="Override provider for this run"
            compact
            alwaysShowModel
            emptyProviderOption={`Series default (${providerDisplayName(providers, seriesProviderId || activeProviderId, '—')})`}
            emptyModelOption={inheritedModel ? `Series default (${inheritedModel})` : 'Default model'}
          />
        </div>
        <label className="flex items-center gap-2 text-xs text-gray-300 pt-1">
          <input
            type="checkbox"
            checked={opt.overrideStagePins}
            onChange={(e) => options.edit('overrideStagePins', e.target.checked)}
          />
          Use this provider and model for every stage (ignore Prompts stage pins)
        </label>
        {opt.overrideStagePins ? (
          <p className="text-[11px] text-gray-500 pl-5">
            Stages that pin their own provider, model id, reasoning effort or judge in{' '}
            <Link to="/prompts" className="text-port-accent hover:underline">Prompts</Link>{' '}
            run on this route instead, so the whole pipeline — script verification included — stays on one provider.
            A stage pinned to a local provider to keep manuscript text off the network loses that too.
            Stage <em>tiers</em> (quick / coding / heavy) still apply when you leave the model blank,
            and the judge and per-stage overrides still win where you set them.
          </p>
        ) : null}
        <label className="flex items-center gap-2 text-xs text-gray-300 pt-1">
          <input
            type="checkbox"
            checked={separateJudgeLlm}
            onChange={(e) => setSeparateJudgeLlm(e.target.checked)}
          />
          Use a separate model for judging and verification
        </label>
        {separateJudgeLlm ? (
          <div className="max-w-md pl-5">
            <ProviderModelSelector
              providers={providers}
              selectedProviderId={judgeProviderOverride}
              effectiveProviderId={judgeProviderId}
              selectedModel={judgeModelOverride}
              availableModels={judgeModels}
              onProviderChange={(id) => {
                setJudgeProviderOverride(id);
                setJudgeModelOverride('');
                setJudgeEffortOverride('');
              }}
              onModelChange={setJudgeModelOverride}
              effort={judgeEffortOverride}
              onEffortChange={setJudgeEffortOverride}
              label="Override judge and verifier for this run"
              compact
              alwaysShowModel
              emptyProviderOption={`Run default (${providerDisplayName(providers, effProviderId, '—')})`}
              emptyModelOption={effModel ? `Run default (${effModel})` : 'Run default model'}
            />
            <p className="mt-1 text-[11px] text-gray-500">
              Useful for experiments such as Luna/xhigh writing with an independent Sol/medium critic. Exact stage pins in Prompts still take precedence.
            </p>
          </div>
        ) : null}
      </div>
      <label className="flex items-center gap-2 text-xs text-gray-300">
        <input type="checkbox" checked={opt.autoSelectModels} onChange={(e) => options.edit('autoSelectModels', e.target.checked)} />
        Let autopilot choose models from stage-specific results
      </label>
      {opt.autoSelectModels ? (
        <p className="text-[11px] text-gray-500">
          Uses separate technical and quality outcomes by step, role, provider, model and effort. Historical outcomes can backfill effort when older run records lack it. A route needs at least {modelMetrics?.minimumQualitySamples ?? 2} quality-reviewed samples and a positive reliability threshold; explicit route overrides and exact Prompts-stage pins still win. Current history: {modelMetrics?.evidenceRuns ?? 0} attributed run{modelMetrics?.evidenceRuns === 1 ? '' : 's'}, {modelMetrics?.metrics?.reduce((sum, metric) => sum + (metric.qualityEvaluated || 0), 0) ?? 0} quality-reviewed.
        </p>
      ) : null}
      <label className="flex items-center gap-2 text-xs text-gray-300">
        <input type="checkbox" checked={includeVisual} onChange={(e) => setIncludeVisual(e.target.checked)} />
        Draft cover + all interior pages (comic targets)
      </label>
      <label className="flex items-center gap-2 text-xs text-gray-300">
        <input type="checkbox" checked={fileGaps} onChange={(e) => setFileGaps(e.target.checked)} />
        File CoS tasks for gaps it can&apos;t resolve
      </label>
      <label className="flex items-center gap-2 text-xs text-gray-300">
        <input type="checkbox" checked={opt.notifyOnPause} onChange={(e) => options.edit('notifyOnPause', e.target.checked)} />
        Notify me when a run pauses (with a resume link)
      </label>
      <label className="flex items-center gap-2 text-xs text-gray-300">
        <input type="checkbox" checked={unlockForRun} onChange={(e) => setUnlockForRun(e.target.checked)} />
        Unlock everything this series owns first (full edit control)
      </label>
      {unlockForRun ? (
        <p className="text-[11px] text-gray-500">
          Clears the arc freeze, arc-field locks, volume locks and issue stage locks — so the run can actually apply the fixes its editorial passes find. Universe canon is only unlocked when this is the universe&apos;s <em>only</em> series: once another series shares the universe, its cast and setting stay locked, because a character this series introduced may well be one the other series is built on. Nothing is ever deleted: characters, objects and volumes can be rewritten in full but stay in the Universe and the Catalog. Locks are <em>not</em> restored when the run ends. Applies to this run only — it is never saved as a default and the box clears itself after you launch, so a scheduled or repeat run can&apos;t inherit it.
        </p>
      ) : null}
      <label className="flex items-center gap-2 text-xs text-gray-300 pt-1 border-t border-port-border mt-1">
        <input type="checkbox" checked={opt.selfImprove} onChange={(e) => options.edit('selfImprove', e.target.checked)} />
        Improve the pipeline itself (diagnose PortOS when a run goes wrong)
      </label>
      {opt.selfImprove ? (
        <p className="text-[11px] text-gray-500">
          When a run pauses, errors, or finishes with an editorial check that threw or a step that had to be retried, it spends one call asking whether the fault is the <em>story</em> or the <em>pipeline</em> — a missing editorial step earlier in the process, a stage prompt breaking its contract, a runner swallowing a failure. A pipeline verdict files a CoS task against PortOS itself: worktree-isolated, PR-opening, and waiting in your CoS approval queue — it never starts on its own. A healthy run never spends anything here. Saved as the default and reused on Resume.
        </p>
      ) : null}
      <label className="flex items-center gap-2 text-xs text-gray-300 pt-1">
        <input type="checkbox" checked={opt.observer} onChange={(e) => options.edit('observer', e.target.checked)} />
        Observing orchestrator (auto-fix the pipeline as the run progresses)
      </label>
      {opt.observer ? (
        <p className="text-[11px] text-gray-500">
          An orchestrator watches the run step by step. When a step&apos;s telemetry says the automation misbehaved — a retried child, a skipped step, a check that threw, a filed gap — it diagnoses what in PortOS should change (step ordering, missing steps, editorial checks, prompts, gates, even missing options) and <strong>dispatches the fix immediately</strong>: an auto-approved CoS task that works in a worktree, opens a PR, and merges after the review loop with no approval step. Enabling this is your standing consent for those unattended changes. Bounded passes per run, budget-gated, higher confidence bar than the diagnosis above (which this supersedes at the run&apos;s end). Saved as the default and reused on Resume — including scheduled runs.
        </p>
      ) : null}
      <p className="text-[11px] text-gray-500">
        Runs under the CoS auto-run autonomy domain. With it set to <em>dry-run</em>, this only previews the plan.
      </p>
    </div>
  );
}
