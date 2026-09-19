import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import toast from '../ui/Toast';
import Banner from '../ui/Banner';
import * as api from '../../services/api';
import ReviewerPicker from '../cos/ReviewerPicker';
import GoalFidelityControls from './GoalFidelityControls';
import useReviewerModelOptions from '../../hooks/useReviewerModelOptions';
import { reviewerModelsFromDefaults, reviewerModelsToDefaults, reviewerEffortsFromDefaults, reviewerEffortsToDefaults } from '../../lib/reviewerModels';
import { DEFAULT_GOAL_FIDELITY_FOLLOW_UP_TRIGGER } from '../../lib/reviewerPins';
import {
  DEFAULT_REVIEWERS,
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
  const [reviewers, setReviewers] = useState(DEFAULT_REVIEWERS);
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
  const [reviewerFallbackGroups, setReviewerFallbackGroups] = useState([]);
  const modelOptions = useReviewerModelOptions();

  const loadDefaults = useCallback(() => {
    setLoading(true);
    setLoadError(false);
    let cancelled = false;
    api.getCodeReviewDefaults({ silent: true })
      .then((defaults) => {
        if (cancelled) return;
        if (defaults) {
          setReviewers(Array.isArray(defaults.reviewers) && defaults.reviewers.length ? defaults.reviewers : DEFAULT_REVIEWERS);
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
          setReviewerFallbackGroups(Array.isArray(defaults.reviewerFallbackGroups) ? defaults.reviewerFallbackGroups : []);
        } else {
          setLoadError(true);
        }
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadError(true);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    return loadDefaults();
  }, [loadDefaults]);

  const handleSave = async () => {
    if (saving || loadError) return;
    setSaving(true);
    const payload = {
      reviewers,
      reviewerFallbackGroups,
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
    setSaving(false);
    if (ok) toast.success('Code Review Defaults saved');
  };

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-2">
        <ShieldCheck size={16} className="text-port-accent" />
        <h2 className="text-base font-semibold text-white">Code Review Defaults</h2>
      </div>
      <p className="text-xs text-gray-500">
        Choose providers and models for the default review chain used by CoS tasks and schedules without their own override. Leave the chain empty to disable code review by default. Provider reviews retain the selected provider's configuration; existing harness and GitHub reviewer choices remain available below. Choose <span className="font-mono">Custom…</span> on a reviewer row to enter a model absent from its catalog.
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
          {Object.entries(reviewerHealth).filter(([, health]) => Number(health?.pausedUntil) > Date.now()).map(([reviewer, health]) => (
            <Banner key={reviewer} tone="warning" size="sm" align="left">
              {reviewer} is temporarily paused after a quota or usage-limit failure until {new Date(health.pausedUntil).toLocaleString()}.
            </Banner>
          ))}
          <div className="space-y-1">
            <label htmlFor="reviewer-fallback-groups" className="text-xs text-gray-400">Fallback reviewer groups</label>
            <textarea
              id="reviewer-fallback-groups"
              value={reviewerFallbackGroups.map(group => group.join(', ')).join('\n')}
              onChange={(event) => setReviewerFallbackGroups(event.target.value.split('\n').map(line => line.split(',').map(value => value.trim()).filter(Boolean)).filter(group => group.length))}
              placeholder="nim, opencode\nollama\ncopilot"
              rows={3}
              className="w-full rounded border border-port-border bg-port-bg px-2 py-1.5 text-xs text-white"
              disabled={saving || loadError}
            />
            <p className="text-[11px] text-gray-500">One fallback tier per line. A tier runs together; the next tier is selected when every reviewer in it is paused.</p>
          </div>
          <ReviewerPicker
            reviewers={reviewers}
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
            onChange={({ reviewers: r, usernames: u, optionalReviewers: o, reviewerMaxRounds: m, reviewerModels: dm, reviewerEfforts: de, stopMode: s, reviewerApplies: a }) => {
              setReviewers(r);
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
