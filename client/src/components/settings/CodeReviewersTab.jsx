import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { CircleHelp, ListTree, ScanSearch } from 'lucide-react';
import toast from '../ui/Toast';
import Banner from '../ui/Banner';
import Drawer from '../Drawer';
import TabPills from '../ui/TabPills';
import * as api from '../../services/api';
import ReviewerGroupsEditor from '../cos/ReviewerGroupsEditor';
import GoalFidelityControls from './GoalFidelityControls';
import CodeReviewHelp from './CodeReviewHelp';
import useReviewerModelOptions from '../../hooks/useReviewerModelOptions';
import { reviewerModelsFromDefaults, reviewerModelsToDefaults, reviewerEffortsFromDefaults, reviewerEffortsToDefaults } from '../../lib/reviewerModels';
import { DEFAULT_GOAL_FIDELITY_FOLLOW_UP_TRIGGER } from '../../lib/reviewerPins';
import {
  DEFAULT_REVIEW_STOP_MODE,
} from '../cos/constants';

// Global Code Review Defaults — the chain the Review Loop uses when a task or
// task-type config didn't pin its own reviewers. Owns Models → Code Reviewers.
// Every per-reviewer control (model, `~opt`, `~max`) lives in the shared
// ReviewerPicker table (#3133), so this tab owns the fetch of the model option
// lists (via useReviewerModelOptions), the save, and which task view is open.
//
// Review chain and Follow-up are route-backed task views. The help drawer holds
// the tier rules once; the cards themselves stay the controls.

const REVIEW_VIEWS = [
  { id: 'chain', label: 'Review chain', icon: ListTree },
  { id: 'follow-up', label: 'Follow-up', icon: ScanSearch },
];
const CHAIN_PATH = '/models/code-reviewers';
const FOLLOW_UP_PATH = '/models/code-reviewers/follow-up';

const CONFIG_FAULT_REMEDIES = {
  NO_MODEL: 'Select a model on Review chain.',
  REVIEWER_ACCESS_DENIED: 'Select an accessible service or model, or correct provider access.',
  REVIEWER_UNSUPPORTED: 'Set its command or switch it to API mode in AI Providers.',
};

// `null` when the URL is not this page (unit tests render the panel alone).
// A slug under the page that is not a known view is returned so the caller can
// replace it with the chain.
function viewFromPath(pathname) {
  const path = String(pathname || '').replace(/\/+$/, '');
  if (path === CHAIN_PATH) return 'chain';
  if (!path.startsWith(`${CHAIN_PATH}/`)) return null;
  return path.slice(CHAIN_PATH.length + 1).split('/')[0] || 'chain';
}

