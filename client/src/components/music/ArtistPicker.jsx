/**
 * ArtistPicker — pick an Artist persona for an album or track.
 *
 * Mirrors pipeline/AuthorPicker. Selecting an artist calls
 * `onChange(artistId, artistName)` so the caller can store BOTH the FK
 * (`artistId`) and the denormalized name (`artist`) — the name renders before
 * the (local-only) artist record syncs. Selecting "— No artist —" calls
 * `onChange('', '')`. Self-contained: fetches the artist list on mount.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listArtists } from '../../services/api';

export default function ArtistPicker({ id = 'music-artist', value, name, onChange, disabled = false }) {
  const [artists, setArtists] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    listArtists({ silent: true })
      .then((list) => { if (alive) setArtists(Array.isArray(list) ? list : []); })
      .catch(() => { if (alive) setArtists([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const handleChange = (e) => {
    const artistId = e.target.value || '';
    const picked = artists.find((a) => a.id === artistId);
    onChange(artistId, picked ? picked.name : '');
  };

  // An artistId not in the fetched list (deleted persona) shouldn't silently
  // snap to "none" — surface it so the link isn't lost.
  const unknownLink = value && !artists.some((a) => a.id === value);

  return (
    <div>
      <select
        id={id}
        value={value || ''}
        onChange={handleChange}
        disabled={disabled || loading}
        className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white disabled:opacity-50"
      >
        <option value="">— No artist —</option>
        {artists.map((a) => (
          <option key={a.id} value={a.id}>{a.name}</option>
        ))}
        {unknownLink ? <option value={value}>{name || 'Linked artist (unavailable)'}</option> : null}
      </select>
      <p className="text-[11px] text-gray-500 mt-1">
        {artists.length === 0 && !loading ? (
          <>No artist personas yet — <Link to="/music/artists" className="text-port-accent hover:underline">create one</Link>.</>
        ) : !value && name ? (
          <>Unlinked artist: <span className="text-gray-400">{name}</span> — pick a persona to link it.</>
        ) : (
          <>Manage personas in <Link to="/music/artists" className="text-port-accent hover:underline">Artists</Link>.</>
        )}
      </p>
    </div>
  );
}
