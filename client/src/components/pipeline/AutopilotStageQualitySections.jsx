import { useRef } from 'react';
import CollapsibleSection from '../ui/CollapsibleSection';
import AutopilotStageRoutingForm from './AutopilotStageRoutingForm';
import { formatCount } from '../../utils/formatters.js';
import { READINESS_GATE_LABELS, READINESS_GATE_ORDER } from '../../lib/editorialHealth.js';

// Bounds are UI constraints; the fallback values come from the shared defaults.
export const ROUND_MIN = 0;
export const ROUND_MAX = 20;
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
 * editors. The run-options and stage-route hooks own their state.
 */
export default function AutopilotStageQualitySections({
  stageRouting, opt, options, qualityOverrides,
  readinessGate, setReadinessGate, savedGate,
}) {
  return (
    <div className="border-t border-port-border px-3">
      <AutopilotStageRoutingForm {...stageRouting} />
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
