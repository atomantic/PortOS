import { Activity, Download } from 'lucide-react';

// The URL input + Import/Cancel button pairing for a useMusicVideoYoutubeImport
// slot — shared by the create form (full-size) and the detail view's
// track-change row (compact, inline in a flex-wrap toolbar). #1945
export default function YoutubeImportControls({ id, url, onUrlChange, job, onStart, compact = false, disabled = false }) {
  const size = compact ? 12 : 13;
  const py = compact ? 'py-1' : 'py-1.5';
  const btnExtra = compact ? '' : 'text-xs whitespace-nowrap min-h-[44px] sm:min-h-0';
  return (
    <>
      <input
        id={id} type="url" value={url} onChange={onUrlChange} disabled={job.active || disabled}
        // The create form's usage sits inside a <form onSubmit={handleCreate}>
        // — without this, Enter (the natural gesture after pasting a URL)
        // submits the form (creating a track-less project) instead of
        // starting the import. Harmless on the detail view's usage, which
        // isn't inside a <form>.
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (url.trim()) onStart(); } }}
        placeholder="Import audio from a YouTube URL…" aria-label="Import audio from a YouTube URL"
        className={`${compact ? 'flex-1 min-w-[160px]' : 'flex-1 min-w-0'} bg-port-bg border border-port-border rounded px-2 ${py} text-sm disabled:opacity-50`}
      />
      {job.active ? (
        <button type="button" onClick={job.cancel}
          className={`flex items-center gap-1 bg-port-warning/20 text-port-warning border border-port-border rounded px-2 ${py} ${btnExtra}`}>
          <Activity size={size} className="animate-spin" /> {job.percent}%
        </button>
      ) : (
        <button type="button" onClick={onStart} disabled={!url.trim() || disabled}
          title="Download and extract this video's audio as a track"
          className={`flex items-center gap-1 bg-port-bg border border-port-border rounded px-2 ${py} ${btnExtra} disabled:opacity-50`}>
          <Download size={size} /> Import
        </button>
      )}
    </>
  );
}
