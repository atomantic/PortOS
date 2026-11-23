import { useRef } from 'react';
import CollapsibleSection from '../ui/CollapsibleSection';
import ProviderModelSelector from '../ProviderModelSelector';
import { providerDisplayName, providerModelLabel } from '../../utils/providers';
import { formatCount } from '../../utils/formatters.js';
import { READINESS_GATE_LABELS, READINESS_GATE_ORDER } from '../../lib/editorialHealth.js';

// Bounds are UI constraints; the fallback values come from the shared defaults.
export const ROUND_MIN = 0;
export const ROUND_MAX = 20;
const AUTOPILOT_LLM_STAGES = [
  ['characterFoundation', 'Character foundation'],
  ['generateArc', 'Generate arc'],
  ['repairArcStructure', 'Repair arc structure'],
  ['verifyArcSpine', 'Verify arc spine'],
  ['generateEpisodes', 'Generate episodes'],
  ['foundationGate', 'Foundation quality gate'],
  ['verifyArc', 'Verify arc'],
  ['beatSheet', 'Beat sheets'],
  ['beatContinuity', 'Beat continuity'],
  ['textStages', 'Draft text stages'],
  ['pilotDraft', 'Draft opening issue'],
  ['pilotReview', 'Review opening before expansion'],
  ['scriptVerify', 'Verify scripts'],
  ['editorialReview', 'Editorial review'],
  ['reverseOutline', 'Reverse outline'],
  ['editorialChecks', 'Editorial checks'],
  ['revisionCycle', 'Revision cycle'],
  ['produceTeaser', 'Produce teaser'],
];

// A single numeric field for the Options popover (round bounds + the pause
// threshold). Allows '' mid-edit (so the field can be cleared) and clamps +
// persists the chosen value on blur — but ONLY when the user actually changed it.
// A bare focus+blur (tabbing through Options) must not persist the display
// fallback or mark the field dirty, or it would clobber a saved limit before
// settings load and block the load from applying it. `max` caps the input (null =
// uncapped). `settingKey` / `value` / `setValue` / `clamp` / `persist` come from
// the option registry's `inputProps(key)` — the clamp is the option's own, so
// what a blur saves is exactly what a run sends.
function RoundInput({ id, label, settingKey, value, setValue, persist, max = ROUND_MAX, clamp, min = ROUND_MIN, step }) {
  const dirtyRef = useRef(false);
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-xs text-gray-300">{label}</label>
      <input
        id={id}
        type="number"
        min={min}
        max={max ?? undefined}
        step={step ?? undefined}
        value={value}
        onChange={(e) => { dirtyRef.current = true; setValue(e.target.value === '' ? '' : Number(e.target.value)); }}
        onBlur={() => {
          if (!dirtyRef.current) return; // untouched — don't persist/clamp/mark dirty
          dirtyRef.current = false;
          const v = clamp(value);
          setValue(v);
          persist({ [settingKey]: v });
        }}
        className="w-16 px-2 py-1 rounded text-xs bg-port-bg border border-port-border text-gray-200"
      />
    </div>
  );
}

/**
 * The "Stage model overrides" and "Quality gates & round limits" collapsible
 * editors. Presentational only — state and persistence stay in AutopilotPanel.
 */
