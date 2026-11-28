import { useState } from 'react';
import { changeVoiceAvatar } from '../../services/apiVoiceAvatar';

const button = 'satphone-key inline-flex min-h-11 items-center justify-center rounded-lg border px-3 text-xs font-mono font-semibold uppercase tracking-wide disabled:opacity-50';

function AvatarActions({ data, ask, terms, pending }) {
  const action = (name, label, enabled = true) => <button type="button" className={button}
    onClick={() => ask(name)} disabled={pending || !enabled}>{label}</button>;
  if (data.phase === 'installing') return action('cancel', 'Cancel install');
  // A running avatar stays on: there is no stop control.
  if (['running', 'starting', 'stopping'].includes(data.phase)) return null;
  if (!data.installed) return action('install', 'Install AvatarForcing', terms);
  return <>
    {data.updateAvailable ? action('update', 'Update AvatarForcing', terms) : action('start', 'Start AvatarForcing')}
    {action('uninstall', 'Uninstall and remove weights')}
  </>;
}

export default function AvatarRuntimeSettings({ data, error, updateData, refetch, compact = false }) {
  const [terms, setTerms] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);

  const act = async (action) => {
    setPending(true);
    setFailure('');
    try {
      const downloading = action === 'install' || action === 'update';
      updateData(await changeVoiceAvatar(action, downloading && terms));
      if (downloading) setTerms(false);
      refetch();
    } catch (err) {
      setFailure(err.message);
    } finally {
      setPending(false);
    }
  };

  const running = Boolean(data?.supported && data.phase === 'running' && !error);
  const ledTone = running
    ? 'bg-port-success shadow-[0_0_6px_rgb(var(--port-success)/0.85)]'
    : data?.phase === 'starting' || data?.phase === 'installing'
      ? 'bg-port-warning animate-pulse'
      : 'bg-port-text-muted/50';

  return <section aria-label="Voice avatar model" className={`space-y-3 rounded-xl border border-port-border bg-port-card text-port-text ${compact ? 'p-3' : 'p-4'}`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2 min-w-0">
        <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${ledTone}`} />
        <h2 className="font-mono text-xs font-semibold uppercase tracking-wider">
          {running ? 'AvatarForcing live' : 'Avatar setup'}
        </h2>
      </div>
    </div>
    {!running && <p className="text-xs text-port-text-muted">Calls still work with a still portrait.</p>}
    {(error || !data) && <p role="status" className="text-xs">{error ? 'Could not load avatar status.' : 'Checking avatar runtime…'}</p>}
    {error && <button type="button" className={button} onClick={refetch}>Retry status</button>}
    {data && !data.supported && <p className="text-xs text-port-text-muted">This runtime needs an Apple Silicon host running macOS 26 or later.</p>}
    {!error && data?.supported && !running && <>
      {!data.installed || data.updateAvailable ? <label className="flex items-start gap-2 text-xs leading-relaxed">
        <input type="checkbox" checked={terms} disabled={pending} onChange={event => setTerms(event.target.checked)} className="mt-0.5 shrink-0" />
        <span>I accept the <a href="https://github.com/johnrobinsn/avatarforcing-mlx/blob/d83df52b1d891cae7d12d68b247af7be6e6def07/NOTICE"
          target="_blank" rel="noreferrer" className="underline text-port-accent-text">checkpoint terms</a> (noncommercial; motion checkpoint has research-use restrictions). Model downloads use about 1.17 GB before conversion and Python dependencies.</span>
      </label> : null}
      <p role="status" className="font-mono text-xs text-port-text-muted">
        {data.detail || (data.phase === 'running' ? 'Running' : data.installed ? 'Stopped' : 'Not installed')}
      </p>
      {failure && <p role="alert" className="text-xs text-port-error-text">{failure}</p>}
      <div className="flex flex-wrap gap-2">
        {confirmRemove ? <>
          <button type="button" className={button} onClick={() => setConfirmRemove(false)}>Keep model</button>
          <button type="button" className={button} onClick={() => { setConfirmRemove(false); act('uninstall'); }}>Remove model and runtime</button>
        </> : <AvatarActions data={data} terms={terms} pending={pending}
          ask={action => action === 'uninstall' ? setConfirmRemove(true) : act(action)} />}
      </div>
    </>}
  </section>;
}
