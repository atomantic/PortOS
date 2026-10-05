import { RenderFailure } from '../RenderStatusPanel.jsx';
import GradePanel from '../GradePanel.jsx';
import TypographyPanel from '../TypographyPanel.jsx';
import EidoverseVideoPanel from '../EidoverseVideoPanel.jsx';
import CodeVideoPanel from '../CodeVideoPanel.jsx';
import DocumentCompositionPanel from '../DocumentCompositionPanel.jsx';
import { renderStyleLabel } from '../compositionDraft.js';
import { MUSIC_VIDEO_MEDIA_MODE_LABELS, musicVideoMediaMode } from '../../../../../server/lib/musicVideoMediaPolicy.js';

/**
 * The composition half of Make: how the final render is put together — grade,
 * timed typography and (per render style, set in Project settings) the
 * code-rendered or composition-document panel. The preview of what this
 * produces is docked beside the step.
 */
export default function ComposeStage({ board }) {
  const { project, locked, audioUrl } = board;
  const mode = project.composition?.mode;
  return (
    <fieldset disabled={locked} className="min-w-0">
      <RenderFailure project={project} renderJob={board.renderJob} />
      <div className="space-y-2 rounded-lg border border-port-border bg-port-card p-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-port-text-muted">
          <span>Render style: <span className="text-port-text">{renderStyleLabel(mode)}</span></span>
          <span>Media: <span className="text-port-text">{MUSIC_VIDEO_MEDIA_MODE_LABELS[musicVideoMediaMode(project)]}</span></span>
          <button type="button" onClick={() => board.openSettings('project')} className="min-h-[44px] px-1 text-port-accent sm:min-h-0">
            Change
          </button>
        </div>
        {mode !== 'document' && (
          <p className="text-xs text-port-text-muted" role="status">
            No live preview for this style — render a draft excerpt to check changes.{' '}
            <button type="button" onClick={() => board.goToStage('review', 'mv-draft-excerpts')} className="min-h-[44px] px-1 text-port-accent sm:min-h-0">Render a draft excerpt</button>
          </p>
        )}
        <GradePanel project={project} onSave={board.saveCompositionGrade} />
        {mode !== 'eidoverse' && <TypographyPanel project={project} onEditLocal={board.editProjectLocal} onSave={board.saveProjectFields} />}
        {mode === 'eidoverse' && <EidoverseVideoPanel key={project.id} project={project} onProject={board.replaceProject} productionReadiness={board.productionReadiness} />}
        {mode === 'code' && (
          <CodeVideoPanel project={project} audioUrl={audioUrl} onProject={board.replaceProject} />
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
  );
}
