import { useState } from 'react';
import { Package, Download, Copy, Sparkles, Image as ImageIcon, Captions, ListOrdered } from 'lucide-react';
import useProviderModels from '../../hooks/useProviderModels.js';
import ProviderModelSelector from '../ProviderModelSelector.jsx';
import { copyToClipboard } from '../../lib/clipboard.js';
import CoverArtPanel from './CoverArtPanel.jsx';
import { formatCount, formatUsd } from '../../utils/formatters.js';

const fmtTime = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const chaptersText = (chapters) => chapters.map((c) => `${fmtTime(c.startSec)} ${c.label}`).join('\n');

// What each platform's copy is made of; `max` shows a live count against the platform's own ceiling.
export const PUBLISH_FIELDS = [
  { platform: 'youtube', label: 'YouTube', fields: [
    { key: 'title', label: 'Title', max: 100 },
    { key: 'description', label: 'Description', multiline: true },
    { key: 'tags', label: 'Tags (comma-separated)', tags: true },
  ] },
  { platform: 'shorts', label: 'YouTube Shorts', fields: [{ key: 'title', label: 'Title', max: 100 }, { key: 'description', label: 'Description', multiline: true }] },
  { platform: 'x', label: 'X', fields: [{ key: 'hook', label: 'Hook post (no links)', max: 280, multiline: true }, { key: 'story', label: 'Story reply', multiline: true }] },
  { platform: 'tiktok', label: 'TikTok', fields: [{ key: 'caption', label: 'Caption', max: 2200, multiline: true }] },
  { platform: 'instagram', label: 'Instagram Reels', fields: [{ key: 'caption', label: 'Caption', max: 2200, multiline: true }] },
  { platform: 'reddit', label: 'Reddit', fields: [{ key: 'title', label: 'Title', max: 300 }, { key: 'body', label: 'Body (markdown)', multiline: true }] },
  { platform: 'stackerNews', label: 'Stacker News', fields: [{ key: 'title', label: 'Title', max: 80 }, { key: 'body', label: 'Body (markdown)', multiline: true }] },
];

// What the writer may use beyond the notes and links; mirrors the server's
// DEFAULT_COPY_INCLUDE (song title on, everything else off, no hashtags).
const DEFAULT_INCLUDE = { title: true, lyrics: false, spend: false, chapters: false, hashtags: false };
// Generation spend across the project's production runs, as the server totals it for the draft.
const projectSpend = (project) => (project?.productionRuns || [])
  .reduce((sum, run) => sum + (Number.isFinite(Number(run?.usage?.spentUsd)) ? Number(run.usage.spentUsd) : 0), 0);

const fieldValue = (copy, platform, field) => {
  const v = copy?.[platform]?.[field.key];
  if (field.tags) return Array.isArray(v) ? v.join(', ') : '';
  return typeof v === 'string' ? v : '';
};

function CopyField({ id, field, initial, onSave, disabled }) {
  const [value, setValue] = useState(initial);
  const over = field.max && value.length > field.max;
  const commit = () => {
    if (value === initial) return;
    onSave(field.tags ? value.split(',').map((t) => t.trim()).filter(Boolean) : value);
  };
  const Input = field.multiline ? 'textarea' : 'input';
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-[11px] text-port-text-muted">{field.label}</label>
        <div className="flex items-center gap-2">
          {field.max && <span className={`text-[10px] font-mono ${over ? 'text-port-error' : 'text-port-text-muted'}`}>{value.length}/{field.max}</span>}
          <button type="button" onClick={() => copyToClipboard(value, `${field.label} copied`)} disabled={!value}
            aria-label={`Copy ${field.label}`} className="text-port-text-muted disabled:opacity-40 min-h-[44px] sm:min-h-0 px-1"><Copy size={12} /></button>
        </div>
      </div>
      <Input id={id} value={value} disabled={disabled} rows={field.multiline ? 4 : undefined}
        onChange={(e) => setValue(e.target.value)} onBlur={commit}
        className="w-full bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs min-h-[44px] sm:min-h-0" />
    </div>
  );
}

/**
 * Publishing kit (#9281): build the release assets from the final render
 * (platform encodes, thumbnails, SRT captions, YouTube chapters), draft every
 * platform's copy in one provider call from the director's own making-of
 * notes, then edit and copy each field out.
 */
