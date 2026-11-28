import { useCallback, useState } from 'react';
import { Link } from 'react-router';
import { ImagePlus, Images, ScanFace, Sparkles, Trash2 } from 'lucide-react';
import { generateImage } from '../../services/apiSystem.js';
import { addAvatarToLibrary, removeAvatarFromLibrary, saveAvatarChannels } from '../../services/apiVoiceAvatar';
import GalleryImagePicker from '../imageGen/GalleryImagePicker';
import MediaJobThumb from '../pipeline/MediaJobThumb';
import MediaImage from '../MediaImage';
import AutoSizeTextarea from '../ui/AutoSizeTextarea';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import toast from '../ui/Toast';
import portraitUrl from './call-portrait.webp';
import { avatarImageSrc, useAvatarLibrary } from './useAvatarLibrary';

const key = 'satphone-key inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border px-3 font-mono text-xs font-semibold uppercase tracking-wider disabled:opacity-45';
const LABEL_MAX = 24;
// Square renders: AvatarForcing animates a 512px square crop of the portrait.
const AVATAR_EDGE = 1024;

function AvatarThumb({ filename, alt, className = '' }) {
  return filename
    ? <MediaImage src={avatarImageSrc(filename)} thumbnail alt={alt} className={`object-cover ${className}`} />
    : <img src={portraitUrl} alt={alt} className={`object-cover ${className}`} />;
}

function ChannelRow({ index, channel, active, avatars, onSelect, onLabel, onAvatar }) {
  const [picking, setPicking] = useState(false);
  const [label, setLabel] = useState(channel.label);
  const [lastSaved, setLastSaved] = useState(channel.label);
  // Follow edits from other tabs without clobbering an unsaved local edit.
  if (channel.label !== lastSaved) {
    setLastSaved(channel.label);
    setLabel(channel.label);
  }
  const commitLabel = () => { if (label.trim() !== channel.label) onLabel(label.trim()); };
  const number = index + 1;
  const pick = (filename) => { setPicking(false); onAvatar(filename); };

  return (
    <li className="flex flex-col gap-2 rounded-xl border border-port-border bg-port-bg p-2">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={active}
          title={active ? `Channel ${number} is on air` : `Switch the handset to channel ${number}`}
          className={`${key} shrink-0 ${active ? 'text-port-accent-text border-port-accent' : ''}`}
          data-active={active ? 'true' : 'false'}
        >
          {`CH${number}`}
        </button>
        <button
          type="button"
          onClick={() => setPicking((open) => !open)}
          aria-expanded={picking}
          aria-label={`Choose the avatar for channel ${number}`}
          title="Choose this channel's avatar"
          className="relative size-11 shrink-0 overflow-hidden rounded-lg border border-port-border hover:border-port-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-port-accent"
        >
          <AvatarThumb filename={channel.avatar} alt="" className="size-full" />
        </button>
        <label htmlFor={`avatar-channel-label-${index}`} className="sr-only">{`Channel ${number} name`}</label>
        <input
          id={`avatar-channel-label-${index}`}
          type="text"
          value={label}
          maxLength={LABEL_MAX}
          placeholder={`Channel ${number}`}
          onChange={(event) => setLabel(event.target.value)}
          onBlur={commitLabel}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitLabel(); } }}
          className="min-h-11 min-w-0 flex-1 rounded-lg border border-port-border bg-port-card px-2.5 font-mono text-xs text-port-text placeholder:text-port-text-muted focus:border-port-accent focus:outline-none"
        />
      </div>
      {picking && (
        <div role="group" aria-label={`Avatars for channel ${number}`} className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">
          <button
            type="button"
            onClick={() => pick(null)}
            aria-label="Use the default portrait"
            aria-pressed={!channel.avatar}
            title="Use the default radio operator portrait"
            className={`relative aspect-square overflow-hidden rounded-lg border ${!channel.avatar ? 'border-port-accent ring-2 ring-port-accent' : 'border-port-border hover:border-port-accent'}`}
          >
            <AvatarThumb filename={null} alt="Default portrait" className="size-full" />
          </button>
          {avatars.map((avatar, position) => (
            <button
              key={avatar.filename}
              type="button"
              onClick={() => pick(avatar.filename)}
              aria-label={`Assign avatar ${position + 1}`}
              aria-pressed={channel.avatar === avatar.filename}
              title="Assign this avatar"
              className={`relative aspect-square overflow-hidden rounded-lg border ${channel.avatar === avatar.filename ? 'border-port-accent ring-2 ring-port-accent' : 'border-port-border hover:border-port-accent'}`}
            >
              <AvatarThumb filename={avatar.filename} alt="Avatar" className="size-full" />
            </button>
          ))}
        </div>
      )}
    </li>
  );
}

