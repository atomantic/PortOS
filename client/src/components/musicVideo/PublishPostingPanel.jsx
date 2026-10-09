import { useEffect, useState } from 'react';
import ConfirmButtonPair from '../ui/ConfirmButtonPair.jsx';
import { safeReadJsonStorage, safeWriteJsonStorage } from '../../lib/safeStorage.js';
import { ExternalLink, X as XIcon, LogIn, Link as LinkIcon, Check, ChevronDown, ChevronRight, ImageOff, Undo2 } from 'lucide-react';
import PublishCard from './PublishCard.jsx';
import { DISTROKID_GENRES, suggestDistrokidGenres } from '../../../../server/lib/distrokidGenres.js';
import { publishRowAnchor } from '../../lib/musicVideoStages.js';

// Where the release goes, in posting order: the full video first so every
// other post can link to it.
export const PUBLISH_TARGETS = [
  { target: 'youtube', label: 'YouTube', note: 'The final render, with chapters, thumbnail and captions' },
  { target: 'suno', label: 'Suno', note: 'Publishes the song with the cover and a link to the video' },
  { target: 'sunoHook', label: 'Suno Hook', note: 'A 9:16 cut (the newest by default) set to its window of the song. You press Post' },
  { target: 'x', label: 'X thread', note: 'Hook with the 1080p video, then the story, prompt and links' },
  { target: 'shorts', label: 'YouTube Shorts', note: 'A 9:16 cut (the newest by default)' },
  { target: 'tiktok', label: 'TikTok', note: 'A 9:16 cut (the newest by default), labelled AI-generated' },
  { target: 'instagram', label: 'Instagram Reels', note: 'A 9:16 cut (the newest by default), with the AI label' },
  { target: 'reddit', label: 'Reddit', note: 'A native video post to r/aivideo (title and flair, no body)' },
  { target: 'stackerNews', label: 'Stacker News', note: 'A link post to the full video' },
  {
    target: 'substack', label: 'Substack', accountPlaceholder: 'name.substack.com',
    note: 'A post with the full video at the top, then your title, subtitle and body. Substack keeps it in Drafts; you choose who gets it and press Publish',
  },
  {
    // `accountPlaceholder` marks an account that is a name, not an @handle.
    target: 'distrokid', label: 'DistroKid', accountPlaceholder: 'Artist name',
    note: 'The song as a single to Spotify, Apple Music, YouTube Music and the other stores, with a square cover and the AI disclosure. You tick the agreements and press Upload',
    linkPlaceholder: 'Release or store link (optional): Mark done works without one',
  },
];

// The DistroKid answers the director gives once (songwriter legal name and
// role, language, Apple performer role), remembered on this device only. The
// store-profile answer is never remembered: new profiles are per first release.
const SONGWRITER_KEY = 'portos.musicVideo.distrokidSongwriter';
const DISTROKID_REMEMBERED = { songwriterFirst: 'first', songwriterLast: 'last', songwriterRole: 'role', language: 'language', performerRole: 'performerRole' };

const inputCls = 'w-full bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs min-h-[44px] sm:min-h-0';

const summaryRows = (summary) => Object.entries(summary || {})
  .filter(([, v]) => v != null && v !== '' && (typeof v !== 'object' || (Array.isArray(v) && v.every((x) => typeof x === 'string'))))
  .map(([k, v]) => [k, Array.isArray(v) ? v.join(' · ') : String(v)]);

const VERTICAL_TARGETS = ['shorts', 'tiktok', 'instagram'];
const fmtSec = (n) => `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`;

/**
 * Postable 9:16 cuts, oldest first (mirrors the server's list and pick in publish/payloads.js).
 * The server refuses any excerpt with a dependency change, which the record presents as a
 * dependencyState other than 'current' ('stale' or 'unknown').
 */
function verticalCutChoices(project) {
  const kit = project?.publishKit || {};
  const cuts = (project?.excerpts || [])
    .filter((e) => e?.status === 'complete' && e.aspect === '9:16' && e.filename)
    .map((e) => ({ id: e.id, layout: 'native', stale: e.dependencyState?.status !== 'current', label: `Social cut ${fmtSec(e.startSec ?? 0)}-${fmtSec(e.endSec ?? 0)}` }));
  const crop = (kit.exports || []).find((e) => e.kind === 'vertical-9x16' && e.filename);
  if (crop && (kit.master?.renderHistoryId ?? null) === (project?.renderHistoryId ?? null)) {
    const layout = crop.layout === 'native' ? 'native' : 'fit';
    cuts.unshift({ id: 'kit-vertical', layout, stale: false, fitReason: crop.fitReason, startSec: crop.startSec ?? 0, endSec: crop.endSec ?? 0,
      label: `Kit vertical (${layout}) ${fmtSec(crop.startSec ?? 0)}-${fmtSec(crop.endSec ?? 0)}` });
  }
  return cuts;
}

