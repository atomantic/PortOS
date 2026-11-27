import usePendingFieldEdits from '../../hooks/usePendingFieldEdits.js';
import { useRef, useState } from 'react';
import { Copy, Sparkles } from 'lucide-react';
import useProviderModels from '../../hooks/useProviderModels.js';
import ProviderModelSelector from '../ProviderModelSelector.jsx';
import { copyToClipboard } from '../../lib/clipboard.js';
import PublishCard from './PublishCard.jsx';
import { formatCount, formatUsd } from '../../utils/formatters.js';

// What each platform's copy is made of; `max` shows a live count against the platform's own ceiling.
export const PUBLISH_FIELDS = [
  { platform: 'youtube', label: 'YouTube', fields: [
    { key: 'title', label: 'Title', max: 100 },
    { key: 'description', label: 'Description', multiline: true },
    { key: 'tags', label: 'Tags (comma-separated)', tags: true },
  ] },
  { platform: 'shorts', label: 'YouTube Shorts', fields: [{ key: 'title', label: 'Title', max: 100 }, { key: 'description', label: 'Description', multiline: true }] },
  { platform: 'x', label: 'X', fields: [{ key: 'hook', label: 'Hook post (no links)', max: 280, multiline: true }, { key: 'story', label: 'Story reply', multiline: true }] },
  { platform: 'linkedin', label: 'LinkedIn', fields: [{ key: 'post', label: 'Post (no links: they go in the first comment)', max: 3000, multiline: true }] },
  { platform: 'facebook', label: 'Facebook', fields: [{ key: 'post', label: 'Post (no links: they go in the first comment)', max: 63206, multiline: true }] },
  { platform: 'sunoHook', label: 'Suno Hook', fields: [{ key: 'caption', label: 'Caption', max: 300, multiline: true }] },
  { platform: 'tiktok', label: 'TikTok', fields: [{ key: 'caption', label: 'Caption', max: 2200, multiline: true }] },
  { platform: 'instagram', label: 'Instagram Reels', fields: [{ key: 'caption', label: 'Caption', max: 2200, multiline: true }] },
  { platform: 'reddit', label: 'Reddit', fields: [{ key: 'title', label: 'Title', max: 300 }, { key: 'body', label: 'Body (markdown)', multiline: true }] },
  { platform: 'stackerNews', label: 'Stacker News', fields: [{ key: 'title', label: 'Title', max: 80 }, { key: 'body', label: 'Body (markdown)', multiline: true }] },
  { platform: 'substack', label: 'Substack', fields: [{ key: 'title', label: 'Title', max: 100 }, { key: 'subtitle', label: 'Subtitle', max: 250 }, { key: 'body', label: 'Body (under the video)', multiline: true }] },
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

function CopyField({ id, field, platformLabel, initial, onSave }) {
  const draft = usePendingFieldEdits({ copy: initial });
  const value = draft.value('copy');
  const over = field.max && value.length > field.max;
  const commit = () => draft.commit('copy', text => onSave(field.tags ? text.split(',').map(tag => tag.trim()).filter(Boolean) : text));
  const Input = field.multiline ? 'textarea' : 'input';
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-[11px] text-port-text-muted">{field.label}</label>
        <div className="flex items-center gap-2">
          {field.max && <span className={`text-[10px] font-mono ${over ? 'text-port-error' : 'text-port-text-muted'}`}>{value.length}/{field.max}</span>}
          <button type="button" onClick={() => copyToClipboard(value, `${field.label} copied`)} disabled={!value}
            aria-label={`Copy ${field.label} for ${platformLabel}`} className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 text-port-text-muted disabled:opacity-40 min-h-[44px] sm:min-h-0 px-1"><Copy size={12} /></button>
        </div>
      </div>
      <Input id={id} value={value} rows={field.multiline ? 4 : undefined}
        onChange={(e) => draft.update('copy', e.target.value)} onBlur={commit}
        className="w-full bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs min-h-[44px] pointer-fine:sm:min-h-0" />
    </div>
  );
}

function copyIncludeRows(project, kit) {
  // Same filter as the server's timedLines: only cues with text and a start time reach the writer.
  const lyricLines = (project?.lyricCues || [])
    .filter((c) => typeof c?.text === 'string' && c.text.trim() && typeof c.startSec === 'number' && Number.isFinite(c.startSec)).length;
  const spend = projectSpend(project);
  return [
    { key: 'title', label: 'Song title', detail: project?.name ? `"${project.name}"` : 'no title yet', available: !!project?.name },
    { key: 'lyrics', label: 'Lyrics', detail: lyricLines ? `${formatCount(lyricLines)} timed line${lyricLines === 1 ? '' : 's'}` : 'no timed lyrics', available: lyricLines > 0 },
    { key: 'chapters', label: 'Chapters', detail: kit.chapters?.length ? `${formatCount(kit.chapters.length)} from the kit` : 'from the song sections', available: true },
    { key: 'spend', label: 'Generation spend', detail: spend > 0 ? formatUsd(spend) : 'none recorded', available: spend > 0 },
    { key: 'hashtags', label: 'Hashtags and YouTube tags', detail: 'none are added unless ticked', available: true },
  ];
}

