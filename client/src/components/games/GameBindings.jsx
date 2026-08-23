import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  HelpCircle,
  Image as ImageIcon,
  Music2,
  PersonStanding,
  Plus,
  Save,
  Send,
  Sparkles,
  Unlink,
} from 'lucide-react';
import { Link } from 'react-router';
import Pill from '../ui/Pill.jsx';

const selectClass = 'w-full min-h-[44px] rounded-lg border border-port-border bg-port-bg px-3 py-2 text-sm text-white';
const actionClass = 'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-port-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50';
const inputClass = 'w-full min-h-[44px] rounded-lg border border-port-border bg-port-bg px-3 py-2 text-sm text-white';

const ARTWORK_ROLES = [
  {
    id: 'title-key-art',
    label: 'Title key art',
    destinationPath: 'game/assets/art/title/title-key-art.png',
    prompt: 'Premium cinematic 16:9 title-screen key art for a cozy science-fiction homesteading game, painterly stylized realism, rich alien world, sophisticated AAA composition, dark calm negative space for a menu, no text, no logo, no UI.',
  },
  {
    id: 'game-logo',
    label: 'Game logo',
    destinationPath: 'game/assets/art/ui/branding/game-logo.png',
    prompt: 'Premium illustrated game-title wordmark for a cozy science-fiction frontier game, handcrafted expedition-map lettering, subtle botanical and astronomical motifs, strong silhouette, transparent-ready flat chroma background, exact title text only, no mockup, no extra words.',
  },
  {
    id: 'biome-luminous-wilds',
    label: 'Luminous Wilds',
    destinationPath: 'game/assets/art/biomes/luminous-wilds.png',
    prompt: 'Wide cinematic biome selection artwork for a luminous alien woodland, cyan bioluminescent grove, reflective stream, premium painterly game concept art, no text, no UI.',
  },
  {
    id: 'biome-mineral-steppe',
    label: 'Mineral Steppe',
    destinationPath: 'game/assets/art/biomes/mineral-steppe.png',
    prompt: 'Wide cinematic biome selection artwork for an alien mineral steppe, golden grass, violet crystals, monumental weathered stone arch, premium painterly game concept art, no text, no UI.',
  },
  {
    id: 'biome-tide-meadow',
    label: 'Tide Meadow',
    destinationPath: 'game/assets/art/biomes/tide-meadow.png',
    prompt: 'Wide cinematic biome selection artwork for a tranquil alien tide meadow, turquoise shallows, flowered islands, distant ringed planet, premium painterly game concept art, no text, no UI.',
  },
  {
    id: 'loading-screen',
    label: 'Loading screen',
    destinationPath: 'game/assets/art/loading/loading-screen.png',
    prompt: 'Premium cinematic loading-screen artwork for a cozy science-fiction frontier game, an inviting alien homestead and distant world, painterly stylized realism, no text, no logo, no UI.',
  },
  {
    id: 'other',
    label: 'Other artwork',
    destinationPath: 'game/assets/art/custom/artwork.png',
    prompt: 'Polished production-ready concept artwork for a cozy science-fiction homesteading game, painterly stylized realism, cohesive alien world, no text, no UI.',
  },
];
const roleFor = (role) => ARTWORK_ROLES.find((entry) => entry.id === role) || ARTWORK_ROLES.at(-1);

// Sprites and music share this mapping so a new status can't render one way in
// one list and another in the other. Three outcomes, deliberately distinct:
// no preflight result at all (it hasn't loaded, or the fetch failed) is
// UNKNOWN, not a warning — painting every asset amber because verification is
// unavailable claims a problem nobody detected. An unrecognized status still
// falls to `blocked`, which is the conservative read for a real verdict.
const HEALTH_TONES = {
  ready: { Icon: CheckCircle2, className: 'text-emerald-400' },
  blocked: { Icon: AlertTriangle, className: 'text-amber-400' },
  unknown: { Icon: HelpCircle, className: 'text-gray-500' },
};
const healthTone = (health) => {
  if (!health) return HEALTH_TONES.unknown;
  return HEALTH_TONES[health.status] || HEALTH_TONES.blocked;
};