/** The cut a fill posts: the director's pick, else the newest fresh one. */
const postedCut = (cuts, cutId) => (cutId ? cuts.find((c) => c.id === cutId) : cuts.filter((c) => !c.stale).at(-1)) || null;

const FIT_REASONS = {
  changed: 'the composition changed after the final render',
  unavailable: 'the composition has no 9:16 layout, or its 9:16 render failed',
  footage: 'a footage edit has no 9:16 layout of its own',
};
const SEEKED_MODES = ['document', 'code', 'eidoverse'];

/**
 * A fitted cut (the 16:9 master over a blurred fill of itself) reads as a square on a phone
 * (#10860). Say so, and for a composition that can lay itself out at 9:16, offer a native render
 * of the same window: it becomes the newest cut, so the next fill posts it.
 */
function FittedCutNotice({ project, cut, excerpts }) {
  const canRender = SEEKED_MODES.includes(project?.composition?.mode) && excerpts?.startExcerpt;
  const failed = (project?.excerpts || []).filter((e) => e?.aspect === '9:16' && e.status === 'error' && e.error).at(-1);
  return (
    <div role="status" className="sm:col-span-2 rounded border border-port-warning/40 bg-port-warning/10 p-2 text-xs space-y-1.5">
      <p>
        This cut is fitted: the 16:9 frame over a blurred copy of itself, so it reads as a square on a phone
        {FIT_REASONS[cut.fitReason] ? ` (${FIT_REASONS[cut.fitReason]})` : ''}.
      </p>
      {canRender && (
        excerpts.rendering ? (
          <p className="text-port-text-muted">Rendering a native 9:16 cut… {Math.round(excerpts.progress || 0)}%</p>
        ) : (
          <button type="button" disabled={excerpts.occupied}
            onClick={() => excerpts.startExcerpt(cut.startSec, cut.endSec, { aspect: '9:16', fade: true })}
            className="border border-port-border disabled:opacity-50 rounded px-2 py-1.5 min-h-[44px] sm:min-h-0">
            Render a native 9:16 cut of {fmtSec(cut.startSec)}-{fmtSec(cut.endSec)}
          </button>
        )
      )}
      {canRender && !excerpts.rendering && failed && <p className="text-port-error break-words">The last 9:16 render failed: {failed.error}</p>}
    </div>
  );
}

/** The story reply's image, picked by sight: a tile per video frame plus "No image". */
function StoryImagePicker({ idFor, thumbnails, value, onChange }) {
  const tile = (selected) => `relative rounded overflow-hidden border-2 aspect-video min-h-[44px] ${selected ? 'border-port-accent ring-2 ring-port-accent/40' : 'border-port-border'}`;
  const mark = <span className="absolute top-1 right-1 rounded-full bg-port-accent text-white p-0.5" aria-hidden="true"><Check size={12} /></span>;
  return (
    <div className="space-y-0.5 min-w-0">
      <span id={idFor('storyImage')} className="block text-[11px] text-port-text-muted">Image on the story reply (optional)</span>
      <div role="radiogroup" aria-labelledby={idFor('storyImage')} className="grid grid-cols-3 sm:grid-cols-4 gap-2">
        <button type="button" role="radio" aria-checked={!value} onClick={() => onChange('')}
          className={`${tile(!value)} flex items-center justify-center gap-1 bg-port-bg text-xs text-port-text-muted`}>
          <ImageOff size={14} aria-hidden="true" /> No image
          {!value && mark}
        </button>
        {thumbnails.map((name, i) => (
          <button key={name} type="button" role="radio" aria-checked={value === name} aria-label={`Video frame ${i + 1}`} title={name}
            onClick={() => onChange(name)} className={tile(value === name)}>
            <img src={`/data/video-thumbnails/${encodeURIComponent(name)}`} alt="" loading="lazy" className="w-full h-full object-cover" />
            {value === name && mark}
          </button>
        ))}
      </div>
    </div>
  );
}

