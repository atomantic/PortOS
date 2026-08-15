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

import { useParams, useNavigate, Navigate } from 'react-router';
import { Music as MusicIcon, Mic, Disc3, AudioLines, Wand2 } from 'lucide-react';
import ArtistsManager from '../components/music/ArtistsManager';
import AlbumsManager from '../components/music/AlbumsManager';
import TracksManager from '../components/music/TracksManager';
import MusicDesigner from '../components/music/MusicDesigner';
import TabPills from '../components/ui/TabPills';

const TABS = [
  { id: 'generate', label: 'Generate', icon: Wand2 },
  { id: 'artists', label: 'Artists', icon: Mic },
  { id: 'albums', label: 'Albums', icon: Disc3 },
  { id: 'tracks', label: 'Tracks', icon: AudioLines },
];

const VALID = new Set(TABS.map((t) => t.id));

export default function Music() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const active = tab || 'generate';
  // Unknown tab → redirect to the default rather than render an empty shell.
  if (!VALID.has(active)) return <Navigate to="/music/generate" replace />;

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <MusicIcon className="w-6 h-6 text-port-accent" />
        <h1 className="text-2xl font-bold text-white">Music</h1>
      </div>

      {/* Selection lives in the URL (`/music/:tab`) — TabPills drives onChange
          callbacks rather than links, so we navigate() to keep the route canonical
          and deep-linkable. */}
      <TabPills
        tabs={TABS}
        activeTab={active}
        onChange={(id) => navigate(`/music/${id}`)}
        ariaLabel="Music sections"
        className="mb-6"
      />

      {active === 'generate' && <MusicDesigner />}
      {active === 'artists' && <ArtistsManager />}
      {active === 'albums' && <AlbumsManager />}
      {active === 'tracks' && <TracksManager />}
    </div>
  );
}
