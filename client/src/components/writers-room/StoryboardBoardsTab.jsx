import { Loader2, Palette } from 'lucide-react';
import { timeAgo } from '../../utils/formatters';
import { STYLE_ID } from '../../lib/wrImageDefaults';
import SceneCard from './SceneCard';
import {
  StoryboardSetup,
  FailedAdaptBanner,
  BiblesMissingNotice,
  StaleBanner,
} from './StoryboardBoardsBanners';

function styleChip(style, presets) {
  if (!style || style.presetId === STYLE_ID.NONE) return null;
  if (style.presetId === STYLE_ID.CUSTOM) return 'Custom style';
  const p = presets.find((x) => x.id === style.presetId);
  return p?.label || style.presetId;
}

// ─── Boards (storyboard scene cards / render dock) ─────────────────────────
export default function StoryboardBoardsTab({
  work,
  scenes,
  sceneImages,
  latestScript,
  latestFailure,
  loading,
  isStale,
  imageCfg,
  imageStyle,
  stylePresets,
  charByKey,
  placeByKey,
  charactersCount,
  placesCount,
  sceneRefs,
  onJumpToScene,
  onDebug,
  onRunAdapt,
  onRunCharacters,
  onRunPlaces,
  onRunFullPipeline,
  runningAdapt,
  runningKind,
  readingTheme,
  activeSceneId,
  onOpenConfig,
  hotRef = null,
  onSceneHover,
  onSceneRenderStart,
}) {
  return (
    <div className="px-3 py-3 space-y-2">
      {/* Live rendering status moved to the page-level WritersRoomDock so it's
          visible from any tab, not just Boards. */}
      {latestScript && (
        <div className="flex items-center gap-2 pb-2 text-[10px] text-gray-500">
          <span>{scenes.length} scene{scenes.length === 1 ? '' : 's'} · {timeAgo(latestScript.completedAt || latestScript.createdAt, 'never')}</span>
          {imageStyle.presetId !== STYLE_ID.NONE && (
            <button
              type="button"
              onClick={onOpenConfig}
              className="text-port-accent/80 hover:text-port-accent flex items-center gap-1"
              title="World style applied — click to edit in Config"
            >
              <Palette size={10} /> {styleChip(imageStyle, stylePresets)}
            </button>
          )}
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center text-[11px] text-gray-500 gap-2 py-6">
          <Loader2 size={14} className="animate-spin" /> Loading storyboard…
        </div>
      )}

      {!loading && latestFailure && (
        <FailedAdaptBanner
          failure={latestFailure}
          onRunAdapt={onRunAdapt}
          runningAdapt={runningAdapt}
          onOpenConfig={onOpenConfig}
          hasPriorScript={!!latestScript}
        />
      )}

      {!loading && !latestScript && !latestFailure && (
        <StoryboardSetup
          charactersCount={charactersCount}
          placesCount={placesCount}
          onRunCharacters={onRunCharacters}
          onRunPlaces={onRunPlaces}
          onRunAdapt={onRunAdapt}
          onRunFullPipeline={onRunFullPipeline}
          runningKind={runningKind}
        />
      )}

      {!loading && latestScript && isStale && !latestFailure && (
        <StaleBanner onRunAdapt={onRunAdapt} runningAdapt={runningAdapt} />
      )}

      {!loading && latestScript && !isStale && !latestFailure && (charactersCount === 0 || placesCount === 0) && (
        <BiblesMissingNotice
          charactersMissing={charactersCount === 0}
          placesMissing={placesCount === 0}
          onRunCharacters={onRunCharacters}
          onRunPlaces={onRunPlaces}
          runningKind={runningKind}
        />
      )}

      {!loading && latestScript && scenes.length === 0 && (
        <div className="text-[11px] text-gray-500 italic px-1">
          Adapt finished but produced no scenes. Try adding `## Scene` headings to your prose, then re-run.
        </div>
      )}

      {!loading && scenes.map((scene, i) => {
        const sceneId = scene.id || `scene-${i}`;
        return (
          <SceneCard
            key={sceneId}
            ref={(handle) => {
              if (handle) sceneRefs.current[sceneId] = handle;
              else delete sceneRefs.current[sceneId];
            }}
            scene={{ ...scene, id: sceneId }}
            sceneNumber={i + 1}
            workId={work.id}
            analysisId={latestScript.id}
            workTitle={work.title}
            imageCfg={imageCfg}
            imageStyle={imageStyle}
            initialImage={sceneImages[sceneId] || null}
            readingTheme={readingTheme}
            charByKey={charByKey}
            placeByKey={placeByKey}
            isActive={sceneId === activeSceneId}
            onJumpToProse={onJumpToScene ? () => onJumpToScene(scene, i, scenes.length) : null}
            onDebug={onDebug}
            hotRef={hotRef}
            onHoverEnter={onSceneHover ? () => onSceneHover(sceneId) : null}
            onHoverLeave={onSceneHover ? () => onSceneHover(null) : null}
            onRenderStart={onSceneRenderStart}
          />
        );
      })}
    </div>
  );
}
