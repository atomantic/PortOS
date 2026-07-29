import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Music2,
  PersonStanding,
  Plus,
  Unlink,
} from 'lucide-react';
import Banner from '../ui/Banner.jsx';
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

const missingHelp = {
  SPRITE_MISSING: 'This Sprite Manager record was deleted. Unbind it from this game to clear the blocker.',
  TRACK_MISSING: 'This music track was deleted. Unbind it from this game to clear the blocker.',
};

function BindingRow({
  label,
  detail,
  health,
  issue,
  manageTo,
  manageLabel,
  disabled,
  onUnbind,
  unbindTitle,
}) {
  const { Icon, className } = healthTone(health);
  const message = health?.message || detail;
  const needsAttention = health?.status !== 'ready';
  const explanation = missingHelp[issue?.code] || issue?.message;
  return (
    <li className={`flex min-h-[54px] items-start justify-between gap-2 rounded-lg border px-3 py-2 ${
      needsAttention
        ? 'border-port-warning/40 bg-port-warning/5'
        : 'border-port-border bg-port-bg/50'
    }`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <Icon className={`h-3.5 w-3.5 shrink-0 ${className}`} aria-hidden="true" />
          <div className="truncate text-sm font-medium text-white">{label}</div>
        </div>
        <div className={`text-xs ${needsAttention ? 'font-medium text-port-warning' : 'truncate text-gray-500'}`}>
          {message}
        </div>
        {needsAttention && explanation ? (
          <p className="mt-1 text-xs leading-5 text-gray-400">{explanation}</p>
        ) : null}
        {needsAttention && manageTo ? (
          <Link
            to={manageTo}
            className="mt-1.5 inline-flex min-h-[32px] items-center gap-1 text-xs font-medium text-port-accent hover:underline"
          >
            {manageLabel}
            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onUnbind}
        disabled={disabled}
        className="min-h-[44px] min-w-[44px] shrink-0 rounded-lg p-2 text-gray-400 hover:text-port-error disabled:opacity-50"
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
  const spriteIssues = useMemo(() => new Map(
    (integrity?.issues || [])
      .filter((issue) => issue.assetType === 'sprite')
      .map((issue) => [issue.assetId, issue]),
  ), [integrity]);
  const musicIssues = useMemo(() => new Map(
    (integrity?.issues || [])
      .filter((issue) => issue.assetType === 'music')
      .map((issue) => [issue.assetId, issue]),
  ), [integrity]);
  const affectedAssets = useMemo(() => (integrity?.issues || [])
    .filter((issue) => issue.assetType === 'sprite' || issue.assetType === 'music'), [integrity]);
  const affectedAssetRows = useMemo(() => affectedAssets.map((issue) => {
    const sourceExists = issue.assetType === 'sprite'
      ? spriteMap.has(issue.assetId)
      : trackMap.has(issue.assetId);
    return {
      ...issue,
      manageTo: sourceExists
        ? (issue.assetType === 'sprite'
          ? `/sprites/${encodeURIComponent(issue.assetId)}`
          : `/music/tracks/${encodeURIComponent(issue.assetId)}`)
        : null,
      manageLabel: issue.assetType === 'sprite' ? 'Open in Sprite Manager' : 'Open in Music',
    };
  }), [affectedAssets, spriteMap, trackMap]);
  const boundSpriteIds = new Set(game.spriteBindings.map((binding) => binding.spriteId));
  const boundTrackIds = new Set(game.musicBindings.map((binding) => binding.trackId));
  const availableSprites = sprites
    .filter((sprite) => !boundSpriteIds.has(sprite.id))
    .map((sprite) => ({ id: sprite.id, label: `${sprite.name} · ${sprite.kind}` }));
  const availableTracks = tracks
    .filter((track) => !boundTrackIds.has(track.id))
    .map((track) => ({ id: track.id, label: `${track.title}${track.audioFilename ? '' : ' · no audio yet'}` }));
  const orderedSpriteBindings = useMemo(() => [...game.spriteBindings].sort((left, right) => {
    const leftBlocked = spriteIntegrity.get(left.spriteId)?.status === 'blocked';
    const rightBlocked = spriteIntegrity.get(right.spriteId)?.status === 'blocked';
    return Number(rightBlocked) - Number(leftBlocked);
  }), [game.spriteBindings, spriteIntegrity]);
  const orderedMusicBindings = useMemo(() => [...game.musicBindings].sort((left, right) => {
    const leftBlocked = musicIntegrity.get(left.id)?.status === 'blocked';
    const rightBlocked = musicIntegrity.get(right.id)?.status === 'blocked';
    return Number(rightBlocked) - Number(leftBlocked);
  }), [game.musicBindings, musicIntegrity]);

  const addSprite = async () => {
    if (!spriteId) return;
    if (await onBindSprite(spriteId)) setSpriteId('');
  };
  const addMusic = async () => {
    if (!trackId) return;
    if (await onBindMusic(trackId)) setTrackId('');
  };

  return (
    <div className="space-y-4">
      {affectedAssets.length > 0 ? (
        <Banner
          tone="warning"
          size="md"
          icon={AlertTriangle}
          title={`${affectedAssets.length} ${affectedAssets.length === 1 ? 'asset is' : 'assets are'} blocking the bundle`}
        >
          <ul className="mt-2 grid gap-2 sm:grid-cols-2">
            {affectedAssetRows.map((issue) => (
              <li
                key={`${issue.assetType}-${issue.assetId}`}
                className="rounded-md border border-port-warning/20 bg-port-bg/30 px-2.5 py-2 text-xs leading-5 text-gray-300"
              >
                <span className="block font-medium text-white">{issue.name}</span>
                <span className="block">{missingHelp[issue.code] || issue.message}</span>
                {issue.manageTo ? (
                  <Link
                    to={issue.manageTo}
                    className="mt-1 inline-flex min-h-[32px] items-center gap-1 font-medium text-port-accent hover:underline"
                  >
                    {issue.manageLabel}
                    <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </Banner>
      ) : null}

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
              {orderedSpriteBindings.map((binding) => {
                const sprite = spriteMap.get(binding.spriteId);
                return (
                  <BindingRow
                    key={binding.spriteId}
                    label={sprite?.name || binding.spriteId}
                    detail={sprite ? `${sprite.kind} · ${sprite.status}` : 'Record unavailable'}
                    health={spriteIntegrity.get(binding.spriteId)}
                    issue={spriteIssues.get(binding.spriteId)}
                    manageTo={sprite ? `/sprites/${encodeURIComponent(binding.spriteId)}` : null}
                    manageLabel="Open in Sprite Manager"
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
              {orderedMusicBindings.map((binding) => {
                const track = trackMap.get(binding.trackId);
                return (
                  <BindingRow
                    key={binding.id}
                    label={track?.title || binding.trackId}
                    detail={track?.audioFilename ? 'Audio ready' : 'Audio render required'}
                    health={musicIntegrity.get(binding.id)}
                    issue={musicIssues.get(binding.trackId)}
                    manageTo={track ? `/music/tracks/${encodeURIComponent(binding.trackId)}` : null}
                    manageLabel="Open in Music"
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
    </div>
  );
}
