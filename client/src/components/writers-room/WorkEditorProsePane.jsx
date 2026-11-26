import { useMemo } from 'react';
import { countWords } from '../../lib/textUtils';
import { formatCount } from '../../utils/formatters';
import ProseEditor from '../ui/ProseEditor';
import ProseReader from './ProseReader';
import SyncedReview from './SyncedReview';

export default function WorkEditorProsePane({
  viewMode, work, hidden, body, dirty, readOnly, onEdit, textareaRef, readerRef,
  readingTheme, latestScenes, activeSceneId, characters, places, objects,
  hotRef, pop, hotScene, setHotScene, handleTokenEnter, handleTokenLeave, handleTokenClick,
}) {
  const wordCount = useMemo(() => countWords(body), [body]);
  return (
    <div className={`relative min-h-0 flex-1 ${hidden ? 'hidden lg:block' : 'block'}`}>
      {viewMode === 'review' ? (
        <SyncedReview work={work} />
      ) : viewMode === 'read' ? (
        <div ref={readerRef} className="w-full h-full">
          <ProseReader
            body={body}
            scenes={latestScenes}
            characters={characters}
            places={places}
            objects={objects}
            readingTheme={readingTheme}
            activeSceneId={activeSceneId}
            hotRef={hotRef}
            pinnedToken={pop?.pinned ? pop : null}
            hotScene={hotScene}
            onTokenEnter={handleTokenEnter}
            onTokenLeave={handleTokenLeave}
            onTokenClick={handleTokenClick}
            onSceneEnter={setHotScene}
            onSceneLeave={() => setHotScene(null)}
          />
        </div>
      ) : (
        <ProseEditor
          ref={textareaRef}
          value={body}
          readOnly={readOnly}
          aria-busy={readOnly}
          onChange={(event) => onEdit(event.target.value)}
          readingTheme={readingTheme}
          className="w-full h-full resize-none px-6 py-6 text-base focus:outline-none"
        />
      )}
      {viewMode !== 'review' && (
        <div
          className={`absolute bottom-2 right-3 flex items-center gap-3 text-[11px] px-2 py-1 rounded pointer-events-none ${
            readingTheme === 'light' ? 'text-gray-700 bg-[var(--wr-reading-paper)]/85' : 'text-gray-500 bg-port-bg/80'
          }`}
        >
          <span>{formatCount(wordCount)} words</span>
          {dirty && <span className="text-port-warning">● unsaved</span>}
        </div>
      )}
    </div>
  );
}
