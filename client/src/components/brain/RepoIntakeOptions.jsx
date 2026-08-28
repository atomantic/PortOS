import { GitBranch, ShieldCheck, Lightbulb } from 'lucide-react';
import ToggleChip from '../ui/ToggleChip';
import AgentJobProviderFields from '../cos/AgentJobProviderFields';

/**
 * The "this URL is a GitHub repo" affordance shared by both Brain capture boxes
 * (the Quick Capture dashboard widget and the Inbox capture form).
 *
 * Presentational only — the sticky checkbox state and the repo-URL rule live in
 * `hooks/useRepoIntake.js`, whose `repo` this renders. The keys must stay in
 * step with the server's `REPO_INTAKE_KEYS`; parity is pinned by
 * `server/lib/repoIntakeActions.mirror.test.js`.
 */
export const REPO_INTAKE_OPTIONS = [
  {
    key: 'malwareScan',
    label: 'Scan for malware',
    Icon: ShieldCheck,
    hint: 'Read-only static audit of the clone. Produces a CLEAN / CAUTION / DANGEROUS report you can open from the link.',
  },
  {
    key: 'learn',
    label: 'Study for app ideas',
    Icon: Lightbulb,
    hint: 'An agent studies the clone as a product — its features and design — and files the feature ideas and enhancements worth adopting as issues. Clean-room — it never copies code.',
  },
];

/**
 * @param {object} props
 * @param {string} props.idPrefix unique per host form — the checkbox ids/labels
 *   must not collide when both capture boxes are mounted on the same page.
 * @param {{owner: string, repo: string}|null} props.repo parsed repo, or null to
 *   render nothing (the capture isn't a bare repo URL)
 * @param {{malwareScan: boolean, learn: boolean}} props.options
 * @param {string} props.studyContext
 * @param {(context: string) => void} props.onStudyContextChange
 * @param {{providerId: string, model: string, effort: string}} props.providerOverride
 * @param {Array} props.providers
 * @param {string} props.activeProviderId
 * @param {(patch: object) => void} props.onProviderOverrideChange
 * @param {(key: string) => void} props.onToggle
 */
export default function RepoIntakeOptions({ idPrefix, repo, options, managedApps = [], targetAppId, onTargetAppChange, studyContext = '', onStudyContextChange, providerOverride = { providerId: '', model: '', effort: '' }, providers = [], activeProviderId = '', onProviderOverrideChange, onToggle }) {
  if (!repo) return null;

  return (
    <div className="mt-3 pt-3 border-t border-port-border space-y-2">
      <p className="flex items-center gap-1.5 text-xs text-gray-400">
        <GitBranch size={12} className="text-port-accent shrink-0" />
        <span>
          <span className="text-gray-200">{repo.owner}/{repo.repo}</span> will be cloned locally.
        </span>
      </p>
      <div className="flex flex-wrap gap-2">
        {REPO_INTAKE_OPTIONS.map(({ key, label, hint, Icon }) => (
          <ToggleChip
            key={key}
            id={`${idPrefix}-${key}`}
            label={label}
            hint={hint}
            Icon={Icon}
            checked={options[key]}
            onToggle={() => onToggle(key)}
          />
        ))}
      </div>
      {options.learn && managedApps.length > 0 && (
        <label htmlFor={`${idPrefix}-target-app`} className="block text-xs text-gray-400">
          File study issues against
          <select
            id={`${idPrefix}-target-app`}
            value={targetAppId}
            onChange={e => onTargetAppChange?.(e.target.value)}
            className="ml-2 px-2 py-1 bg-port-bg border border-port-border rounded text-gray-200 text-xs"
          >
            {managedApps.map(app => <option key={app.id} value={app.id}>{app.name}</option>)}
          </select>
        </label>
      )}
      {options.learn && (
        <div>
          <label htmlFor={`${idPrefix}-study-context`} className="block text-xs text-gray-400 mb-1">
            Study context <span className="text-gray-600">(optional)</span>
          </label>
          <textarea
            id={`${idPrefix}-study-context`}
            rows={3}
            maxLength={5000}
            value={studyContext}
            onChange={e => onStudyContextChange?.(e.target.value)}
            placeholder="What should the agent look for, and where might an implementation fit?"
            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
          />
        </div>
      )}
      {options.learn && (
        <div className="pt-1">
          <AgentJobProviderFields
            data={providerOverride}
            providers={providers}
            activeProviderId={activeProviderId}
            onChange={onProviderOverrideChange}
          />
          {providers.length > 0 && (
            <p className="mt-1 text-xs text-gray-500">
              Optional override for this study only. Leave it on the default to use the configured CoS provider.
            </p>
          )}
        </div>
      )}
      {REPO_INTAKE_OPTIONS.some(({ key }) => options[key]) && (
        <p className="text-xs text-gray-500">
          A CoS agent starts once the clone finishes — track it in Chief of Staff.
        </p>
      )}
    </div>
  );
}
