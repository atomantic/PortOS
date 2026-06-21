/**
 * Music studio — generate and organize music with local OSS tools.
 *
 * A hub for the music feature: manage **Artists** (reusable musical personas,
 * like Authors), **Albums** (ordered track collections with cover art), and
 * **Tracks** (singles or album members, with uploaded/attached audio). On-device
 * generation (Ace-Step and friends) wires into the Tracks editor next update.
 *
 * Tabbed via URL param (`/music/:tab`) per the linkable-routes convention, so a
 * tab is deep-linkable and survives reload. `tab` defaults to `artists`.
 */

import { useParams, Navigate, Link } from 'react-router-dom';
import { Music as MusicIcon, Mic, Disc3, AudioLines } from 'lucide-react';
import ArtistsManager from '../components/music/ArtistsManager';
import AlbumsManager from '../components/music/AlbumsManager';
import TracksManager from '../components/music/TracksManager';

const TABS = [
  { id: 'artists', label: 'Artists', icon: Mic },
  { id: 'albums', label: 'Albums', icon: Disc3 },
  { id: 'tracks', label: 'Tracks', icon: AudioLines },
];

const VALID = new Set(TABS.map((t) => t.id));

export default function Music() {
  const { tab } = useParams();
  const active = tab || 'artists';
  // Unknown tab → redirect to the default rather than render an empty shell.
  if (!VALID.has(active)) return <Navigate to="/music/artists" replace />;

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <MusicIcon className="w-6 h-6 text-port-accent" />
        <h1 className="text-2xl font-bold text-white">Music</h1>
      </div>

      <div className="flex items-center gap-1 mb-6 border-b border-port-border">
        {TABS.map((t) => {
          const Icon = t.icon;
          const isActive = t.id === active;
          return (
            <Link
              key={t.id}
              to={`/music/${t.id}`}
              className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
                isActive
                  ? 'border-port-accent text-white'
                  : 'border-transparent text-gray-400 hover:text-white'
              }`}
            >
              <Icon size={15} aria-hidden="true" />
              {t.label}
            </Link>
          );
        })}
      </div>

      {active === 'artists' && <ArtistsManager />}
      {active === 'albums' && <AlbumsManager />}
      {active === 'tracks' && <TracksManager />}
    </div>
  );
}
