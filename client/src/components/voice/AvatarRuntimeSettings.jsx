import { useState } from 'react';
import { changeVoiceAvatar } from '../../services/apiVoiceAvatar';
import { setAvatarMode, useAvatarMode } from './useAvatarMode';

const button = 'min-h-11 rounded-lg border border-port-border px-3 text-sm hover:border-port-accent disabled:opacity-50';

function AvatarActions({ data, ask, terms, pending }) {
  const action = (name, label, enabled = true) => <button type="button" className={button}
    onClick={() => ask(name)} disabled={pending || !enabled}>{label}</button>;
  if (data.phase === 'installing') return action('cancel', 'Cancel install');
  if (['running', 'starting'].includes(data.phase)) return action('stop', 'Stop');
  if (data.phase === 'stopping') return null;
  if (!data.installed) return action('install', 'Install AvatarForcing', terms);
  return <>
    {data.updateAvailable ? action('update', 'Update AvatarForcing', terms) : action('start', 'Start AvatarForcing')}
    {action('uninstall', 'Uninstall and remove weights')}
  </>;
}

export default function AvatarRuntimeSettings({ data, error, updateData, refetch }) {
  const useGenerativeAvatar = useAvatarMode();
  const [showControls, setShowControls] = useState(false);
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

  const running = data?.supported && data.phase === 'running' && !error;

  return <section aria-label="Voice avatar model" className="space-y-3 rounded-xl border border-port-border bg-port-card p-4 text-port-text">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-semibold">{running && useGenerativeAvatar ? 'AvatarForcing ready' : 'Avatar setup'} <span className="text-xs font-normal text-port-text-muted">Experimental</span></h3>
      {running && useGenerativeAvatar && <button type="button" className={button} aria-expanded={showControls}
        onClick={() => setShowControls(value => !value)}>{showControls ? 'Hide avatar settings' : 'Avatar settings'}</button>}
    </div>
    {(!running || !useGenerativeAvatar) && <p className="text-sm text-port-text-muted">Calls and Play sample still work with a still portrait.</p>}
    {(error || !data) && <p role="status" className="text-sm">{error ? 'Could not load avatar status.' : 'Checking avatar runtime…'}</p>}
    {error && <button type="button" className={button} onClick={refetch}>Retry status</button>}
    {data && !data.supported && <p className="text-sm">This runtime needs an Apple Silicon host running macOS 26 or later.</p>}
    {!error && data?.supported && (!running || showControls || !useGenerativeAvatar) && <>
      {!data.installed || data.updateAvailable ? <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={terms} disabled={pending} onChange={event => setTerms(event.target.checked)} className="mt-0.5" />
        <span>I accept the <a href="https://github.com/johnrobinsn/avatarforcing-mlx/blob/d83df52b1d891cae7d12d68b247af7be6e6def07/NOTICE"
          target="_blank" rel="noreferrer" className="underline">checkpoint terms</a> (noncommercial; motion checkpoint has research-use restrictions). Model downloads use about 1.17 GB before conversion and Python dependencies.</span>
      </label> : null}
      {data.installed && <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={useGenerativeAvatar}
          onChange={event => {
            setShowControls(true);
            setAvatarMode(event.target.checked);
          }} />
        Use generated avatar in this browser
      </label>}
      <p role="status" className="text-sm text-port-text-muted">
        {data.detail || (data.phase === 'running' ? 'Running' : data.installed ? 'Stopped' : 'Not installed')}
      </p>
      {failure && <p role="alert" className="text-sm text-port-error">{failure}</p>}
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
