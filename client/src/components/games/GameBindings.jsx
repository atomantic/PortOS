import { useMemo, useState } from 'react';
import { Music2, PersonStanding, Plus, Unlink } from 'lucide-react';

const selectClass = 'w-full min-h-[44px] rounded-lg border border-port-border bg-port-bg px-3 py-2 text-sm text-white';
const actionClass = 'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-port-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50';

function BindingSection({
  title,
  icon: Icon,
  emptyText,
  available,
  value,
  onValueChange,
  onAdd,
  addLabel,
  disabled,
  children,
}) {
  const selectId = `game-${title.toLowerCase().replace(/\s+/g, '-')}-picker`;
  return (
    <section className="rounded-xl border border-port-border bg-port-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <Icon className="h-5 w-5 text-port-accent" aria-hidden="true" />
        <h2 className="font-semibold text-white">{title}</h2>
      </div>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <div className="min-w-0 flex-1">
          <label htmlFor={selectId} className="mb-1 block text-xs text-gray-400">
            {addLabel}
          </label>
          <select
            id={selectId}
            value={value}
            onChange={(event) => onValueChange(event.target.value)}
            className={selectClass}
            disabled={disabled || available.length === 0}
          >
            <option value="">{available.length ? `Select ${addLabel.toLowerCase()}…` : 'Nothing else available'}</option>
            {available.map((item) => (
              <option key={item.id} value={item.id}>{item.label}</option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={onAdd}
          disabled={disabled || !value}
          className={`${actionClass} sm:self-end`}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Bind
        </button>
      </div>
      {children || <p className="text-sm text-gray-500">{emptyText}</p>}
    </section>
  );
}

export default function GameBindings({
  game,
  sprites,
  tracks,
  busy,
  onBindSprite,
  onUnbindSprite,
  onBindMusic,
  onUnbindMusic,
}) {
  const [spriteId, setSpriteId] = useState('');
  const [trackId, setTrackId] = useState('');
  const spriteMap = useMemo(() => new Map(sprites.map((sprite) => [sprite.id, sprite])), [sprites]);
  const trackMap = useMemo(() => new Map(tracks.map((track) => [track.id, track])), [tracks]);
  const boundSpriteIds = new Set(game.spriteBindings.map((binding) => binding.spriteId));
  const boundTrackIds = new Set(game.musicBindings.map((binding) => binding.trackId));
  const availableSprites = sprites
    .filter((sprite) => !boundSpriteIds.has(sprite.id))
    .map((sprite) => ({ id: sprite.id, label: `${sprite.name} · ${sprite.kind}` }));
  const availableTracks = tracks
    .filter((track) => !boundTrackIds.has(track.id))
    .map((track) => ({ id: track.id, label: `${track.title}${track.audioFilename ? '' : ' · no audio yet'}` }));

  const addSprite = async () => {
    if (!spriteId) return;
    if (await onBindSprite(spriteId)) setSpriteId('');
  };
  const addMusic = async () => {
    if (!trackId) return;
    if (await onBindMusic(trackId)) setTrackId('');
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <BindingSection
        title="Sprite assets"
        icon={PersonStanding}
        emptyText="No sprites are bound yet."
        available={availableSprites}
        value={spriteId}
        onValueChange={setSpriteId}
        onAdd={addSprite}
        addLabel="Sprite record"
        disabled={busy}
      >
        {game.spriteBindings.length > 0 ? (
          <ul className="space-y-2">
            {game.spriteBindings.map((binding) => {
              const sprite = spriteMap.get(binding.spriteId);
              return (
                <li key={binding.spriteId} className="flex items-center justify-between gap-3 rounded-lg border border-port-border bg-port-bg/50 px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-white">{sprite?.name || binding.spriteId}</div>
                    <div className="text-xs text-gray-500">{sprite ? `${sprite.kind} · ${sprite.status}` : 'Record unavailable'}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onUnbindSprite(binding.spriteId)}
                    disabled={busy}
                    className="min-h-[44px] min-w-[44px] rounded-lg p-2 text-gray-400 hover:text-port-error disabled:opacity-50"
                    aria-label={`Unbind ${sprite?.name || binding.spriteId}`}
                    title="Unbind sprite"
                  >
                    <Unlink className="h-4 w-4" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </BindingSection>

      <BindingSection
        title="Music assets"
        icon={Music2}
        emptyText="No music tracks are bound yet."
        available={availableTracks}
        value={trackId}
        onValueChange={setTrackId}
        onAdd={addMusic}
        addLabel="Music track"
        disabled={busy}
      >
        {game.musicBindings.length > 0 ? (
          <ul className="space-y-2">
            {game.musicBindings.map((binding) => {
              const track = trackMap.get(binding.trackId);
              return (
                <li key={binding.id} className="flex items-center justify-between gap-3 rounded-lg border border-port-border bg-port-bg/50 px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-white">{track?.title || binding.trackId}</div>
                    <div className="text-xs text-gray-500">{track?.audioFilename ? 'Audio ready' : 'Audio render required'}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onUnbindMusic(binding.id)}
                    disabled={busy}
                    className="min-h-[44px] min-w-[44px] rounded-lg p-2 text-gray-400 hover:text-port-error disabled:opacity-50"
                    aria-label={`Unbind ${track?.title || binding.trackId}`}
                    title="Unbind music track"
                  >
                    <Unlink className="h-4 w-4" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </BindingSection>
    </div>
  );
}
