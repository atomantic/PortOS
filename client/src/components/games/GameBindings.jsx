import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Music2, PersonStanding, Plus, Unlink } from 'lucide-react';
import Pill from '../ui/Pill.jsx';

const selectClass = 'w-full min-h-[44px] rounded-lg border border-port-border bg-port-bg px-3 py-2 text-sm text-white';
const actionClass = 'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-port-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50';

// Anything the preflight didn't mark `ready` — including an asset it hasn't
// reported on yet — reads as needing attention. Sprites and music share the
// mapping so a new status can't render one way in one list and another in the
// other.
const HEALTH_TONES = {
  ready: { Icon: CheckCircle2, className: 'text-emerald-400' },
  blocked: { Icon: AlertTriangle, className: 'text-amber-400' },
};
const healthTone = (health) => HEALTH_TONES[health?.status] || HEALTH_TONES.blocked;

function BindingRow({ label, detail, health, disabled, onUnbind, unbindTitle }) {
  const { Icon, className } = healthTone(health);
  const message = health?.message || detail;
  return (
    <li className="flex min-h-[54px] items-center justify-between gap-2 rounded-lg border border-port-border bg-port-bg/50 px-3 py-1.5">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <Icon className={`h-3.5 w-3.5 shrink-0 ${className}`} aria-hidden="true" />
          <div className="truncate text-sm font-medium text-white">{label}</div>
        </div>
        <div className="truncate text-xs text-gray-500" title={message}>{message}</div>
      </div>
      <button
        type="button"
        onClick={onUnbind}
        disabled={disabled}
        className="min-h-[44px] min-w-[44px] rounded-lg p-2 text-gray-400 hover:text-port-error disabled:opacity-50"
        aria-label={`Unbind ${label}`}
        title={unbindTitle}
      >
        <Unlink className="h-4 w-4" aria-hidden="true" />
      </button>
    </li>
  );
}

function BindingSection({
  title,
  icon: Icon,
  emptyText,
  available,
  value,
  onValueChange,
  onAdd,
  addLabel,
  count,
  disabled,
  children,
}) {
  const selectId = `game-${title.toLowerCase().replace(/\s+/g, '-')}-picker`;
  return (
    <section className="rounded-xl border border-port-border bg-port-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <Icon className="h-5 w-5 text-port-accent" aria-hidden="true" />
        <h2 className="font-semibold text-white">{title}</h2>
        <Pill tone="muted" bordered={false}>{count}</Pill>
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
  integrity,
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
  const spriteIntegrity = useMemo(() => new Map(
    (integrity?.assets?.sprites || []).map((asset) => [asset.assetId, asset]),
  ), [integrity]);
  const musicIntegrity = useMemo(() => new Map(
    (integrity?.assets?.music || []).map((asset) => [asset.bindingId, asset]),
  ), [integrity]);
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
        count={game.spriteBindings.length}
        disabled={busy}
      >
        {game.spriteBindings.length > 0 ? (
          <ul className="grid max-h-72 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
            {game.spriteBindings.map((binding) => {
              const sprite = spriteMap.get(binding.spriteId);
              return (
                <BindingRow
                  key={binding.spriteId}
                  label={sprite?.name || binding.spriteId}
                  detail={sprite ? `${sprite.kind} · ${sprite.status}` : 'Record unavailable'}
                  health={spriteIntegrity.get(binding.spriteId)}
                  disabled={busy}
                  onUnbind={() => onUnbindSprite(binding.spriteId)}
                  unbindTitle="Unbind sprite"
                />
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
        count={game.musicBindings.length}
        disabled={busy}
      >
        {game.musicBindings.length > 0 ? (
          <ul className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {game.musicBindings.map((binding) => {
              const track = trackMap.get(binding.trackId);
              return (
                <BindingRow
                  key={binding.id}
                  label={track?.title || binding.trackId}
                  detail={track?.audioFilename ? 'Audio ready' : 'Audio render required'}
                  health={musicIntegrity.get(binding.id)}
                  disabled={busy}
                  onUnbind={() => onUnbindMusic(binding.id)}
                  unbindTitle="Unbind music track"
                />
              );
            })}
          </ul>
        ) : null}
      </BindingSection>
    </div>
  );
}