export default function CodeReviewersTab({ view } = {}) {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const pathView = viewFromPath(location.pathname);
  const requested = pathView ?? (view === 'follow-up' ? 'follow-up' : 'chain');
  const activeView = requested === 'follow-up' ? 'follow-up' : 'chain';
  const helpOpen = searchParams.get('help') === '1';
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [usernames, setUsernames] = useState([]);
  const [optionalReviewers, setOptionalReviewers] = useState([]);
  const [reviewerMaxRounds, setReviewerMaxRounds] = useState({});
  const [reviewerModels, setReviewerModels] = useState({});
  const [reviewerEfforts, setReviewerEfforts] = useState({});
  const [stopMode, setStopMode] = useState(DEFAULT_REVIEW_STOP_MODE);
  const [reviewerApplies, setReviewerApplies] = useState(false);
  const [goalFidelity, setGoalFidelity] = useState({
    enabled: true, backend: null, model: null, effort: null,
    fileIssue: false, queueTask: false, followUpOn: DEFAULT_GOAL_FIDELITY_FOLLOW_UP_TRIGGER,
  });
  const [installed, setInstalled] = useState({});
  const [providerReviewUnsupported, setProviderReviewUnsupported] = useState({});
  const [reviewerHealth, setReviewerHealth] = useState({});
  const [reviewerConfigFaults, setReviewerConfigFaults] = useState({});
  const [reviewerFallbackGroups, setReviewerFallbackGroups] = useState([]);
  const modelOptions = useReviewerModelOptions();
  const loadVersion = useRef(0);
  const saveInFlight = useRef(false);

  const loadDefaults = useCallback(() => {
    setLoading(true);
    setLoadError(false);
    const version = ++loadVersion.current;
    api.getCodeReviewDefaults({ silent: true })
      .then((defaults) => {
        if (version !== loadVersion.current) return;
        const groups = defaults?.reviewerFallbackGroups;
        const validList = value => Array.isArray(value) && value.every(token => typeof token === 'string' && !token.startsWith('@'));
        if (defaults && (groups === undefined ? validList(defaults.reviewers) : Array.isArray(groups) && groups.every(validList))) {
          setUsernames(Array.isArray(defaults.usernames) ? defaults.usernames : []);
          setOptionalReviewers(Array.isArray(defaults.optionalReviewers) ? defaults.optionalReviewers : []);
          setReviewerMaxRounds(defaults.reviewerMaxRounds && typeof defaults.reviewerMaxRounds === 'object' && !Array.isArray(defaults.reviewerMaxRounds)
            ? defaults.reviewerMaxRounds
            : {});
          setReviewerModels(reviewerModelsFromDefaults(defaults));
          setReviewerEfforts(reviewerEffortsFromDefaults(defaults));
          setStopMode(defaults.stopMode || DEFAULT_REVIEW_STOP_MODE);
          setReviewerApplies(defaults.reviewerApplies === true);
          // `enabled` defaults ON, so an absent block must read as on — not as a
          // stored `false` the next save would then persist.
          setGoalFidelity({
            enabled: defaults.goalFidelity?.enabled !== false,
            backend: defaults.goalFidelity?.backend || null,
            model: defaults.goalFidelity?.model || null,
            effort: defaults.goalFidelity?.effort || null,
            // Both follow-up actions default OFF — filing on a tracker and
            // spawning an unattended run are each opt-in — so an absent block
            // must read as off, the mirror image of `enabled` above.
            fileIssue: defaults.goalFidelity?.fileIssue === true,
            queueTask: defaults.goalFidelity?.queueTask === true,
            followUpOn: defaults.goalFidelity?.followUpOn || DEFAULT_GOAL_FIDELITY_FOLLOW_UP_TRIGGER,
          });
          setInstalled(defaults.installed && typeof defaults.installed === 'object' && !Array.isArray(defaults.installed) ? defaults.installed : {});
          setProviderReviewUnsupported(defaults.providerReviewUnsupported && typeof defaults.providerReviewUnsupported === 'object' && !Array.isArray(defaults.providerReviewUnsupported) ? defaults.providerReviewUnsupported : {});
          setReviewerHealth(defaults.reviewerHealth && typeof defaults.reviewerHealth === 'object' && !Array.isArray(defaults.reviewerHealth) ? defaults.reviewerHealth : {});
          setReviewerConfigFaults(defaults.reviewerConfigFaults && typeof defaults.reviewerConfigFaults === 'object' && !Array.isArray(defaults.reviewerConfigFaults) ? defaults.reviewerConfigFaults : {});
          // Persisted priority is independent of defaults.reviewers, which is
          // the currently healthy tier for execution consumers.
          const configured = groups ?? (defaults.reviewers.length ? [defaults.reviewers] : []);
          setReviewerFallbackGroups(configured.map((reviewers, index) => ({ id: `tier-${index}`, reviewers })));
        } else {
          setLoadError(true);
        }
        setLoading(false);
      })
      .catch(() => {
        if (version !== loadVersion.current) return;
        setLoadError(true);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    loadDefaults();
    return () => { loadVersion.current += 1; };
  }, [loadDefaults]);

  useEffect(() => {
    if (pathView && pathView !== 'chain' && pathView !== 'follow-up') {
      navigate({ pathname: CHAIN_PATH, search: location.search }, { replace: true });
    }
  }, [location.search, navigate, pathView]);

  const openView = (next) => {
    navigate({ pathname: next === 'follow-up' ? FOLLOW_UP_PATH : CHAIN_PATH, search: location.search });
  };
  const setHelp = (open) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (open) next.set('help', '1');
      else next.delete('help');
      return next;
    }, { replace: true });
  };

  const handleSave = async () => {
    if (saveInFlight.current || loading || loadError) return;
    saveInFlight.current = true;
    setSaving(true);
    const groups = reviewerFallbackGroups.filter(group => group.reviewers.length);
    const payload = {
      reviewers: groups[0]?.reviewers || [],
      reviewerFallbackGroups: groups.map(group => group.reviewers),
      usernames,
      optionalReviewers,
      reviewerMaxRounds,
      stopMode,
      reviewerApplies,
      ...reviewerModelsToDefaults(reviewerModels),
      ...reviewerEffortsToDefaults(reviewerEfforts),
      // Absent keys are dropped rather than sent as null: the schema treats an
      // absent scalar as "inherit", and persisting an explicit null would be a
      // pin the resolver can't tell from a deliberate one.
      goalFidelity: {
        enabled: goalFidelity.enabled,
        ...(goalFidelity.backend ? { backend: goalFidelity.backend } : {}),
        ...(goalFidelity.model ? { model: goalFidelity.model } : {}),
        ...(goalFidelity.effort ? { effort: goalFidelity.effort } : {}),
        // Booleans always ride: unlike the scalars above, `false` here is the
        // user turning an action OFF, not "inherit", so dropping it would make
        // the switch un-clearable once it had been on. The trigger is the other
        // way round — it only means something once an action is armed, so an
        // install that never armed one is left inheriting the shipped default
        // rather than pinned to today's value forever.
        fileIssue: goalFidelity.fileIssue === true,
        queueTask: goalFidelity.queueTask === true,
        ...(goalFidelity.fileIssue || goalFidelity.queueTask ? { followUpOn: goalFidelity.followUpOn } : {}),
      },
    };
    const ok = await api.updateSettings({ codeReview: payload }, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error(`Failed to save Code Review Defaults: ${err?.message || 'Save failed'}`); return false; });
    saveInFlight.current = false;
    setSaving(false);
    if (ok) {
      setReviewerFallbackGroups(groups);
      toast.success('Code Review Defaults saved');
    }
  };

  return (
    <div className="space-y-4 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TabPills
          tabs={REVIEW_VIEWS}
          activeTab={activeView}
          onChange={openView}
          ariaLabel="Code review tasks"
          controlsIdPrefix="code-review-task"
          mobileCompact
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setHelp(true)}
            className="inline-flex min-h-11 items-center gap-1.5 px-3 text-sm text-gray-300 border border-port-border rounded hover:text-white hover:border-port-accent"
          >
            <CircleHelp size={16} aria-hidden="true" />
            How this works
          </button>
          {!loading && (
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || loadError}
              className="min-h-11 px-3 text-sm bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 text-white rounded transition-colors"
            >
              {saving ? 'Saving…' : 'Save defaults'}
            </button>
          )}
        </div>
      </div>
      <p className="text-sm text-gray-400">
        {activeView === 'follow-up'
          ? 'After a run ships, compare its diff with the task it was given.'
          : 'Primary runs first. One paused reviewer skips that whole tier. Tasks with their own reviewers keep that override.'}
      </p>

      {loadError && (
        <Banner
          tone="error"
          size="sm"
          align="center"
          actions={
            <button
              type="button"
              onClick={loadDefaults}
              className="px-2.5 py-1 text-xs font-medium bg-port-error/20 hover:bg-port-error/30 text-port-error rounded transition-colors"
            >
              Retry
            </button>
          }
        >
          Failed to load code review defaults.
        </Banner>
      )}

      {loading ? (
        <div className="text-xs text-gray-500">Loading defaults…</div>
      ) : (
        <>
          {Object.entries(reviewerConfigFaults).map(([reviewer, fault]) => (
            <Banner key={`config-${reviewer}`} tone="warning" size="sm" align="left">
              {reviewer}: the last review attempt failed ({fault.code}). {CONFIG_FAULT_REMEDIES[fault.code] || 'Enable or configure the reviewer in Settings → Code Reviewers.'} The next successful review clears this warning.
            </Banner>
          ))}
          {activeView === 'chain' ? (
            <div role="tabpanel" id="code-review-task-chain" aria-labelledby="tab-chain">
              <ReviewerGroupsEditor
                groups={reviewerFallbackGroups}
                onGroupsChange={setReviewerFallbackGroups}
                reviewerHealth={reviewerHealth}
                usernames={usernames}
                optionalReviewers={optionalReviewers}
                reviewerMaxRounds={reviewerMaxRounds}
                reviewerModels={reviewerModels}
                reviewerEfforts={reviewerEfforts}
                modelOptions={modelOptions}
                installed={installed}
                providerReviewUnsupported={providerReviewUnsupported}
                stopMode={stopMode}
                reviewerApplies={reviewerApplies}
                disabled={saving || loadError}
                onChange={({ usernames: u, optionalReviewers: o, reviewerMaxRounds: m, reviewerModels: dm, reviewerEfforts: de, stopMode: s, reviewerApplies: a }) => {
                  setUsernames(u);
                  setOptionalReviewers(o);
                  setReviewerMaxRounds(m);
                  setReviewerModels(dm);
                  setReviewerEfforts(de);
                  setStopMode(s);
                  setReviewerApplies(a);
                }}
              />
            </div>
          ) : (
            <div role="tabpanel" id="code-review-task-follow-up" aria-labelledby="tab-follow-up">
              <GoalFidelityControls
                value={goalFidelity}
                modelOptions={modelOptions}
                disabled={saving || loadError}
                onChange={setGoalFidelity}
              />
            </div>
          )}
        </>
      )}
      <Drawer
        open={helpOpen}
        onClose={() => setHelp(false)}
        title="How code review works"
        closeLabel="Close how code review works"
        size="md"
      >
        <CodeReviewHelp />
      </Drawer>
    </div>
  );
}
