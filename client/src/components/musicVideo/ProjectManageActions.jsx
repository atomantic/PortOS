import { Clapperboard, Copy, Trash2 } from 'lucide-react';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';

const buttonCls = 'flex min-h-[44px] items-center gap-1 rounded border border-port-border bg-port-bg px-2.5 py-1.5 text-sm disabled:opacity-50 sm:min-h-0';

/**
 * The project's fork and delete controls, in Project settings › Project so the
 * page header carries only the title, the next step and the settings gear.
 * `onFork(options)` forks the open project (`{ variant: 'video-generation' }`
 * for the footage fork); delete asks for an inline confirm first.
 */
export default function ProjectManageActions({ project, cloning, onFork, confirmingDelete, onDeleteRequest, onDeleteConfirm, onDeleteCancel }) {
  const nextVersion = (project.version || 1) + 1;
  return (
    <section aria-label="Versions and delete" className="flex min-w-0 flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => onFork()}
        disabled={cloning}
        title={`Create an editable v${nextVersion}; keep scene media attached and clear the final render`}
        className={buttonCls}
      >
        <Copy size={15} aria-hidden="true" /> {cloning ? 'Forking…' : `Fork v${nextVersion}`}
      </button>
      <button
        type="button"
        onClick={() => onFork({ variant: 'video-generation' })}
        disabled={cloning}
        aria-label="Fork for video generation"
        title="Fork for video generation: keep the song and storyboard; start fresh cast, sets and mood board with footage rendering. No generation starts."
        className={buttonCls}
      >
        <Clapperboard size={15} aria-hidden="true" /> Fork
      </button>
      <div className="ml-auto">
        {confirmingDelete ? (
          <ConfirmButtonPair
            prompt="Delete?"
            confirmText="Delete"
            ariaLabel={`Confirm delete project ${project.name}`}
            confirmAriaLabel={`Confirm delete project ${project.name}`}
            onConfirm={onDeleteConfirm}
            onCancel={onDeleteCancel}
          />
        ) : (
          <button
            type="button"
            onClick={onDeleteRequest}
            title="Delete project"
            aria-label="Delete project"
            className={`${buttonCls} text-port-error`}
          >
            <Trash2 size={15} aria-hidden="true" /> Delete
          </button>
        )}
      </div>
    </section>
  );
}
