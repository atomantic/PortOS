import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { getCreativeDirectorVideoExecution, startCreativeDirectorVideoExecution } from '../../services/apiCreativeDirector.js';

const LIMITS = [
  ['maxAudioJobs', 'Maximum soundtrack jobs', 0, 4],
  ['maxClips', 'Maximum clip submissions', 1, 200],
  ['maxRetries', 'Retries per shot or step', 0, 3],
  ['maxReplans', 'Replans', 0, 5],
  ['maxAgentCalls', 'Maximum agent calls', 1, 500],
];
const choiceText = choice => choice ? `${choice.providerId || choice.mode} · ${choice.modelDescription || choice.model || choice.modelId || 'provider default'}${choice.effort ? ` · ${choice.effort}` : ''}` : 'Not available';

export default function VideoExecutionPanel({ project, onChange, basePath }) {
  const [preview, setPreview] = useState(null);
  const [limits, setLimits] = useState(null);
  const [retryAttemptIds, setRetryAttemptIds] = useState([]);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [reload, setReload] = useState(0);
  const submitting = useRef(false);
  useEffect(() => {
    let active = true;
    getCreativeDirectorVideoExecution(project.id, { silent: true }).then(result => {
      if (!active) return;
      setPreview(result);
      setLimits(previous => previous || result.limits);
    }).catch(err => { if (active) setError(err.message || 'Could not load production choices'); });
    return () => { active = false; };
  }, [project.id, project.updatedAt, reload]);
  const active = ['planning', 'rendering', 'stitching'].includes(project.status);
  const uncertain = (preview?.execution?.attempts || []).filter(attempt => attempt.status === 'uncertain');
  const valid = limits && LIMITS.every(([key, , min, max]) => limits[key] !== '' && Number.isInteger(Number(limits[key])) && Number(limits[key]) >= min && Number(limits[key]) <= max)
    && (limits.spendCapUsd === null || limits.spendCapUsd === '' || Number(limits.spendCapUsd) > 0);
  const start = async () => {
    if (submitting.current || !valid) return;
    submitting.current = true;
    setPending(true);
    setError('');
    try {
      await startCreativeDirectorVideoExecution(project.id, {
        configurationRevision: preview.configurationRevision,
        limits: { ...Object.fromEntries(LIMITS.map(([key]) => [key, Number(limits[key])])), spendCapUsd: limits.spendCapUsd === '' || limits.spendCapUsd === null ? null : Number(limits.spendCapUsd) },
        retryAttemptIds,
      }, { silent: true });
      setRetryAttemptIds([]);
      onChange?.();
      setReload(value => value + 1);
    } catch (err) {
      setError(err.message || 'Could not start production');
      setReload(value => value + 1);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };
  return <section aria-label="Video execution" className="rounded border border-port-border p-4 space-y-3">
    <h3 className="font-medium">Production choices and limits</h3>
    {!preview && !error && <p role="status">Loading production choices…</p>}
    {error && <p role="alert" className="text-port-error">{error}</p>}
    {preview && <>
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        {['treatment', 'plan', 'evaluation', 'video'].map(key => <div key={key}><dt className="capitalize text-port-text-muted">{key}</dt><dd className="break-words">{choiceText(preview.choices?.[key])}</dd></div>)}
        <div><dt className="text-port-text-muted">Audio</dt><dd>{preview.choices?.audio?.providerId ? choiceText(preview.choices.audio) : preview.choices?.audio?.mode || 'Native clip audio'}</dd></div>
      </dl>
      <p className="text-xs text-port-text-muted">{preview.costNotice}</p>
      {preview.blockers.map(blocker => <p key={blocker} role="alert" className="text-port-warning">{blocker}</p>)}
      {preview.execution?.blocker && <p role="status" className="text-port-warning">{preview.execution.blocker}</p>}
      <div className="flex flex-wrap gap-3 text-sm"><Link className="underline" to="/settings">Settings</Link><Link className="underline" to={`${basePath}/${project.id}/overview?models=1`}>Change models</Link><Link className="underline" to="/system-resources/queues">Inspect render queue</Link><Link className="underline" to={`${basePath}/${project.id}/review`}>Review artifacts</Link></div>
      {limits && <div className="grid gap-3 sm:grid-cols-2">
        {LIMITS.map(([key, label, min, max]) => <div key={key}>
          <label className="block text-sm" htmlFor={`video-limit-${key}`}>{label}</label>
          <input id={`video-limit-${key}`} type="number" min={min} max={max} step="1" value={limits[key]} disabled={active || pending} onChange={event => setLimits(previous => ({ ...previous, [key]: event.target.value }))} className="w-full rounded border border-port-border bg-port-bg p-2" />
        </div>)}
        <div><label className="block text-sm" htmlFor="video-dollar-cap">Dollar cap (optional)</label><input id="video-dollar-cap" type="number" min="0.01" max="10000" step="0.01" placeholder="Unknown cost; use clip limits" value={limits.spendCapUsd ?? ''} disabled={active || pending} onChange={event => setLimits(previous => ({ ...previous, spendCapUsd: event.target.value }))} className="w-full rounded border border-port-border bg-port-bg p-2" /></div>
      </div>}
      <p className="text-xs text-port-text-muted">Used: {(preview.execution?.attempts || []).filter(attempt => attempt.kind === 'clip').length} clip submissions · {(preview.execution?.attempts || []).filter(attempt => !['clip', 'audio'].includes(attempt.kind)).length} agent calls · {(preview.execution?.attempts || []).filter(attempt => attempt.kind === 'audio').length} soundtrack jobs. Limits include previous attempts.</p>
      {uncertain.map(attempt => <div key={attempt.id} className="text-sm">
        <label htmlFor={`retry-${attempt.id}`} className="flex gap-2 items-start"><input id={`retry-${attempt.id}`} type="checkbox" checked={retryAttemptIds.includes(attempt.id)} onChange={event => setRetryAttemptIds(previous => event.target.checked ? [...previous, attempt.id] : previous.filter(id => id !== attempt.id))} />Authorize another attempt for {attempt.sceneId || attempt.stepId || attempt.kind}. The earlier submission is uncertain and retrying may charge again{attempt.jobId ? ` (job ${attempt.jobId})` : ''}.</label>
      </div>)}
      <button onClick={start} disabled={active || pending || !preview.canStart || !valid || uncertain.some(attempt => !retryAttemptIds.includes(attempt.id))} className="rounded bg-port-accent px-3 py-2 text-white disabled:opacity-40">{pending ? 'Starting…' : project.status === 'draft' ? 'Start production' : 'Resume production'}</button>
    </>}
    <button className="text-sm underline" onClick={() => setReload(value => value + 1)} disabled={pending}>Refresh choices</button>
  </section>;
}
