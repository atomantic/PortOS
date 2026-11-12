import { RenderFailure } from './RenderStatusPanel.jsx';
import GradePanel from './GradePanel.jsx';
import FilmLookPanel from './FilmLookPanel.jsx';
import TypographyPanel from './TypographyPanel.jsx';
import EidoverseVideoPanel from './EidoverseVideoPanel.jsx';
import CodeVideoPanel from './CodeVideoPanel.jsx';
import DocumentCompositionPanel from './DocumentCompositionPanel.jsx';
import BlenderFilmPanel, { FILM_LOOK_ANCHOR } from './BlenderFilmPanel.jsx';
import { renderStyleLabel } from './compositionDraft.js';
import { MUSIC_VIDEO_MEDIA_MODE_LABELS, musicVideoMediaMode } from '../../../../server/lib/musicVideoMediaPolicy.js';

/**
 * The composition half of Make: how the final render is put together — grade,
 * timed typography and (per render style, set in Project settings) the
 * code-rendered, composition-document or Blender film panel. The preview of
 * what this produces is docked beside the step.
 *
 * A Blender film leads with its own panel (the docked preview plays its
 * shots' renders live) and keeps the Film look: that finishing pass runs over
 * its final render like any other. It has no typography panel (lettering is authored in
 * Blender, and the automatic lyric overlay is not applied). Its grade is
 * available alongside the Film look as part of the finishing controls.
 */
export default function CompositionPanel({ board }) {
  const { project, locked, audioUrl } = board;
  const mode = project.composition?.mode;
  const blender = mode === 'blender';
  const filmLook = <FilmLookPanel project={project} activeSceneId={board.activeSceneId} onEditLocal={board.editProjectLocal} onSave={board.saveProjectFields} />;
  const failure = <RenderFailure project={project} renderJob={board.renderJob} onPatchShots={board.onPatchShots} onRenderClips={board.onRenderClips} />;
  return (
    <>
      {blender && <fieldset disabled={locked} className="min-w-0">{failure}</fieldset>}
      {/* Outside the save lock: nothing in the film panel writes through the project record. */}
      {blender && <BlenderFilmPanel board={board} />}
      <fieldset disabled={locked} className="min-w-0">
        {!blender && failure}
        <div className="space-y-2 rounded-lg border border-port-border bg-port-card p-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-port-text-muted">
            <span>Render style: <span className="text-port-text">{renderStyleLabel(mode)}</span></span>
            <span>Media: <span className="text-port-text">{MUSIC_VIDEO_MEDIA_MODE_LABELS[musicVideoMediaMode(project)]}</span></span>
            <button type="button" onClick={() => board.openSettings('project')} aria-label="Change render style and media in Project settings" className="min-h-[44px] px-1 text-port-accent pointer-fine:sm:min-h-0">
              Change
            </button>
          </div>
          {(!mode || mode === 'concat' || mode === 'eidoverse') && (
            <p className="text-xs text-port-text-muted" role="status">
              No live preview for this style — render a draft excerpt to check changes.{' '}
              <button type="button" onClick={() => board.goToStage('review', 'mv-draft-excerpts')} className="min-h-[44px] px-1 text-port-accent pointer-fine:sm:min-h-0">Render a draft excerpt</button>
            </p>
          )}
          <GradePanel project={project} onSave={board.saveCompositionGrade} />
          {blender ? <div id={FILM_LOOK_ANCHOR} tabIndex={-1} className="focus:outline-none">{filmLook}</div> : filmLook}
          {mode !== 'eidoverse' && !blender && <TypographyPanel project={project} onEditLocal={board.editProjectLocal} onSave={board.saveProjectFields} />}
          {mode === 'eidoverse' && <EidoverseVideoPanel key={project.id} project={project} onProject={board.replaceProject} />}
          {mode === 'code' && (
            <CodeVideoPanel project={project} audioUrl={audioUrl} onProject={board.replaceProject} productionReadiness={board.productionReadiness} />
          )}
          {mode === 'document' && (
            <DocumentCompositionPanel
              key={`document-${project.id}`}
              project={project}
              audioUrl={audioUrl}
              onProject={board.replaceProject}
              onSave={board.saveProjectFields}
            />
          )}
        </div>
      </fieldset>
    </>
  );
}
