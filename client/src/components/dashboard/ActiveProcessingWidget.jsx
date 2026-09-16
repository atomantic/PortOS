import { memo } from 'react';
import { Link } from 'react-router';
import { AudioLines, Bot, Brain, Cpu, ExternalLink, Film, Image as ImageIcon, Layers3, Package, X } from 'lucide-react';
import * as api from '../../services/api';
import { useAutoRefetch } from '../../hooks/useAutoRefetch';

const elapsed = (startedAt, now = Date.now()) => {
  if (!startedAt) return 'queued';
  const parsed = Date.parse(startedAt);
  if (Number.isNaN(parsed)) return 'queued';
  const seconds = Math.max(0, Math.floor((now - parsed) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};
const eta = (etaMs) => (Number.isFinite(etaMs) && etaMs >= 0 ? `~${Math.ceil(etaMs / 60000)}m` : null);
export const sameProcessingSnapshot = (a, b) => {
  if (!a || !b) return a === b;
  return a.agents?.active === b.agents?.active
    && a.agents?.queued === b.agents?.queued
    && a.gpu?.status === b.gpu?.status
    && a.gpu?.laneBusy === b.gpu?.laneBusy
    && a.gpu?.gpus?.[0]?.utilizationPercent === b.gpu?.gpus?.[0]?.utilizationPercent
    && a.mind?.thinking === b.mind?.thinking
    && a.mind?.queued === b.mind?.queued
    && a.mind?.status === b.mind?.status
    && (a.appOperations || []).length === (b.appOperations || []).length
    && a.jobs?.length === b.jobs?.length
    && (a.extras?.imageTo3d || []).length === (b.extras?.imageTo3d || []).length
    && (a.jobs || []).every((job, index) => job?.id === b.jobs[index]?.id
      && job?.status === b.jobs[index]?.status
      && job?.progress === b.jobs[index]?.progress
      && job?.position === b.jobs[index]?.position
      && job?.statusMsg === b.jobs[index]?.statusMsg)
    && (a.extras?.imageTo3d || []).every((item, index) => item?.id === b.extras?.imageTo3d?.[index]?.id
      && item?.name === b.extras?.imageTo3d?.[index]?.name);
};

function JobRow({ job, onCancel }) {
  const tag = job.params?.musicStudio;
  const kind = job.kind;
  const label = tag?.title || job.params?.characterName || job.params?.prompt || `${kind} render`;
  const target = tag?.trackId
    ? `/music/tracks/${encodeURIComponent(tag.trackId)}`
    : kind === 'video' ? '/media/video'
      : kind === 'image' ? '/media/image'
        : kind === 'audio' ? '/media/history?type=audio'
          : kind === 'training' ? '/models/training' : '/media/history';
  const Icon = kind === 'video' ? Film : kind === 'audio' ? AudioLines : kind === 'training' ? Cpu : ImageIcon;
  const progress = Number.isFinite(job.progress) ? Math.max(0, Math.min(100, Math.round(job.progress * 100))) : null;
  return (
    <div className="group rounded-lg border border-port-border bg-port-bg/60 px-2.5 py-2 transition-colors hover:border-port-accent/50">
      <div className="flex items-center gap-2 text-xs">
        <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${job.status === 'running' ? 'bg-port-accent/15 text-port-accent' : 'bg-port-warning/15 text-port-warning'}`}><Icon size={14} aria-hidden="true" /></span>
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${job.status === 'running' ? 'animate-pulse bg-port-accent' : 'bg-port-warning'}`} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-gray-200" title={label}>{label}</span>
        <span className="shrink-0 font-mono text-[10px] text-gray-500">{job.status === 'queued' ? `#${job.position || '—'}` : elapsed(job.startedAt)}{eta(job.etaMs) ? ` · ${eta(job.etaMs)}` : ''}</span>
        <Link to={target} title={`Open ${kind} activity`} aria-label={`Open ${kind} activity`} className="text-gray-500 opacity-70 transition-opacity hover:text-port-accent group-hover:opacity-100"><ExternalLink size={13} /></Link>
        <button type="button" onClick={() => onCancel(job.id)} title="Cancel render" aria-label={`Cancel ${label}`} className="text-gray-500 hover:text-port-warning"><X size={13} /></button>
      </div>
      {job.status === 'running' ? <div className="ml-8 mt-1.5 flex items-center gap-2"><div className="h-1 flex-1 overflow-hidden rounded-full bg-port-border"><div className="h-full rounded-full bg-port-accent transition-all" style={{ width: `${progress ?? 8}%` }} /></div><span className="w-8 text-right font-mono text-[10px] text-gray-500">{progress == null ? '…' : `${progress}%`}</span></div> : null}
    </div>
  );
}

/** A non-cancellable lane (mind, agents, app operations, 3D) as one linked row. */
function LaneRow({ to, icon: Icon, label, detail }) {
  return (
    <Link to={to} className="mt-1.5 flex items-center gap-2 rounded-lg border border-port-border bg-port-bg/60 px-2.5 py-2 text-xs text-gray-300 hover:border-port-accent/50">
      <Icon size={14} className="text-port-accent" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {detail ? <span className="shrink-0 font-mono text-gray-500">{detail}</span> : null}
      <ExternalLink size={13} className="shrink-0 text-gray-500" />
    </Link>
  );
}

function ActiveProcessingWidget() {
  const { data } = useAutoRefetch(() => api.getActiveProcessing({ silent: true }), 3000, {
    compare: sameProcessingSnapshot,
  });
  const cancel = (id) => api.cancelMediaJob(id, { silent: true }).catch(() => undefined);
  const jobs = data?.jobs || [];
  const gpu = data?.gpu;
  const imageTo3d = data?.extras?.imageTo3d || [];
  const mind = data?.mind;
  const appOperations = data?.appOperations || [];
  const activeAgents = data?.agents?.active || 0;
  // Derived server-side (server/lib/systemIdle.js) and rendered as sent: the
  // unattended auto-updater refuses to restart the install on this same verdict,
  // so a second definition here is exactly what that module exists to prevent.
  const activity = data?.activity ?? null;
  const idle = !activity || activity.idle;
  const runningJobs = jobs.filter((job) => job.status !== 'queued').length;
  return (
    // @container on the widget's OWN root: a dashboard cell is ~250px wide on a
    // 2560px screen, so a viewport breakpoint here would pin the four-up metric
    // row into the narrowest column. See the dashboard AGENTS.md.
    <div className="@container h-full rounded-xl border border-port-border bg-port-card p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div><h3 className="flex items-center gap-2 text-sm font-semibold text-white"><span className={`relative flex h-6 w-6 items-center justify-center rounded-lg ${idle ? 'bg-port-border/60 text-gray-400' : 'bg-port-accent/15 text-port-accent'}`}><Cpu size={15} />{!idle ? <span className="absolute -right-0.5 -top-0.5 h-2 w-2 animate-ping rounded-full bg-port-accent" /> : null}</span> Live activity</h3><p className="mt-1 text-[11px] text-gray-500">What PortOS is working on right now</p></div>
        <span className={`rounded-full px-2 py-1 text-[10px] font-medium uppercase tracking-wider ${idle ? 'bg-port-border/60 text-gray-500' : 'bg-port-accent/15 text-port-accent'}`}>{idle ? 'idle' : `${activity.activeCount} active${activity.queuedCount ? ` · ${activity.queuedCount} queued` : ''}`}</span>
      </div>
      {!data ? <p className="text-xs text-gray-500">Checking render lanes…</p> : <>
        {!idle ? <div className="mb-3 grid grid-cols-2 gap-1.5 text-center @xs:grid-cols-4"><Metric icon={Bot} value={activeAgents} label="agents" /><Metric icon={Layers3} value={runningJobs} label="rendering" /><Metric icon={Brain} value={mind?.thinking ? 'yes' : 'no'} label="thinking" /><Metric icon={Cpu} value={gpu?.laneBusy ? 'busy' : 'ready'} label="GPU" /></div> : null}
        {idle ? <Link to="/system-resources/overview" className="flex items-center justify-between rounded-lg border border-port-border bg-port-bg px-3 py-3 text-xs text-gray-400 transition-colors hover:border-port-accent/50 hover:text-gray-200"><span>Nothing is running</span><span>GPU {gpu?.status === 'available' ? 'ready' : gpu?.status || 'unknown'} →</span></Link> : null}
        <div className="space-y-1.5">{jobs.map((job) => <JobRow key={job.id} job={job} onCancel={cancel} />)}</div>
        {imageTo3d.map((item) => <LaneRow key={`3d-${item.id}`} to="/3d" icon={Layers3} label={`Image-to-3D · ${item.name}`} />)}
        {/* Counts and lifecycle only — never what the mind is thinking ABOUT. */}
        {mind?.thinking || mind?.queued ? (
          <LaneRow
            to="/cos/mind"
            icon={Brain}
            label={mind.thinking ? 'Persistent Mind is thinking' : 'Persistent Mind has queued work'}
            detail={[mind.thinking ? elapsed(mind.thinkingSince) : null, mind.queued ? `${mind.queued} queued` : null].filter(Boolean).join(' · ')}
          />
        ) : null}
        {activeAgents || data.agents?.queued ? (
          <LaneRow
            to="/cos/agents"
            icon={Bot}
            label="Chief of Staff agents"
            detail={`${activeAgents} active${data.agents.queued ? ` · ${data.agents.queued} queued` : ''}`}
          />
        ) : null}
        {appOperations.map((op) => <LaneRow key={`op-${op.appId}-${op.type}`} to="/apps" icon={Package} label={`${op.appName} · ${op.type}`} />)}
      {!idle && gpu?.status === 'available' && gpu.gpus?.length ? <div className="mt-3 text-[11px] text-gray-500">GPU {gpu.gpus[0]?.utilizationPercent == null ? 'utilization unknown' : `${Math.round(gpu.gpus[0]?.utilizationPercent)}% utilized`}</div> : null}
      </>}
    </div>
  );
}

function Metric({ icon: Icon, value, label }) {
  return <div className="rounded-md border border-port-border/70 bg-port-bg/40 px-1.5 py-1.5"><div className="flex items-center justify-center gap-1 text-xs font-semibold text-gray-200"><Icon size={12} className="text-gray-500" />{value}</div><div className="mt-0.5 text-[9px] uppercase tracking-wider text-gray-500">{label}</div></div>;
}

export default memo(ActiveProcessingWidget);
