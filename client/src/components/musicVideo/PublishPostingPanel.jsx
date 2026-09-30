import { useState } from 'react';
import { Send, ExternalLink, X as XIcon, LogIn } from 'lucide-react';

// Where the release goes, in posting order: the full video first so every
// other post can link to it.
export const PUBLISH_TARGETS = [
  { target: 'youtube', label: 'YouTube', note: 'The final render, with chapters, thumbnail and captions' },
  { target: 'suno', label: 'Suno', note: 'Publishes the song with the cover and a link to the video' },
  { target: 'x', label: 'X thread', note: 'Hook with the 1080p video, then the story, prompt and links' },
  { target: 'shorts', label: 'YouTube Shorts', note: 'The newest 9:16 social cut' },
  { target: 'tiktok', label: 'TikTok', note: 'The newest 9:16 social cut, labelled AI-generated' },
  { target: 'instagram', label: 'Instagram Reels', note: 'The newest 9:16 social cut, with the AI label' },
  { target: 'reddit', label: 'Reddit', note: 'A text or link post to one subreddit' },
  { target: 'stackerNews', label: 'Stacker News', note: 'A link post to the full video' },
];

const inputCls = 'w-full bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs min-h-[44px] sm:min-h-0';

const summaryRows = (summary) => Object.entries(summary || {})
  .filter(([, v]) => v != null && v !== '' && (typeof v !== 'object' || (Array.isArray(v) && v.every((x) => typeof x === 'string'))))
  .map(([k, v]) => [k, Array.isArray(v) ? v.join(' · ') : String(v)]);

