import StoryboardPanel from './StoryboardPanel';
import LiveContinuationPanel from './LiveContinuationPanel';
import LiveRenderPanel from './LiveRenderPanel';
import CdBridgePanel from './CdBridgePanel';
import { ANALYSIS_KIND } from './useWorkAnalysisPipeline';

export default function WorkEditorSidebar({
  work, onChange, hidden, sidebarWidth, sidebarTab, setSidebarTab, readingTheme, activeSceneId,
  body, dirty, hotRef, setHotScene,
  analysis: {
    characters, places, objects, bibleStatus, retryBible, setCharacters, setPlaces, setObjects,
    runObjects, runAdapt, runCharacters, runPlaces, runFullPipeline, runningKind,
  },
  liveDirector: {
    showLiveDirector, liveMode, liveUsage, setLiveUsage, getCursorOffset, getCursorContext,
    liveRenderContext, setLiveRenderContext, registerSceneImageMerge, handleSceneImageAttached,
    insertAtCursor, registerLiveTrigger,
  },
  queueRegister, setLatestScenes, jumpToScene, handleDebug, commitImageStyle,
}) {
  return (
    <aside
      style={{ '--sidebar-w': `${sidebarWidth}px` }}
      className={`border-t lg:border-t-0 border-port-border bg-port-card/60 flex flex-col text-xs min-h-0 w-full flex-1 lg:flex-initial lg:w-[var(--sidebar-w)] lg:shrink-0 ${
        hidden ? 'hidden lg:flex' : 'flex'
      }`}
    >
      {showLiveDirector && (
        <>
          <LiveRenderPanel
            workId={work.id}
            liveMode={liveMode}
            getCursorOffset={getCursorOffset}
            body={body}
            renderContext={liveRenderContext}
            registerQueue={queueRegister}
            onSceneImageAttached={handleSceneImageAttached}
            workTitle={work.title}
          />
          <div className="shrink-0 max-h-[40%] min-h-0 border-b border-port-border overflow-hidden flex flex-col">
            <LiveContinuationPanel
              workId={work.id}
              liveMode={liveMode}
              usage={liveUsage}
              onUsageChange={setLiveUsage}
              getCursorContext={getCursorContext}
              onInsert={insertAtCursor}
              registerTrigger={registerLiveTrigger}
            />
          </div>
          <CdBridgePanel
            workId={work.id}
            liveMode={liveMode}
            usage={liveUsage}
            onUsageChange={setLiveUsage}
            getCursorContext={getCursorContext}
            onLinked={(cdProjectId) => onChange?.({ ...work, cdProjectId })}
          />
        </>
      )}
      <StoryboardPanel
        work={work}
        characters={characters}
        places={places}
        objects={objects}
        bibleStatus={bibleStatus}
        onRetryBible={retryBible}
        onCharactersChange={setCharacters}
        onPlacesChange={setPlaces}
        onObjectsChange={setObjects}
        onRunObjects={runObjects}
        onScenesChange={setLatestScenes}
        onLiveRenderContextChange={setLiveRenderContext}
        registerSceneImageMerge={registerSceneImageMerge}
        onJumpToScene={jumpToScene}
        onDebug={handleDebug}
        onRunAdapt={runAdapt}
        onRunCharacters={runCharacters}
        onRunPlaces={runPlaces}
        onRunFullPipeline={runFullPipeline}
        runningAdapt={runningKind === ANALYSIS_KIND.SCRIPT}
        runningKind={runningKind}
        readingTheme={readingTheme}
        activeSceneId={activeSceneId}
        onStyleChange={commitImageStyle}
        hotRef={hotRef}
        onSceneHover={setHotScene}
        onSceneRenderStart={queueRegister}
        tab={sidebarTab}
        onTabChange={setSidebarTab}
        dirty={dirty}
      />
    </aside>
  );
}
