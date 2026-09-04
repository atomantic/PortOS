import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  Activity,
  Brain,
  CheckCircle,
  Database,
  ExternalLink,
  FileText,
  Gauge,
  Palette,
  Server,
  Settings,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import toast from '../../ui/Toast';
import * as api from '../../../services/api';
import { useAutoRefetch } from '../../../hooks/useAutoRefetch.js';
import PersistentMindProfileControls from '../PersistentMindProfileControls';
import { PersistentMindThoughtStatus } from '../PersistentMindRuntimePanel';
import ConfigRow from './ConfigRow';
import {
  AVATAR_STYLE_LABELS,
  AUTONOMY_DOMAINS,
  DOMAIN_AUTONOMY_MODES,
  DOMAIN_BUDGET_FIELDS,
  getDomainBudget,
  getDomainMode,
  normalizeBudgetLimit,
} from '../constants';
import ProviderModelSelector from '../../ProviderModelSelector';
import useProviderModels from '../../../hooks/useProviderModels';
import { coverageSummary, isRiggedAvatarStyle, riggedRecordForStyle } from '../../../hooks/useAvatarCapabilities';
import { timeAgo } from '../../../utils/formatters';

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

const getDefaultFormData = (config, avatarStyle) => ({
  healthCheckIntervalMs: config?.healthCheckIntervalMs ?? 900_000,
  maxConcurrentAgents: config?.maxConcurrentAgents ?? 3,
  maxConcurrentAgentsPerProject: config?.maxConcurrentAgentsPerProject ?? 2,
  maxProcessMemoryMb: config?.maxProcessMemoryMb ?? 2_048,
  maxTotalProcesses: config?.maxTotalProcesses ?? 50,
  startOnBoot: Boolean(config?.alwaysOn || config?.autoStart),
  improvementEnabled: config?.improvementEnabled ?? config?.selfImprovementEnabled ?? true,
  proactiveMode: config?.proactiveMode ?? true,
  idleReviewEnabled: config?.idleReviewEnabled ?? true,
  idleReviewPriority: config?.idleReviewPriority ?? 'MEDIUM',
  autonomousJobsEnabled: config?.autonomousJobsEnabled ?? true,
  autoApproveInvestigations: config?.autoApproveInvestigations ?? false,
  appReviewCooldownMs: config?.appReviewCooldownMs ?? 1_800_000,
  avatarStyle: config?.avatarStyle || avatarStyle || 'svg',
  dynamicAvatar: config?.dynamicAvatar ?? true,
});

const configPayload = (formData) => ({
  healthCheckIntervalMs: formData.healthCheckIntervalMs,
  maxConcurrentAgents: formData.maxConcurrentAgents,
  maxConcurrentAgentsPerProject: formData.maxConcurrentAgentsPerProject,
  maxProcessMemoryMb: formData.maxProcessMemoryMb,
  maxTotalProcesses: formData.maxTotalProcesses,
  alwaysOn: formData.startOnBoot,
  // Clear the legacy alias so turning boot startup off is not defeated by the
  // server's `alwaysOn || autoStart` compatibility read.
  autoStart: false,
  improvementEnabled: formData.improvementEnabled,
  proactiveMode: formData.proactiveMode,
  idleReviewEnabled: formData.idleReviewEnabled,
  idleReviewPriority: formData.idleReviewPriority,
  autonomousJobsEnabled: formData.autonomousJobsEnabled,
  autoApproveInvestigations: formData.autoApproveInvestigations,
  appReviewCooldownMs: formData.appReviewCooldownMs,
  avatarStyle: formData.avatarStyle,
  dynamicAvatar: formData.dynamicAvatar,
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
                    onClick={() => onDomainChange(domain.id, mode.id, mode.label, domain.label)}
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
                      onBlur={(event) => onBudgetChange(domain.id, field.id, event.target.value, domain.label, field.label)}
                      className={`w-full rounded-md border bg-port-bg px-2 py-1.5 text-xs text-port-text ${capped ? 'border-port-warning' : 'border-port-border'}`}
                    />
                  </div>
                );
              })}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function PersistentMindStatus({ mind, loaded, error }) {
  const state = mind?.state;
  const model = mind?.profile?.model;
  const supervisor = !loaded
    ? 'Loading…'
    : error ? 'Unavailable'
      : state?.started ? 'Started'
        : state?.enabled ? 'Ready, not started'
          : 'Disabled';

  return (
    <div className="rounded-lg border border-port-border bg-port-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PersistentMindThoughtStatus state={state} model={model} />
        <Link to="/cos/mind" className="inline-flex items-center gap-1 text-xs font-medium text-port-accent hover:underline">
          Open mind <ExternalLink size={13} aria-hidden="true" />
        </Link>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2">
        <div className="rounded-md bg-port-bg p-2.5">
          <span className="block text-[10px] font-medium uppercase tracking-wide text-port-text-muted">Supervisor</span>
          <span className="mt-1 block text-xs font-semibold text-port-text">{supervisor}</span>
        </div>
        <div className="rounded-md bg-port-bg p-2.5">
          <span className="block text-[10px] font-medium uppercase tracking-wide text-port-text-muted">Queued</span>
          <span aria-label="Queued persistent mind messages" className="mt-1 block text-xs font-semibold text-port-text">{loaded && !error ? state?.queuedMessageCount || 0 : '—'}</span>
        </div>
        <div className="rounded-md bg-port-bg p-2.5">
          <span className="block text-[10px] font-medium uppercase tracking-wide text-port-text-muted">Last turn</span>
          <span className="mt-1 block text-xs font-semibold text-port-text">{state?.lastCompletedAt ? timeAgo(state.lastCompletedAt) : 'None yet'}</span>
        </div>
      </div>
      {(error || state?.lastError || state?.pauseReason) && (
        <p className="mt-3 rounded-md border border-port-warning/30 bg-port-warning/10 px-3 py-2 text-xs text-port-warning">
          {error || state.lastError || state.pauseReason}
        </p>
      )}
      <p className="mt-3 text-xs leading-relaxed text-port-text-muted">
        Enabling a profile only configures its reasoning lane. Starting, pausing, conversation, context, and task access remain on the Persistent Mind page.
      </p>
    </div>
  );
}

