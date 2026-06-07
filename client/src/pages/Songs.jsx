/**
 * Songs page — a cappella song workbench index.
 *
 * Lists every song the user is writing or learning and lets them create, open,
 * or delete any of them. The heavy editor lives at `/songs/:id`; the learning
 * reference (dirge rhythm shapes, the layer ladder, notation help) lives at
 * `/songs/guide`. Mirrors the Universes index — a plain padded+scrolling page
 * (NOT full-width), one card/row per song.
 */

import { useEffect, useState, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Music, Plus, Trash2, BookOpen, CheckCircle2, Circle, Wand2 } from 'lucide-react';
import toast from '../components/ui/Toast';
import { timeAgo } from '../utils/formatters';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { listSongs, createSong, deleteSong, generateSong } from '../services/api';
import { RHYTHM_SHAPES } from '../lib/songCraft';

const shapeLabel = (id) => RHYTHM_SHAPES.find((s) => s.id === id)?.label || null;

export default function Songs() {
  const navigate = useNavigate();
  const [songs, setSongs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  // Two-step delete confirm (no window.confirm) — the armed song id.
  const [armed, setArmed] = useState(null);

  useEffect(() => {
    listSongs({ silent: true })
      .then((data) => setSongs(Array.isArray(data?.songs) ? data.songs : []))
      .catch((err) => toast.error(err?.message || 'Failed to load songs'))
      .finally(() => setLoading(false));
  }, []);

  const [create, creating] = useAsyncAction(async () => {
    const name = title.trim();
    if (!name) { toast.error('Give the song a title'); return null; }
    const data = await createSong({ title: name, artist: artist.trim() }, { silent: true });
    const song = data?.song;
    if (song) navigate(`/songs/${song.id}`);
    return song;
  }, { errorMessage: 'Failed to create song' });

  // Generate a full draft from the title/artist as a brief, persist it, then
  // open the editor on the new song. Two server calls (generate → create) keep
  // the AI service stateless about storage; the editor's own Generate/Expand
  // buttons drive subsequent rounds.
  const [generate, generating] = useAsyncAction(async () => {
    const name = title.trim();
    const data = await generateSong(
      { title: name || undefined, artist: artist.trim() || undefined },
      { silent: true },
    );
    const fields = data?.song;
    if (!fields) { toast.error('Generation produced nothing — try again'); return null; }
    const created = await createSong(fields, { silent: true });
    const song = created?.song;
    if (song) navigate(`/songs/${song.id}`);
    return song;
  }, { errorMessage: 'Failed to generate song' });

  const onDelete = useCallback(async (song) => {
    if (armed !== song.id) { setArmed(song.id); return; }
    setArmed(null);
    await deleteSong(song.id, { silent: true })
      .then(() => setSongs((prev) => prev.filter((s) => s.id !== song.id)))
      .catch((err) => toast.error(err?.message || 'Failed to delete song'));
  }, [armed]);

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="flex items-center gap-3">
          <Music className="w-6 h-6 text-port-accent" />
          <h1 className="text-2xl font-bold text-white">Songs</h1>
        </div>
        <Link
          to="/songs/guide"
          className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50"
        >
          <BookOpen size={16} />
          Learning Guide
        </Link>
      </div>
      <p className="text-sm text-gray-400 mb-6">
        Write and learn a cappella songs — dirges, ballads, and harmonies. Track lyrics,
        rhythm shapes, and the voice layers you're stacking.
      </p>

      {/* Create form */}
      <form
        onSubmit={(e) => { e.preventDefault(); create(); }}
        className="bg-port-card border border-port-border rounded-lg p-4 mb-6 flex flex-col sm:flex-row gap-3 sm:items-end"
      >
        <div className="flex-1">
          <label htmlFor="song-title" className="block text-xs text-gray-400 mb-1">Title</label>
          <input
            id="song-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. 500 Miles"
            className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:border-port-accent focus:outline-none"
          />
        </div>
        <div className="flex-1">
          <label htmlFor="song-artist" className="block text-xs text-gray-400 mb-1">Artist (optional)</label>
          <input
            id="song-artist"
            type="text"
            value={artist}
            onChange={(e) => setArtist(e.target.value)}
            placeholder="e.g. Peter, Paul and Mary"
            className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:border-port-accent focus:outline-none"
          />
        </div>
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={creating || generating}
            className="flex items-center justify-center gap-2 px-4 py-2 text-sm rounded-lg bg-port-accent text-white hover:bg-port-accent/90 disabled:opacity-50"
          >
            <Plus size={16} />
            New Song
          </button>
          <button
            type="button"
            onClick={() => generate()}
            disabled={creating || generating}
            title="Draft a full arrangement with AI from the title/artist above"
            className="flex items-center justify-center gap-2 px-4 py-2 text-sm rounded-lg border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50 disabled:opacity-50"
          >
            <Wand2 size={16} />
            {generating ? 'Generating…' : 'Generate'}
          </button>
        </div>
      </form>

      {/* List */}
      {loading ? (
        <p className="text-sm text-gray-500">Loading songs…</p>
      ) : songs.length === 0 ? (
        <p className="text-sm text-gray-500">No songs yet — write your first above.</p>
      ) : (
        <ul className="space-y-2">
          {songs.map((song) => {
            const shape = shapeLabel(song.rhythmShapeId);
            const layerCount = song.layers?.length || 0;
            return (
              <li
                key={song.id}
                className="group bg-port-card border border-port-border rounded-lg flex items-center gap-3 px-4 py-3 hover:border-port-accent/50"
              >
                <Link to={`/songs/${song.id}`} className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    {song.learned
                      ? <CheckCircle2 size={16} className="text-port-success shrink-0" aria-label="Learned" />
                      : <Circle size={16} className="text-gray-600 shrink-0" aria-label="In progress" />}
                    <span className="text-white font-medium truncate">{song.title}</span>
                    {song.artist && <span className="text-gray-500 text-sm truncate">· {song.artist}</span>}
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-gray-500 mt-1 pl-6">
                    {song.key && <span>Key: {song.key}</span>}
                    {song.tempo && <span>{song.tempo} BPM</span>}
                    {shape && <span>{shape}</span>}
                    {layerCount > 0 && <span>{layerCount} layer{layerCount === 1 ? '' : 's'}</span>}
                    {song.updatedAt && <span>Edited {timeAgo(song.updatedAt)}</span>}
                  </div>
                </Link>
                <button
                  type="button"
                  onClick={() => onDelete(song)}
                  onBlur={() => setArmed((cur) => (cur === song.id ? null : cur))}
                  className={`p-2 shrink-0 ${armed === song.id ? 'text-port-error' : 'text-gray-500 hover:text-port-error'}`}
                  aria-label={armed === song.id ? `Confirm delete ${song.title}` : `Delete ${song.title}`}
                  title={armed === song.id ? 'Click again to confirm delete' : 'Delete song'}
                >
                  <Trash2 size={16} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