function TargetOptions({ target, kit, project, options, setOption, flairs, idFor, account, excerpts }) {
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

  const cuts = verticalCutChoices(project);
  const cut = postedCut(cuts, options.cutId);
  const fitted = cut?.layout === 'fit' ? <FittedCutNotice key="fitted" project={project} cut={cut} excerpts={excerpts} /> : null;
  const cutPicker = () => {
    if (cuts.length < 2) return null;
    return field('cutId', 'Vertical cut to post', (
      <select id={idFor('cutId')} aria-label="Vertical cut to post" value={options.cutId || ''} onChange={(e) => setOption('cutId', e.target.value)} className={inputCls}>
        <option value="">Newest fresh cut (default)</option>
        {[...cuts].reverse().map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
      </select>));
  };
  if (VERTICAL_TARGETS.includes(target)) return <div className="grid sm:grid-cols-2 gap-2 items-end">{cutPicker()}{fitted}</div>;
  if (target === 'sunoHook') {
    return (
      <div className="grid sm:grid-cols-2 gap-2 items-end">
        {text('songUrl', 'Song URL (the take the Hook plays)', kit.links?.song || 'https://suno.com/song/…')}
        {cutPicker()}
        <label className="flex items-center gap-1.5 text-xs min-h-[44px] sm:min-h-0">
          <input type="checkbox" checked={options.showLyrics === true} onChange={(e) => setOption('showLyrics', e.target.checked)} /> Show Suno's lyrics (off when the cut has its own)
        </label>
        {fitted}
      </div>
    );
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
  if (target === 'substack') {
    return text('publication', 'Publication', account || 'name.substack.com');
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
    const instrumental = options.instrumental ?? !hasLyrics;
    const suggested = suggestDistrokidGenres(project);
    const fullName = [options.songwriterFirst, options.songwriterLast].map((v) => v?.trim()).filter(Boolean).join(' ') || 'Songwriter legal name';
    const genreSelect = (key, label, suggestion, noneLabel) => field(key, label,
      <select id={idFor(key)} aria-label={label} value={options[key] || ''} onChange={(e) => setOption(key, e.target.value)} className={inputCls}>
        <option value="">{suggestion ? `${suggestion} (from the song's style)` : noneLabel}</option>
        {DISTROKID_GENRES.map((g) => <option key={g} value={g}>{g}</option>)}
      </select>);
    return (
      <div className="space-y-2">
        <div className="grid sm:grid-cols-2 gap-2">
          {text('artistName', 'Artist name', account || 'Your artist name')}
          {field('releaseDate', 'Release date (blank = as soon as possible)',
            <input id={idFor('releaseDate')} type="date" aria-label="Release date" value={options.releaseDate || ''} onChange={(e) => setOption('releaseDate', e.target.value)} className={inputCls} />)}
          {text('songwriterFirst', 'Songwriter legal first name', 'First')}
          {text('songwriterLast', 'Songwriter legal last name', 'Last')}
          {field('songwriterRole', 'Songwriter wrote',
            <select id={idFor('songwriterRole')} aria-label="Songwriter wrote" value={options.songwriterRole || (instrumental ? 'music' : 'both')} onChange={(e) => setOption('songwriterRole', e.target.value)} className={inputCls}>
              <option value="both">Music and lyrics</option>
              <option value="music">Music</option>
              <option value="lyrics">Lyrics</option>
            </select>)}
          {text('language', 'Language', 'English')}
          {genreSelect('genre', 'Genre', suggested.primary, 'Pick a genre')}
          {genreSelect('secondaryGenre', 'Secondary genre (optional)', suggested.secondary, 'None')}
        </div>
        <div className="flex flex-wrap gap-x-4">
          {check('explicit', 'Explicit lyrics', false)}
          {check('instrumental', 'Instrumental', !hasLyrics)}
          {check('newArtistProfile', 'First release as this artist (new store profiles)', false)}
        </div>
        <div role="group" aria-label="Apple Music credits" className="grid sm:grid-cols-3 gap-2">
          {text('performerName', 'Apple performer (real name)', fullName)}
          {text('performerRole', 'Performer role (optional)', 'e.g. Vocals')}
          {text('producerName', 'Apple producer (real name)', fullName)}
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
        {kit.thumbnails?.length > 0 && <StoryImagePicker idFor={idFor} thumbnails={kit.thumbnails} value={options.storyImage || ''} onChange={(name) => setOption('storyImage', name)} />}
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

/**
 * Record a post made outside PortOS, so its reception can be tracked too, or
 * mark the platform done without a link (a DistroKid upload has none until the
 * stores go live).
 */
function ManualLink({ idFor, label, placeholder, onSave, hideMarkDone = false }) {
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
      {!hideMarkDone && (
        <button type="button" aria-label={`Mark ${label} done`} onClick={() => onSave({ posted: true })}
          className="flex items-center gap-1 border border-port-border rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0">
          <Check size={12} /> Mark done
        </button>
      )}
    </div>
  );
}

/** Undo a platform's done mark: drops PortOS's record (link, rating, notes), never the post. Behind a confirm. */
function UndoDone({ label, onUndo }) {
  const [confirm, setConfirm] = useState(false);
  return confirm ? (
    <ConfirmButtonPair
      prompt={`Remove PortOS's record of the ${label} post (its link, rating and notes)? The post itself stays up.`}
      confirmText="Not done"
      ariaLabel={`Confirm marking ${label} not done`}
      confirmAriaLabel={`Confirm marking ${label} not done`}
      largeTouchTargets
      onConfirm={() => { setConfirm(false); onUndo(); }}
      onCancel={() => setConfirm(false)}
    />
  ) : (
    <button type="button" onClick={() => setConfirm(true)}
      className="flex items-center gap-1 border border-port-border rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0">
      <Undo2 size={12} /> Not done…
    </button>
  );
}

const STATUS = { posted: ['Done', 'text-port-success border-port-success/40'], draft: ['Draft open', 'text-port-warning border-port-warning/40'], none: ['To do', 'text-port-text-muted border-port-border'] };

function TargetRow({ project, kit, entry, publishing, excerpts }) {
  const { target, label, note, linkPlaceholder } = entry;
  const idFor = (key) => `mv-post-${project.id}-${target}-${key}`;
  const [options, setOptions] = useState(() => {
    // Prefill Suno URL from autonomous run if available
    if ((target === 'suno' || target === 'sunoHook') && project?.autonomousRun?.output?.sunoSongIds?.length > 0) {
      const songId = project.autonomousRun.output.sunoSongIds[0];
      return { songUrl: `https://suno.com/song/${encodeURIComponent(songId)}` };
    }
    if (target === 'distrokid') {
      const saved = safeReadJsonStorage(SONGWRITER_KEY, {}) || {};
      const remembered = Object.fromEntries(Object.entries(DISTROKID_REMEMBERED).filter(([, k]) => saved[k] != null && saved[k] !== '').map(([opt, k]) => [opt, saved[k]]));
      // A song whose lyrics an LLM wrote in the autonomous run discloses AI lyrics by default.
      return { songwriterFirst: '', songwriterLast: '', ...remembered, aiLyrics: !!project?.autonomousRun?.output?.lyrics };
    }
    return {};
  });
  const setOption = (key, value) => setOptions((prev) => ({ ...prev, [key]: value }));
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmAgain, setConfirmAgain] = useState(false);
  const draft = publishing.drafts[target];
  // A Suno share link the draft followed: show the song page it opened instead.
  const draftSongUrl = draft?.songUrl;
  useEffect(() => {
    if (!draftSongUrl) return;
    setOptions((prev) => (prev.songUrl && prev.songUrl !== draftSongUrl ? { ...prev, songUrl: draftSongUrl } : prev));
  }, [draftSongUrl]);
  // A done platform folds to its header so the ones still to do are easy to reach.
  const [open, setOpen] = useState(() => !kit.posts?.[target]);
  const busy = publishing.busy[target];
  const error = publishing.errors[target];
  const posted = kit.posts?.[target];
  const flairs = draft?.summary?.flairs;
  const account = publishing.platforms?.[target]?.account;
  const status = posted ? 'posted' : draft ? 'draft' : 'none';
  const Chevron = open ? ChevronDown : ChevronRight;
  const clean = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== '' && v != null));
  const fill = (extra) => {
    if (target === 'distrokid' && clean.songwriterFirst && clean.songwriterLast) {
      safeWriteJsonStorage(SONGWRITER_KEY, Object.fromEntries(Object.entries(DISTROKID_REMEMBERED).filter(([opt]) => clean[opt] != null).map(([opt, k]) => [k, clean[opt]])));
    }
    publishing.prepare(target, { ...clean, ...extra });
  };

  return (
    <li id={publishRowAnchor(target)} data-fold className="rounded border border-port-border p-2 space-y-2 scroll-mt-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h4 className="text-xs font-medium">
            <button type="button" data-fold-toggle aria-expanded={open} aria-controls={open ? idFor('body') : undefined} onClick={() => setOpen(!open)}
              className="flex items-center gap-1 min-h-[44px] sm:min-h-0">
              <Chevron size={13} className="shrink-0" />
              <span>{label}{account && <span className="font-normal text-port-text-muted"> as {entry.accountPlaceholder ? '' : '@'}{account}</span>}</span>
              <span className={`ml-1 shrink-0 rounded border px-1 text-[10px] font-normal ${STATUS[status][1]}`}>{STATUS[status][0]}</span>
            </button>
          </h4>
          {open && <div className="text-[11px] text-port-text-muted">{note}</div>}
          {posted?.url && (
            <a href={posted.url} target="_blank" rel="noreferrer" className="text-[11px] text-port-accent flex items-center gap-1 break-all">
              <ExternalLink size={11} /> Posted {posted.postedAt ? new Date(posted.postedAt).toLocaleDateString() : ''}: {posted.url}
            </a>
          )}
          {posted && !posted.url && (
            <div className="text-[11px] text-port-text-muted flex items-center gap-1"><Check size={11} /> Marked done {posted.postedAt ? new Date(posted.postedAt).toLocaleDateString() : ''}</div>
          )}
        </div>
        {/* Already posted: a second draft would repeat the post, so it takes a confirm (and the server refuses without `again`). */}
        {!open ? null : posted && !draft ? (
          confirmAgain ? (
            <ConfirmButtonPair
              prompt={`Already posted to ${label}. Fill another draft?`}
              confirmText="Post again"
              ariaLabel={`Confirm posting to ${label} again`}
              confirmAriaLabel={`Confirm posting to ${label} again`}
              largeTouchTargets
              busy={!!busy}
              onConfirm={() => { setConfirmAgain(false); fill({ again: true }); }}
              onCancel={() => setConfirmAgain(false)}
            />
          ) : (
            <button type="button" onClick={() => setConfirmAgain(true)} disabled={!!busy}
              className="flex items-center gap-1 border border-port-border disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0">
              {busy === 'prepare' ? 'Filling…' : 'Post again…'}
            </button>
          )
        ) : (
          <button type="button" onClick={() => fill(posted ? { again: true } : {})} disabled={!!busy}
            className="flex items-center gap-1 bg-port-accent/20 text-port-accent disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0">
            {busy === 'prepare' ? 'Filling…' : (draft ? 'Fill again' : 'Fill draft')}
          </button>
        )}
      </div>
      {open && <div id={idFor('body')} className="space-y-2">
      {posted
        ? (
          <>
            <PostFeedback key={posted.url || 'post'} idFor={idFor} label={label} post={posted} onSave={(body) => publishing.recordPost(target, body)} />
            {!posted.url && <ManualLink idFor={idFor} label={label} placeholder={linkPlaceholder} onSave={(body) => publishing.recordPost(target, body)} hideMarkDone />}
            <UndoDone label={label} onUndo={() => publishing.removePost?.(target)} />
          </>
        )
        : <ManualLink idFor={idFor} label={label} placeholder={linkPlaceholder} onSave={(body) => publishing.recordPost(target, body)} />}
      <TargetOptions target={target} kit={kit} project={project} options={options} setOption={setOption} flairs={flairs} idFor={idFor} account={account} excerpts={excerpts} />
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
      </div>}
    </li>
  );
}

/**
 * Posting (#9282): each platform's post is filled in the PortOS Browser (in
 * a new tab, with the director's signed-in sessions) and shown back here as
 * a screenshot and summary. Publication is performed manually on the platform.
 */
export default function PublishPostingPanel({ project, publishing, excerpts = null }) {
  const kit = project?.publishKit || {};
  if (!kit.builtAt) return null;
  // Only the platforms the director turned on (#9287), in posting order.
  const targets = PUBLISH_TARGETS.filter((entry) => publishing.enabledTargets?.includes(entry.target));
  const done = targets.filter(({ target }) => kit.posts?.[target]).length;
  return (
    <PublishCard projectId={project.id} cardId="posting" label="Publish manually" icon={ExternalLink}
      summary={targets.length ? `${done} of ${targets.length} done` : ''} defaultOpen={!targets.length || done < targets.length}>
      <p className="text-port-text-muted">Sign in to each platform in the PortOS Browser first. Fill draft opens a new tab there and fills the post from the kit and copy above; review and publish yourself on the platform. PortOS cannot submit posts.</p>
      {!targets.length && <p className="text-port-text-muted">Turn on the platforms you use under Where you post to prepare drafts. Final publication happens on each platform.</p>}
      <ul className="space-y-2">
        {targets.map((entry) => <TargetRow key={`${project.id}-${entry.target}`} project={project} kit={kit} entry={entry} publishing={publishing} excerpts={excerpts} />)}
      </ul>
    </PublishCard>
  );
}
