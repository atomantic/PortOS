import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  Activity,
  Brain,
  Database,
  ExternalLink,
  Gauge,
  Palette,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import toast from '../../ui/Toast';
import { updateCosConfig, getCosBudgetUsage } from '../../../services/apiAgents.js';
import ConfigRow from './ConfigRow';
import MemoryEmbeddingRecommendation from '../MemoryEmbeddingRecommendation';
import {
  AVATAR_STYLE_LABELS,
  AUTONOMY_DOMAINS,
  CREATIVE_DOMAIN,
  CREATIVE_DOMAIN_MODES,
  DOMAIN_AUTONOMY_MODES,
  DOMAIN_BUDGET_FIELDS,
  getCreativeAutonomyMode,
  getCreativeAutonomyOverride,
  getDomainBudget,
  getDomainMode,
  normalizeBudgetLimit,
} from '../constants';
import EmbeddingSourceNotice from '../../settings/EmbeddingSourceNotice';
import { updateSettings } from '../../../services/apiSystem';
import { coverageSummary, isRiggedAvatarStyle, riggedRecordForStyle } from '../../../hooks/useAvatarCapabilities';

const DOMAIN_MODE_COLORS = {
  off: {
    base: 'border-port-border text-port-text-muted hover:bg-port-border/30',
    active: 'border-port-border bg-port-border text-port-text',
  },
  'dry-run': {
    base: 'border-port-warning/30 text-port-warning hover:bg-port-warning/10',
    active: 'border-port-warning bg-port-warning text-port-bg',
  },
  execute: {
    base: 'border-port-success/30 text-port-success hover:bg-port-success/10',
    active: 'border-port-success bg-port-success text-white',
  },
};

const PRIORITY_OPTIONS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']
  .map((value) => ({ value, label: value[0] + value.slice(1).toLowerCase() }));

// Mirrors OUTWARD_SAFETY_KINDS. Each kind has its own pending form value.
const SAFETY_KIND_FIELDS = [
  { id: 'content', field: 'safetyKindContent', label: 'Content', description: 'Generated posts, newsletters, and blogs.' },
  { id: 'publish', field: 'safetyKindPublish', label: 'Publish', description: 'Deploys, releases, and outbound sends.' },
  { id: 'federation', field: 'safetyKindFederation', label: 'Federation', description: 'Record sync to the user\'s other machines.' },
  { id: 'external-pr', field: 'safetyKindExternalPr', label: 'External PR', description: 'Pull requests opened outside this install.' },
];

const selectedSafetyKinds = (form) => SAFETY_KIND_FIELDS.filter((item) => form[item.field]).map((item) => item.id);

const removeOverride = (overrides, key) => {
  const remaining = { ...overrides };
  delete remaining[key];
  return remaining;
};

const getDefaultFormData = (config, avatarStyle) => ({
  healthCheckIntervalMs: config?.healthCheckIntervalMs ?? 900_000,
  maxConcurrentAgents: config?.maxConcurrentAgents ?? 3,
  maxConcurrentAgentsPerProject: config?.maxConcurrentAgentsPerProject ?? 2,
  maxTotalProcesses: config?.maxTotalProcesses ?? 50,
  startOnBoot: Boolean(config?.alwaysOn || config?.autoStart),
  improvementEnabled: config?.improvementEnabled ?? config?.selfImprovementEnabled ?? true,
  idleReviewEnabled: config?.idleReviewEnabled ?? true,
  idleReviewPriority: config?.idleReviewPriority ?? 'MEDIUM',
  autonomousJobsEnabled: config?.autonomousJobsEnabled ?? true,
  autoApproveInvestigations: config?.autoApproveInvestigations ?? false,
  appReviewCooldownMs: config?.appReviewCooldownMs ?? 1_800_000,
  avatarStyle: config?.avatarStyle || avatarStyle || 'svg',
  dynamicAvatar: config?.dynamicAvatar ?? true,
  confidenceEnabled: config?.confidenceAutoApproval?.enabled ?? true,
  confidenceHighThreshold: config?.confidenceAutoApproval?.highThreshold ?? 80,
  confidenceLowThreshold: config?.confidenceAutoApproval?.lowThreshold ?? 50,
  confidenceMinSamples: config?.confidenceAutoApproval?.minSamples ?? 5,
  safetyEnabled: config?.safetyKindApproval?.enabled ?? true,
  ...Object.fromEntries(SAFETY_KIND_FIELDS.map((item) => [
    item.field,
    (config?.safetyKindApproval?.alwaysApproveKinds ?? SAFETY_KIND_FIELDS.map((kind) => kind.id)).includes(item.id),
  ])),
});