function TargetOptions({ target, kit, options, setOption, flairs, idFor }) {
  const field = (key, label, input) => (
    <div key={key} className="space-y-0.5 min-w-0">
      <label htmlFor={idFor(key)} className="block text-[11px] text-port-text-muted">{label}</label>
      {input}
    </div>
  );
  const text = (key, label, placeholder) => field(key, label,
    <input id={idFor(key)} value={options[key] || ''} placeholder={placeholder} onChange={(e) => setOption(key, e.target.value)} className={inputCls} />);
  const area = (key, label) => field(key, label,
    <textarea id={idFor(key)} value={options[key] || ''} rows={3} onChange={(e) => setOption(key, e.target.value)} className={inputCls} />);

  if (target === 'reddit') {
    return (
      <div className="grid sm:grid-cols-2 gap-2">
        {text('subreddit', 'Subreddit', 'SunoAI')}
        {field('kind', 'Post type',
          <select id={idFor('kind')} aria-label="Post type" value={options.kind || 'self'} onChange={(e) => setOption('kind', e.target.value)} className={inputCls}>
            <option value="self">Text post</option>
            <option value="link">Link to the full video</option>
          </select>)}
        {flairs?.length > 0 && field('flairId', 'Flair',
          <select id={idFor('flairId')} aria-label="Flair" value={options.flairId || ''} onChange={(e) => setOption('flairId', e.target.value)} className={inputCls}>
            <option value="">No flair</option>
            {flairs.map((f) => <option key={f.id} value={f.id}>{f.text}</option>)}
          </select>)}
        <div className="sm:col-span-2">{area('firstComment', 'First comment (optional)')}</div>
      </div>
    );
  }
  if (target === 'stackerNews') {
    return <div className="grid sm:grid-cols-2 gap-2">{text('territory', 'Territory', 'art')}<div className="sm:col-span-2">{area('firstComment', 'First comment (optional)')}</div></div>;
  }
  if (target === 'suno') {
    return (
      <div className="grid sm:grid-cols-2 gap-2 items-end">
        {text('songUrl', 'Song URL (the take to publish)', kit.links?.song || 'https://suno.com/song/…')}
        <label className="flex items-center gap-1.5 text-xs min-h-[44px] sm:min-h-0">
          <input type="checkbox" checked={options.pin !== false} onChange={(e) => setOption('pin', e.target.checked)} /> Pin to profile
        </label>
      </div>
    );
  }
  if (target === 'x') {
    return (
      <div className="space-y-2">
        {area('prompt', 'Prompt reply (optional, e.g. the prompt that started it)')}
        {kit.thumbnails?.length > 0 && field('storyImage', 'Image on the story reply (optional)',
          <select id={idFor('storyImage')} aria-label="Image on the story reply" value={options.storyImage || ''} onChange={(e) => setOption('storyImage', e.target.value)} className={inputCls}>
            <option value="">None</option>
            {kit.thumbnails.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>)}
      </div>
    );
  }
  return null;
}

function TargetRow({ project, kit, entry, publishing }) {
  const { target, label, note } = entry;
  const idFor = (key) => `mv-post-${project.id}-${target}-${key}`;
  const [options, setOptions] = useState({});
  const setOption = (key, value) => setOptions((prev) => ({ ...prev, [key]: value }));
  const draft = publishing.drafts[target];
  const busy = publishing.busy[target];
  const error = publishing.errors[target];
  const posted = kit.posts?.[target];
  const flairs = draft?.summary?.flairs;
  const clean = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== '' && v != null));

  return (
    <li className="rounded border border-port-border p-2 space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-medium">{label}</div>
          <div className="text-[11px] text-port-text-muted">{note}</div>
          {posted?.url && (
            <a href={posted.url} target="_blank" rel="noreferrer" className="text-[11px] text-port-accent flex items-center gap-1 break-all">
              <ExternalLink size={11} /> Posted {posted.postedAt ? new Date(posted.postedAt).toLocaleDateString() : ''}: {posted.url}
            </a>
          )}
        </div>
        <button type="button" onClick={() => publishing.prepare(target, clean)} disabled={!!busy}
          className="flex items-center gap-1 bg-port-accent/20 text-port-accent disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0">
          {busy === 'prepare' ? 'Filling…' : (draft ? 'Fill again' : 'Fill draft')}
        </button>
      </div>
      <TargetOptions target={target} kit={kit} options={options} setOption={setOption} flairs={flairs} idFor={idFor} />
      {error && (
        <div role="alert" className="text-[11px] text-port-error space-y-0.5">
          <div className="flex items-center gap-1">{error.code === 'PUBLISH_LOGIN_REQUIRED' && <LogIn size={11} />}{error.message}</div>
          {error.url && <div className="text-port-text-muted break-all">Sign-in page: {error.url}</div>}
        </div>
      )}
      {draft && (
        <div className="space-y-2">
          {draft.screenshot && <img src={draft.screenshot} alt={`${label} draft as filled`} className="w-full rounded border border-port-border" />}
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px]">
            {summaryRows(draft.summary).map(([k, v]) => (
              <div key={k} className="contents"><dt className="text-port-text-muted">{k}</dt><dd className="min-w-0 break-words whitespace-pre-wrap">{v}</dd></div>
            ))}
          </dl>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => publishing.submit(target)} disabled={!!busy}
              className="flex items-center gap-1 bg-port-accent text-white disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0">
              <Send size={13} /> {busy === 'submit' ? 'Posting…' : `Post to ${label}`}
            </button>
            <button type="button" onClick={() => publishing.discard(target)} disabled={!!busy}
              className="flex items-center gap-1 border border-port-border disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0">
              <XIcon size={13} /> Discard
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * Posting (#9282): each platform's post is filled in the PortOS Browser (in
 * a new tab, with the director's signed-in sessions) and shown back here as
 * a screenshot and summary. Nothing is posted until the director presses
 * Post for that draft.
 */
export default function PublishPostingPanel({ project, publishing }) {
  const kit = project?.publishKit || {};
  if (!kit.builtAt) return null;
  return (
    <section aria-label="Post the release" className="rounded-lg border border-port-border bg-port-card p-3 space-y-2 text-xs">
      <h3 className="text-sm font-medium flex items-center gap-1.5"><Send size={14} /> Post the release</h3>
      <p className="text-port-text-muted">Sign in to each platform in the PortOS Browser first. Fill draft opens a new tab there and fills the post from the kit and copy above; nothing is posted until you review it and press Post.</p>
      <ul className="space-y-2">
        {PUBLISH_TARGETS.map((entry) => <TargetRow key={entry.target} project={project} kit={kit} entry={entry} publishing={publishing} />)}
      </ul>
    </section>
  );
}
