import { useMemo } from 'react';
import useUrlParams from '../../hooks/useUrlParams.js';
import { matchHaystack, tokenizeQuery } from '../../lib/mediaSearch.js';

const SORTS = { unfinished: 'Unfinished first', newest: 'Newest created', updated: 'Recently updated', name: 'Name A–Z' };

export default function ProjectLibrary({ projects, children }) {
  const [params, updateParams] = useUrlParams();
  const query = params.get('q') || '';
  const statuses = useMemo(() => [...new Set(projects.map(p => p.status).filter(Boolean))].sort(), [projects]);
  const requestedStatus = params.get('status');
  const status = requestedStatus === 'unfinished' || statuses.includes(requestedStatus) ? requestedStatus : 'all';
  const sort = Object.hasOwn(SORTS, params.get('sort')) ? params.get('sort') : 'unfinished';
  const compact = params.get('layout') === 'list';
  const visible = useMemo(() => {
    const tokens = tokenizeQuery(query);
    return projects.filter(p => (
      (status === 'all' || (status === 'unfinished' ? p.status !== 'complete' : p.status === status)) &&
      matchHaystack([p.name, p.id, p.status, p.modelId, p.directive?.goal, p.userStory, p.styleSpec].filter(Boolean).join(' ').toLowerCase(), tokens)
    )).sort((a, b) => {
      if (sort === 'unfinished') {
        const completed = Number(a.status === 'complete') - Number(b.status === 'complete');
        if (completed) return completed;
      }
      if (sort !== 'name') {
        const aTime = (sort === 'updated' && Date.parse(a.updatedAt)) || Date.parse(a.createdAt) || 0;
        const bTime = (sort === 'updated' && Date.parse(b.updatedAt)) || Date.parse(b.createdAt) || 0;
        if (aTime !== bTime) return bTime - aTime;
      }
      return (a.name || '').localeCompare(b.name || '') || a.id.localeCompare(b.id);
    });
  }, [projects, query, status, sort]);
  const controlClass = 'w-full bg-port-bg border border-port-border rounded px-3 py-2 text-sm';

  return (
    <section aria-label="Project library" className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div>
          <label htmlFor="project-search" className="block text-xs text-port-text-muted mb-1">Search projects</label>
          <input id="project-search" type="search" value={query} onChange={e => updateParams({ q: e.target.value }, { replace: true })} placeholder="Name, brief, model, or ID…" className={controlClass} />
        </div>
        <div>
          <label htmlFor="project-status" className="block text-xs text-port-text-muted mb-1">Status</label>
          <select id="project-status" value={status} onChange={e => updateParams({ status: e.target.value === 'all' ? null : e.target.value })} className={controlClass}>
            <option value="all">All projects ({projects.length})</option>
            <option value="unfinished">Unfinished ({projects.filter(p => p.status !== 'complete').length})</option>
            {statuses.map(value => <option key={value} value={value}>{value} ({projects.filter(p => p.status === value).length})</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="project-sort" className="block text-xs text-port-text-muted mb-1">Sort projects</label>
          <select id="project-sort" value={sort} onChange={e => updateParams({ sort: e.target.value === 'unfinished' ? null : e.target.value })} className={controlClass}>
            {Object.entries(SORTS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="project-layout" className="block text-xs text-port-text-muted mb-1">View</label>
          <select id="project-layout" value={compact ? 'list' : 'gallery'} onChange={e => updateParams({ layout: e.target.value === 'gallery' ? null : e.target.value })} className={controlClass}>
            <option value="gallery">Preview gallery</option>
            <option value="list">Compact list</option>
          </select>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-port-text-muted">
        <span role="status">Showing {visible.length} of {projects.length} projects</span>
        {(query || status !== 'all') && <button onClick={() => updateParams({ q: null, status: null })} className="text-port-accent">Clear filters</button>}
      </div>
      {projects.length > 0 && visible.length === 0 && <p className="py-8 text-center text-port-text-muted">No projects match your search and filters.</p>}
      <div className={compact ? 'space-y-2' : 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3'}>
        {visible.map(p => children(p, compact))}
      </div>
    </section>
  );
}
