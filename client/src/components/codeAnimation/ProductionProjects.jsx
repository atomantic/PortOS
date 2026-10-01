import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { useSocketResource } from '../../hooks/useSocketResource';
import { useSocketSubscription } from '../../hooks/useSocketSubscription';
import { usePagedCollection } from '../../hooks/usePagedCollection';
import socket from '../../services/socket';
import {
  listCodeAnimationProjects, createCodeAnimationProject, getCodeAnimationProject,
  updateCodeAnimationProject, importCodeAnimationPackage, acceptCodeAnimationSource,
  getCodeAnimationProjectBrief, getCodeAnimationRevisionPackage, listCodeAnimationProjectHistory,
} from '../../services/apiCodeAnimation';
import { downloadBlob } from '../../lib/downloadBlob';
import { formatCount, formatBytes, timeAgo } from '../../utils/formatters';
import InfiniteScrollFooter from '../ui/InfiniteScrollFooter';
import ProductionProjectForm from './ProductionProjectForm';

const EVENTS = ['code-animation:changed'];
const buttonClass = 'rounded border border-port-border px-3 py-2 text-sm hover:border-port-accent disabled:opacity-50';

export default function ProductionProjects() {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const [dirty, setDirty] = useState(false);
  const loadProjects = useCallback(({ cursor, signal }) => listCodeAnimationProjects({ cursor, signal }), []);
  const projects = usePagedCollection(loadProjects);
  const resource = useSocketResource(({ signal }) => getCodeAnimationProject(projectId, { signal, silent: true }), {
    namespace: 'code-animation', events: EVENTS, resourceKey: projectId, enabled: !!projectId,
    matchesEvent: payload => payload?.id === projectId,
  });
  const loadHistory = useCallback(({ cursor, signal }) => listCodeAnimationProjectHistory(projectId, { cursor, signal }), [projectId]);
  const history = usePagedCollection(loadHistory, { enabled: !!projectId });
  useSocketSubscription('code-animation', { onResubscribe: () => {
    projects.refreshFirst();
    if (projectId) history.refreshFirst();
  } });
  useEffect(() => {
    const changed = payload => {
      projects.refreshFirst();
      if (projectId && payload?.id === projectId) history.refreshFirst();
    };
    socket.on('code-animation:changed', changed);
    return () => socket.off('code-animation:changed', changed);
  }, [projectId, projects.refreshFirst, history.refreshFirst]);

  const [act, busy] = useAsyncAction(async operation => operation());
  const applyProject = project => {
    resource.updateData(project);
    projects.setItems(previous => [project, ...previous.filter(item => item.id !== project.id)]);
  };
  const save = input => act(async () => {
    const project = projectId
      ? await updateCodeAnimationProject(projectId, input, { silent: true })
      : await createCodeAnimationProject(input, { silent: true });
    applyProject(project);
    if (!projectId) navigate(`/code-animation/production/${project.id}`);
    return project;
  });
  const importFile = event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    act(async () => {
      if (file.size > 55 * 1024 * 1024) throw new Error('Package file exceeds the import size limit');
      const result = await importCodeAnimationPackage(projectId, JSON.parse(await file.text()), { silent: true });
      applyProject(result.project);
      history.setItems(previous => [{
        id: result.runId, status: 'completed', revisionId: result.revision.id,
        createdAt: result.revision.createdAt,
        data: { kind: 'package-import', executed: false, packageHash: result.revision.packageHash, totalBytes: result.revision.totalBytes },
      }, ...previous]);
    });
  };
  const download = (revisionId = null) => act(async () => {
    const data = revisionId
      ? await getCodeAnimationRevisionPackage(projectId, revisionId, { silent: true })
      : await getCodeAnimationProjectBrief(projectId, { silent: true });
    downloadBlob(JSON.stringify(data, null, 2), revisionId ? `source-${revisionId}.json` : 'animation-brief.json', 'application/json');
  });
  const project = resource.data;
  return <div className="space-y-4">
    <section className="space-y-3 rounded-xl border border-port-border bg-port-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">Production projects</h2>
        <Link to="/code-animation/production" className={buttonClass}>New Production project</Link>
      </div>
      <p className="text-sm text-gray-400">Keep a film brief, independent budgets and immutable source revisions. Import and source acceptance stage files; rendering and evidence review are separate production stages.</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {projects.items.map(item => <Link key={item.id} to={`/code-animation/production/${item.id}`} className="min-w-0 rounded border border-port-border p-3 hover:border-port-accent" aria-current={item.id === projectId ? 'page' : undefined}>
          <span className="block truncate font-medium">{item.title || 'Untitled production'}</span>
          <span className="text-xs text-gray-400">{item.acceptedRevisionId ? 'Accepted source' : 'No accepted source'} · {timeAgo(item.createdAt)}</span>
        </Link>)}
      </div>
      <InfiniteScrollFooter hasMore={projects.hasMore} loading={projects.loading} error={projects.error} onLoadMore={projects.loadMore} autoLoad={false} label="Load older projects" />
    </section>

    {projectId && resource.loading && <p>Loading production project…</p>}
    {resource.error && <div role="alert" className="rounded border border-port-error p-3">
      <p>{resource.error.status === 404 ? 'Production project not found' : resource.error.message}</p>
      {resource.error.status !== 404 && <button className={buttonClass} onClick={resource.refetch}>Retry project</button>}
    </div>}
    {(!projectId || project) && <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <section className="min-w-0 space-y-3 rounded-xl border border-port-border bg-port-card p-4">
        <h2 className="text-base font-semibold">{project ? project.title || 'Untitled production' : 'New Production project'}</h2>
        <ProductionProjectForm key={projectId || 'new'} project={project} onSave={save} busy={busy} onDirtyChange={setDirty} />
      </section>
      {project && <section className="min-w-0 space-y-4 rounded-xl border border-port-border bg-port-card p-4">
        <h2 className="text-base font-semibold">Source and history</h2>
        <div className="flex flex-wrap gap-2">
          <button className={buttonClass} disabled={busy || dirty} onClick={() => download()}>Export brief</button>
          {project.acceptedRevisionId && <button className={buttonClass} disabled={busy} onClick={() => download(project.acceptedRevisionId)}>Export accepted package</button>}
          {project.candidateRevisionId && <>
            <button className={buttonClass} disabled={busy} onClick={() => download(project.candidateRevisionId)}>Export candidate package</button>
            <button className={buttonClass} disabled={busy} onClick={() => act(async () => applyProject(await acceptCodeAnimationSource(projectId, project.candidateRevisionId, { silent: true })))}>Accept candidate source</button>
          </>}
        </div>
        <div>
          <label htmlFor="cap-import" className="mb-1 block text-sm">Import source package as a new candidate</label>
          <input id="cap-import" type="file" accept=".json,application/json" disabled={busy || dirty} onChange={importFile} className="w-full min-w-0 text-sm" />
          {dirty && <p className="mt-1 text-xs text-gray-400">Save project settings before importing or exporting the brief.</p>}
        </div>
        <p className="text-xs text-gray-400">Imports never execute source or install dependencies. Failed candidates retain accepted source. Accepting source records your selection; it does not mark rendering, motion or sound as verified.</p>
        <p className="text-xs text-gray-400">Requested model: {project.localSettings?.model || 'Unspecified'} · Mode: {project.localSettings?.mode || 'Unspecified'}</p>
        <ul className="space-y-2">
          {history.items.map(run => <li key={run.id} className="min-w-0 space-y-1 rounded border border-port-border p-3">
            <div className="flex flex-wrap justify-between gap-2 text-sm"><span>Package import · {run.status}</span><span>{timeAgo(run.createdAt)}</span></div>
            <p className="break-all text-xs text-gray-400">{run.data.packageHash}</p>
            <p className="text-xs text-gray-400">{formatBytes(run.data.totalBytes || 0)} · Source execution: {run.data.executed ? 'Recorded' : 'None'}</p>
            {run.data.error && <p className="text-xs text-port-error">{run.data.error}</p>}
            {run.revisionId && <button className={buttonClass} disabled={busy} onClick={() => download(run.revisionId)}>Export this revision</button>}
          </li>)}
        </ul>
        <InfiniteScrollFooter hasMore={history.hasMore} loading={history.loading} error={history.error} onLoadMore={history.loadMore} autoLoad={false} label="Load older runs" />
        <p className="text-xs text-gray-400">{formatCount(history.items.length)} loaded runs</p>
      </section>}
    </div>}
  </div>;
}
