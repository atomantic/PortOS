import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import BrailleSpinner from '../components/BrailleSpinner';
import LayoutPicker from '../components/dashboard/LayoutPicker';
import LayoutEditor from '../components/dashboard/LayoutEditor';
import { WIDGETS_BY_ID, WIDTH_CLASS, FALLBACK_LAYOUT } from '../components/dashboard/widgetRegistry.jsx';
import { DASHBOARD_LAYOUT_CHANGED } from '../constants/events.js';
import { Monitor } from 'lucide-react';
import * as api from '../services/api';
import socket from '../services/socket';
import toast from '../components/ui/Toast';

export default function Dashboard() {
  const [apps, setApps] = useState([]);
  const [health, setHealth] = useState(null);
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [dataError, setDataError] = useState(null);
  const [layoutsError, setLayoutsError] = useState(null);

  const [layouts, setLayouts] = useState([]);
  const [layoutsLoading, setLayoutsLoading] = useState(true);
  const [layoutLimits, setLayoutLimits] = useState(null);
  const [activeLayoutId, setActiveLayoutId] = useState(null);
  const [editorOpen, setEditorOpen] = useState(false);

  const fetchData = useCallback(async () => {
    setDataError(null);
    const [appsData, healthData, usageData] = await Promise.all([
      api.getApps().catch((err) => { setDataError(err.message); return []; }),
      api.checkHealth().catch(() => null),
      api.getUsage().catch(() => null),
    ]);
    setApps(appsData);
    setHealth(healthData);
    setUsage(usageData);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
    const handleAppsChanged = () => fetchData();
    socket.on('apps:changed', handleAppsChanged);
    return () => socket.off('apps:changed', handleAppsChanged);
  }, [fetchData]);

  useEffect(() => {
    // `cancelled` guard prevents setState-on-unmounted warnings (and
    // accidental state writes) when the user navigates away before the
    // fetch resolves, or while a DASHBOARD_LAYOUT_CHANGED fetch is in
    // flight at unmount time.
    let cancelled = false;
    const fetchLayouts = () => api.getDashboardLayouts()
      .then((data) => {
        if (cancelled) return;
        setLayouts(data.layouts);
        setActiveLayoutId(data.activeLayoutId);
        if (data.limits) setLayoutLimits(data.limits);
        setLayoutsError(null);
      })
      .catch((err) => { if (!cancelled) setLayoutsError(err.message); })
      .finally(() => { if (!cancelled) setLayoutsLoading(false); });

    fetchLayouts();

    // External switchers (the ⌘K palette) fire this event after writing
    // to the server so the Dashboard re-syncs even when already on `/`
    // (where navigate('/') would be a no-op and no remount happens).
    const handleLayoutChanged = () => fetchLayouts();
    window.addEventListener(DASHBOARD_LAYOUT_CHANGED, handleLayoutChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(DASHBOARD_LAYOUT_CHANGED, handleLayoutChanged);
    };
  }, []);

  const sortedApps = useMemo(() =>
    [...apps].sort((a, b) => {
      const archiveDiff = (a.archived ? 1 : 0) - (b.archived ? 1 : 0);
      if (archiveDiff !== 0) return archiveDiff;
      return a.name.localeCompare(b.name);
    }),
    [apps]
  );

  const activeApps = useMemo(() => apps.filter((a) => !a.archived), [apps]);
  const appStats = useMemo(() => ({
    total: activeApps.length,
    online: activeApps.filter((a) => a.overallStatus === 'online').length,
    stopped: activeApps.filter((a) => a.overallStatus === 'stopped').length,
    notStarted: activeApps.filter((a) => a.overallStatus === 'not_started' || a.overallStatus === 'not_found').length,
  }), [activeApps]);

  const dashboardState = useMemo(
    () => ({ apps, sortedApps, activeApps, appStats, health, usage, refetch: fetchData }),
    [apps, sortedApps, activeApps, appStats, health, usage, fetchData]
  );

  // Falls back to a local minimal layout only AFTER the initial fetch has
  // settled so the spinner isn't rendered alongside a flash of fallback
  // widgets. A failed refresh preserves the prior `layouts` (the .catch()
  // branch doesn't reset them); a failed/empty initial load then shows
  // the fallback so the dashboard stays usable until recovery.
  const activeLayout = useMemo(() => {
    const found = layouts.find((l) => l.id === activeLayoutId) || layouts[0];
    if (found) return found;
    return layoutsLoading ? undefined : FALLBACK_LAYOUT;
  }, [layouts, activeLayoutId, layoutsLoading]);

  const visibleWidgets = useMemo(
    () => (activeLayout?.widgets ?? [])
      .map((id) => WIDGETS_BY_ID[id])
      .filter((w) => w && (!w.gate || w.gate(dashboardState))),
    [activeLayout, dashboardState]
  );

  const selectLayout = async (id) => {
    const previousId = activeLayoutId;
    setActiveLayoutId(id);
    // Revert on failure. request() already surfaces the error via toast,
    // so swallow here to prevent an unhandled rejection from click handlers.
    // Guard the revert with a functional setState — if the user has since
    // switched to another layout, the more recent selection wins instead
    // of snapping back to the stale `previousId`.
    await api.setActiveDashboardLayout(id).catch(() => {
      setActiveLayoutId((current) => (current === id ? previousId : current));
    });
  };

  const saveLayout = async ({ id, name, widgets }) => {
    const result = await api.saveDashboardLayout(id, name, widgets);
    setLayouts(result.layouts);
  };

  const duplicateLayout = async ({ id, name, widgets }) => {
    const previousId = activeLayoutId;
    const result = await api.saveDashboardLayout(id, name, widgets);
    setLayouts(result.layouts);
    setActiveLayoutId(id);
    // Mirror selectLayout's revert-on-failure so the picker doesn't
    // diverge from server state if the active-write fails. Only revert
    // if the UI still reflects the id we tried to set; a later selection
    // must not be clobbered by an earlier failed request.
    await api.setActiveDashboardLayout(id).catch(() => {
      setActiveLayoutId((current) => (current === id ? previousId : current));
    });
  };

  const deleteLayoutById = async (id) => {
    const result = await api.deleteDashboardLayout(id);
    setLayouts(result.layouts);
    setActiveLayoutId(result.activeLayoutId);
    toast.success('Layout deleted');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <BrailleSpinner text="Loading dashboard" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-4">
        <div>
          <h2 className="text-2xl font-bold text-white">Dashboard</h2>
          <p className="text-gray-500 text-sm sm:text-base">
            {activeApps.length} app{activeApps.length !== 1 ? 's' : ''} registered{apps.length !== activeApps.length ? ` (${apps.length - activeApps.length} archived)` : ''}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {health && (
            <div className="text-sm text-gray-500">
              Server: <span className="text-port-success">Online</span>
            </div>
          )}
          {layouts.length > 0 && (
            <LayoutPicker
              layouts={layouts}
              activeLayoutId={activeLayoutId}
              onSelect={selectLayout}
              onEdit={() => setEditorOpen(true)}
            />
          )}
          <Link
            to="/ambient"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-port-card border border-port-border hover:border-gray-600 transition-colors text-sm text-gray-400 hover:text-white min-h-[40px]"
            title="Ambient display mode"
          >
            <Monitor size={14} />
            <span className="hidden sm:inline">Ambient</span>
          </Link>
        </div>
      </div>

      {dataError && (
        <div className="p-4 bg-port-error/20 border border-port-error rounded-lg text-port-error">
          {dataError}
        </div>
      )}
      {layoutsError && (
        <div className="p-4 bg-port-error/20 border border-port-error rounded-lg text-port-error">
          Layouts: {layoutsError}
        </div>
      )}

      {layoutsLoading && !layoutsError && (
        <div className="flex items-center justify-center h-24">
          <BrailleSpinner text="Loading layout" />
        </div>
      )}

      {!layoutsLoading && activeLayout && visibleWidgets.length === 0 && (
        <div className="bg-port-card border border-port-border rounded-xl p-8 text-center text-gray-500">
          This layout has no widgets. Click the layout picker and choose &ldquo;Edit layouts…&rdquo; to add some.
        </div>
      )}

      {visibleWidgets.length > 0 && (
        <div className="grid grid-cols-12 gap-4">
          {visibleWidgets.map((w) => (
            <div key={w.id} className={WIDTH_CLASS[w.width] || WIDTH_CLASS.quarter}>
              <w.Component dashboardState={dashboardState} />
            </div>
          ))}
        </div>
      )}

      {editorOpen && layouts.length > 0 && (
        <LayoutEditor
          layouts={layouts}
          activeLayoutId={activeLayoutId}
          limits={layoutLimits}
          onClose={() => setEditorOpen(false)}
          onSave={saveLayout}
          onDelete={deleteLayoutById}
          onDuplicate={duplicateLayout}
        />
      )}
    </div>
  );
}
