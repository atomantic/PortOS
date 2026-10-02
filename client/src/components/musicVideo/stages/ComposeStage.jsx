import { RenderFailure } from '../RenderStatusPanel.jsx';
import GradePanel from '../GradePanel.jsx';
import TypographyPanel from '../TypographyPanel.jsx';
import CodeVideoPanel from '../CodeVideoPanel.jsx';
import DocumentCompositionPanel from '../DocumentCompositionPanel.jsx';
import { RenderStyleSelect } from '../ProjectActionGroups.jsx';

/**
 * Compose: how the final render is put together — the render style, the timed
 * typography, and (per style) the code-rendered or composition-document
 * panel. The preview of what this produces is docked beside these panels.
 */
export default function ComposeStage({ board }) {
  const { project, locked, audioUrl } = board;
  const mode = project.composition?.mode;
  return (
    <fieldset disabled={locked} className="min-w-0">
      <RenderFailure project={project} renderJob={board.renderJob} />
      <div className="space-y-2 rounded-lg border border-port-border bg-port-card p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-port-text-muted" aria-hidden="true">Render style</span>
          <RenderStyleSelect project={project} onRenderStyle={board.onRenderStyle} />
        </div>
        <GradePanel project={project} onSave={board.saveCompositionGrade} />
        <TypographyPanel project={project} onEditLocal={board.editProjectLocal} onSave={board.saveProjectFields} />
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
