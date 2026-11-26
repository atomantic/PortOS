import { useCallback } from 'react';
import { Film, Image as ImageIcon, Music } from 'lucide-react';
import { LibraryTile, StillTile, AudioRow } from './VideoTimelineLanes';
import TabPills from '../ui/TabPills';

const LIBRARY_TABS = [
  { id: 'clips', label: 'Clips', icon: Film },
  { id: 'stills', label: 'Stills', icon: ImageIcon },
  { id: 'audio', label: 'Audio', icon: Music },
];


export default function VideoTimelineLibrary({ library, playheadRef, total }) {
  const {
    libraryTab, setLibraryTab, imageQuery, setImageQuery, stills,
    libraryClips, usedClipIds, musicTracks, catalogStatus, retryCatalog,
    addClip, addStill, addOverlay, addBed,
  } = library;
  const addOverlayAtPlayhead = useCallback((image) => addOverlay(image, playheadRef.current, total), [addOverlay, playheadRef, total]);
  const addBedAtPlayhead = useCallback((track) => addBed(track, playheadRef.current, total), [addBed, playheadRef, total]);

  const catalogNotice = (kind) => {
    const status = catalogStatus[kind];
    if (!status.loadFailure) return null;
    return (
      <div role="status" className="text-xs text-port-error px-1 py-2 flex flex-wrap items-center gap-2">
        <span>{status.loadFailure}</span>
        <button
          type="button"
          onClick={() => retryCatalog(kind)}
          disabled={status.pending}
          className="min-h-[44px] text-port-accent disabled:opacity-50"
        >
          {status.pending ? 'Retrying…' : 'Retry'}
        </button>
      </div>
    );
  };
  return (
    <div
      id="timeline-library"
      className="order-2 lg:order-1 bg-port-card/50 border border-port-border rounded-lg p-2 max-h-[600px] overflow-y-auto"
    >
      {/* The shared TabPills owns the roving tabindex + arrow-key contract —
          never roll a tab bar (client/src/AGENTS.md). */}
      <TabPills
        variant="pills"
        size="xs"
        tabs={LIBRARY_TABS}
        activeTab={libraryTab}
        onChange={setLibraryTab}
        ariaLabel="Clip library"
        className="mb-2"
      />

      {libraryTab === 'clips' && catalogNotice('clips')}
      {libraryTab === 'clips' && (libraryClips.length === 0 ? (
        !catalogStatus.clips.loadFailure && <div className="text-xs text-gray-500 px-1 py-4">No clips. Generate some on the Video page.</div>
      ) : (
        <div className="grid grid-cols-1 gap-2">
          {libraryClips.map((clip) => (
            <div key={clip.id} className={usedClipIds.has(clip.id) ? 'ring-1 ring-port-accent/40 rounded-md' : ''}>
              <LibraryTile clip={clip} onAdd={addClip} />
            </div>
          ))}
        </div>
      ))}

      {libraryTab === 'stills' && <div>
        <label htmlFor="timeline-image-search" className="sr-only">Search images</label>
        <input id="timeline-image-search" value={imageQuery} onChange={event => setImageQuery(event.target.value)} placeholder="Search images…" className="w-full p-2 mb-2 bg-port-bg border border-port-border rounded" />
        {stills.error && <p role="alert">{stills.error} <button type="button" onClick={stills.retry}>Retry</button></p>}
        {stills.hasMore && <button type="button" onClick={stills.loadMore} disabled={stills.loading} className="min-h-[44px] text-port-accent">Show more ({stills.total - stills.items.length} remaining)</button>}
      </div>}
      {libraryTab === 'stills' && (stills.items.length === 0 ? (
        <div className="text-xs text-gray-500 px-1 py-4">No images. Generate some on the Image page.</div>
      ) : (
        <div className="grid grid-cols-1 gap-2">
          {stills.items.map((image) => (
            <StillTile key={image.filename} image={image} onAddStill={addStill} onAddOverlay={addOverlayAtPlayhead} />
          ))}
        </div>
      ))}

      {libraryTab === 'audio' && catalogNotice('music')}
      {libraryTab === 'audio' && (musicTracks.length === 0 ? (
        !catalogStatus.music.loadFailure && <div className="text-xs text-gray-500 px-1 py-4">No audio in the shared music library.</div>
      ) : (
        <div className="grid grid-cols-1 gap-1.5">
          {musicTracks.map((track) => (
            <AudioRow key={track.filename} track={track} onAdd={addBedAtPlayhead} />
          ))}
        </div>
      ))}
    </div>
  );
}
