import { useState } from 'react';
import ConfirmButtonPair from '../ui/ConfirmButtonPair.jsx';
import { safeReadJsonStorage, safeWriteJsonStorage } from '../../lib/safeStorage.js';
import { ExternalLink, X as XIcon, LogIn, Link as LinkIcon } from 'lucide-react';

// Where the release goes, in posting order: the full video first so every
// other post can link to it.
export const PUBLISH_TARGETS = [
  { target: 'youtube', label: 'YouTube', note: 'The final render, with chapters, thumbnail and captions' },
  { target: 'suno', label: 'Suno', note: 'Publishes the song with the cover and a link to the video' },
  { target: 'x', label: 'X thread', note: 'Hook with the 1080p video, then the story, prompt and links' },
  { target: 'shorts', label: 'YouTube Shorts', note: 'A 9:16 cut (the newest by default)' },
  { target: 'tiktok', label: 'TikTok', note: 'A 9:16 cut (the newest by default), labelled AI-generated' },
  { target: 'instagram', label: 'Instagram Reels', note: 'A 9:16 cut (the newest by default), with the AI label' },
  { target: 'reddit', label: 'Reddit', note: 'A native video post to r/aivideo (title and flair, no body)' },
  { target: 'stackerNews', label: 'Stacker News', note: 'A link post to the full video' },
  {
    // `accountPlaceholder` marks an account that is a name, not an @handle.
    target: 'distrokid', label: 'Spotify (via DistroKid)', accountPlaceholder: 'Artist name',
    note: 'The song as a single for Spotify and other stores, with a square cover and the AI disclosure. You tick the agreements and press Upload',
    linkPlaceholder: 'Live on Spotify? Paste the Spotify link',
  },
];

// The songwriter's legal name DistroKid asks for, remembered on this device only.
const SONGWRITER_KEY = 'portos.musicVideo.distrokidSongwriter';

const inputCls = 'w-full bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs min-h-[44px] sm:min-h-0';

const summaryRows = (summary) => Object.entries(summary || {})
  .filter(([, v]) => v != null && v !== '' && (typeof v !== 'object' || (Array.isArray(v) && v.every((x) => typeof x === 'string'))))
  .map(([k, v]) => [k, Array.isArray(v) ? v.join(' · ') : String(v)]);

const VERTICAL_TARGETS = ['shorts', 'tiktok', 'instagram'];
const fmtSec = (n) => `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`;

/** Postable 9:16 cuts, oldest first (mirrors the server's pick; it still refuses a stale one). */
function verticalCutChoices(project) {
  const kit = project?.publishKit || {};
  const cuts = (project?.excerpts || [])
    .filter((e) => e?.status === 'complete' && e.aspect === '9:16' && e.filename)
    .map((e) => ({ id: e.id, label: `Social cut ${fmtSec(e.startSec ?? 0)}-${fmtSec(e.endSec ?? 0)}` }));
  const crop = (kit.exports || []).find((e) => e.kind === 'vertical-9x16' && e.filename);
  if (crop && (kit.master?.renderHistoryId ?? null) === (project?.renderHistoryId ?? null)) {
    cuts.unshift({ id: 'kit-vertical', label: `Kit center-crop ${fmtSec(crop.startSec ?? 0)}-${fmtSec(crop.endSec ?? 0)}` });
  }
  return cuts;
}

