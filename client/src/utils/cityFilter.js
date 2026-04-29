export const STATUS_FILTERS = [
  { id: 'all', label: 'ALL', match: () => true },
  { id: 'online', label: 'ONLINE', match: (app) => !app.archived && app.overallStatus === 'online' },
  { id: 'stopped', label: 'STOPPED', match: (app) => !app.archived && app.overallStatus === 'stopped' },
  {
    id: 'errored',
    label: 'ERRORED',
    match: (app) => {
      if (app.archived) return false;
      const pm2 = app.pm2Status || {};
      return Object.values(pm2).some(s => s?.status === 'errored');
    },
  },
  {
    id: 'agent',
    label: 'AGENT',
    match: (app, { agentMap }) => agentMap?.has?.(app.id),
  },
];

export function computeFilterResult({ apps, status, search, agentMap }) {
  const matcher = STATUS_FILTERS.find(f => f.id === status) || STATUS_FILTERS[0];
  const trimmed = (search || '').trim().toLowerCase();
  const matches = [];
  const dimmed = new Set();

  (apps || []).forEach(app => {
    const passesStatus = matcher.match(app, { agentMap });
    const haystack = [app.name, app.id, ...(app.tags || [])]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    const passesSearch = trimmed.length === 0 || haystack.includes(trimmed);
    if (passesStatus && passesSearch) {
      matches.push(app);
    } else {
      dimmed.add(app.id);
    }
  });

  return { matches, dimmed };
}
