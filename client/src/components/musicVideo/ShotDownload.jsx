import { useEffect, useRef, useState } from 'react';
import { throwApiError } from '../../services/apiCore.js';
import { formatTimecode } from '../../utils/formatters.js';

/** Prepare first, then offer a real link the phone can open or save. */
export default function ShotDownload({ projectId, sceneId, basis, startSec, endSec, disabled = false, saveFailed = false }) {
  const [state, setState] = useState({ status: 'idle' });
  const controller = useRef(null);
  const url = useRef(null);
  useEffect(() => () => {
    controller.current?.abort();
    if (url.current) URL.revokeObjectURL(url.current);
  }, []);

  const prepare = async () => {
    if (controller.current) return;
    if (url.current) { URL.revokeObjectURL(url.current); url.current = null; }
    const request = new AbortController();
    controller.current = request;
    setState({ status: 'rendering' });
    try {
      const response = await fetch(`/api/music-video/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}/download`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ basis }), signal: request.signal });
      if (!response.ok) await throwApiError(response);
      const blob = await response.blob();
      if (request.signal.aborted) return;
      url.current = URL.createObjectURL(blob);
      setState({ status: 'ready', url: url.current });
    } catch (err) {
      if (!request.signal.aborted) setState({ status: 'error', message: err.message || 'Could not prepare the clip' });
    } finally {
      if (controller.current === request) controller.current = null;
    }
  };
  const cancel = () => { controller.current?.abort(); controller.current = null; setState({ status: 'idle' }); };
  return <div className="flex flex-wrap items-center gap-2 text-xs">
    <span className="w-full text-port-text-muted">Selected clip with song {Number.isFinite(startSec) && Number.isFinite(endSec) ? `${formatTimecode(startSec)}–${formatTimecode(endSec)}` : '(set shot timing first)'}. A short non-looping clip ends early.</span>
    {saveFailed && <span role="alert" className="w-full text-port-error">Save the shot changes before preparing this clip.</span>}
    {state.status === 'rendering' ? <><span>Preparing clip with music…</span><button type="button" className="min-h-[44px] text-port-error" onClick={cancel}>Cancel</button></> : <button type="button" className="min-h-[44px] rounded border border-port-border px-3 disabled:opacity-50" disabled={disabled} onClick={prepare}>{state.status === 'ready' ? 'Prepare again' : 'Prepare clip with music'}</button>}
    {state.status === 'ready' && <a className="min-h-[44px] flex items-center rounded bg-port-accent px-3 text-white" href={state.url} download="music-video-shot.mp4">Download clip</a>}
    {state.status === 'error' && <p role="alert" className="text-port-error">{state.message}</p>}
  </div>;
}
