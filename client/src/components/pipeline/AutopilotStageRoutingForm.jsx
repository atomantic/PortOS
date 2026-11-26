import CollapsibleSection from '../ui/CollapsibleSection';
import ProviderModelSelector from '../ProviderModelSelector';
import { providerDisplayName, providerModelLabel } from '../../utils/providers';
import { formatCount } from '../../utils/formatters.js';

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

export default function AutopilotStageRoutingForm({
  providers, customStages, editStageLlm, setEditStageLlm, setStageLlm,
  selectedStageLlm, setSelectedStageLlm, selectedStageRole, setSelectedStageRole,
  selectedStageRoute, stageProviderId, stageModel, stageModels, stageEffort,
  stageBaseProviderId, stageBaseModel, updateSelectedStageRoute,
}) {
  return (
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
  );
}
