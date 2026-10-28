import { useState } from 'react';
import CreativeSetupPanel from '../CreativeSetupPanel.jsx';
import AutoSizeTextarea from '../../ui/AutoSizeTextarea';

/** Re-read the song style from its Suno link, for a song imported before excluded styles were kept. */
function SongStyleFromSuno({ onRead, disabled }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [reading, setReading] = useState(false);
  if (!open) {
    return (
      <button type="button" disabled={disabled} onClick={() => setOpen(true)}
        className="text-xs text-port-accent hover:underline disabled:opacity-50">Read from Suno</button>
    );
  }
  const read = () => {
    setReading(true);
    onRead(url.trim()).then((ok) => { setReading(false); if (ok) { setOpen(false); setUrl(''); } });
  };
  return (
    <div className="flex min-w-0 basis-full flex-wrap items-center gap-2">
      <label htmlFor="mv-song-style-suno" className="sr-only">Suno song link</label>
      <input id="mv-song-style-suno" type="url" value={url} onChange={(e) => setUrl(e.target.value)}
        placeholder="https://suno.com/song/…"
        className="min-w-0 flex-1 rounded border border-port-border bg-port-bg px-2 py-1 text-sm" />
      <button type="button" disabled={disabled || reading || !url.trim()} onClick={read}
        className="rounded bg-port-accent px-3 py-1 text-xs text-white disabled:opacity-50">{reading ? 'Reading…' : 'Read'}</button>
      <button type="button" onClick={() => setOpen(false)} className="text-xs text-port-text-muted hover:underline">Cancel</button>
    </div>
  );
}

/** Concept, style, universe and look references: what the cast and sets are built from. */
export default function StoryDirection({ board }) {
  const { project, locked, conceptDraft, styleDraft, songStyleDraft, songStyleFromSuno } = board;
  return (
    <>
      <CreativeSetupPanel
        key={`creative-${project.id}`}
        project={project}
        onPendingChange={board.setCreativeSetupPending}
        onSave={board.saveCreativeSetup}
      />
      {Object.keys(board.conceptSaveFailures || {}).length > 0 && <div role="alert" className="rounded border border-port-warning p-2 text-xs text-port-warning">
        Some direction edits have not saved. Your text is still here.{' '}
        <button type="button" disabled={board.conceptSavePending > 0} onClick={board.retryConceptSave} className="min-h-[44px] text-port-accent underline disabled:opacity-50">Retry saving</button>
      </div>}
      <fieldset disabled={locked} className="min-w-0 space-y-2">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div>
            <label htmlFor="mv-concept" className="mb-1 block text-xs text-port-text-muted">Concept</label>
            <AutoSizeTextarea
              id="mv-concept"
              value={conceptDraft.value}
              rows={2}
              maxLength={8000}
              onChange={conceptDraft.onChange}
              onBlur={conceptDraft.onBlur}
              placeholder="The broad creative direction, themes and story arc for the whole video."
              className="min-h-[44px] w-full rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm"
            />
          </div>
          <div>
            <label htmlFor="mv-style" className="mb-1 block text-xs text-port-text-muted">Visual style</label>
            <AutoSizeTextarea
              id="mv-style"
              value={styleDraft.value}
              rows={2}
              maxLength={2000}
              onChange={styleDraft.onChange}
              onBlur={styleDraft.onBlur}
              placeholder="Art style, palette and mood, added to every frame and shot prompt."
              className="min-h-[44px] w-full rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm"
            />
          </div>
          {songStyleDraft && (
            <div className="sm:col-span-2">
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                <label htmlFor="mv-song-style" className="block text-xs text-port-text-muted">Song style</label>
                {songStyleFromSuno && <SongStyleFromSuno onRead={songStyleFromSuno} disabled={locked || board.conceptSavePending > 0 || Object.hasOwn(board.conceptSaveFailures || {}, 'songStyle')} />}
              </div>
              <AutoSizeTextarea
                id="mv-song-style"
                value={songStyleDraft.value}
                rows={2}
                maxLength={2000}
                onChange={songStyleDraft.onChange}
                onBlur={songStyleDraft.onBlur}
                placeholder="The song's Suno style. Excluded styles start with a minus."
                className="min-h-[44px] w-full rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm"
              />
              <p className="mt-1 text-xs text-port-text-muted">With the lyrics, it shapes the world, cast and scenes. It is never added to frame prompts.</p>
            </div>
          )}
        </div>
      </fieldset>
    </>
  );
}