export default function PublishKitPanel({ project, publishKit, enabledTargets }) {
  const kit = project?.publishKit || {};
  // Copy only for where the director posts (#9287); Suno's caption reuses the YouTube description.
  const copyFields = enabledTargets
    ? PUBLISH_FIELDS.filter(({ platform }) => enabledTargets.includes(platform) || (platform === 'youtube' && enabledTargets.includes('suno')))
    : PUBLISH_FIELDS;
  const noPlatforms = !!enabledTargets && copyFields.length === 0;
  const idFor = (s) => `mv-publish-${project?.id}-${s}`;
  const [notes, setNotes] = useState(kit.notes || '');
  const [youtubeUrl, setYoutubeUrl] = useState(kit.links?.youtube || '');
  const [songUrl, setSongUrl] = useState(kit.links?.song || '');
  const [include, setInclude] = useState({ ...DEFAULT_INCLUDE, ...(kit.draftOptions?.include || {}) });
  const [length, setLength] = useState(kit.draftOptions?.length === 'full' ? 'full' : 'short');
  // Same filter as the server's timedLines: only cues with text and a start time reach the writer.
  const lyricLines = (project?.lyricCues || [])
    .filter((c) => typeof c?.text === 'string' && c.text.trim() && typeof c.startSec === 'number' && Number.isFinite(c.startSec)).length;
  const [confirmReplace, setConfirmReplace] = useState(false);
  // Mirrors the server's copyEditedSinceDraft: a draft would replace posts written or edited by hand.
  const editedAt = Date.parse(kit.copyEditedAt || '');
  const draftedAt = Date.parse(kit.copyDraftedAt || '');
  const editedSinceDraft = Number.isFinite(editedAt) && (!Number.isFinite(draftedAt) || editedAt > draftedAt);
  const spend = projectSpend(project);
  const includeRows = [
    { key: 'title', label: 'Song title', detail: project?.name ? `"${project.name}"` : 'no title yet', available: !!project?.name },
    { key: 'lyrics', label: 'Lyrics', detail: lyricLines ? `${formatCount(lyricLines)} timed line${lyricLines === 1 ? '' : 's'}` : 'no timed lyrics', available: lyricLines > 0 },
    { key: 'chapters', label: 'Chapters', detail: kit.chapters?.length ? `${formatCount(kit.chapters.length)} from the kit` : 'from the song sections', available: true },
    { key: 'spend', label: 'Generation spend', detail: spend > 0 ? formatUsd(spend) : 'none recorded', available: spend > 0 },
    { key: 'hashtags', label: 'Hashtags and YouTube tags', detail: 'none are added unless ticked', available: true },
  ];
  const {
    providers, selectedProviderId, selectedModel, availableModels, setSelectedProviderId, setSelectedModel,
  } = useProviderModels({ allowDefault: true, silent: true });
  const canBuild = !!project?.renderHistoryId;
  const kitStale = !!kit.builtAt && (kit.master?.renderHistoryId ?? null) !== (project?.renderHistoryId ?? null);
  const links = {
    ...(/^https?:\/\//.test(youtubeUrl.trim()) ? { youtube: youtubeUrl.trim() } : {}),
    ...(/^https?:\/\//.test(songUrl.trim()) ? { song: songUrl.trim() } : {}),
  };
  const draft = (replaceEdited = false) => publishKit.draftCopy({
    ...(selectedProviderId ? { providerId: selectedProviderId } : {}),
    ...(selectedModel ? { model: selectedModel } : {}),
    notes, links,
    include: Object.fromEntries(includeRows.map(({ key, available }) => [key, available && include[key]])),
    length,
    ...(replaceEdited ? { replaceEdited: true } : {}),
  });
  const onDraft = () => (editedSinceDraft ? setConfirmReplace(true) : draft());

  return (
    <div className="space-y-3">
      <section aria-label="Release assets" className="rounded-lg border border-port-border bg-port-card p-3 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium flex items-center gap-1.5"><Package size={14} /> Release assets</h3>
          <button type="button" disabled={!canBuild || publishKit.building} onClick={publishKit.build}
            className="flex items-center gap-1 bg-port-accent/20 text-port-accent disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0">
            <Package size={13} /> {kit.builtAt ? 'Rebuild kit' : 'Build publishing kit'}
          </button>
        </div>
        {!canBuild && <p className="text-xs text-port-text-muted">Render the final video first. The kit is made from it.</p>}
        {kitStale && (
          <p role="status" className="text-xs text-port-warning">Kit built from an earlier render. Fill draft is refused until you rebuild it. Use Rebuild kit.</p>
        )}
        {publishKit.building && (
          <div className="space-y-2">
            <div className="h-1.5 bg-port-bg rounded overflow-hidden"><div className="h-full bg-port-accent transition-all" style={{ width: `${publishKit.progress}%` }} /></div>
            <div className="flex items-center justify-between">
              <p className="text-xs text-port-text-muted">Encoding — {Math.round(publishKit.progress)}%</p>
              <button type="button" onClick={publishKit.cancelBuild} className="text-xs text-port-text-muted hover:text-port-text-base px-2 py-1">Cancel</button>
            </div>
          </div>
        )}
        {kit.builtAt && (
          <div className="space-y-2 text-xs">
            <ul className="space-y-1">
              {kit.master?.filename && (
                <li className="flex flex-wrap items-center justify-between gap-2">
                  <span>YouTube master (the final render)</span>
                  <a href={`/data/videos/${kit.master.filename}`} download className="text-port-accent flex items-center gap-1 min-h-[44px] sm:min-h-0"><Download size={12} /> Download</a>
                </li>
              )}
              {(kit.exports || []).map((e) => (
                <li key={e.filename} className="flex flex-wrap items-center justify-between gap-2">
                  <span>{e.label}{e.kind === 'teaser' && e.startSec != null && <span className="text-port-text-muted"> · {fmtTime(e.startSec)}–{fmtTime(e.endSec)}</span>}</span>
                  <a href={`/data/videos/${e.filename}`} download className="text-port-accent flex items-center gap-1 min-h-[44px] sm:min-h-0"><Download size={12} /> Download</a>
                </li>
              ))}
              {kit.captionsFilename && (
                <li className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-1"><Captions size={12} /> Lyric captions (SRT)</span>
                  <a href={`/data/videos/${kit.captionsFilename}`} download className="text-port-accent flex items-center gap-1 min-h-[44px] sm:min-h-0"><Download size={12} /> Download</a>
                </li>
              )}
            </ul>
            {kit.chapters?.length > 0 && (
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-port-text-muted flex items-center gap-1"><ListOrdered size={12} /> YouTube chapters (paste into the description)</span>
                  <button type="button" onClick={() => copyToClipboard(chaptersText(kit.chapters), 'Chapters copied')} aria-label="Copy chapters"
                    className="text-port-text-muted min-h-[44px] sm:min-h-0 px-1"><Copy size={12} /></button>
                </div>
                <pre className="bg-port-bg border border-port-border rounded p-2 whitespace-pre-wrap break-words font-mono text-[11px]">{chaptersText(kit.chapters)}</pre>
              </div>
            )}
            {kit.thumbnails?.length > 0 && (
              <div className="space-y-1">
                <span className="text-port-text-muted flex items-center gap-1"><ImageIcon size={12} /> Thumbnail: pick one, or add title text before uploading</span>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {kit.thumbnails.map((name) => (
                    <button key={name} type="button" onClick={() => publishKit.selectThumbnail(name)} aria-pressed={kit.thumbnail === name}
                      aria-label={`Use thumbnail ${name}`}
                      className={`rounded overflow-hidden border-2 ${kit.thumbnail === name ? 'border-port-accent' : 'border-transparent'}`}>
                      <img src={`/data/video-thumbnails/${name}`} alt="" className="w-full aspect-video object-cover" />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      <CoverArtPanel key={project?.id} project={project} publishKit={publishKit} />

      <section aria-label="Release copy" className="rounded-lg border border-port-border bg-port-card p-3 space-y-2 text-xs">
        <h3 className="text-sm font-medium flex items-center gap-1.5"><Sparkles size={14} /> Release copy</h3>
        <p className="text-port-text-muted">Each post below is exactly what goes out. Write it yourself, or have the writer draft it from your notes, the links and only what you tick under Draft from. Nothing runs until you press Draft.</p>
        <div className="space-y-0.5">
          <label htmlFor={idFor('notes')} className="text-[11px] text-port-text-muted">Making-of notes (your story, in your words)</label>
          <textarea id={idFor('notes')} value={notes} maxLength={8000} rows={4} onChange={(e) => setNotes(e.target.value)}
            className="w-full bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs" />
        </div>
        <div className="grid sm:grid-cols-2 gap-2">
          <div>
            <label htmlFor={idFor('youtube-url')} className="block text-[11px] text-port-text-muted">Full video URL (optional)</label>
            <input id={idFor('youtube-url')} value={youtubeUrl} onChange={(e) => setYoutubeUrl(e.target.value)} placeholder="https://…"
              className="w-full bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs min-h-[44px] sm:min-h-0" />
          </div>
          <div>
            <label htmlFor={idFor('song-url')} className="block text-[11px] text-port-text-muted">Song URL (optional)</label>
            <input id={idFor('song-url')} value={songUrl} onChange={(e) => setSongUrl(e.target.value)} placeholder="https://…"
              className="w-full bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs min-h-[44px] sm:min-h-0" />
          </div>
        </div>
        <fieldset className="space-y-1 rounded border border-port-border p-2">
          <legend className="px-1 text-[11px] font-medium">Draft from (plus your notes and links)</legend>
          {includeRows.map(({ key, label, detail, available }) => (
            <label key={key} htmlFor={idFor(`include-${key}`)} className={`flex items-center gap-2 min-h-[44px] sm:min-h-0 ${available ? '' : 'opacity-50'}`}>
              <input id={idFor(`include-${key}`)} type="checkbox" checked={available && include[key]} disabled={!available || publishKit.drafting}
                onChange={(e) => setInclude((cur) => ({ ...cur, [key]: e.target.checked }))} />
              <span>{label} <span className="text-port-text-muted">· {detail}</span></span>
            </label>
          ))}
        </fieldset>
        <fieldset className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <legend className="text-[11px] text-port-text-muted mb-0.5">Length</legend>
          {[['short', 'A sentence or two'], ['full', 'Full making-of']].map(([value, label]) => (
            <label key={value} htmlFor={idFor(`length-${value}`)} className="flex items-center gap-1.5 min-h-[44px] sm:min-h-0">
              <input id={idFor(`length-${value}`)} type="radio" name={idFor('length')} value={value} checked={length === value}
                disabled={publishKit.drafting} onChange={() => setLength(value)} />
              {label}
            </label>
          ))}
        </fieldset>
        <div className="flex flex-wrap items-end gap-2">
          {providers.length > 0 && (
            <ProviderModelSelector providers={providers} selectedProviderId={selectedProviderId} selectedModel={selectedModel}
              availableModels={availableModels} onProviderChange={setSelectedProviderId} onModelChange={setSelectedModel}
              label="Writer" compact alwaysShowModel modelDisabled={availableModels.length === 0}
              emptyProviderOption="Active provider (default)" emptyModelOption="Default model" disabled={publishKit.drafting} />
          )}
          <button type="button" onClick={onDraft} disabled={publishKit.drafting || publishKit.saving || noPlatforms || confirmReplace}
            className="flex items-center gap-1 bg-port-accent/20 text-port-accent disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0">
            <Sparkles size={13} /> {publishKit.drafting ? 'Drafting…' : (kit.copy ? 'Redraft copy' : 'Draft copy')}
          </button>
        </div>
        {confirmReplace && (
          <div role="alert" className="flex flex-wrap items-center gap-2 rounded border border-port-warning/50 bg-port-warning/10 p-2">
            <span className="flex-1 min-w-[12rem]">Drafting replaces the posts you wrote or edited below.</span>
            <button type="button" onClick={() => { setConfirmReplace(false); draft(true); }}
              className="bg-port-warning/20 text-port-warning rounded px-2 py-1.5 min-h-[44px] sm:min-h-0">Replace them</button>
            <button type="button" onClick={() => setConfirmReplace(false)}
              className="text-port-text-muted px-2 py-1.5 min-h-[44px] sm:min-h-0">Keep mine</button>
          </div>
        )}
        {noPlatforms && <p className="text-port-text-muted">Turn on a platform under Where you post to draft its copy.</p>}
        {!noPlatforms && (
          <div className="space-y-3" key={kit.copyDraftedAt || 'copy'}>
            {copyFields.map(({ platform, label, fields }) => (
              <fieldset key={platform} className="space-y-1.5 rounded border border-port-border p-2">
                <legend className="px-1 text-[11px] font-medium">{label}</legend>
                {fields.map((field) => (
                  <CopyField key={field.key} id={idFor(`${platform}-${field.key}`)} field={field}
                    initial={fieldValue(kit.copy, platform, field)} disabled={publishKit.saving}
                    onSave={(value) => publishKit.saveCopy({ [platform]: { [field.key]: value } })} />
                ))}
              </fieldset>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
