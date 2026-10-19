import { useEffect, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import FilePickerButton from '../ui/FilePickerButton';
import { importGalleryFile, assignImportedMedia } from '../../services/apiMedia';
import { pinImportedMedia } from '../../services/apiMoodBoard';
import { formatCount } from '../../utils/formatters';
import useMounted from '../../hooks/useMounted';

const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,video/mp4,video/quicktime,video/webm,.png,.jpg,.jpeg,.gif,.webp,.mp4,.m4v,.mov,.webm,.mkv';

export default function MediaBatchImport({ collectionId, moodBoardId, onImported }) {
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const running = useRef(false);
  const cancelled = useRef(false);
  const mounted = useMounted();
  const importedCallback = useRef(onImported);
  useEffect(() => { importedCallback.current = onImported; }, [onImported]);
  useEffect(() => () => { cancelled.current = true; }, []);

  const run = async (batch) => {
    if (running.current) return;
    running.current = true;
    cancelled.current = false;
    setBusy(true);
    setStopping(false);
    const publish = () => { if (mounted.current) setRows(batch.map(row => ({ ...row }))); };
    for (const row of batch) {
      if (row.status !== 'queued') continue;
      if (cancelled.current) { row.status = 'cancelled'; continue; }
      row.error = null;
      row.status = row.saved ? 'assigning' : 'uploading';
      publish();
      // Finish the current request so cancellation never misreports a durable
      // import as aborted. The saved reference survives assignment retries.
      const imported = row.saved || await importGalleryFile(row.file, { silent: true }).catch(error => {
        row.uncertain = !['INVALID_MEDIA_FILE', 'VALIDATION_ERROR', 'UNSUPPORTED_IMAGE', 'UNSUPPORTED_VIDEO'].includes(error.code);
        row.error = row.uncertain
          ? `${error.message || 'Upload response lost.'} The file may already be in History. Check History and pick the existing import from the gallery; Retry will not upload this file again.`
          : error.message;
        return null;
      });
      if (!imported) { row.status = row.uncertain ? 'uncertain' : 'failed'; publish(); continue; }
      row.saved = imported;
      let collection;
      let boardItem;
      if (moodBoardId) {
        row.status = 'assigning';
        publish();
        boardItem = await pinImportedMedia(moodBoardId, imported, { silent: true }).catch(error => {
          row.error = `Imported to History; mood board assignment failed: ${error.message}. Retry will only pin the existing import.`;
          return null;
        });
        if (!boardItem) { row.status = 'failed'; publish(); continue; }
      } else if (collectionId) {
        row.status = 'assigning';
        publish();
        const assigned = await assignImportedMedia(collectionId, imported, { silent: true }).catch(error => {
          row.error = `Imported to History; collection assignment failed: ${error.message}. Retry will only assign the existing import.`;
          return null;
        });
        if (!assigned) { row.status = 'failed'; publish(); continue; }
        collection = assigned.collection;
      }
      row.status = 'done';
      publish();
      if (mounted.current) importedCallback.current?.(imported, collection, boardItem);
    }
    publish();
    running.current = false;
    if (mounted.current) { setBusy(false); setStopping(false); }
  };

  const completed = rows.filter(row => row.status === 'done').length;
  // Keep results for retry/accounting, but completed files leave the visible queue.
  const pending = rows.filter(row => ['queued', 'uploading', 'assigning'].includes(row.status));
  const retryable = rows.filter(row => ['failed', 'cancelled'].includes(row.status));
  const uncertain = rows.filter(row => row.status === 'uncertain');
  const warnings = rows.filter(row => row.status === 'done' && row.saved.data.importWarnings?.length);
  const retry = () => run(rows.map(row => ['failed', 'cancelled'].includes(row.status)
    ? { ...row, status: 'queued', error: null } : row));
  return (
    <section aria-label="Import media" className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <FilePickerButton multiple accept={ACCEPT} disabled={busy}
          onChange={event => {
            const files = Array.from(event.target.files || []);
            if (files.length) run([...rows, ...files.map(file => ({ file, status: 'queued' }))]);
          }}
          className="inline-flex min-h-[44px] items-center gap-2 rounded border border-port-border px-3 text-sm text-port-accent hover:bg-port-border/50">
          <Upload className="h-4 w-4" aria-hidden="true" /> {moodBoardId ? 'Upload' : 'Upload / import'}
        </FilePickerButton>
        <span className="text-xs text-gray-400">Images and videos · embedded prompts checked{moodBoardId ? ' · pinned to this mood board' : collectionId ? ' · added to this collection' : ''}</span>
        {busy && <button type="button" disabled={stopping} className="min-h-[44px] px-3 text-sm text-port-accent disabled:opacity-50"
          onClick={() => { cancelled.current = true; setStopping(true); }}>
          {stopping ? 'Finishing current file…' : 'Cancel remaining'}
        </button>}
      </div>
      <p role="status" aria-atomic="true" className={busy ? 'text-xs text-gray-400' : 'sr-only'}>
        {rows.length > 0 && `${formatCount(completed)} of ${formatCount(rows.length)} imported${busy ? ' — working…' : ''}`}
      </p>
      {pending.length > 0 && <ul className="max-h-56 overflow-y-auto space-y-1 text-xs" aria-label="Import queue">
        {pending.map((row, index) => <li key={index} className="break-words rounded border border-port-border px-2 py-1">
          <span className="font-medium">{row.file.name}</span>: {row.status}
        </li>)}
      </ul>}
      {retryable.length > 0 && <section aria-label="Imports needing attention" className="rounded border border-port-border p-2 text-xs">
        <p className="font-medium">Some files still need attention</p>
        <ul className="max-h-56 overflow-y-auto space-y-1">
          {retryable.map((row, index) => <li key={index} role={row.error ? 'alert' : undefined} className="break-words text-port-error">
            <span className="font-medium">{row.file.name}</span>: {row.error || 'Cancelled. Retry to resume.'}
          </li>)}
        </ul>
        <button type="button" disabled={busy} onClick={retry} className="min-h-[44px] px-3 text-sm text-port-accent disabled:opacity-50">Retry failed / cancelled</button>
      </section>}
      {uncertain.length > 0 && <section aria-label="Uploads to check in History" className="rounded border border-port-border p-2 text-xs">
        {uncertain.map((row, index) => <p key={index} role="alert" className="break-words text-port-error">{row.file.name}: {row.error}</p>)}
        <a href="/media/history" target="_blank" rel="noreferrer" className="inline-flex min-h-[44px] items-center text-port-accent">Check Media History</a>
      </section>}
      {warnings.length > 0 && <section aria-label="Import warnings" className="text-xs text-port-warning">
        {warnings.map((row, index) => <p key={index} role="status" className="break-words">{row.file.name}: {row.saved.data.importWarnings.join(' ')}</p>)}
      </section>}
    </section>
  );
}
