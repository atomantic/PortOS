/**
 * SongBook index — /songbook.
 *
 * Repertoire tracker: every song the user knows or is learning (guitar tabs,
 * chord sheets, sheet music) with a learning stage (new → learning → learned →
 * memorized). A plain padded+scrolling page (NOT full-width, like /rounds);
 * the play/edit viewer lives at /songbook/:id and import at /songbook/import.
 *
 * Filters live in URL search params (?stage=&instrument=&tag=&q=) so a
 * filtered view is linkable (Catalog.jsx pattern). Stage flips PUT just the
 * stage field and update local state reactively — no refetch.
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { ListMusic, Plus, Trash2, Download, Search, X } from 'lucide-react';
import toast from '../components/ui/Toast';
import PageHeader from '../components/PageHeader';
import EmptyState from '../components/EmptyState';
import ConfirmButtonPair from '../components/ui/ConfirmButtonPair';
import { timeAgo } from '../utils/formatters';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { useConfirmDelete } from '../hooks/useConfirmDelete';
import { listSongs, createSong, deleteSong, updateSong } from '../services/api';
import {
  SONG_STAGES, SONG_STAGE_COLORS, INSTRUMENTS, instrumentLabel, inputClass, labelClass,
} from '../components/songbook/constants';

export default function SongBook() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const stageFilter = searchParams.get('stage') || '';
  const instrumentFilter = searchParams.get('instrument') || '';
  const tagFilter = searchParams.get('tag') || '';
  const q = searchParams.get('q') || '';

  const setParam = useCallback((key, value) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const [songs, setSongs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();

  useEffect(() => {
    listSongs({ silent: true })
      .then((data) => setSongs(Array.isArray(data?.songs) ? data.songs : []))
      .catch((err) => toast.error(err?.message || 'Failed to load songs'))
      .finally(() => setLoading(false));
  }, []);

  const [create, creating] = useAsyncAction(async () => {
    const name = title.trim();
    if (!name) { toast.error('Give the song a title'); return null; }
    const song = await createSong({ title: name }, { silent: true });
    // A blank new song has nothing to read — open straight into edit mode.
    if (song?.id) navigate(`/songbook/${song.id}?mode=edit`);
    return song;
  }, { errorMessage: 'Failed to create song' });

  const onDelete = useCallback((song) => confirmDelete(() =>
    deleteSong(song.id, { silent: true })
      .then(() => setSongs((prev) => prev.filter((s) => s.id !== song.id)))
      .catch((err) => toast.error(err?.message || 'Failed to delete song')),
  ), [confirmDelete]);

  // Stage flip: PUT just the stage (defaults-free partial) then merge the
  // server record into local state. No custom catch toast — the request
  // helper owns the error toast (single layer).
  const onStageChange = useCallback((id, stage) => {
    updateSong(id, { stage })
      .then((updated) => setSongs((prev) => prev.map((s) => (s.id === id ? { ...s, ...updated } : s))))
      .catch(() => {});
  }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return songs.filter((s) => {
      if (stageFilter && s.stage !== stageFilter) return false;
      if (instrumentFilter && s.instrument !== instrumentFilter) return false;
      if (tagFilter && !(Array.isArray(s.tags) && s.tags.includes(tagFilter))) return false;
      if (needle && !(`${s.title} ${s.artist}`.toLowerCase().includes(needle))) return false;
      return true;
    });
  }, [songs, stageFilter, instrumentFilter, tagFilter, q]);

  const selectClass = 'bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:border-port-accent focus:outline-none';

  return (
    <div className="flex flex-col h-full min-h-0">
      <PageHeader
        icon={ListMusic}
        title="SongBook"
        subtitle="Songs you're learning — tabs, chord sheets, and sheet music"
        actions={(
          <Link
            to="/songbook/import"
            className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50"
          >
            <Download size={16} />
            Import
          </Link>
        )}
      />

      <div className="flex-1 overflow-auto p-3 sm:p-4">
      {/* Create row */}
      <form
        onSubmit={(e) => { e.preventDefault(); create(); }}
        className="bg-port-card border border-port-border rounded-lg p-4 mb-4 flex flex-col sm:flex-row gap-3 sm:items-end"
      >
        <div className="flex-1">
          <label htmlFor="song-title" className={labelClass}>Title</label>
          <input
            id="song-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Example Song"
            className={inputClass}
          />
        </div>
        <button
          type="submit"
          disabled={creating}
          className="flex items-center justify-center gap-2 px-4 py-2 text-sm rounded-lg bg-port-accent text-white hover:bg-port-accent/90 disabled:opacity-50"
        >
          <Plus size={16} />
          New Song
        </button>
      </form>

      {/* Filters (URL-backed) */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative flex-1 min-w-[160px] max-w-xs">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" aria-hidden="true" />
          <input
            type="search"
            value={q}
            onChange={(e) => setParam('q', e.target.value)}
            placeholder="Search title/artist…"
            aria-label="Search songs"
            className="w-full bg-port-bg border border-port-border rounded-lg pl-8 pr-3 py-2 text-sm text-white focus:border-port-accent focus:outline-none"
          />
        </div>
        <select
          value={stageFilter}
          onChange={(e) => setParam('stage', e.target.value)}
          aria-label="Filter by stage"
          className={selectClass}
        >
          <option value="">All stages</option>
          {SONG_STAGES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <select
          value={instrumentFilter}
          onChange={(e) => setParam('instrument', e.target.value)}
          aria-label="Filter by instrument"
          className={selectClass}
        >
          <option value="">All instruments</option>
          {INSTRUMENTS.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
        </select>
        {tagFilter && (
          <button
            type="button"
            onClick={() => setParam('tag', '')}
            className="flex items-center gap-1 px-2 py-1 rounded-full text-xs bg-port-accent/10 text-port-accent border border-port-accent/20 hover:bg-port-accent/20"
            aria-label={`Clear tag filter ${tagFilter}`}
          >
            #{tagFilter}
            <X size={12} />
          </button>
        )}
      </div>

      {/* Grid */}
      {loading ? (
        <p className="text-sm text-gray-500">Loading songs…</p>
      ) : filtered.length === 0 ? (
        songs.length === 0 ? (
          <EmptyState
            icon={ListMusic}
            title="No songs yet"
            message="Add the first song you're learning — create one above, or import a tab from a URL or paste."
            actionTo="/songbook/import"
            actionLabel="Import a song"
          />
        ) : (
          <p className="text-sm text-gray-500">No songs match the current filters.</p>
        )
      ) : (
        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {filtered.map((song) => (
            <li
              key={song.id}
              className="group bg-port-card border border-port-border rounded-lg flex items-start gap-3 px-4 py-3 hover:border-port-accent/50"
            >
              <Link to={`/songbook/${song.id}`} className="flex-1 min-w-0">
                <div className="text-white font-medium truncate" title={song.title}>{song.title}</div>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-gray-500 mt-1">
                  {song.artist && <span className="text-gray-400">{song.artist}</span>}
                  {song.instrument && <span>{instrumentLabel(song.instrument)}</span>}
                  {song.updatedAt && <span>Edited {timeAgo(song.updatedAt)}</span>}
                </div>
                {Array.isArray(song.tags) && song.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {song.tags.map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        onClick={(e) => { e.preventDefault(); setParam('tag', tag); }}
                        className="px-1.5 py-0.5 rounded-full text-[10px] bg-port-bg text-gray-400 border border-port-border hover:text-port-accent hover:border-port-accent/40"
                      >
                        #{tag}
                      </button>
                    ))}
                  </div>
                )}
              </Link>
              <div className="flex flex-col items-end gap-2 shrink-0">
                <select
                  value={song.stage || 'new'}
                  onChange={(e) => onStageChange(song.id, e.target.value)}
                  aria-label={`Stage for ${song.title}`}
                  className={`text-xs rounded-full border px-2 py-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-port-accent ${SONG_STAGE_COLORS[song.stage] || SONG_STAGE_COLORS.new}`}
                >
                  {SONG_STAGES.map((s) => <option key={s.id} value={s.id} className="bg-port-card text-white">{s.label}</option>)}
                </select>
                {isConfirming(song.id) ? (
                  <ConfirmButtonPair
                    prompt="Delete?"
                    ariaLabel={`Confirm delete ${song.title}`}
                    onConfirm={() => onDelete(song)}
                    onCancel={cancelDelete}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => requestDelete(song.id)}
                    className="p-1.5 text-gray-500 hover:text-port-error"
                    aria-label={`Delete ${song.title}`}
                    title="Delete song"
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      </div>
    </div>
  );
}
