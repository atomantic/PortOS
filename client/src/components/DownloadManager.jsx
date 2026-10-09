import { useEffect, useRef, useState } from 'react';
import Modal from './ui/Modal.jsx';
import { assetDownloadUrl, installStandaloneDownloadHandler, prepareDownload } from '../lib/standaloneDownload.js';

// One app-level surface for all same-origin download links on share-capable
// touch browsers and Home Screen apps. The file stays available after canceling
// a share sheet, so another Save tap never downloads the video again.
export default function DownloadManager() {
  const [download, setDownload] = useState(null);
  const [file, setFile] = useState(null);
  const [error, setError] = useState('');
  const [sharing, setSharing] = useState(false);
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
      prepareDownload(next, controller.signal).then((ready) => {
        if (!controller.signal.aborted) setFile(ready);
      }).catch((err) => {
        if (!controller.signal.aborted) setError(`Download failed: ${err.message}`);
      });
    });
    return () => { uninstall(); pending.current?.abort(); };
  }, []);

  const close = () => { pending.current?.abort(); setDownload(null); setFile(null); };
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

  return <Modal open={Boolean(download)} onClose={close} ariaLabel="Save download" size="sm"
    panelClassName="bg-port-card border border-port-border rounded-xl p-4 space-y-3">
    <h2 className="text-lg font-semibold">Save download</h2>
    <p className="text-sm break-all">{download?.filename}</p>
    <p role="status" className="text-sm text-port-text-muted">{file ? 'Ready. Tap Save, then choose Save Video or Save to Files.' : error ? 'Use the browser download or close and try again.' : 'Preparing download…'}</p>
    {error && <p role="alert" className="text-sm text-port-error">{error}</p>}
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" disabled={!file || sharing} onClick={save} className="min-h-[44px] rounded bg-port-accent text-port-bg px-4 disabled:opacity-50">{sharing ? 'Saving…' : 'Save'}</button>
      <button type="button" onClick={close} className="min-h-[44px] px-3">Close</button>
      {download && <a href={assetDownloadUrl(download.url)} download={download.filename} data-native-download onClick={close} target="_blank" rel="noopener noreferrer" className="min-h-[44px] inline-flex items-center text-sm text-port-accent">Browser download</a>}
    </div>
  </Modal>;
}