function SectionHeading({ icon: Icon, title, description }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-port-accent/10 text-port-accent">
        <Icon size={17} aria-hidden="true" />
      </span>
      <div>
        <h4 className="text-sm font-semibold text-port-text">{title}</h4>
        {description && <p className="mt-0.5 text-xs leading-relaxed text-port-text-muted">{description}</p>}
      </div>
    </div>
  );
}

function DomainAutomationControl({ config, usage, onDomainChange, onBudgetChange }) {
  const creativeOverride = getCreativeAutonomyOverride(config);
  const effectiveCreativeMode = getCreativeAutonomyMode(config);
  const effectiveCreativeLabel = DOMAIN_AUTONOMY_MODES.find((mode) => mode.id === effectiveCreativeMode)?.label || effectiveCreativeMode;

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {AUTONOMY_DOMAINS.map((domain) => {
        const current = getDomainMode(config, domain.id);
        const budget = getDomainBudget(config, domain.id);
        const domainUsage = usage?.[domain.id] || { actions: 0, ms: 0 };
        const minutesUsed = Math.round((domainUsage.ms || 0) / 60_000);

        return (
          <article key={domain.id} className="rounded-lg border border-port-border bg-port-card p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h5 className="text-sm font-medium text-port-text">{domain.label}</h5>
                <p className="mt-1 text-xs leading-relaxed text-port-text-muted">{domain.description}</p>
              </div>
              <span className="shrink-0 rounded-full bg-port-bg px-2 py-1 text-[11px] text-port-text-muted">
                {domainUsage.actions || 0} actions · {minutesUsed} min today
              </span>
            </div>

            <div className="mt-3 grid grid-cols-3 gap-1" role="group" aria-label={`${domain.label} mode`}>
              {DOMAIN_AUTONOMY_MODES.map((mode) => {
                const active = current === mode.id;
                const colors = DOMAIN_MODE_COLORS[mode.id];
                return (
                  <button
                    key={mode.id}
                    type="button"
                    aria-pressed={active}
                    title={mode.description}
                    onClick={() => onDomainChange(domain.id, mode.id)}
                    className={`rounded-md border px-2 py-1.5 text-xs font-medium transition-colors ${active ? colors.active : colors.base}`}
                  >
                    {mode.label}
                  </button>
                );
              })}
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2 border-t border-port-border pt-3">
              {DOMAIN_BUDGET_FIELDS.map((field) => {
                const inputId = `budget-${domain.id}-${field.id}`;
                const cap = budget[field.id];
                const used = field.usageKey === 'actions'
                  ? domainUsage.actions || 0
                  : (domainUsage.ms || 0) / 60_000;
                const capped = cap != null && used >= cap;
                return (
                  <div key={field.id}>
                    <label htmlFor={inputId} className="mb-1 block text-[11px] text-port-text-muted">{field.label}</label>
                    <input
                      id={inputId}
                      key={`${inputId}-${cap ?? ''}`}
                      type="number"
                      min="0"
                      inputMode="numeric"
                      defaultValue={cap ?? ''}
                      placeholder="Unlimited"
                      onBlur={(event) => onBudgetChange(domain.id, field.id, event.target.value)}
                      className={`w-full rounded-md border bg-port-bg px-2 py-1.5 text-xs text-port-text ${capped ? 'border-port-warning' : 'border-port-border'}`}
                    />
                  </div>
                );
              })}
            </div>
          </article>
        );
      })}

      <article className="rounded-lg border border-port-border bg-port-card p-4 md:col-span-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h5 className="text-sm font-medium text-port-text">{CREATIVE_DOMAIN.label}</h5>
            <p className="mt-1 text-xs leading-relaxed text-port-text-muted">{CREATIVE_DOMAIN.description}</p>
          </div>
          <span className="shrink-0 rounded-full bg-port-bg px-2 py-1 text-[11px] text-port-text-muted">
            {creativeOverride
              ? `Override: ${effectiveCreativeLabel} · Uses CoS budget`
              : `Inheriting CoS (${effectiveCreativeLabel}) · Uses CoS budget`}
          </span>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-1 sm:grid-cols-4" role="group" aria-label={`${CREATIVE_DOMAIN.label} mode`}>
          {CREATIVE_DOMAIN_MODES.map((mode) => {
            const active = creativeOverride === mode.id;
            const colors = mode.id === null
              ? {
                  base: 'border-port-accent/30 text-port-accent hover:bg-port-accent/10',
                  active: 'border-port-accent bg-port-accent text-white',
                }
              : DOMAIN_MODE_COLORS[mode.id];
            return (
              <button
                key={mode.id ?? 'inherit'}
                type="button"
                aria-pressed={active}
                title={mode.description}
                onClick={() => onDomainChange(CREATIVE_DOMAIN.id, mode.id)}
                className={`rounded-md border px-2 py-1.5 text-xs font-medium transition-colors ${active ? colors.active : colors.base}`}
              >
                {mode.label}
              </button>
            );
          })}
        </div>
      </article>
    </div>
  );
}

