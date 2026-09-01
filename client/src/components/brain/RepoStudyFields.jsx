import AgentJobProviderFields from '../cos/AgentJobProviderFields';

/**
 * The `repo-study` configuration form: which managed app's tracker receives the
 * issues, the free-form brief telling the agent what to look for, and an
 * optional provider/model/effort pin for that one run.
 *
 * Presentational only — state lives in `hooks/useRepoStudyConfig.js`, whose
 * return value spreads straight onto these props (the prop names ARE that
 * hook's, so a call site never has to re-map them). Shared by the Brain capture
 * boxes' post-clone opt-in (`RepoIntakeOptions`) and the Links tab's on-demand
 * re-study panel, so the two can't drift.
 *
 * @param {object} props
 * @param {string} props.idPrefix unique per host form — the field ids/labels
 *   must not collide when several of these are mounted on the same page.
 * @param {string} [props.contextLabel] heading for the brief textarea.
 * @param {string} [props.contextPlaceholder]
 * @param {string} [props.providerHint] note under the provider controls.
 */
export default function RepoStudyFields({
  idPrefix,
  managedApps,
  targetAppId,
  setTargetAppId,
  studyContext,
  setStudyContext,
  providerOverride,
  providers,
  activeProviderId,
  setProviderOverride,
  contextLabel = 'Study context',
  contextPlaceholder = 'What should the agent look for, and where might an implementation fit?',
  providerHint = 'Optional override for this study only. Leave it on the default to use the configured CoS provider.',
}) {
  return (
    <>
      {managedApps.length > 0 && (
        <label htmlFor={`${idPrefix}-target-app`} className="block text-xs text-gray-400">
          File study issues against
          <select
            id={`${idPrefix}-target-app`}
            value={targetAppId}
            onChange={e => setTargetAppId?.(e.target.value)}
            className="ml-2 px-2 py-1 bg-port-bg border border-port-border rounded text-gray-200 text-xs"
          >
            {managedApps.map(app => <option key={app.id} value={app.id}>{app.name}</option>)}
          </select>
        </label>
      )}
      <div>
        <label htmlFor={`${idPrefix}-study-context`} className="block text-xs text-gray-400 mb-1">
          {contextLabel} <span className="text-gray-600">(optional)</span>
        </label>
        <textarea
          id={`${idPrefix}-study-context`}
          rows={3}
          maxLength={5000}
          value={studyContext}
          onChange={e => setStudyContext?.(e.target.value)}
          placeholder={contextPlaceholder}
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
        />
      </div>
      <div className="pt-1">
        <AgentJobProviderFields
          data={providerOverride}
          providers={providers}
          activeProviderId={activeProviderId}
          onChange={setProviderOverride}
        />
        {providers.length > 0 && (
          <p className="mt-1 text-xs text-gray-500">{providerHint}</p>
        )}
      </div>
    </>
  );
}
