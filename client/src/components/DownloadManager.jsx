import { useEffect, useRef, useState } from 'react';
import Modal from './ui/Modal.jsx';
import ProgressBar from './ui/ProgressBar.jsx';
import { SHARE_SHEET_MAX_BYTES, assetDownloadUrl, installStandaloneDownloadHandler, prepareDownload } from '../lib/standaloneDownload.js';
import { formatBytes } from '../utils/formatters.js';

// One app-level surface for all same-origin download links on share-capable
// touch browsers and Home Screen apps. The file stays available after canceling
// a share sheet, so another Save tap never downloads the video again.
export default function DownloadManager() {
  const [download, setDownload] = useState(null);
  const [file, setFile] = useState(null);
  const [error, setError] = useState('');
  const [sharing, setSharing] = useState(false);
  const [progress, setProgress] = useState(null);
  const [tooLarge, setTooLarge] = useState(null);
  const pending = useRef(null);

  useEffect(() => {
    const uninstall = installStandaloneDownloadHandler((next) => {
      pending.current?.abort();
      const controller = new AbortController();
      pending.current = controller;
      setDownload(next);
      setFile(null);
      setError('');
      setSharing(false);
      setProgress(null);
      setTooLarge(null);
      const onProgress = (next) => { if (!controller.signal.aborted) setProgress(next); };
      prepareDownload(next, controller.signal, onProgress).then((ready) => {
        if (!controller.signal.aborted) setFile(ready);
      }).catch((err) => {
        if (controller.signal.aborted) return;
        if (err.code === 'DOWNLOAD_TOO_LARGE') setTooLarge({ bytes: err.bytes });
        else setError(`Download failed: ${err.message}`);
      });
    });
    return () => { uninstall(); pending.current?.abort(); };
  }, []);

  const close = () => { pending.current?.abort(); setDownload(null); setFile(null); setProgress(null); setTooLarge(null); };
  const save = () => {
    const controller = pending.current;
    setSharing(true);
    setError('');
    // Invoke synchronously inside the tap, with no fetch/await before share.
    navigator.share({ files: [file] }).then(() => {
      if (!controller.signal.aborted) close();
    }).catch((err) => {
      if (!controller.signal.aborted && err.name !== 'AbortError') setError(`Could not open the share sheet: ${err.message}`);
    }).finally(() => { if (!controller.signal.aborted) setSharing(false); });
  };

  const preparing = Boolean(download) && !file && !error && !tooLarge;
  const percent = progress?.total ? (progress.received / progress.total) * 100 : null;
  const progressText = progress?.received > 0
    ? (progress.total ? `${formatBytes(progress.received)} of ${formatBytes(progress.total)}` : `${formatBytes(progress.received)} loaded`)
    : undefined;
  const statusText = file ? 'Ready. Tap Save, then choose Save Video or Save to Files.'
    : tooLarge ? `This file is ${tooLarge.bytes ? formatBytes(tooLarge.bytes) : `over ${formatBytes(SHARE_SHEET_MAX_BYTES)}`}, too big for the phone's save sheet. Tap Browser download to save it directly.`
    : error ? 'Use the browser download or close and try again.'
    : `Loading the file onto this device${percent == null ? '…' : ` (${Math.floor(percent)}%)`}`;

  return <Modal open={Boolean(download)} onClose={close} ariaLabel="Save download" size="sm"
    panelClassName="bg-port-card border border-port-border rounded-xl p-4 space-y-3">
    <h2 className="text-lg font-semibold">Save download</h2>
    <p className="text-sm break-all">{download?.filename}</p>
    <p role="status" className="text-sm text-port-text-muted">{statusText}</p>
    {preparing && <div className="space-y-1">
      <ProgressBar percent={percent} label="Download progress" valueText={progressText} />
      {progress?.received > 0 && <p className="text-xs text-port-text-muted">{progressText}</p>}
    </div>}
    {error && <p role="alert" className="text-sm text-port-error">{error}</p>}
    <div className="flex flex-wrap items-center gap-3">
      {!tooLarge && <button type="button" disabled={!file || sharing} onClick={save} className="min-h-[44px] rounded bg-port-accent text-port-bg px-4 disabled:opacity-50">{sharing ? 'Saving…' : 'Save'}</button>}
      <button type="button" onClick={close} className="min-h-[44px] px-3">Close</button>
      {download && <a href={assetDownloadUrl(download.url)} download={download.filename} data-native-download onClick={close} target="_blank" rel="noopener noreferrer"
        className={tooLarge ? 'min-h-[44px] inline-flex items-center rounded bg-port-accent text-port-bg px-4' : 'min-h-[44px] inline-flex items-center text-sm text-port-accent'}>Browser download</a>}
    </div>
  </Modal>;
}
