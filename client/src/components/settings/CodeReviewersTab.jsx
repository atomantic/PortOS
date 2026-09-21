import { useCallback, useEffect, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import toast from '../ui/Toast';
import Banner from '../ui/Banner';
import * as api from '../../services/api';
import ReviewerGroupsEditor from '../cos/ReviewerGroupsEditor';
import GoalFidelityControls from './GoalFidelityControls';
import useReviewerModelOptions from '../../hooks/useReviewerModelOptions';
import { reviewerModelsFromDefaults, reviewerModelsToDefaults, reviewerEffortsFromDefaults, reviewerEffortsToDefaults } from '../../lib/reviewerModels';
import { DEFAULT_GOAL_FIDELITY_FOLLOW_UP_TRIGGER } from '../../lib/reviewerPins';
import {
  DEFAULT_REVIEW_STOP_MODE,
} from '../cos/constants';

// Global Code Review Defaults — the chain the Review Loop uses when a task or
// task-type config didn't pin its own reviewers. Owns the Settings › Code
// Reviewers tab (it used to sit at the top of the AI Providers page, where it
// buried the provider list under a table most visits didn't need). Every
// per-reviewer control (model, `~opt`, `~max`) lives in the shared
// ReviewerPicker table (#3133), so this tab owns only the fetch of the model
// option lists (via useReviewerModelOptions) and the save.
export default function CodeReviewersTab() {
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
    <div className="bg-port-card border border-port-border rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-2">
        <ShieldCheck size={16} className="text-port-accent" />
        <h2 className="text-base font-semibold text-white">Code Review Defaults</h2>
      </div>
      <p className="text-xs text-gray-500">
        Choose Primary and fallback tiers for CoS tasks and schedules without their own override. Clearing all tiers disables AI reviewers while preserving forge reviewers. Provider reviews retain the selected provider's configuration. Choose <span className="font-mono">Custom…</span> on a reviewer row to enter a model absent from its catalog.
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
              {reviewer} cannot review on this install ({fault.code}). The review loop is currently a no-op for this reviewer. {fault.code === 'NO_MODEL'
                ? 'Select a model in this tab.'
                : fault.code === 'REVIEWER_ACCESS_DENIED'
                  ? 'Select an accessible service or model, or correct provider access. A successful review clears this warning.'
                  : fault.code === 'REVIEWER_UNSUPPORTED'
                    ? 'Switch the provider to API mode or choose a supported tool-free review harness.'
                    : 'Enable or configure the reviewer in Settings → Code Reviewers.'}
            </Banner>
          ))}
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

          <GoalFidelityControls
            value={goalFidelity}
            modelOptions={modelOptions}
            disabled={saving || loadError}
            onChange={setGoalFidelity}
          />

          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || loadError}
              className="px-3 py-1.5 text-sm bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 text-white rounded transition-colors"
            >
              {saving ? 'Saving…' : 'Save defaults'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
