import { useEffect, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import FilePickerButton from '../ui/FilePickerButton';
import { importGalleryFile, assignImportedMedia } from '../../services/apiMedia';
import { formatCount } from '../../utils/formatters';
import useMounted from '../../hooks/useMounted';

const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,video/mp4,video/quicktime,video/webm,.png,.jpg,.jpeg,.gif,.webp,.mp4,.m4v,.mov,.webm,.mkv';

export default function MediaBatchImport({ collectionId, onImported }) {
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
      if (row.status === 'done') continue;
      if (cancelled.current) { row.status = 'cancelled'; continue; }
      row.error = null;
      row.status = row.saved ? 'assigning' : 'uploading';
      publish();
      // Finish the current request so cancellation never misreports a durable
      // import as aborted. The saved reference survives assignment retries.
      const imported = row.saved || await importGalleryFile(row.file, { silent: true }).catch(error => {
        row.error = `${error.message || 'Upload failed.'} If the connection was lost, check History before retrying.`;
        return null;
      });
      if (!imported) { row.status = 'failed'; publish(); continue; }
      row.saved = imported;
      let collection;
      if (collectionId) {
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
      if (mounted.current) importedCallback.current?.(imported, collection);
    }
    publish();
    running.current = false;
    if (mounted.current) { setBusy(false); setStopping(false); }
  };

  const completed = rows.filter(row => row.status === 'done').length;
  const retryable = rows.some(row => ['failed', 'cancelled'].includes(row.status));
  return (
    <section aria-label="Import media" className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <FilePickerButton multiple accept={ACCEPT} disabled={busy}
          onChange={event => run(Array.from(event.target.files || []).map(file => ({ file, status: 'queued' })))}
          className="inline-flex min-h-[44px] items-center gap-2 rounded border border-port-border px-3 text-sm text-port-accent hover:bg-port-border/50">
          <Upload className="h-4 w-4" aria-hidden="true" /> Upload / import
        </FilePickerButton>
        <span className="text-xs text-gray-400">Images and videos · embedded prompts checked{collectionId ? ' · added to this collection' : ''}</span>
        {busy && <button type="button" disabled={stopping} className="min-h-[44px] px-3 text-sm text-port-accent disabled:opacity-50"
          onClick={() => { cancelled.current = true; setStopping(true); }}>
          {stopping ? 'Finishing current file…' : 'Cancel remaining'}
        </button>}
        {!busy && retryable && <button type="button" onClick={() => run(rows)} className="min-h-[44px] px-3 text-sm text-port-accent">Retry failed / cancelled</button>}
      </div>
      {rows.length > 0 && <>
        <p role="status" className="text-xs text-gray-400">{formatCount(completed)} of {formatCount(rows.length)} imported{busy ? ' — working…' : ''}</p>
        <ul className="max-h-56 overflow-y-auto space-y-1 text-xs" aria-label="Import results">
          {rows.map((row, index) => <li key={index} className="break-words rounded border border-port-border px-2 py-1">
            <span className="font-medium">{row.file.name}</span>: {row.status === 'done' ? 'Imported' : row.status}
            {row.status === 'done' && <span> — {row.saved.data.importWarnings?.length ? row.saved.data.importWarnings.join(' ') : row.saved.data.prompt ? 'Embedded prompt imported' : 'No supported embedded prompt found'}</span>}
            {row.error && <p role="alert" className="text-port-error">{row.error}</p>}
          </li>)}
        </ul>
      </>}
    </section>
  );
}