function TargetOptions({ target, kit, project, options, setOption, flairs, idFor, account }) {
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

  if (VERTICAL_TARGETS.includes(target)) {
    const cuts = verticalCutChoices(project);
    if (cuts.length < 2) return null;
    return field('cutId', 'Vertical cut to post', (
      <select id={idFor('cutId')} aria-label="Vertical cut to post" value={options.cutId || ''} onChange={(e) => setOption('cutId', e.target.value)} className={inputCls}>
        <option value="">Newest fresh cut (default)</option>
        {[...cuts].reverse().map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
      </select>));
  }
  if (target === 'reddit') {
    return (
      <div className="grid sm:grid-cols-2 gap-2">
        {text('subreddit', 'Subreddit', 'aivideo')}
        {field('kind', 'Post type',
          <select id={idFor('kind')} aria-label="Post type" value={options.kind || 'video'} onChange={(e) => setOption('kind', e.target.value)} className={inputCls}>
            <option value="video">Video upload</option>
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
    // Prefill from kit links or run output if available
    const defaultSongUrl = kit.links?.song || (options.songUrl ? null : 'https://suno.com/song/…');
    return (
      <div className="grid sm:grid-cols-2 gap-2 items-end">
        {text('songUrl', 'Song URL (the take to publish)', defaultSongUrl)}
        <label className="flex items-center gap-1.5 text-xs min-h-[44px] sm:min-h-0">
          <input type="checkbox" checked={options.pin !== false} onChange={(e) => setOption('pin', e.target.checked)} /> Pin to profile
        </label>
      </div>
    );
  }
  if (target === 'distrokid') {
    const check = (key, label, fallback) => (
      <label key={key} className="flex items-center gap-1.5 text-xs min-h-[44px] sm:min-h-0">
        <input type="checkbox" checked={options[key] ?? fallback} onChange={(e) => setOption(key, e.target.checked)} /> {label}
      </label>
    );
    const hasLyrics = (project?.lyricCues || []).some((cue) => cue?.text?.trim());
    return (
      <div className="space-y-2">
        <div className="grid sm:grid-cols-2 gap-2">
          {text('artistName', 'Artist name', account || 'Your artist name')}
          {field('releaseDate', 'Release date (blank = as soon as possible)',
            <input id={idFor('releaseDate')} type="date" aria-label="Release date" value={options.releaseDate || ''} onChange={(e) => setOption('releaseDate', e.target.value)} className={inputCls} />)}
          {text('songwriterFirst', 'Songwriter legal first name', 'First')}
          {text('songwriterLast', 'Songwriter legal last name', 'Last')}
        </div>
        <div className="flex flex-wrap gap-x-4">
          {check('explicit', 'Explicit lyrics', false)}
          {check('instrumental', 'Instrumental', !hasLyrics)}
        </div>
        <div role="group" aria-label="Parts made with AI" className="flex flex-wrap gap-x-4">
          <span className="text-[11px] text-port-text-muted self-center">Made with AI:</span>
          {check('aiMusic', 'Music', true)}
          {check('aiVocals', 'All of the audio', true)}
          {check('aiLyrics', 'Lyrics', false)}
        </div>
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

const RECEPTIONS = [['good', 'Good'], ['mixed', 'Mixed'], ['poor', 'Poor']];

/** How a post landed: the director's rating and notes, which feed later copy drafts (#9287). */
function PostFeedback({ idFor, label, post, onSave }) {
  const [notes, setNotes] = useState(post.notes || '');
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={`How the ${label} post was received`}>
        <span className="text-[11px] text-port-text-muted">Reception</span>
        {RECEPTIONS.map(([value, text]) => (
          <button key={value} type="button" aria-pressed={post.reception === value}
            onClick={() => onSave({ reception: post.reception === value ? null : value })}
            className={`rounded border px-2 py-1 text-[11px] min-h-[44px] sm:min-h-0 ${post.reception === value ? 'border-port-accent text-port-accent bg-port-accent/10' : 'border-port-border'}`}>
            {text}
          </button>
        ))}
      </div>
      <textarea id={idFor('notes')} aria-label={`Notes on the ${label} post`} value={notes} rows={2} maxLength={2000}
        placeholder="What worked or didn't (feeds the next copy draft)"
        onChange={(e) => setNotes(e.target.value)}
        onBlur={() => { if (notes.trim() !== (post.notes || '')) onSave({ notes: notes.trim() || null }); }}
        className={inputCls} />
    </div>
  );
}

/** Record a post made outside PortOS, so its reception can be tracked too. */
function ManualLink({ idFor, label, placeholder, onSave }) {
  const [url, setUrl] = useState('');
  const valid = /^https?:\/\/\S+$/.test(url.trim());
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input id={idFor('manual-url')} aria-label={`Link to a ${label} post made by hand`} value={url} placeholder={placeholder || 'Posted by hand? Paste the link'}
        onChange={(e) => setUrl(e.target.value)} className={`${inputCls} flex-1 min-w-0`} />
      <button type="button" disabled={!valid} onClick={() => onSave({ url: url.trim() }).then((post) => { if (post) setUrl(''); })}
        className="flex items-center gap-1 border border-port-border disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0">
        <LinkIcon size={12} /> Record
      </button>
    </div>
  );
}

function TargetRow({ project, kit, entry, publishing }) {
  const { target, label, note, linkPlaceholder } = entry;
  const idFor = (key) => `mv-post-${project.id}-${target}-${key}`;
  const [options, setOptions] = useState(() => {
    // Prefill Suno URL from autonomous run if available
    if (target === 'suno' && project?.autonomousRun?.output?.sunoSongIds?.length > 0) {
      const songId = project.autonomousRun.output.sunoSongIds[0];
      return { songUrl: `https://suno.com/song/${encodeURIComponent(songId)}` };
    }
    if (target === 'distrokid') {
      const saved = safeReadJsonStorage(SONGWRITER_KEY, {}) || {};
      // A song whose lyrics an LLM wrote in the autonomous run discloses AI lyrics by default.
      return { songwriterFirst: saved.first || '', songwriterLast: saved.last || '', aiLyrics: !!project?.autonomousRun?.output?.lyrics };
    }
    return {};
  });
  const setOption = (key, value) => setOptions((prev) => ({ ...prev, [key]: value }));
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const draft = publishing.drafts[target];
  const busy = publishing.busy[target];
  const error = publishing.errors[target];
  const posted = kit.posts?.[target];
  const flairs = draft?.summary?.flairs;
  const account = publishing.platforms?.[target]?.account;
  const clean = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== '' && v != null));

  return (
    <li className="rounded border border-port-border p-2 space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-medium">{label}{account && <span className="font-normal text-port-text-muted"> as {entry.accountPlaceholder ? '' : '@'}{account}</span>}</div>
          <div className="text-[11px] text-port-text-muted">{note}</div>
          {posted?.url && (
            <a href={posted.url} target="_blank" rel="noreferrer" className="text-[11px] text-port-accent flex items-center gap-1 break-all">
              <ExternalLink size={11} /> Posted {posted.postedAt ? new Date(posted.postedAt).toLocaleDateString() : ''}: {posted.url}
            </a>
          )}
        </div>
        <button type="button" onClick={() => {
          if (target === 'distrokid' && clean.songwriterFirst && clean.songwriterLast) safeWriteJsonStorage(SONGWRITER_KEY, { first: clean.songwriterFirst, last: clean.songwriterLast });
          publishing.prepare(target, clean);
        }} disabled={!!busy}
          className="flex items-center gap-1 bg-port-accent/20 text-port-accent disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0">
          {busy === 'prepare' ? 'Filling…' : (draft ? 'Fill again' : 'Fill draft')}
        </button>
      </div>
      {posted
        ? <PostFeedback key={posted.url || 'post'} idFor={idFor} label={label} post={posted} onSave={(body) => publishing.recordPost(target, body)} />
        : <ManualLink idFor={idFor} label={label} placeholder={linkPlaceholder} onSave={(body) => publishing.recordPost(target, body)} />}
      <TargetOptions target={target} kit={kit} project={project} options={options} setOption={setOption} flairs={flairs} idFor={idFor} account={account} />
      {error && (
        <div role="alert" className="text-[11px] text-port-error space-y-0.5">
          <div className="flex items-center gap-1">{error.code === 'PUBLISH_LOGIN_REQUIRED' && <LogIn size={11} />}{error.message}</div>
          {error.url && <div className="text-port-text-muted break-all">Sign-in page: {error.url}</div>}
        </div>
      )}
      {draft && (
        <div className="space-y-2">
          {draft.state === 'closed' && <p role="status" className="text-[11px] text-port-warning">Tab closed — Fill again</p>}
          {draft.state !== 'closed' && draft.screenshot && <img src={draft.screenshot} alt={`${label} draft as filled`} className="w-full rounded border border-port-border" />}
          {draft.state !== 'closed' && <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px]">
            {summaryRows(draft.summary).map(([k, v]) => (
              <div key={k} className="contents"><dt className="text-port-text-muted">{k}</dt><dd className="min-w-0 break-words whitespace-pre-wrap">{v}</dd></div>
            ))}
          </dl>}
          {confirmDiscard ? (
            <ConfirmButtonPair
              prompt="Discard this draft?"
              confirmText="Discard"
              ariaLabel={`Confirm discard ${label} draft`}
              confirmAriaLabel={`Confirm discard ${label} draft`}
              largeTouchTargets
              busy={!!busy}
              onConfirm={() => { setConfirmDiscard(false); publishing.discard(target); }}
              onCancel={() => setConfirmDiscard(false)}
            />
          ) : (
            <button type="button" onClick={() => setConfirmDiscard(true)} disabled={!!busy}
              className="flex items-center gap-1 border border-port-border disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0">
              <XIcon size={13} /> Discard
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Posting (#9282): each platform's post is filled in the PortOS Browser (in
 * a new tab, with the director's signed-in sessions) and shown back here as
 * a screenshot and summary. Publication is performed manually on the platform.
 */
export default function PublishPostingPanel({ project, publishing }) {
  const kit = project?.publishKit || {};
  if (!kit.builtAt) return null;
  // Only the platforms the director turned on (#9287), in posting order.
  const targets = PUBLISH_TARGETS.filter((entry) => publishing.enabledTargets?.includes(entry.target));
  return (
    <section aria-label="Post the release" className="rounded-lg border border-port-border bg-port-card p-3 space-y-2 text-xs">
      <h3 className="text-sm font-medium flex items-center gap-1.5"><ExternalLink size={14} /> Publish manually</h3>
      <p className="text-port-text-muted">Sign in to each platform in the PortOS Browser first. Fill draft opens a new tab there and fills the post from the kit and copy above; review and publish yourself on the platform. PortOS cannot submit posts.</p>
      {!targets.length && <p className="text-port-text-muted">Turn on the platforms you use under Where you post to prepare drafts. Final publication happens on each platform.</p>}
      <ul className="space-y-2">
        {targets.map((entry) => <TargetRow key={`${project.id}-${entry.target}`} project={project} kit={kit} entry={entry} publishing={publishing} />)}
      </ul>
    </section>
  );
}