export default function ConfigTab({ config, onUpdate, onEvaluate, avatarStyle, riggedAvatars = [] }) {
  const {
    providers,
    availableModels,
    setSelectedProviderId: setProviderHook,
    setSelectedModel: setModelHook,
    selectedProviderId: hookProviderId,
    selectedModel: hookModel,
  } = useProviderModels();
  const [embeddingProviderId, setEmbeddingProviderId] = useState(config?.embeddingProviderId || 'lmstudio');
  const [embeddingModel, setEmbeddingModel] = useState(config?.embeddingModel || '');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formData, setFormData] = useState(() => getDefaultFormData(config, avatarStyle));
  const [budgetUsage, setBudgetUsage] = useState({});
  const [mindStatus, setMindStatus] = useState({ data: null, loaded: false, error: null });

  useEffect(() => {
    if (config?.embeddingProviderId) {
      setEmbeddingProviderId(config.embeddingProviderId);
      setProviderHook(config.embeddingProviderId);
    }
    if (config?.embeddingModel) {
      setEmbeddingModel(config.embeddingModel);
      setModelHook(config.embeddingModel);
    }
  }, [config?.embeddingProviderId, config?.embeddingModel, setProviderHook, setModelHook]);

  useEffect(() => {
    if (!editing) setFormData(getDefaultFormData(config, avatarStyle));
  }, [config, avatarStyle, editing]);

  const refreshBudgetUsage = useCallback(() => (
    api.getCosBudgetUsage({ silent: true })
      .then((response) => setBudgetUsage(response?.usage || {}))
      .catch(() => {})
  ), []);

  const refreshMindStatus = useCallback(() => (
    api.getPersistentMind({ limit: 1 }, { silent: true })
      .then((data) => setMindStatus({ data, loaded: true, error: null }))
      .catch((error) => setMindStatus((current) => ({
        ...current,
        loaded: true,
        error: error?.message || 'Persistent mind status is unavailable',
      })))
  ), []);

  useEffect(() => { void refreshBudgetUsage(); }, [refreshBudgetUsage]);
  useAutoRefetch(refreshMindStatus, 15_000, { pollOnly: true });

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

  const avatarLabel = (style) => {
    if (AVATAR_STYLE_LABELS[style]) return AVATAR_STYLE_LABELS[style];
    const record = riggedRecordForStyle(riggedAvatars, style);
    return record ? `${record.name} (rigged 3D)` : style;
  };

  // Honest coverage note for the staged value: which states the character
  // covers, what the rest fall back to — or a warning when the record the
  // saved style points at is gone.
  const stagedRiggedNote = useMemo(() => {
    if (!isRiggedAvatarStyle(formData.avatarStyle)) return null;
    const record = riggedRecordForStyle(riggedAvatars, formData.avatarStyle);
    if (!record) return 'That animated record is no longer available — pick another avatar.';
    const covered = record.coverage?.coveredStates || [];
    const fallback = record.clip ? `Other states play ${record.clip}.` : '';
    return `${coverageSummary(record.coverage)}. Covered: ${covered.join(', ') || 'none'}. ${fallback}`.trim();
  }, [formData.avatarStyle, riggedAvatars]);

  const handleCancel = () => {
    setFormData(getDefaultFormData(config, avatarStyle));
    setEditing(false);
  };

  const handleSave = () => {
    setSaving(true);
    return api.updateCosConfig(configPayload(formData), { silent: true })
      .then(() => {
        toast.success('Configuration updated');
        setEditing(false);
        onUpdate();
      })
      .catch((error) => toast.error(error.message))
      .finally(() => setSaving(false));
  };

  const handleDomainChange = (domainId, mode, modeLabel, domainLabel) => (
    api.updateCosConfig({ domainAutonomy: { [domainId]: mode } }, { silent: true })
      .then(() => {
        toast.success(`${domainLabel} autonomy set to ${modeLabel}`);
        onUpdate();
        void refreshMindStatus();
      })
      .catch((error) => toast.error(error.message))
  );

  const handleBudgetChange = (domainId, field, rawValue, domainLabel, fieldLabel) => {
    const value = normalizeBudgetLimit(rawValue);
    const current = getDomainBudget(config, domainId)[field];
    if ((current ?? null) === value) return Promise.resolve();
    return api.updateCosConfig({ domainBudgets: { [domainId]: { [field]: value } } }, { silent: true })
      .then(() => {
        toast.success(`${domainLabel} ${fieldLabel} ${value == null ? 'set to unlimited' : `capped at ${value}`}`);
        onUpdate();
        void refreshBudgetUsage();
      })
      .catch((error) => toast.error(error.message));
  };

  return (
    <div className="mx-auto max-w-6xl space-y-7 pb-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-lg font-semibold text-port-text">Chief of Staff settings</h3>
          <p className="mt-1 max-w-2xl text-sm text-port-text-muted">
            Configure capacity, automatic work, the persistent mind, and supporting services. Domain guardrails are the authoritative autonomy controls.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onEvaluate}
            className="inline-flex items-center gap-2 rounded-lg bg-port-accent/15 px-3 py-2 text-sm text-port-accent transition-colors hover:bg-port-accent/25"
            title="Immediately check for pending tasks and spawn eligible agents"
          >
            <Activity size={14} /> Force Evaluate
          </button>
          {!editing ? (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="inline-flex items-center gap-2 rounded-lg bg-port-border px-3 py-2 text-sm text-port-text transition-colors hover:bg-port-border/80"
            >
              <Settings size={14} /> Edit settings
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={handleCancel}
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-lg bg-port-border px-3 py-2 text-sm text-port-text-muted disabled:opacity-50"
              >
                <X size={14} /> Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-lg bg-port-success/15 px-3 py-2 text-sm text-port-success transition-colors hover:bg-port-success/25 disabled:opacity-50"
              >
                <CheckCircle size={14} /> {saving ? 'Saving…' : 'Save settings'}
              </button>
            </>
          )}
        </div>
      </header>

      <section className="space-y-3" aria-labelledby="persistent-mind-config-heading">
        <div id="persistent-mind-config-heading">
          <SectionHeading
            icon={Brain}
            title="Persistent Mind"
            description="Live supervisor status beside the pinned provider profile used for every wake."
          />
        </div>
        <div className="grid gap-3 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <PersistentMindStatus mind={mindStatus.data} loaded={mindStatus.loaded} error={mindStatus.error} />
          <div className="rounded-lg border border-port-border bg-port-card p-4">
            <PersistentMindProfileControls
              profile={config?.persistentMindProfile}
              onSaved={() => {
                onUpdate();
                void refreshMindStatus();
              }}
            />
          </div>
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
          config={config}
          usage={budgetUsage}
          onDomainChange={handleDomainChange}
          onBudgetChange={handleBudgetChange}
        />
      </section>

      <section className="space-y-3" aria-labelledby="capacity-heading">
        <div id="capacity-heading">
          <SectionHeading icon={Gauge} title="Capacity and health" description="Concurrency and health thresholds for the local CoS runtime." />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <ConfigRow label="Concurrent agents" description="Maximum active agents across all projects." value={formData.maxConcurrentAgents} editing={editing} type="number" inputValue={formData.maxConcurrentAgents} min={1} onChange={(value) => setFormData((current) => ({ ...current, maxConcurrentAgents: value }))} />
          <ConfigRow label="Agents per project" description="Prevents one project from consuming every agent slot." value={formData.maxConcurrentAgentsPerProject} editing={editing} type="number" inputValue={formData.maxConcurrentAgentsPerProject} min={1} onChange={(value) => setFormData((current) => ({ ...current, maxConcurrentAgentsPerProject: value }))} />
          <ConfigRow label="Process memory alert" description="Flags non-model processes above this memory use." value={`${formData.maxProcessMemoryMb} MB`} editing={editing} type="number" inputValue={formData.maxProcessMemoryMb} min={128} suffix="MB" onChange={(value) => setFormData((current) => ({ ...current, maxProcessMemoryMb: value }))} />
          <ConfigRow label="Process count alert" description="Flags an unexpectedly large PM2 process fleet." value={formData.maxTotalProcesses} editing={editing} type="number" inputValue={formData.maxTotalProcesses} min={1} onChange={(value) => setFormData((current) => ({ ...current, maxTotalProcesses: value }))} />
          <ConfigRow label="Health check interval" description="How often CoS checks processes and memory." value={`${formData.healthCheckIntervalMs / 60_000} min`} editing={editing} type="number" inputValue={formData.healthCheckIntervalMs / 60_000} min={1} suffix="minutes" onChange={(value) => setFormData((current) => ({ ...current, healthCheckIntervalMs: value * 60_000 }))} />
          <ConfigRow label="Start on server boot" description="Start the CoS daemon when PortOS starts." value={formData.startOnBoot ? 'Enabled' : 'Disabled'} editing={editing} type="checkbox" inputValue={formData.startOnBoot} onChange={(value) => setFormData((current) => ({ ...current, startOnBoot: value }))} />
        </div>
      </section>

      <section className="space-y-3" aria-labelledby="work-heading">
        <div id="work-heading">
          <SectionHeading icon={Sparkles} title="Work generation and scheduling" description="Independent switches for how eligible work enters and moves through the queue." />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <ConfigRow label="Improvement tasks" description="Allow improvement work for PortOS and managed apps." value={formData.improvementEnabled ? 'Enabled' : 'Disabled'} editing={editing} type="checkbox" inputValue={formData.improvementEnabled} onChange={(value) => setFormData((current) => ({ ...current, improvementEnabled: value }))} />
          <ConfigRow label="Proactive discovery" description="Create tasks from mission goals when capacity is available." value={formData.proactiveMode ? 'Enabled' : 'Disabled'} editing={editing} type="checkbox" inputValue={formData.proactiveMode} onChange={(value) => setFormData((current) => ({ ...current, proactiveMode: value }))} />
          <ConfigRow label="Idle app review" description="Look for app improvements when user work is idle." value={formData.idleReviewEnabled ? 'Enabled' : 'Disabled'} editing={editing} type="checkbox" inputValue={formData.idleReviewEnabled} onChange={(value) => setFormData((current) => ({ ...current, idleReviewEnabled: value }))} />
          <ConfigRow label="Idle review priority" description="Priority assigned to newly generated idle-review tasks." value={PRIORITY_OPTIONS.find((option) => option.value === formData.idleReviewPriority)?.label} editing={editing} type="select" inputValue={formData.idleReviewPriority} options={PRIORITY_OPTIONS} onChange={(value) => setFormData((current) => ({ ...current, idleReviewPriority: value }))} />
          <ConfigRow label="Scheduled agent jobs" description="Enable the global scheduler in addition to each job's own switch." value={formData.autonomousJobsEnabled ? 'Enabled' : 'Disabled'} editing={editing} type="checkbox" inputValue={formData.autonomousJobsEnabled} onChange={(value) => setFormData((current) => ({ ...current, autonomousJobsEnabled: value }))} />
          <ConfigRow label="App review cooldown" description="Minimum time before CoS reviews the same app again." value={`${formData.appReviewCooldownMs / 60_000} min`} editing={editing} type="number" inputValue={formData.appReviewCooldownMs / 60_000} min={0} step="any" suffix="minutes" onChange={(value) => setFormData((current) => ({ ...current, appReviewCooldownMs: value * 60_000 }))} />
          <ConfigRow label="Auto-approve investigations" description="Admit failure-loop and failure-storm investigations unattended." value={formData.autoApproveInvestigations ? 'Enabled' : 'Disabled'} editing={editing} type="checkbox" inputValue={formData.autoApproveInvestigations} onChange={(value) => setFormData((current) => ({ ...current, autoApproveInvestigations: value }))} />
        </div>
      </section>

      <section className="space-y-3" aria-labelledby="appearance-heading">
        <div id="appearance-heading">
          <SectionHeading icon={Palette} title="Appearance" description="Set the default avatar and whether active work may choose a matching style." />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <ConfigRow label="Default avatar" description="Visual style used by the CoS panel." value={avatarLabel(formData.avatarStyle)} editing={editing} type="select" inputValue={formData.avatarStyle} options={avatarOptions} onChange={(value) => setFormData((current) => ({ ...current, avatarStyle: value }))} />
          <ConfigRow label="Dynamic avatar" description="Switch style based on task type, provider, or priority." value={formData.dynamicAvatar ? 'Enabled' : 'Disabled'} editing={editing} type="checkbox" inputValue={formData.dynamicAvatar} onChange={(value) => setFormData((current) => ({ ...current, dynamicAvatar: value }))} />
        </div>
        {stagedRiggedNote && (
          <p className="text-xs leading-relaxed text-port-text-muted">{stagedRiggedNote}</p>
        )}
      </section>

      <section className="space-y-3" aria-labelledby="embeddings-heading">
        <div id="embeddings-heading">
          <SectionHeading icon={Database} title="Memory embeddings" description="Provider and model used to index CoS memory for semantic retrieval." />
        </div>
        <div className="rounded-lg border border-port-border bg-port-card p-4">
          <ProviderModelSelector
            providers={providers}
            selectedProviderId={providers?.some((provider) => provider.id === embeddingProviderId)
              ? embeddingProviderId
              : providers?.some((provider) => provider.id === hookProviderId) ? hookProviderId : ''}
            selectedModel={embeddingModel || hookModel}
            availableModels={availableModels}
            onProviderChange={(id) => {
              setEmbeddingProviderId(id);
              setProviderHook(id);
              setEmbeddingModel('');
              return api.updateCosConfig({ embeddingProviderId: id, embeddingModel: '' })
                .then(() => {
                  toast.success('Embedding provider updated');
                  onUpdate();
                });
            }}
            onModelChange={(model) => {
              setEmbeddingModel(model);
              setModelHook(model);
              return api.updateCosConfig({ embeddingModel: model })
                .then(() => {
                  toast.success('Embedding model updated');
                  onUpdate();
                });
            }}
            label="Embedding provider"
          />
        </div>
      </section>

      <section className="space-y-3" aria-labelledby="advanced-heading">
        <div id="advanced-heading">
          <SectionHeading icon={Server} title="Advanced" description="Read-only runtime wiring managed by the installation and repository." />
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-lg border border-port-border bg-port-card p-4">
            <h5 className="text-sm font-medium text-port-text">MCP servers</h5>
            <div className="mt-3 space-y-2">
              {config?.mcpServers?.length ? config.mcpServers.map((mcp) => (
                <div key={mcp.name} className="rounded-md bg-port-bg px-3 py-2 text-xs">
                  <span className="font-mono font-medium text-port-accent">{mcp.name}</span>
                  <span className="ml-2 break-all text-port-text-muted">{mcp.command} {mcp.args?.join(' ')}</span>
                </div>
              )) : <span className="text-xs text-port-text-muted">No MCP servers configured</span>}
            </div>
          </div>
          <div className="rounded-lg border border-port-border bg-port-card p-4">
            <h5 className="text-sm font-medium text-port-text">Task files</h5>
            <div className="mt-3 space-y-2 text-xs">
              <div className="flex items-center gap-2 rounded-md bg-port-bg px-3 py-2">
                <FileText size={14} className="text-port-text-muted" />
                <span className="text-port-text-muted">User</span>
                <span className="ml-auto font-mono text-port-text">{config?.userTasksFile || 'TASKS.md'}</span>
              </div>
              <div className="flex items-center gap-2 rounded-md bg-port-bg px-3 py-2">
                <FileText size={14} className="text-port-text-muted" />
                <span className="text-port-text-muted">System</span>
                <span className="ml-auto font-mono text-port-text">{config?.cosTasksFile || 'COS-TASKS.md'}</span>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