export default function AutopilotStageQualitySections({
  providers, opt, options, customStages, qualityOverrides,
  editStageLlm, setEditStageLlm, setStageLlm,
  selectedStageLlm, setSelectedStageLlm, selectedStageRole, setSelectedStageRole,
  selectedStageRoute, stageProviderId, stageModel, stageModels, stageEffort,
  stageBaseProviderId, stageBaseModel, updateSelectedStageRoute,
  readinessGate, setReadinessGate, savedGate,
}) {
  return (
    <div className="border-t border-port-border px-3">
      <CollapsibleSection
        label="Stage model overrides"
        summary={`${formatCount(customStages)} custom`}
        size="bar"
        bodyClassName="space-y-2 pb-3"
      >
        <label className="flex items-center gap-2 text-xs text-gray-300">
          <input
            type="checkbox"
            checked={editStageLlm}
            onChange={(e) => {
              setEditStageLlm(e.target.checked);
              if (!e.target.checked) setStageLlm({});
            }}
          />
          Override a specific stage and role
        </label>
        {editStageLlm ? (
          <>
            <p className="text-[11px] text-gray-400">
              Stage route overrides win over run-wide and learned routes for the selected role. They are restored when a run pauses.
            </p>
            <div className="flex flex-wrap gap-2 max-w-2xl">
              <div>
                <label htmlFor="autopilot-stage-llm" className="block text-[11px] text-gray-400 mb-1">Stage override</label>
                <select
                  id="autopilot-stage-llm"
                  value={selectedStageLlm}
                  onChange={(e) => setSelectedStageLlm(e.target.value)}
                  className="bg-port-bg border border-port-border rounded px-2 py-1.5 text-xs text-gray-200"
                >
                  {AUTOPILOT_LLM_STAGES.map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="autopilot-stage-role" className="block text-[11px] text-gray-400 mb-1">Role</label>
                <select
                  id="autopilot-stage-role"
                  value={selectedStageRole}
                  onChange={(e) => setSelectedStageRole(e.target.value)}
                  className="bg-port-bg border border-port-border rounded px-2 py-1.5 text-xs text-gray-200"
                >
                  <option value="creative">Creative / repair</option>
                  <option value="judge">Judge / verify</option>
                </select>
              </div>
            </div>
            <div className="max-w-md">
              <ProviderModelSelector
                providers={providers}
                selectedProviderId={selectedStageRoute.providerOverride || ''}
                effectiveProviderId={stageProviderId}
                selectedModel={selectedStageRoute.modelOverride || ''}
                availableModels={stageModels}
                onProviderChange={(id) => updateSelectedStageRoute({
                  providerOverride: id,
                  modelOverride: '',
                  effortOverride: '',
                })}
                onModelChange={(model) => updateSelectedStageRoute({ modelOverride: model })}
                effort={selectedStageRoute.effortOverride || ''}
                onEffortChange={(effort) => updateSelectedStageRoute({ effortOverride: effort })}
                label="Override this stage and role"
                compact
                alwaysShowModel
                emptyProviderOption={`Role default (${providerDisplayName(providers, stageBaseProviderId, '—')})`}
                emptyModelOption={stageBaseModel ? `Role default (${stageBaseModel})` : 'Role default model'}
              />
              {Object.keys(selectedStageRoute).length > 0 ? (
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-[11px] text-port-accent">
                    Active: {providerModelLabel(providers, stageProviderId, stageModel)}{stageEffort ? ` / ${stageEffort}` : ''}
                  </span>
                  <button
                    type="button"
                    onClick={() => updateSelectedStageRoute({
                      providerOverride: '', modelOverride: '', effortOverride: '',
                    })}
                    className="text-[11px] text-gray-500 hover:text-white"
                  >
                    Clear override
                  </button>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </CollapsibleSection>
      <CollapsibleSection
        label="Quality gates & round limits"
        summary={`${formatCount(qualityOverrides)} custom`}
        size="bar"
        className="border-t border-port-border"
        bodyClassName="space-y-2 pb-3"
      >
        <label className="flex items-center gap-2 text-xs text-gray-300">
          <input type="checkbox" checked={opt.foundationGate} onChange={(e) => options.edit('foundationGate', e.target.checked)} />
          Judge the foundation (world / characters / arc) before drafting
        </label>
        <div className="flex flex-wrap gap-4 pt-1">
          <RoundInput
            id="autopilot-arc-rounds"
            label="Arc verify rounds"
            {...options.inputProps('maxArcVerifyRounds')}
          />
          <RoundInput
            id="autopilot-beat-continuity-rounds"
            label="Beat continuity rounds"
            {...options.inputProps('maxBeatContinuityRounds')}
          />
          <RoundInput
            id="autopilot-editorial-rounds"
            label="Editorial rounds"
            {...options.inputProps('maxEditorialRounds')}
          />
        </div>
        <p className="text-[11px] text-gray-500">
          How many auto-resolve rounds each gate attempts before pausing for human review (0 skips the gate, max {ROUND_MAX}). Saved as the default and reused on Resume.
        </p>
        {opt.foundationGate ? (
          <>
            <div className="flex flex-wrap gap-4 pt-1">
              <RoundInput
                id="autopilot-foundation-threshold"
                label="Foundation threshold"
                {...options.inputProps('foundationThreshold')}
                max={10}
              />
              <RoundInput
                id="autopilot-foundation-rounds"
                label="Foundation rounds"
                {...options.inputProps('maxFoundationRounds')}
              />
            </div>
            <p className="text-[11px] text-gray-500">
              Weighted quality bar (0–10: worldbuilding 40%, character 30%, structure 20%, craft 10%) the foundation must clear before drafting; the run repairs the largest weighted deficit up to the round limit, then pauses for review.
            </p>
          </>
        ) : null}
        <div className="flex items-center gap-2 pt-1">
          <label htmlFor="autopilot-readiness-gate" className="text-xs text-gray-300">Readiness gate</label>
          <select
            id="autopilot-readiness-gate"
            value={readinessGate}
            onChange={(e) => setReadinessGate(e.target.value)}
            className="px-2 py-1 rounded text-xs bg-port-bg border border-port-border text-gray-200"
          >
            <option value="">
              Use saved default{savedGate ? ` (${READINESS_GATE_LABELS[savedGate]})` : ''}
            </option>
            {READINESS_GATE_ORDER.map((value) => (
              <option key={value} value={value}>{READINESS_GATE_LABELS[value]}</option>
            ))}
          </select>
        </div>
        <p className="text-[11px] text-gray-500">
          The editorial-health bar this run must clear before drafting visuals. A per-run choice applies to this run only — it does not change the saved default.
        </p>
        <div className="pt-1">
          <RoundInput
            id="autopilot-check-pause-threshold"
            label="Pause at high findings"
            {...options.inputProps('checkFindingsPauseThreshold')}
            max={null}
          />
        </div>
        <p className="text-[11px] text-gray-500">
          When the editorial-checks pass surfaces this many High findings (or more), the run pauses for review instead of proceeding. 0 = off. Saved as the default and reused on Resume.
        </p>
        <label className="flex items-center gap-2 text-xs text-gray-300 pt-1 border-t border-port-border mt-1">
          <input type="checkbox" checked={opt.revisionEnabled} onChange={(e) => options.edit('revisionEnabled', e.target.checked)} />
          Iterate to quality (revise the weakest issue under a keep/revert score gate)
        </label>
        {opt.revisionEnabled ? (
          <>
            <div className="flex flex-wrap gap-4 pt-1">
              <RoundInput
                id="autopilot-revision-min-cycles"
                label="Min cycles"
                {...options.inputProps('revisionMinCycles')}
                min={1}
              />
              <RoundInput
                id="autopilot-revision-max-cycles"
                label="Max cycles"
                {...options.inputProps('revisionMaxCycles')}
                min={1}
              />
              <RoundInput
                id="autopilot-revision-plateau-delta"
                label="Plateau Δ"
                {...options.inputProps('revisionPlateauDelta')}
                min={0}
                max={10}
                step={0.1}
              />
            </div>
            <p className="text-[11px] text-gray-500">
              After the editorial-health gate, judge every drafted issue and revise the weakest via adversarial cuts, keeping a change only when the quality score doesn&apos;t regress. Stops on plateau (mean score moves less than Δ), hedged-convergence, or max cycles. Fresh judge + cut LLM spend — saved as the default and reused on Resume.
            </p>
          </>
        ) : null}
      </CollapsibleSection>
    </div>
  );
}