const getSavedDomainSelection = (config, domainId) => (
  domainId === CREATIVE_DOMAIN.id ? getCreativeAutonomyOverride(config) : getDomainMode(config, domainId)
);

export default function ConfigTab({ config, onUpdate, onEvaluate, avatarStyle, riggedAvatars = [] }) {
  const [confirmedConfig, setConfirmedConfig] = useState(config);
  const confirmedConfigRef = useRef(config);
  const [pendingConfigFields, setPendingConfigFields] = useState({});
  const [domainAutonomyOverrides, setDomainAutonomyOverrides] = useState({});
  const [domainBudgetOverrides, setDomainBudgetOverrides] = useState({});
  const [saveStatus, setSaveStatus] = useState('idle');
  const [budgetUsage, setBudgetUsage] = useState({});
  // Remounts the embeddings notice after the recommendation saves, so it
  // re-reads the backend it just switched to.
  const [embeddingSaves, setEmbeddingSaves] = useState(0);
  const configSaveQueueRef = useRef(Promise.resolve());
  const pendingSaveCountRef = useRef(0);
  const failedSaveKeysRef = useRef(new Set());
  const writeSequencesRef = useRef(new Map());

  const confirmConfig = useCallback((nextConfig) => {
    if (!nextConfig) return;
    confirmedConfigRef.current = nextConfig;
    setConfirmedConfig(nextConfig);
  }, []);

  useEffect(() => { confirmConfig(config); }, [config, confirmConfig]);

  const formData = { ...getDefaultFormData(confirmedConfig, avatarStyle), ...pendingConfigFields };

  const saveConfigPatch = useCallback((buildPatch, { key, clearOverride, onSuccess }) => {
    const sequence = (writeSequencesRef.current.get(key) ?? 0) + 1;
    writeSequencesRef.current.set(key, sequence);
    const isLatestWrite = () => writeSequencesRef.current.get(key) === sequence;
    pendingSaveCountRef.current += 1;
    setSaveStatus('saving');

    const request = configSaveQueueRef.current.then(async () => {
      const result = await updateCosConfig(buildPatch(confirmedConfigRef.current), { silent: true });
      // A successful older write still determines what a newer failure rolls back to.
      confirmConfig(result);
      return result;
    });
    configSaveQueueRef.current = request.catch(() => undefined);

    return request.then((result) => {
      if (isLatestWrite()) {
        clearOverride();
        failedSaveKeysRef.current.delete(key);
      }
      const reportRefreshError = (error) => toast.error(error?.message || 'Settings saved, but the page could not refresh');
      try {
        Promise.resolve(onSuccess?.(result)).catch(reportRefreshError);
      } catch (error) {
        reportRefreshError(error);
      }
      try {
        Promise.resolve(onUpdate?.()).catch(reportRefreshError);
      } catch (error) {
        reportRefreshError(error);
      }
      return result;
    }, (error) => {
      if (isLatestWrite()) {
        clearOverride();
        failedSaveKeysRef.current.add(key);
      }
      toast.error(error?.message || 'Configuration could not be saved');
      return null;
    }).finally(() => {
      pendingSaveCountRef.current -= 1;
      if (pendingSaveCountRef.current > 0) setSaveStatus('saving');
      else setSaveStatus(failedSaveKeysRef.current.size ? 'error' : 'saved');
    });
  }, [confirmConfig, onUpdate]);

  const patchFormField = (field, value, buildPatch) => {
    setPendingConfigFields((current) => ({ ...current, [field]: value }));
    return saveConfigPatch(buildPatch, {
      key: field,
      clearOverride: () => setPendingConfigFields((current) => removeOverride(current, field)),
    });
  };

  const updateSetting = (field, value) => patchFormField(field, value, () => (
    field === 'startOnBoot' ? { alwaysOn: value, autoStart: false } : { [field]: value }
  ));

  const patchConfidence = (field, apiKey, value) => patchFormField(field, value, () => (
    { confidenceAutoApproval: { [apiKey]: value } }
  ));

  const patchSafetyEnabled = (value) => patchFormField('safetyEnabled', value, () => (
    { safetyKindApproval: { enabled: value } }
  ));

  const patchSafetyKind = (field, checked) => patchFormField(field, checked, (savedConfig) => {
    // The API replaces the entire list. Build it when the write starts so a sibling
    // edit that failed while this one was queued cannot be persisted accidentally.
    const savedForm = getDefaultFormData(savedConfig, avatarStyle);
    return { safetyKindApproval: { alwaysApproveKinds: selectedSafetyKinds({ ...savedForm, [field]: checked }) } };
  });

  const displayConfig = useMemo(() => {
    const domainBudgets = { ...confirmedConfig?.domainBudgets };
    for (const [domainId, fields] of Object.entries(domainBudgetOverrides)) {
      domainBudgets[domainId] = { ...(domainBudgets[domainId] || {}), ...fields };
    }
    return {
      ...confirmedConfig,
      domainAutonomy: { ...confirmedConfig?.domainAutonomy, ...domainAutonomyOverrides },
      domainBudgets,
    };
  }, [confirmedConfig, domainAutonomyOverrides, domainBudgetOverrides]);

  const refreshBudgetUsage = useCallback(() => (
    getCosBudgetUsage({ silent: true })
      .then((response) => setBudgetUsage(response?.usage || {}))
      .catch(() => {})
  ), []);

  useEffect(() => { void refreshBudgetUsage(); }, [refreshBudgetUsage]);

  // Built-in styles plus the install's verified animated records (#5894). A
  // record entry carries its state coverage in the label, so what the
  // character can and cannot do is visible BEFORE it is picked.
  const avatarOptions = useMemo(() => ([
    ...Object.entries(AVATAR_STYLE_LABELS).map(([value, label]) => ({ value, label })),
    ...(Array.isArray(riggedAvatars) ? riggedAvatars : [])
      .filter((record) => record?.variant)
      .map((record) => ({
        value: record.variant,
        label: `${record.name} (rigged 3D) — ${coverageSummary(record.coverage)}`,
      })),
  ]), [riggedAvatars]);

  // Honest coverage note for the selected value: which states the character
  // covers, what the rest fall back to — or a warning when the record the
  // saved style points at is gone.
  const selectedRiggedNote = useMemo(() => {
    if (!isRiggedAvatarStyle(formData.avatarStyle)) return null;
    const record = riggedRecordForStyle(riggedAvatars, formData.avatarStyle);
    if (!record) return 'That animated record is no longer available — pick another avatar.';
    const covered = record.coverage?.coveredStates || [];
    const fallback = record.clip ? `Other states play ${record.clip}.` : '';
    return `${coverageSummary(record.coverage)}. Covered: ${covered.join(', ') || 'none'}. ${fallback}`.trim();
  }, [formData.avatarStyle, riggedAvatars]);

  const handleDomainChange = (domainId, mode) => {
    if (getSavedDomainSelection(displayConfig, domainId) === mode) return Promise.resolve();
    setDomainAutonomyOverrides((current) => ({ ...current, [domainId]: mode }));
    return saveConfigPatch(() => ({ domainAutonomy: { [domainId]: mode } }), {
      key: `domainAutonomy:${domainId}`,
      clearOverride: () => setDomainAutonomyOverrides((current) => removeOverride(current, domainId)),
    });
  };

  const handleBudgetChange = (domainId, field, rawValue) => {
    const value = normalizeBudgetLimit(rawValue);
    const current = getDomainBudget(displayConfig, domainId)[field];
    if ((current ?? null) === value) return Promise.resolve();
    setDomainBudgetOverrides((currentOverrides) => ({
      ...currentOverrides,
      [domainId]: { ...(currentOverrides[domainId] || {}), [field]: value },
    }));
    return saveConfigPatch(() => ({ domainBudgets: { [domainId]: { [field]: value } } }), {
      key: `domainBudget:${domainId}:${field}`,
      clearOverride: () => setDomainBudgetOverrides((overrides) => {
        const fields = removeOverride(overrides[domainId], field);
        return Object.keys(fields).length
          ? { ...overrides, [domainId]: fields }
          : removeOverride(overrides, domainId);
      }),
      onSuccess: refreshBudgetUsage,
    });
  };

  const mindProfile = confirmedConfig?.persistentMindProfile;

  return (
    <div className="mx-auto max-w-6xl space-y-7 pb-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-port-text">Chief of Staff settings</h2>
          <p className="mt-1 max-w-2xl text-sm text-port-text-muted">
            Configure capacity, automatic work, the persistent mind, and supporting services. Domain guardrails are the authoritative autonomy controls.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span data-testid="config-save-status" role={saveStatus === 'error' ? 'alert' : 'status'} aria-live="polite" className={`text-xs ${saveStatus === 'error' ? 'text-port-error' : 'text-port-text-muted'}`}>
            {saveStatus === 'saving' ? 'Saving changes…'
              : saveStatus === 'error' ? 'Some changes could not be saved. Change those settings to retry.'
                : saveStatus === 'saved' ? 'All changes saved'
                  : 'Changes save automatically'}
          </span>
          <button
            type="button"
            onClick={onEvaluate}
            className="inline-flex items-center gap-2 rounded-lg bg-port-accent/15 px-3 py-2 text-sm text-port-accent transition-colors hover:bg-port-accent/25"
            title="Immediately check for pending tasks and spawn eligible agents"
          >
            <Activity size={14} /> Force Evaluate
          </button>
        </div>
      </header>

      <section className="space-y-3" aria-labelledby="persistent-mind-config-heading">
        <div id="persistent-mind-config-heading">
          <SectionHeading
            icon={Brain}
            title="Persistent Mind"
            description="The saved profile determines which provider and model the Mind uses on each wake."
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-port-border bg-port-card p-4">
          <p className="min-w-0 max-w-full break-words text-sm text-port-text">
            {!mindProfile?.enabled
              ? 'AI profile disabled'
              : mindProfile.providerId && mindProfile.model
                ? `AI profile · ${mindProfile.providerId} / ${mindProfile.model}`
                : 'AI profile enabled · select a provider and model'}
          </p>
          <Link to="/cos/mind?panel=settings" className="inline-flex items-center gap-1 text-xs font-medium text-port-accent hover:underline">
            Open Mind Settings <ExternalLink size={13} aria-hidden="true" />
          </Link>
        </div>
      </section>

      <section className="space-y-3" aria-labelledby="automation-heading">
        <div id="automation-heading">
          <SectionHeading
            icon={ShieldCheck}
            title="Automation guardrails"
            description="Choose what each domain may do automatically and cap its daily action or runtime allowance. Blank budgets are unlimited."
          />
        </div>
        <DomainAutomationControl
          config={displayConfig}
          usage={budgetUsage}
          onDomainChange={handleDomainChange}
          onBudgetChange={handleBudgetChange}
        />
        <div className="space-y-3" aria-labelledby="approval-gates-heading">
          <h5 id="approval-gates-heading" className="text-sm font-medium text-port-text">Approval gates</h5>
          <p className="text-xs leading-relaxed text-port-text-muted">
            Confidence decides whether familiar improvement work can start on its own. Outward safety kinds stay held for review even when confidence is high. Saved values are what the learning view and the approval decision read.
          </p>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <ConfigRow label="Confidence auto-approval" description="Hold low-confidence improvement work for review." type="checkbox" inputValue={formData.confidenceEnabled} onChange={(value) => patchConfidence('confidenceEnabled', 'enabled', value)} />
            <ConfigRow label="High confidence" description="At or above this score, enough history auto-approves." type="number" inputValue={formData.confidenceHighThreshold} min={0} max={100} step={1} onChange={(value) => patchConfidence('confidenceHighThreshold', 'highThreshold', value)} />
            <ConfigRow label="Low confidence" description="Below this score, work waits for review." type="number" inputValue={formData.confidenceLowThreshold} min={0} max={100} step={1} onChange={(value) => patchConfidence('confidenceLowThreshold', 'lowThreshold', value)} />
            <ConfigRow label="Minimum samples" description="History required before a high score can auto-approve." type="number" inputValue={formData.confidenceMinSamples} min={1} step={1} onChange={(value) => patchConfidence('confidenceMinSamples', 'minSamples', value)} />
            <ConfigRow label="Outward safety approval" description="Force review for the kinds checked below." type="checkbox" inputValue={formData.safetyEnabled} onChange={patchSafetyEnabled} />
            {SAFETY_KIND_FIELDS.map((item) => (
              <ConfigRow
                key={item.id}
                label={item.label}
                description={item.description}
                type="checkbox"
                inputValue={formData[item.field]}
                onChange={(value) => patchSafetyKind(item.field, value)}
              />
            ))}
          </div>
        </div>
      </section>

      <section className="space-y-3" aria-labelledby="capacity-heading">
        <div id="capacity-heading">
          <SectionHeading icon={Gauge} title="Capacity and health" description="Concurrency and health thresholds for the local CoS runtime." />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <ConfigRow label="Concurrent agents" description="Maximum active agents across all projects." type="number" inputValue={formData.maxConcurrentAgents} min={1} onChange={(value) => updateSetting('maxConcurrentAgents', value)} />
          <ConfigRow label="Agents per project" description="Prevents one project from consuming every agent slot." type="number" inputValue={formData.maxConcurrentAgentsPerProject} min={1} onChange={(value) => updateSetting('maxConcurrentAgentsPerProject', value)} />
          <ConfigRow label="Process count alert" description="Flags an unexpectedly large PM2 process fleet." type="number" inputValue={formData.maxTotalProcesses} min={1} onChange={(value) => updateSetting('maxTotalProcesses', value)} />
          <ConfigRow label="Health check interval" description="How often CoS checks processes and memory." type="number" inputValue={formData.healthCheckIntervalMs / 60_000} min={1} suffix="minutes" onChange={(value) => updateSetting('healthCheckIntervalMs', value * 60_000)} />
          <ConfigRow label="Start on server boot" description="Start the CoS daemon when PortOS starts." type="checkbox" inputValue={formData.startOnBoot} onChange={(value) => updateSetting('startOnBoot', value)} />
        </div>
      </section>

      <section className="space-y-3" aria-labelledby="work-heading">
        <div id="work-heading">
          <SectionHeading icon={Sparkles} title="Work generation and scheduling" description="Independent switches for how eligible work enters and moves through the queue." />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <ConfigRow label="Improvement tasks" description="Allow improvement work for PortOS and managed apps." type="checkbox" inputValue={formData.improvementEnabled} onChange={(value) => updateSetting('improvementEnabled', value)} />
          <ConfigRow label="Idle app review" description="Look for app improvements when user work is idle." type="checkbox" inputValue={formData.idleReviewEnabled} onChange={(value) => updateSetting('idleReviewEnabled', value)} />
          <ConfigRow label="Idle review priority" description="Priority assigned to newly generated idle-review tasks." type="select" inputValue={formData.idleReviewPriority} options={PRIORITY_OPTIONS} onChange={(value) => updateSetting('idleReviewPriority', value)} />
          <ConfigRow label="Scheduled agent jobs" description="Enable the global scheduler in addition to each job's own switch." type="checkbox" inputValue={formData.autonomousJobsEnabled} onChange={(value) => updateSetting('autonomousJobsEnabled', value)} />
          <ConfigRow label="App review cooldown" description="Minimum time before CoS reviews the same app again." type="number" inputValue={formData.appReviewCooldownMs / 60_000} min={0} step="any" suffix="minutes" onChange={(value) => updateSetting('appReviewCooldownMs', value * 60_000)} />
          <ConfigRow label="Auto-approve investigations" description="Admit failure-loop and failure-storm investigations unattended." type="checkbox" inputValue={formData.autoApproveInvestigations} onChange={(value) => updateSetting('autoApproveInvestigations', value)} />
        </div>
      </section>

      <section className="space-y-3" aria-labelledby="appearance-heading">
        <div id="appearance-heading">
          <SectionHeading icon={Palette} title="Appearance" description="Set the default avatar and whether active work may choose a matching style." />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <ConfigRow label="Default avatar" description="Visual style used by the CoS panel." type="select" inputValue={formData.avatarStyle} options={avatarOptions} onChange={(value) => updateSetting('avatarStyle', value)} />
          <ConfigRow label="Dynamic avatar" description="Switch style based on task type, provider, or priority." type="checkbox" inputValue={formData.dynamicAvatar} onChange={(value) => updateSetting('dynamicAvatar', value)} />
        </div>
        {selectedRiggedNote && (
          <p className="text-xs leading-relaxed text-port-text-muted">{selectedRiggedNote}</p>
        )}
      </section>

      <section className="space-y-3" aria-labelledby="embeddings-heading">
        <div id="embeddings-heading">
          <SectionHeading icon={Database} title="Memory embeddings" description="The shared embedding provider and model that index CoS memory and the creative catalog for semantic retrieval." />
        </div>
        <div className="rounded-lg border border-port-border bg-port-card p-4">
          <EmbeddingSourceNotice key={embeddingSaves} />
          <MemoryEmbeddingRecommendation
            onSelect={async (provider, model) => {
              // Writes the shared settings.embeddings store (#18296); the server
              // re-points memory and catalog embedding on this save.
              await updateSettings({ embeddings: { provider, model } }, { silent: true })
                .then(() => {
                  setEmbeddingSaves((n) => n + 1);
                  toast.success(`Embeddings now use ${model}`);
                })
                .catch((err) => toast.error(`Save failed: ${err?.message || 'unknown error'}`));
            }}
          />
        </div>
      </section>

    </div>
  );
}
