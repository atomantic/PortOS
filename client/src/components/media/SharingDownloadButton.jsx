import { useState } from 'react';
import { downloadVideoSharingCopy } from '../../services/apiImageVideo';
import { downloadBlob } from '../../lib/downloadBlob';

// The sharing copy is an ffmpeg re-encode the server runs only for a caller
// with host control, so it is fetched (not linked) to show a refusal as an
// unavailable note instead of saving the error body as the download.
export default function SharingDownloadButton({ itemId }) {
  const [state, setState] = useState({ busy: false, note: null });
  const download = async () => {
    if (state.busy) return;
    setState({ busy: true, note: null });
    const blob = await downloadVideoSharingCopy(itemId).catch((err) => err);
    if (blob instanceof Blob) {
      downloadBlob(blob, `sharing-${itemId}.mp4`, 'video/mp4');
      setState({ busy: false, note: null });
      return;
    }
    setState({
      busy: false,
      note: blob?.code === 'HOST_CONTROL_FORBIDDEN'
        ? 'Download for sharing needs operator access.'
        : (blob?.message || 'Could not prepare the sharing download'),
    });
  };
  return (
    <>
      <button type="button" disabled={state.busy} onClick={download}
        className="min-h-[44px] flex items-center px-2 rounded bg-port-border text-white disabled:opacity-50">
        {state.busy ? 'Preparing…' : 'Download for sharing'}
      </button>
      {state.note && <p role="status" className="w-full text-xs text-port-text-muted">{state.note}</p>}
    </>
  );
}
