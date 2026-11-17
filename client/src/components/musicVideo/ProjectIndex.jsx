import { useMemo } from 'react';
import InfiniteScrollFooter from '../ui/InfiniteScrollFooter';
import MusicVideoProjectCard from './MusicVideoProjectCard.jsx';
import { groupMusicVideoProjects } from '../../lib/musicVideoProjectList.js';
import { latestMusicVideoReviewDraft } from '../../../../server/lib/musicVideo/musicVideoReviewDraft.js';

/**
 * The project index grid: forks collapse under their root with a per-card
 * version switcher, filtered by the URL's name query. The picked version per
 * root is held by the page so it survives opening a project and coming back.
 */
export default function ProjectIndex({
  projects, statusFilter, nameQuery, onNameQueryChange, summaries, pickedVersion, onPickVersion, trackName,
  onSelect, onClone, deletion, cloningId, onRename,
}) {
  const projectGroups = useMemo(() => groupMusicVideoProjects(projects, nameQuery), [projects, nameQuery]);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-port-text-muted">
          Projects ({summaries.hasMore ? `${projectGroups.length}+` : projectGroups.length})
        </h2>
        <label htmlFor="mv-project-filter" className="sr-only">Filter projects by name</label>
        <input
          id="mv-project-filter"
          type="search"
          value={nameQuery}
          onChange={(e) => onNameQueryChange(e.target.value)}
          placeholder="Filter by name…"
          className="min-w-0 w-full sm:w-64 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm"
        />
      </div>
      {!summaries.loaded && summaries.loading && <p className="text-sm text-port-text-muted">Searching projects…</p>}
      {summaries.loaded && projectGroups.length === 0 && (
        <p className="text-sm text-port-text-muted">{nameQuery.trim()
          ? <>No projects match &ldquo;{nameQuery}&rdquo;.</>
          : statusFilter === 'all' ? 'No music video projects yet. Create your first project above to get started.'
            : statusFilter === 'completed' ? 'No completed projects.' : 'No projects in progress.'}</p>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" data-testid="mv-project-grid">
        {projectGroups.map(({ rootId, versions }) => {
          const picked = versions.findIndex((v) => v.id === pickedVersion[rootId]);
          const versionIndex = picked >= 0 ? picked : 0;
          const project = versions[versionIndex];
          return (
            <MusicVideoProjectCard
              key={rootId}
              project={project}
              trackLabel={trackName(project.trackId)}
              onSelect={() => onSelect(project.id)}
              onReview={project.preview?.source === 'final' || project.preview?.source === 'animatic' || project.renderHistoryId || latestMusicVideoReviewDraft(project)
                ? () => onSelect(project.id, 'review') : null}
              onClone={(options) => onClone(project, options)}
              isConfirmingDelete={deletion.isConfirming(project.id)}
              onRequestDelete={() => deletion.request(project.id)}
              onConfirmDelete={() => deletion.confirm(project.id)}
              onCancelDelete={deletion.cancel}
              cloning={cloningId === project.id}
              versionCount={versions.length}
              versionIndex={versionIndex}
              onRename={() => onRename(project)}
              onVersionStep={(delta) => {
                const target = versions[versionIndex + delta];
                if (target) onPickVersion(rootId, target.id);
              }}
            />
          );
        })}
      </div>
      <InfiniteScrollFooter
        hasMore={summaries.hasMore}
        loading={summaries.loading}
        error={summaries.error}
        onLoadMore={summaries.loadMore}
        label="Load more projects"
      />
    </div>
  );
}