const missingHelp = {
  SPRITE_MISSING: 'This Sprite Manager record was deleted. Unbind it from this game to clear the blocker.',
  TRACK_MISSING: 'This music track was deleted. Unbind it from this game to clear the blocker.',
};
const sourceIsMissing = (issue) => issue?.code === 'SPRITE_MISSING' || issue?.code === 'TRACK_MISSING';

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
  const needsAttention = health?.status === 'blocked';
  const explanation = missingHelp[issue?.code] || issue?.message;
  return (
    <li className="flex min-h-[54px] items-start justify-between gap-2 rounded-lg border border-port-border bg-port-bg/50 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <Icon className={`h-3.5 w-3.5 shrink-0 ${className}`} aria-hidden="true" />
          <div className="truncate text-sm font-medium text-white">{label}</div>
        </div>
        <div className="truncate text-xs text-gray-500" title={message}>{message}</div>
        {needsAttention && explanation ? (
          <p className="mt-1 text-xs leading-5 text-gray-400">{explanation}</p>
        ) : null}
        {needsAttention && manageTo ? (
          <Link
            to={manageTo}
            className="mt-1 inline-flex min-h-[32px] items-center gap-1 text-xs font-medium text-port-accent hover:underline"
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

// Music rows mirror the artwork publish UX (editable repo destination, publish
// behind saved details, published/pending pill) in the compact row layout the
// music list uses. A destination-less binding (created before the publish lane
// existed, or synced from an older peer) shows the editor with an empty input
// and keeps Publish disabled until a destination is saved.
function MusicBindingRow({
  binding,
  track,
  health,
  issue,
  busy,
  overwriteRequested,
  onUpdate,
  onPublish,
  onUnbind,
  onDismissOverwrite,
}) {
  const [destinationPath, setDestinationPath] = useState(binding.destinationPath || '');
  // Key on the persisted VALUE, not the binding object: every mutation on this
  // page mints a fresh `game` (and so a fresh `binding`), so depending on the
  // object reset this input on unrelated saves — silently discarding a
  // destination the user was mid-way through typing.
  useEffect(() => {
    setDestinationPath(binding.destinationPath || '');
  }, [binding.id, binding.destinationPath]);
  const dirty = destinationPath.trim() !== (binding.destinationPath || '');
  const publicationCurrent = health?.publicationStatus === 'current';
  const { Icon, className } = healthTone(health);
  // Shown only when the preflight has no verdict for this track, so it must
  // state what the RECORD says, not claim a verification result — "Audio
  // ready" here would assert bytes nobody hashed. The server's message wins.
  const message = health?.message || (track?.audioFilename ? 'Audio attached' : 'No audio yet');
  const needsAttention = health?.status === 'blocked';
  const explanation = missingHelp[issue?.code] || issue?.message;
  return (
    <li className="rounded-lg border border-port-border bg-port-bg/50 px-3 py-2">
      <div className="flex min-h-[54px] items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <Icon className={`h-3.5 w-3.5 shrink-0 ${className}`} aria-hidden="true" />
            <div className="truncate text-sm font-medium text-white">{track?.title || binding.trackId}</div>
            {binding.destinationPath ? (
              <Pill tone={publicationCurrent ? 'success' : 'warning'} bordered={false}>
                {publicationCurrent ? 'Published' : 'Publish pending'}
              </Pill>
            ) : null}
          </div>
          <div className="truncate text-xs text-gray-500" title={message}>{message}</div>
          {needsAttention && explanation ? (
            <p className="mt-1 text-xs leading-5 text-gray-400">{explanation}</p>
          ) : null}
          {needsAttention && track && !sourceIsMissing(issue) ? (
            <Link
              to={`/music/tracks/${encodeURIComponent(binding.trackId)}`}
              className="mt-1 inline-flex min-h-[32px] items-center gap-1 text-xs font-medium text-port-accent hover:underline"
            >
              Open in Music
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => onUnbind(binding.id)}
          disabled={busy}
          className="min-h-[44px] min-w-[44px] shrink-0 rounded-lg p-2 text-gray-400 hover:text-port-error disabled:opacity-50"
          aria-label={`Unbind ${track?.title || binding.trackId}`}
          title="Unbind music track"
        >
          <Unlink className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <div className="mt-2">
        <label htmlFor={`music-dest-${binding.id}`} className="mb-1 block text-xs text-gray-400">Game destination</label>
        <input
          id={`music-dest-${binding.id}`}
          value={destinationPath}
          maxLength={500}
          placeholder="game/assets/music/track.mp3"
          onChange={(event) => setDestinationPath(event.target.value)}
          className={`${inputClass} font-mono text-xs`}
        />
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || !dirty || !destinationPath.trim()}
          onClick={() => onUpdate(binding.id, { destinationPath: destinationPath.trim() })}
          className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-port-border px-3 text-xs font-medium text-gray-200 hover:border-port-accent/60 disabled:opacity-40"
        >
          <Save className="h-3.5 w-3.5" aria-hidden="true" />
          Save destination
        </button>
        <button
          type="button"
          disabled={busy || dirty || !binding.destinationPath}
          onClick={() => onPublish(binding.id)}
          title={dirty
            ? 'Save destination changes before publishing'
            : (!binding.destinationPath ? 'Set a game destination before publishing' : undefined)}
          className="inline-flex min-h-[40px] items-center gap-2 rounded-lg bg-port-accent px-3 text-xs font-semibold text-white disabled:opacity-40"
        >
          <Send className="h-3.5 w-3.5" aria-hidden="true" />
          {publicationCurrent ? 'Republish' : 'Publish to game'}
        </button>
      </div>
      {overwriteRequested ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
          <p className="min-w-0 flex-1 text-xs leading-5 text-amber-200">
            {binding.destinationPath} contains bytes PortOS did not publish. Overwrite it?
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => onPublish(binding.id, true)}
            className="inline-flex min-h-[36px] items-center rounded-lg bg-port-warning px-3 text-xs font-semibold text-port-on-warning disabled:opacity-40"
          >
            Overwrite
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onDismissOverwrite}
            className="inline-flex min-h-[36px] items-center rounded-lg border border-port-border px-3 text-xs text-gray-300 disabled:opacity-40"
          >
            Cancel
          </button>
        </div>
      ) : null}
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

function ArtworkCard({
  binding,
  image,
  health,
  busy,
  onUpdate,
  onPublish,
  onUnbind,
}) {
  const [label, setLabel] = useState(binding.label);
  const [role, setRole] = useState(binding.role);
  const [destinationPath, setDestinationPath] = useState(binding.destinationPath);
  useEffect(() => {
    setLabel(binding.label);
    setRole(binding.role);
    setDestinationPath(binding.destinationPath);
  }, [binding]);
  const dirty = label.trim() !== binding.label
    || role !== binding.role
    || destinationPath.trim() !== binding.destinationPath;
  const publicationCurrent = health?.publicationStatus === 'current';
  return (
    <article className="overflow-hidden rounded-xl border border-port-border bg-port-bg/55">
      <div className="relative aspect-[16/7] overflow-hidden bg-black/30">
        {image?.path ? (
          <img
            src={image.path}
            alt={`${binding.label} preview`}
            className="h-full w-full object-cover transition-transform duration-500 hover:scale-[1.02]"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-gray-500">Gallery image unavailable</div>
        )}
        <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/90 to-transparent px-3 pb-2 pt-8">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-white">{binding.label}</div>
            <div className="truncate text-[11px] uppercase tracking-[0.16em] text-cyan-200">{roleFor(binding.role).label}</div>
          </div>
          <Pill tone={publicationCurrent ? 'success' : 'warning'} bordered={false}>
            {publicationCurrent ? 'Published' : 'Publish pending'}
          </Pill>
        </div>
      </div>
      <div className="grid gap-3 p-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`art-label-${binding.id}`} className="mb-1 block text-xs text-gray-400">Display name</label>
          <input
            id={`art-label-${binding.id}`}
            value={label}
            maxLength={120}
            onChange={(event) => setLabel(event.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor={`art-role-${binding.id}`} className="mb-1 block text-xs text-gray-400">Design role</label>
          <select
            id={`art-role-${binding.id}`}
            value={role}
            onChange={(event) => setRole(event.target.value)}
            className={selectClass}
          >
            {ARTWORK_ROLES.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </select>
        </div>
        <div className="sm:col-span-2">
          <label htmlFor={`art-dest-${binding.id}`} className="mb-1 block text-xs text-gray-400">Game destination</label>
          <input
            id={`art-dest-${binding.id}`}
            value={destinationPath}
            maxLength={500}
            onChange={(event) => setDestinationPath(event.target.value)}
            className={`${inputClass} font-mono text-xs`}
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-2 border-t border-port-border px-3 py-2.5">
        <button
          type="button"
          disabled={busy || !dirty || !label.trim() || !destinationPath.trim()}
          onClick={() => onUpdate(binding.id, {
            label: label.trim(),
            role,
            destinationPath: destinationPath.trim(),
          })}
          className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-port-border px-3 text-xs font-medium text-gray-200 hover:border-port-accent/60 disabled:opacity-40"
        >
          <Save className="h-3.5 w-3.5" aria-hidden="true" />
          Save details
        </button>
        <button
          type="button"
          disabled={busy || dirty}
          onClick={() => onPublish(binding.id)}
          title={dirty ? 'Save destination changes before publishing' : undefined}
          className="inline-flex min-h-[40px] items-center gap-2 rounded-lg bg-port-accent px-3 text-xs font-semibold text-white disabled:opacity-40"
        >
          <Send className="h-3.5 w-3.5" aria-hidden="true" />
          {publicationCurrent ? 'Republish' : 'Publish to game'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onUnbind(binding.id)}
          className="ml-auto inline-flex min-h-[40px] items-center gap-2 rounded-lg px-3 text-xs text-gray-400 hover:text-port-error disabled:opacity-40"
        >
          <Unlink className="h-3.5 w-3.5" aria-hidden="true" />
          Unbind
        </button>
      </div>
    </article>
  );
}

export default function GameBindings({
  game,
  sprites,
  tracks,
  gallery = [],
  integrity,
  busy,
  onBindSprite,
  onUnbindSprite,
  onBindMusic,
  onUpdateMusic,
  onPublishMusic,
  onUnbindMusic,
  musicOverwriteFor,
  onDismissMusicOverwrite,
  onBindArtwork,
  onUpdateArtwork,
  onPublishArtwork,
  onUnbindArtwork,
}) {
  const [spriteId, setSpriteId] = useState('');
  const [trackId, setTrackId] = useState('');
  const [artworkFilename, setArtworkFilename] = useState('');
  const [artworkRole, setArtworkRole] = useState(ARTWORK_ROLES[0].id);
  const [artworkLabel, setArtworkLabel] = useState(ARTWORK_ROLES[0].label);
  const [artworkDestination, setArtworkDestination] = useState(ARTWORK_ROLES[0].destinationPath);
  const spriteMap = useMemo(() => new Map(sprites.map((sprite) => [sprite.id, sprite])), [sprites]);
  const trackMap = useMemo(() => new Map(tracks.map((track) => [track.id, track])), [tracks]);
  const spriteIntegrity = useMemo(() => new Map(
    (integrity?.assets?.sprites || []).map((asset) => [asset.assetId, asset]),
  ), [integrity]);
  const musicIntegrity = useMemo(() => new Map(
    (integrity?.assets?.music || []).map((asset) => [asset.bindingId, asset]),
  ), [integrity]);
  const artworkIntegrity = useMemo(() => new Map(
    (integrity?.assets?.artwork || []).map((asset) => [asset.bindingId, asset]),
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
  const boundSpriteIds = new Set(game.spriteBindings.map((binding) => binding.spriteId));
  const boundTrackIds = new Set(game.musicBindings.map((binding) => binding.trackId));
  const availableSprites = sprites
    .filter((sprite) => !boundSpriteIds.has(sprite.id))
    .map((sprite) => ({ id: sprite.id, label: `${sprite.name} · ${sprite.kind}` }));
  const availableTracks = tracks
    .filter((track) => !boundTrackIds.has(track.id))
    .map((track) => ({ id: track.id, label: `${track.title}${track.audioFilename ? '' : ' · no audio yet'}` }));
  const galleryMap = useMemo(() => new Map(gallery.map((image) => [image.filename, image])), [gallery]);
  const selectedArtwork = galleryMap.get(artworkFilename);

  const addSprite = async () => {
    if (!spriteId) return;
    if (await onBindSprite(spriteId)) setSpriteId('');
  };
  const addMusic = async () => {
    if (!trackId) return;
    if (await onBindMusic(trackId)) setTrackId('');
  };
  const chooseArtworkRole = (nextRole) => {
    const next = roleFor(nextRole);
    setArtworkRole(nextRole);
    setArtworkLabel(next.label);
    setArtworkDestination(next.destinationPath);
  };
  const addArtwork = async () => {
    if (!artworkFilename || !artworkLabel.trim() || !artworkDestination.trim()) return;
    if (await onBindArtwork({
      imageFilename: artworkFilename,
      label: artworkLabel.trim(),
      role: artworkRole,
      destinationPath: artworkDestination.trim(),
    })) setArtworkFilename('');
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
              const issue = spriteIssues.get(binding.spriteId);
              return (
                <BindingRow
                  key={binding.spriteId}
                  label={sprite?.name || binding.spriteId}
                  detail={sprite ? `${sprite.kind} · ${sprite.status}` : 'Record unavailable'}
                  health={spriteIntegrity.get(binding.spriteId)}
                  issue={issue}
                  manageTo={sprite && !sourceIsMissing(issue)
                    ? `/sprites/${encodeURIComponent(binding.spriteId)}`
                    : null}
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
            {game.musicBindings.map((binding) => (
              <MusicBindingRow
                key={binding.id}
                binding={binding}
                track={trackMap.get(binding.trackId)}
                health={musicIntegrity.get(binding.id)}
                issue={musicIssues.get(binding.trackId)}
                busy={busy}
                overwriteRequested={musicOverwriteFor?.bindingId === binding.id
                  && musicOverwriteFor?.destinationPath === (binding.destinationPath || '')}
                onUpdate={onUpdateMusic}
                onPublish={onPublishMusic}
                onUnbind={onUnbindMusic}
                onDismissOverwrite={onDismissMusicOverwrite}
              />
            ))}
          </ul>
        ) : null}
      </BindingSection>

      <section className="rounded-xl border border-port-border bg-port-card p-4 lg:col-span-2">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
          <div>
            <div className="flex items-center gap-2">
              <ImageIcon className="h-5 w-5 text-port-accent" aria-hidden="true" />
              <h2 className="font-semibold text-white">World &amp; interface artwork</h2>
              <Pill tone="muted" bordered={false}>{game.artworkBindings?.length || 0}</Pill>
            </div>
            <p className="mt-1 max-w-2xl text-sm text-gray-400">
              Assign gallery images to a design role, preview them here, and publish verified bytes into the managed game.
            </p>
          </div>
          <Link
            to={`/media/image?prompt=${encodeURIComponent(roleFor(artworkRole).prompt)}`}
            className="inline-flex min-h-[44px] shrink-0 items-center justify-center gap-2 rounded-lg border border-port-accent/50 bg-port-accent/10 px-3 py-2 text-sm font-medium text-port-accent hover:bg-port-accent/20"
          >
            <Sparkles className="h-4 w-4" aria-hidden="true" />
            Generate for this role
          </Link>
        </div>

        <div className="mt-4 grid gap-3 rounded-xl border border-port-border bg-port-bg/35 p-3 lg:grid-cols-[minmax(0,1.3fr)_minmax(180px,.7fr)]">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="game-artwork-picker" className="mb-1 block text-xs text-gray-400">Gallery image</label>
              <select
                id="game-artwork-picker"
                value={artworkFilename}
                onChange={(event) => setArtworkFilename(event.target.value)}
                className={selectClass}
                disabled={busy || gallery.length === 0}
              >
                <option value="">{gallery.length ? 'Select artwork…' : 'No gallery images available'}</option>
                {gallery.map((image) => (
                  <option key={image.filename} value={image.filename}>
                    {image.prompt?.slice(0, 70) || image.filename}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="game-artwork-role" className="mb-1 block text-xs text-gray-400">Design role</label>
              <select
                id="game-artwork-role"
                value={artworkRole}
                onChange={(event) => chooseArtworkRole(event.target.value)}
                className={selectClass}
                disabled={busy}
              >
                {ARTWORK_ROLES.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="game-artwork-label" className="mb-1 block text-xs text-gray-400">Display name</label>
              <input
                id="game-artwork-label"
                value={artworkLabel}
                maxLength={120}
                onChange={(event) => setArtworkLabel(event.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="game-artwork-destination" className="mb-1 block text-xs text-gray-400">Game destination</label>
              <input
                id="game-artwork-destination"
                value={artworkDestination}
                maxLength={500}
                onChange={(event) => setArtworkDestination(event.target.value)}
                className={`${inputClass} font-mono text-xs`}
              />
            </div>
            <button
              type="button"
              disabled={busy || !artworkFilename || !artworkLabel.trim() || !artworkDestination.trim()}
              onClick={addArtwork}
              className={`${actionClass} sm:col-span-2 sm:justify-self-start`}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Bind artwork
            </button>
          </div>
          <div className="overflow-hidden rounded-lg border border-port-border bg-black/25">
            {selectedArtwork?.path ? (
              <img src={selectedArtwork.path} alt="Selected gallery preview" className="h-full min-h-40 w-full object-cover" />
            ) : (
              <div className="flex h-full min-h-40 items-center justify-center px-6 text-center text-sm text-gray-500">
                Select a gallery image to preview the game-facing composition.
              </div>
            )}
          </div>
        </div>

        {(game.artworkBindings?.length || 0) > 0 ? (
          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            {game.artworkBindings.map((binding) => (
              <ArtworkCard
                key={binding.id}
                binding={binding}
                image={galleryMap.get(binding.imageFilename)}
                health={artworkIntegrity.get(binding.id)}
                busy={busy}
                onUpdate={onUpdateArtwork}
                onPublish={onPublishArtwork}
                onUnbind={onUnbindArtwork}
              />
            ))}
          </div>
        ) : (
          <p className="mt-4 text-sm text-gray-500">
            No world or interface artwork is bound yet. Start with title key art to give the launch experience a strong visual identity.
          </p>
        )}
      </section>
    </div>
  );
}
