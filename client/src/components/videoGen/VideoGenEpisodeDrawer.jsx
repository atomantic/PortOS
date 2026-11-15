import Drawer from '../Drawer';
import ListLoadError from '../ui/ListLoadError';
import EpisodeComposer from './EpisodeComposer';

/** The Episode Composer drawer; `episode` is `useVideoGenEpisodeImport()`. */
export default function VideoGenEpisodeDrawer({ episode, onQueued }) {
  const {
    episodeOpen, closeEpisodeComposer, episodeImportKey, episodeImportScenes,
    episodeImportError, episodeImportPending, retryEpisodeImport,
  } = episode;
  return (
    <Drawer open={episodeOpen} onClose={closeEpisodeComposer} title="Episode Composer" size="xl" closeOnBackdrop={false}>
      {episodeOpen && episodeImportError && (
        <ListLoadError
          what="the FableLoom episode"
          error={episodeImportError}
          onRetry={retryEpisodeImport}
          retrying={episodeImportPending}
          className="mb-3"
        />
      )}
      {/* Keyed by target: the composer applies an import only once, so a new
          episode needs a fresh composer rather than the last one's scenes. */}
      {episodeOpen && <EpisodeComposer key={episodeImportKey ?? 'blank'} initialScenes={episodeImportScenes} onQueued={onQueued} />}
    </Drawer>
  );
}