function savedDraftFields(kit) {
  return {
    notes: kit.notes || '', youtube: kit.links?.youtube || '', song: kit.links?.song || '',
    length: kit.draftOptions?.length === 'full' ? 'full' : 'short',
    ...DEFAULT_INCLUDE, ...kit.draftOptions?.include,
  };
}

export default function PublishCopyCard({ project, publishKit, enabledTargets }) {
  const kit = project?.publishKit || {};
  const hasCopy = Object.values(kit.copy || {}).some((fields) => fields && Object.values(fields).some((v) => (Array.isArray(v) ? v.length : !!v)));
  // Copy only for where the director posts (#9287); Suno's caption reuses the YouTube description.
  // `null` = the saved choice is not known yet (loading, or the read failed): show no platform's
  // copy rather than every platform's or "none on". `undefined` (no publishing settings) shows all.
  const platformsUnknown = enabledTargets === null;
  const copyFields = Array.isArray(enabledTargets)
    ? PUBLISH_FIELDS.filter(({ platform }) => enabledTargets.includes(platform) || (platform === 'youtube' && enabledTargets.includes('suno')))
    : (platformsUnknown ? [] : PUBLISH_FIELDS);
  const noPlatforms = Array.isArray(enabledTargets) && copyFields.length === 0;
  const idFor = (s) => `mv-publish-${project?.id}-${s}`;
  const fields = usePendingFieldEdits(savedDraftFields(kit));
  const notes = fields.value('notes');
  const youtubeUrl = fields.value('youtube');
  const songUrl = fields.value('song');
  const length = fields.value('length');
  const [confirmReplace, setConfirmReplace] = useState(false);
  // Every field saves as it is edited (posts and notes on blur, choices on change);
  // the card says so, since there is no Save button to press.
  const [saveState, setSaveState] = useState(null);
  const saveSeq = useRef(0);
  const save = (patch) => {
    const seq = ++saveSeq.current;
    setSaveState('saving');
    // Only the newest save reports, so an earlier one landing late can't claim "saved" over it.
    return publishKit.saveCopy(patch).then(saved => {
      if (seq === saveSeq.current) setSaveState(saved ? 'saved' : 'failed');
      return saved;
    });
  };
  const badLink = (value) => !!value.trim() && !/^https?:\/\//.test(value.trim());
  const saveLink = (key, value) => {
    if (badLink(value)) return;
    fields.commit(key, text => save({ links: { [key]: text.trim() } }));
  };
  // Mirrors the server's copyEditedSinceDraft: a draft would replace posts written or edited by hand.
  const editedAt = Date.parse(kit.copyEditedAt || '');
  const draftedAt = Date.parse(kit.copyDraftedAt || '');
  const editedSinceDraft = Number.isFinite(editedAt) && (!Number.isFinite(draftedAt) || editedAt > draftedAt);
  const includeRows = copyIncludeRows(project, kit);
  const {
    providers, selectedProviderId, selectedModel, availableModels, setSelectedProviderId, setSelectedModel,
  } = useProviderModels({ allowDefault: true, silent: true });
  const links = {
    ...(/^https?:\/\//.test(youtubeUrl.trim()) ? { youtube: youtubeUrl.trim() } : {}),
    ...(/^https?:\/\//.test(songUrl.trim()) ? { song: songUrl.trim() } : {}),
  };
  const draft = (replaceEdited = false) => publishKit.draftCopy({
    ...(selectedProviderId ? { providerId: selectedProviderId } : {}),
    ...(selectedModel ? { model: selectedModel } : {}),
    notes, links,
    include: Object.fromEntries(includeRows.map(({ key, available }) => [key, available && fields.value(key)])),
    length,
    ...(replaceEdited ? { replaceEdited: true } : {}),
  });
  const onDraft = () => (editedSinceDraft ? setConfirmReplace(true) : draft());

  return (
    <PublishCard projectId={project?.id} cardId="copy" label="Release copy" icon={Sparkles}
      summary={hasCopy ? 'Drafted' : 'Not drafted yet'} defaultOpen={!hasCopy}>
      <p className="text-port-text-muted">Each post below is exactly what goes out. Write it yourself, or have the writer draft it from your notes, the links and only what you tick under Draft from. Nothing runs until you press Draft. Edits save on their own when you leave a field.</p>
      {saveState && (
        <p role="status" className={`text-[11px] ${saveState === 'failed' ? 'text-port-error' : 'text-port-text-muted'}`}>
          {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'All changes saved' : 'Last change did not save. Edit the field again to retry.'}
        </p>
      )}
      <div className="space-y-0.5">
        <label htmlFor={idFor('notes')} className="text-[11px] text-port-text-muted">Making-of notes (your story, in your words)</label>
        <textarea id={idFor('notes')} value={notes} maxLength={8000} rows={4} onChange={(e) => fields.update('notes', e.target.value)}
          onBlur={() => fields.commit('notes', value => save({ notes: value }))}
          className="w-full bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs" />
      </div>
      <div className="grid sm:grid-cols-2 gap-2">
        <div>
          <label htmlFor={idFor('youtube-url')} className="block text-[11px] text-port-text-muted">Full video URL (optional)</label>
          <input id={idFor('youtube-url')} value={youtubeUrl} onChange={(e) => fields.update('youtube', e.target.value)} onBlur={() => saveLink('youtube', youtubeUrl)} placeholder="https://…"
            className="w-full bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs min-h-[44px] pointer-fine:sm:min-h-0" />
          {badLink(youtubeUrl) && <p className="text-[11px] text-port-warning">Not saved: a link starts with https://</p>}
        </div>
        <div>
          <label htmlFor={idFor('song-url')} className="block text-[11px] text-port-text-muted">Song URL (optional)</label>
          <input id={idFor('song-url')} value={songUrl} onChange={(e) => fields.update('song', e.target.value)} onBlur={() => saveLink('song', songUrl)} placeholder="https://…"
            className="w-full bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs min-h-[44px] pointer-fine:sm:min-h-0" />
          {badLink(songUrl) && <p className="text-[11px] text-port-warning">Not saved: a link starts with https://</p>}
        </div>
      </div>
      <fieldset className="space-y-1 rounded border border-port-border p-2">
        <legend className="px-1 text-[11px] font-medium">Draft from (plus your notes and links)</legend>
        {includeRows.map(({ key, label, detail, available }) => (
          <label key={key} htmlFor={idFor(`include-${key}`)} className={`flex items-center gap-2 min-h-[44px] pointer-fine:sm:min-h-0 ${available ? '' : 'opacity-50'}`}>
            <input id={idFor(`include-${key}`)} type="checkbox" checked={available && fields.value(key)} disabled={!available || publishKit.drafting}
              onChange={(e) => {
                const checked = e.target.checked;
                fields.choose(key, checked, value => save({ draftOptions: { include: { [key]: value } } }));
              }} />
            <span>{label} <span className="text-port-text-muted">· {detail}</span></span>
          </label>
        ))}
      </fieldset>
      <fieldset className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <legend className="text-[11px] text-port-text-muted mb-0.5">Length</legend>
        {[['short', 'A sentence or two'], ['full', 'Full making-of']].map(([value, label]) => (
          <label key={value} htmlFor={idFor(`length-${value}`)} className="flex items-center gap-1.5 min-h-[44px] pointer-fine:sm:min-h-0">
            <input id={idFor(`length-${value}`)} type="radio" name={idFor('length')} value={value} checked={length === value}
              disabled={publishKit.drafting} onChange={() => fields.choose('length', value, next => save({ draftOptions: { length: next } }))} />
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
        <button type="button" onClick={onDraft} disabled={publishKit.drafting || publishKit.saving || platformsUnknown || noPlatforms || confirmReplace}
          className="flex items-center gap-1 bg-port-accent/20 text-port-accent disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] pointer-fine:sm:min-h-0">
          <Sparkles size={13} /> {publishKit.drafting ? 'Drafting…' : (kit.copy ? 'Redraft copy' : 'Draft copy')}
        </button>
      </div>
      {confirmReplace && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded border border-port-warning/50 bg-port-warning/10 p-2">
          <span className="flex-1 min-w-[12rem]">Drafting replaces the posts you wrote or edited below.</span>
          <button type="button" onClick={() => { setConfirmReplace(false); draft(true); }}
            className="bg-port-warning/20 text-port-warning rounded px-2 py-1.5 min-h-[44px] pointer-fine:sm:min-h-0">Replace them</button>
          <button type="button" onClick={() => setConfirmReplace(false)}
            className="text-port-text-muted px-2 py-1.5 min-h-[44px] pointer-fine:sm:min-h-0">Keep mine</button>
        </div>
      )}
      {noPlatforms && <p className="text-port-text-muted">Turn on a platform under Where you post to draft its copy.</p>}
      {!noPlatforms && !platformsUnknown && (
        <div className="space-y-3" key={kit.copyDraftedAt || 'copy'}>
          {copyFields.map(({ platform, label, fields }) => (
            <fieldset key={platform} className="space-y-1.5 rounded border border-port-border p-2">
              <legend className="px-1 text-[11px] font-medium">{label}</legend>
              {fields.map((field) => (
                <CopyField key={field.key} id={idFor(`${platform}-${field.key}`)} field={field} platformLabel={label}
                  initial={fieldValue(kit.copy, platform, field)}
                  onSave={(value) => save({ [platform]: { [field.key]: value } })} />
              ))}
            </fieldset>
          ))}
        </div>
      )}
    </PublishCard>
  );
}