function AvatarCreator({ onCreated }) {
  const [prompt, setPrompt] = useState('');
  const [job, setJob] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const generate = async (event) => {
    event?.preventDefault();
    const text = prompt.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    // The prompt is sent exactly as written; the saved Image Gen backend and model render it.
    // `collectionName` files the render into Avatars even if this view closes first.
    const result = await generateImage({ prompt: text, width: AVATAR_EDGE, height: AVATAR_EDGE, collectionName: 'Avatars' })
      .catch(() => null);
    setSubmitting(false);
    if (!result) return;
    setPrompt((current) => (current === text ? '' : current));
    if (result.jobId) setJob({ jobId: result.jobId, filename: null });
    else if (result.filename) {
      setJob({ jobId: null, filename: result.filename });
      onCreated(result.filename);
    }
  };

  const filed = useCallback((filename) => { onCreated(filename); }, [onCreated]);

  return (
    <form onSubmit={generate} className="flex flex-col gap-2">
      <label htmlFor="avatar-create-prompt" className="font-mono text-[10px] uppercase tracking-[0.14em] text-port-text-muted">
        Create an avatar
      </label>
      <AutoSizeTextarea
        id="avatar-create-prompt"
        rows={2}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) generate(event); }}
        placeholder="Head-and-shoulders portrait facing the camera, neutral expression, soft studio light…"
        className="min-h-[60px] w-full rounded-xl border border-port-border bg-port-bg px-3 py-2 text-sm text-port-text placeholder:text-port-text-muted focus:border-port-accent focus:outline-none"
      />
      <p className="text-[11px] text-port-text-muted">
        Renders a square image with your saved <Link to="/media/image" className="underline hover:text-port-text">Image Gen</Link> settings.
        A centered, front-facing face animates best.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={!prompt.trim() || submitting} className={`${key} text-port-accent-text`}>
          <Sparkles size={13} aria-hidden="true" />
          {submitting ? 'Submitting…' : 'Generate avatar'}
        </button>
      </div>
      {job && (
        <div className="w-32">
          <MediaJobThumb
            jobId={job.jobId || job.filename}
            fallbackFilename={job.jobId ? null : job.filename}
            onFilename={job.jobId ? filed : null}
            size="fill"
            label="New avatar"
          />
        </div>
      )}
    </form>
  );
}

/**
 * Avatar library and channel assignments for the Voice Call station. Avatars live in the
 * shared Avatars media collection (they federate with it); channel assignments are this
 * install's own.
 */
export default function AvatarChannelsPanel() {
  const { data: library, error, updateData } = useAvatarLibrary();
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(null);
  const [removing, setRemoving] = useState(false);

  const saveChannels = useCallback((patch) => saveAvatarChannels(patch).then(updateData).catch(() => {}), [updateData]);
  const editChannel = (index, change) => saveChannels({
    channels: library.channels.map((channel, i) => (i === index ? { ...channel, ...change } : channel)),
  });
  const fileAvatar = useCallback((filename) => {
    addAvatarToLibrary(filename).then((next) => {
      updateData(next);
      toast.success('Avatar added');
    }).catch(() => {});
  }, [updateData]);
  const remove = async (filename) => {
    setRemoving(true);
    await removeAvatarFromLibrary(filename).then(updateData).catch(() => {});
    setRemoving(false);
    setConfirmRemove(null);
  };

  const avatars = library?.avatars ?? [];

  return (
    <section aria-labelledby="avatar-channels-heading" className="flex min-w-0 flex-col gap-3 rounded-2xl border border-port-border bg-port-card p-3.5 text-port-text sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <ScanFace size={15} aria-hidden="true" className="shrink-0 text-port-accent" />
          <h2 id="avatar-channels-heading" className="font-mono text-xs font-semibold uppercase tracking-[0.14em]">
            Avatars & channels
          </h2>
        </div>
        {library?.collectionId && (
          <Link to={`/media/collections/${library.collectionId}`} className="inline-flex items-center gap-1 text-xs text-port-text-muted hover:text-port-accent">
            <Images size={13} aria-hidden="true" />
            {library.collectionName} collection
          </Link>
        )}
      </div>

      {error && !library && (
        <p role="alert" className="text-sm text-port-error-text">Could not load avatars: {error.message || String(error)}</p>
      )}

      {library && (
        <>
          <ol aria-label="Transceiver channels" className="flex flex-col gap-2">
            {library.channels.map((channel, index) => (
              <ChannelRow
                key={index}
                index={index}
                channel={channel}
                active={library.active === index}
                avatars={avatars}
                onSelect={() => saveChannels({ active: index })}
                onLabel={(label) => editChannel(index, { label })}
                onAvatar={(avatar) => editChannel(index, { avatar })}
              />
            ))}
          </ol>

          <div className="flex flex-col gap-2 border-t border-port-border pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-mono text-[10px] uppercase tracking-[0.14em] text-port-text-muted">
                Avatars ({avatars.length})
              </h3>
              <button type="button" onClick={() => setGalleryOpen(true)} className={key}>
                <ImagePlus size={13} aria-hidden="true" />
                Add from gallery
              </button>
            </div>
            {avatars.length === 0 ? (
              <p className="text-xs text-port-text-muted">
                No avatars yet. Generate one below or add a gallery image. Avatars sync to your other PortOS machines with the collection.
              </p>
            ) : (
              <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 xl:grid-cols-6">
                {avatars.map((avatar) => (
                  <li key={avatar.filename} className="flex flex-col gap-1">
                    <div className="aspect-square overflow-hidden rounded-lg border border-port-border">
                      <AvatarThumb filename={avatar.filename} alt="Avatar" className="size-full" />
                    </div>
                    {confirmRemove === avatar.filename ? (
                      <ConfirmButtonPair
                        prompt="Remove?"
                        confirmText="Remove"
                        onConfirm={() => remove(avatar.filename)}
                        onCancel={() => setConfirmRemove(null)}
                        busy={removing}
                        responsiveTouchTargets
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmRemove(avatar.filename)}
                        aria-label="Remove avatar from the collection"
                        title="Remove from Avatars (the gallery image stays)"
                        className="inline-flex min-h-11 items-center justify-center rounded-lg border border-port-border text-port-text-muted hover:border-port-error hover:text-port-error-text"
                      >
                        <Trash2 size={13} aria-hidden="true" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="border-t border-port-border pt-3">
            <AvatarCreator onCreated={fileAvatar} />
          </div>
        </>
      )}

      <GalleryImagePicker
        open={galleryOpen}
        onClose={() => setGalleryOpen(false)}
        allowUpload
        onSelect={(item) => {
          setGalleryOpen(false);
          if (item?.filename) fileAvatar(item.filename);
        }}
      />
    </section>
  );
}
