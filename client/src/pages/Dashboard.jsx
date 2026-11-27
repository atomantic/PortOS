import { memo, useState, useEffect, useCallback, useMemo, useRef, Suspense } from 'react';
import { Link } from 'react-router';
import BrailleSpinner from '../components/BrailleSpinner';
import LayoutPicker from '../components/dashboard/LayoutPicker';
import LayoutEditor from '../components/dashboard/LayoutEditor';
import DashboardGrid, { readingOrderIds, reconcileGrid, synthesizeGrid } from '../components/dashboard/DashboardGrid.jsx';
import { WIDGETS_BY_ID, FALLBACK_LAYOUT } from '../components/dashboard/widgetRegistry.jsx';
import { readLayoutCache, streamsForWidgets, writeLayoutCache } from '../components/dashboard/dashboardBoot.js';
import WidgetSkeleton from '../components/dashboard/WidgetSkeleton';
import FirstRunCard from '../components/onboarding/FirstRunCard.jsx';
import { DASHBOARD_LAYOUT_CHANGED } from '../constants/events.js';
import PageHeader from '../components/PageHeader';
import { ChevronsDownUp, GripHorizontal, Monitor, Move, Save, X } from 'lucide-react';
import { getApps } from '../services/apiApps.js';
import { getBrainOnThisDay } from '../services/apiBrain.js';
import { getCalendarAgenda } from '../services/apiCalendar.js';
import { deleteDashboardLayout, getDailyDriverState, getDashboardLayouts, saveDashboardLayout, setActiveDashboardLayout } from '../services/apiDashboard.js';
import { getMeatspaceLoggingStats } from '../services/apiMeatspace.js';
import { getFeedStats } from '../services/apiMessages.js';
import { getSystemHealth } from '../services/apiSystem.js';
import { getTribeCareSummary } from '../services/apiTribe.js';
import socket from '../services/socket';
import toast from '../components/ui/Toast';
import { pickActiveLayoutId, recordManualLayoutPick } from '../utils/timeWindow.js';
import { createLayoutSwitcher } from '../lib/layoutSwitch.js';
import { useInstanceFeatures } from '../hooks/useInstanceFeatures.js';

export const isAppsLoading = (appsReadSettled) => !appsReadSettled;

// Optional dashboardState streams, fetched only when a visible widget `needs`
// one. Health (the header status) and the Daily Driver read (it records the
// first-visit-of-day signal, #2666) are always fetched; apps has its own error
// and settled tracking below.
const OPTIONAL_STREAMS = {
  tribeCare: () => getTribeCareSummary({ silent: true }),
  feeds: () => getFeedStats({ silent: true }),
  meatspaceLogging: () => getMeatspaceLoggingStats({ silent: true }),
  calendarAgenda: () => getCalendarAgenda({ silent: true }),
  brainOnThisDay: () => getBrainOnThisDay({ silent: true }),
};

// Renders one widget body. Memoized so a widget that declares no `needs`
// (and so receives no dashboardState) skips the re-render each stream's
// arrival triggers in the page.
const WidgetBody = memo(function WidgetBody({ Component, dashboardState }) {
  return dashboardState ? <Component dashboardState={dashboardState} /> : <Component />;
});

export default function Dashboard() {
  // Read once: the cached copy of the last confirmed layouts paints the grid
  // before the layouts GET returns (see dashboardBoot.js).
  const [layoutCache] = useState(readLayoutCache);
  // null means the first apps read has not completed. Keep that distinct from
  // a successful empty response so the Apps tile cannot flash its empty-state
  // CTA while an existing installation is still being read.
  const [apps, setApps] = useState(null);
  const [appsReadSettled, setAppsReadSettled] = useState(false);
  // undefined = first read pending; null = read failed; object = online.
  const [health, setHealth] = useState(undefined);
  const [streams, setStreams] = useState({});
  const [dailyDriver, setDailyDriver] = useState(null);
  const [dataError, setDataError] = useState(null);
  const [layoutsError, setLayoutsError] = useState(null);

  const [layouts, setLayouts] = useState(() => layoutCache?.layouts ?? []);
  const [layoutsLoading, setLayoutsLoading] = useState(true);
  // True once the server has answered a layouts read this mount. Until then a
  // cached layout is display-only: layout edits stay hidden so nothing saves
  // a grid the server may have moved past.
  const [layoutsConfirmed, setLayoutsConfirmed] = useState(false);
  const [layoutLimits, setLayoutLimits] = useState(null);
  const [activeLayoutId, setActiveLayoutId] = useState(() => (
    layoutCache ? pickActiveLayoutId(layoutCache.activeLayoutId, layoutCache.layouts, false) : null
  ));
  // Optimistic active-layout switching with the server-confirmed baseline and
  // the latest-generation revert gate (see lib/layoutSwitch.js). Held in state
  // only so the factory runs once; it never changes and never re-renders.
  const [layoutSwitcher] = useState(() => createLayoutSwitcher({ setDisplayed: setActiveLayoutId }));
  const [editorOpen, setEditorOpen] = useState(false);
  // Grid edit mode is local — entered via the "Arrange" button. Holds an
  // in-flight grid snapshot the user can Save/Cancel without touching the
  // server until they commit.
  const [editingGrid, setEditingGrid] = useState(false);
  const [draftGrid, setDraftGrid] = useState(null);
  const [savingGrid, setSavingGrid] = useState(false);
  // Which affordance the grid is actually offering. Reported by DashboardGrid
  // rather than derived from a Tailwind `sm:` breakpoint, because the grid
  // measures its own CONTAINER — page padding makes that narrower than the
  // viewport, so the two disagree in a ~30px band and the hint would describe
  // handles that aren't on screen.
  const [gridIsMobile, setGridIsMobile] = useState(false);
  // Dashboard widget gates intentionally read the raw list: unlike navigation,
  // a failed feature read must fail closed and reserve no POST widget cell.
  const { features: instanceFeatureList } = useInstanceFeatures();
  const instanceFeatures = useMemo(
    () => (instanceFeatureList === null ? null : { features: instanceFeatureList }),
    [instanceFeatureList],
  );

  const refreshHealth = useCallback(async () => {
    // Keep the last good snapshot visible when a manual refresh hits a
    // transient failure; only a failed FIRST read marks the server offline.
    const data = await getSystemHealth({ silent: true }).catch(() => undefined);
    if (data) setHealth(data);
    else setHealth((prev) => (prev === undefined ? null : prev));
    return data;
  }, []);

  // Health and the Daily Driver are always-on reads, and apps has its own
  // fetcher, so names without an OPTIONAL_STREAMS entry are skipped here.
  const fetchStreams = useCallback((names) => Promise.all(names
    .filter((name) => Object.hasOwn(OPTIONAL_STREAMS, name))
    .map((name) => OPTIONAL_STREAMS[name]()
      .catch(() => null)
      .then((value) => setStreams((prev) => ({ ...prev, [name]: value }))))), []);

  const fetchApps = useCallback(() => getApps()
    .then((appsData) => {
      setDataError(null);
      if (Array.isArray(appsData)) setApps(appsData);
    }, (err) => setDataError(err.message || 'Could not load apps'))
    .finally(() => setAppsReadSettled(true)), []);

  // One-shot per mount — guards against re-evaluation stomping manual picks.
  // Serialization across concurrent writers (auto-window + manual pick +
  // palette pick) lives server-side in dashboardLayouts.js's `layoutsWriteTail`;
  // no client-side queue needed.
  const autoSwitchedRef = useRef(false);
  const fetchLayoutsRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    let latestRead = 0;
    const fetchLayouts = () => {
      const read = ++latestRead;
      const isStale = () => cancelled || read !== latestRead;
      setLayoutsLoading(true);
      return getDashboardLayouts({ silent: true })
        .then((data) => {
          if (isStale()) return;
          setLayouts(data.layouts);
          // The server's stored active id is the confirmed baseline until/unless
          // the auto-switch PUT below lands.
          layoutSwitcher.confirm(data.activeLayoutId);
          const desiredActiveId = pickActiveLayoutId(data.activeLayoutId, data.layouts, autoSwitchedRef.current);
          setActiveLayoutId(desiredActiveId);
          if (desiredActiveId === data.activeLayoutId) {
            autoSwitchedRef.current = true;
          } else {
            // Server's layoutsWriteTail serializes against concurrent manual
            // picks, so this fire-and-forget can't clobber a later click. Only
            // mark "auto-switched" after the PUT settles so a failing server
            // gets retried on the next mount.
            layoutSwitcher.switchTo(
              desiredActiveId,
              setActiveDashboardLayout(desiredActiveId).then(() => { autoSwitchedRef.current = true; }),
              { isCancelled: () => cancelled },
            );
          }
          if (data.limits) setLayoutLimits(data.limits);
          setLayoutsConfirmed(true);
          setLayoutsError(null);
        })
        .catch((err) => { if (!isStale()) setLayoutsError(err.message || 'Could not load layouts'); })
        .finally(() => { if (!isStale()) setLayoutsLoading(false); });
    };

    fetchLayoutsRef.current = fetchLayouts;
    fetchLayouts();

    // External switchers (the ⌘K palette) fire this event after writing
    // to the server so the Dashboard re-syncs even when already on `/`
    // (where navigate('/') would be a no-op and no remount happens).
    window.addEventListener(DASHBOARD_LAYOUT_CHANGED, fetchLayouts);
    return () => {
      cancelled = true;
      fetchLayoutsRef.current = null;
      window.removeEventListener(DASHBOARD_LAYOUT_CHANGED, fetchLayouts);
    };
  }, [layoutSwitcher]);

  const appList = useMemo(() => (Array.isArray(apps) ? apps : []), [apps]);
  const appsLoading = isAppsLoading(appsReadSettled);
  // Failed FIRST read (no data ever landed): widgets show Retry instead of an
  // empty/zero view. After a successful read, failures keep the loaded data
  // and surface only through the page banner below.
  const appsError = apps === null && dataError ? dataError : null;
  const sortedApps = useMemo(() =>
    [...appList].sort((a, b) => {
      const archiveDiff = (a.archived ? 1 : 0) - (b.archived ? 1 : 0);
      if (archiveDiff !== 0) return archiveDiff;
      return a.name.localeCompare(b.name);
    }),
    [appList]
  );

  const activeApps = useMemo(() => appList.filter((a) => !a.archived), [appList]);
  const appStats = useMemo(() => ({
    total: activeApps.length,
    online: activeApps.filter((a) => a.overallStatus === 'online').length,
    stopped: activeApps.filter((a) => a.overallStatus === 'stopped').length,
    notStarted: activeApps.filter((a) => a.overallStatus === 'not_started' || a.overallStatus === 'not_found').length,
    // PM2 read failed for these — status unavailable, NOT confidently stopped.
    // Counted so the buckets sum to `total` instead of silently dropping them.
    unknown: activeApps.filter((a) => a.degraded || a.overallStatus === 'unknown').length,
  }), [activeApps]);

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

  // Refresh the first-paint copy whenever the server-confirmed view changes.
  useEffect(() => {
    if (layoutsConfirmed) writeLayoutCache(layouts, activeLayoutId);
  }, [layoutsConfirmed, layouts, activeLayoutId]);

  // Data reads start only once a layout is known (instantly from the cache) and
  // only for streams its widgets need, so the layouts read is never queued
  // behind them on a phone's handful of connections.
  const layoutKnown = !!activeLayout;
  const neededStreams = useMemo(() => streamsForWidgets(activeLayout?.widgets), [activeLayout]);
  const neededKey = neededStreams.join(',');
  const neededRef = useRef(neededStreams);
  neededRef.current = neededStreams;
  const fetchedStreamsRef = useRef(new Set());

  const fetchData = useCallback(async () => {
    const needed = neededRef.current;
    needed.forEach((name) => fetchedStreamsRef.current.add(name));
    await Promise.all([
      refreshHealth(),
      // GET records the first-visit-of-day signal (issue #2666); a failure just
      // hides the Daily Driver card via its gate. No LLM calls here.
      getDailyDriverState().catch(() => null).then(setDailyDriver),
      needed.includes('apps') ? fetchApps() : null,
      fetchStreams(needed),
    ]);
  }, [fetchApps, fetchStreams, refreshHealth]);

  const initialFetchDoneRef = useRef(false);
  useEffect(() => {
    if (!layoutKnown) return;
    if (!initialFetchDoneRef.current) {
      initialFetchDoneRef.current = true;
      fetchData();
      return;
    }
    // A layout switch that adds a widget fetches just the streams it brings.
    const added = neededRef.current.filter((name) => !fetchedStreamsRef.current.has(name));
    if (added.length === 0) return;
    added.forEach((name) => fetchedStreamsRef.current.add(name));
    if (added.includes('apps')) fetchApps();
    fetchStreams(added);
  }, [layoutKnown, neededKey, fetchData, fetchApps, fetchStreams]);

  useEffect(() => {
    const handleAppsChanged = () => { if (neededRef.current.includes('apps')) fetchApps(); };
    socket.on('apps:changed', handleAppsChanged);
    return () => {
      socket.off('apps:changed', handleAppsChanged);
    };
  }, [fetchApps]);

  const { tribeCare = null, feeds = null, meatspaceLogging = null, calendarAgenda = null, brainOnThisDay = null } = streams;
  const dashboardState = useMemo(
    () => ({ apps: appList, appsLoading, appsError, refetchApps: fetchApps, sortedApps, activeApps, appStats, health: health ?? null, tribeCare, feeds, meatspaceLogging, calendarAgenda, brainOnThisDay, dailyDriver, instanceFeatures, refetch: fetchData, refetchHealth: refreshHealth }),
    [appList, appsLoading, appsError, fetchApps, sortedApps, activeApps, appStats, health, tribeCare, feeds, meatspaceLogging, calendarAgenda, brainOnThisDay, dailyDriver, instanceFeatures, fetchData, refreshHealth]
  );

  const visibleWidgets = useMemo(
    () => (activeLayout?.widgets ?? [])
      .map((id) => WIDGETS_BY_ID[id])
      .filter((w) => w && (!w.gate || w.gate(dashboardState))),
    [activeLayout, dashboardState]
  );

  // Build the grid the renderer actually uses:
  //   - If the user is mid-edit, prefer the local draft.
  //   - Else, if the layout has a saved grid, reconcile it against the
  //     visible-widget list (fills in gaps, drops gated/missing widgets).
  //   - Else (legacy / unmigrated layouts), synthesize a row-flow grid from
  //     the widget order so the layout opens looking like it always has.
  const visibleIds = useMemo(() => visibleWidgets.map((w) => w.id), [visibleWidgets]);
  const renderGrid = useMemo(() => {
    if (editingGrid && draftGrid) return draftGrid;
    if (!activeLayout) return [];
    if (Array.isArray(activeLayout.grid) && activeLayout.grid.length > 0) {
      return reconcileGrid(activeLayout.grid, visibleIds);
    }
    return synthesizeGrid(visibleIds);
  }, [editingGrid, draftGrid, activeLayout, visibleIds]);

  // Cancel grid edit mode whenever the user switches layouts so unsaved
  // positional edits don't bleed across layouts.
  useEffect(() => {
    setEditingGrid(false);
    setDraftGrid(null);
  }, [activeLayoutId]);

  // Stable identity so DashboardGrid's memoized cells actually bail out — a
  // fresh closure here would re-render every widget on each drag tick.
  const renderWidget = useCallback((item) => {
    const meta = WIDGETS_BY_ID[item.id];
    if (!meta) return null;
    // Per-cell Suspense so a slow widget can't block sibling cells.
    return (
      <Suspense fallback={<WidgetSkeleton label={meta.label} />}>
        <WidgetBody Component={meta.Component} dashboardState={meta.needs ? dashboardState : undefined} />
      </Suspense>
    );
  }, [dashboardState]);

  const startGridEdit = () => {
    setDraftGrid(renderGrid);
    setEditingGrid(true);
  };

  const cancelGridEdit = () => {
    setEditingGrid(false);
    setDraftGrid(null);
  };

  const saveGridEdit = async () => {
    if (!activeLayout || !draftGrid) return;
    setSavingGrid(true);
    // Rewrite `widgets` in the grid's reading order too. The grid is what the
    // renderer reads, so leaving the widget list in its old order would make
    // LayoutEditor list widgets in an order the dashboard doesn't show —
    // widgets hidden by a gate keep their relative position at the end.
    const orderedIds = readingOrderIds(draftGrid);
    const widgets = [
      ...orderedIds,
      ...activeLayout.widgets.filter((id) => !orderedIds.includes(id)),
    ];
    const ok = await saveDashboardLayout(activeLayout.id, { name: activeLayout.name, widgets, grid: draftGrid })
      .then((result) => { setLayouts(result.layouts); return true; }, () => false);
    setSavingGrid(false);
    if (!ok) return;
    setEditingGrid(false);
    setDraftGrid(null);
    toast.success('Layout saved');
  };

  const selectLayout = async (id) => {
    recordManualLayoutPick(id);
    await layoutSwitcher.switchTo(id, setActiveDashboardLayout(id));
  };

  // Preserve the existing grid on widget add/remove so positional edits
  // don't get wiped when the user toggles a widget in the LayoutEditor.
  // reconcileGrid drops removed widgets and appends any new ones at the
  // bottom, mirroring what the renderer does at view time.
  //
  // The renderer reads the grid, not `widgets` — so a Move up/down in the
  // editor is invisible unless the grid is re-flowed to the new order. The
  // editor tells us when that's what the save is (`reordered`) rather than us
  // inferring it from the two orders disagreeing; see reconcileGrid (#4132).
  const saveLayout = async ({ id, name, widgets, activateWindow, reordered }) => {
    const existing = layouts.find((l) => l.id === id);
    const baseGrid = (existing?.grid && existing.grid.length > 0)
      ? existing.grid
      : synthesizeGrid(existing?.widgets ?? widgets);
    const nextGrid = reconcileGrid(baseGrid, widgets, { reorder: reordered });
    const result = await saveDashboardLayout(id, { name, widgets, grid: nextGrid, activateWindow });
    setLayouts(result.layouts);
  };

  const duplicateLayout = async ({ id, name, widgets, activateWindow, reordered }) => {
    // New layouts inherit the current renderGrid so "Save as new…" from a
    // visually-arranged dashboard captures what the user actually sees.
    const sourceGrid = renderGrid && renderGrid.length > 0 ? renderGrid : synthesizeGrid(widgets);
    const grid = reconcileGrid(sourceGrid, widgets, { reorder: reordered });
    const result = await saveDashboardLayout(id, { name, widgets, grid, activateWindow });
    setLayouts(result.layouts);
    // switchTo bumps the switch generation only now — AFTER the save resolved.
    // Bumping at function entry would let a still-in-flight save prematurely
    // supersede (and suppress the failure revert of) an unrelated in-flight
    // selectLayout, and a rejected save must not switch at all.
    // Lock in for the day so a window-driven auto-switch on the next mount
    // doesn't bump the user off the brand-new layout they just created.
    recordManualLayoutPick(id);
    await layoutSwitcher.switchTo(id, setActiveDashboardLayout(id));
  };

  const deleteLayoutById = async (id) => {
    const result = await deleteDashboardLayout(id);
    setLayouts(result.layouts);
    setActiveLayoutId(result.activeLayoutId);
    // The server chose the post-delete active layout — it's now the
    // confirmed baseline a later failed switch should revert to.
    layoutSwitcher.confirm(result.activeLayoutId);
    toast.success('Layout deleted');
  };

  // Grey while the first health read is pending, so a slow read on a phone
  // doesn't flash "offline" red at a server that is up.
  const healthLabel = health ? 'Server online' : health === undefined ? 'Checking server' : 'Server offline';

  return (
    <div className="space-y-6">
      {/* The shared PageHeader owns the page <h1> (#7245) — it must precede
          FirstRunCard so the rendered outline opens at level 1 and the card's
          own heading sits one level under it. The server-health status rides in
          the actions slot, PageHeader's documented place for status badges. */}
      <PageHeader
        title="Dashboard"
        actions={(
          <>
            <span
              role="status"
              className={`text-sm ${health ? 'text-port-success' : health === undefined ? 'text-gray-400' : 'text-port-error'}`}
            >
              {healthLabel}
            </span>
            {layoutsConfirmed && layouts.length > 0 && !editingGrid && (
              <LayoutPicker
                layouts={layouts}
                activeLayoutId={activeLayoutId}
                onSelect={selectLayout}
                onEdit={() => setEditorOpen(true)}
              />
            )}
            {layoutsConfirmed && !editingGrid && activeLayout && visibleWidgets.length > 0 && (
              <button
                onClick={startGridEdit}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-port-card border border-port-border hover:border-gray-600 transition-colors text-sm text-gray-400 hover:text-white min-h-[40px]"
                title="Reorder, move and resize widgets"
              >
                <Move size={14} />
                <span className="max-sm:sr-only">Arrange</span>
              </button>
            )}
            {editingGrid && (
              <>
                <button
                  onClick={cancelGridEdit}
                  disabled={savingGrid}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-port-card border border-port-border hover:border-gray-600 transition-colors text-sm text-gray-400 hover:text-white min-h-[40px] disabled:opacity-50"
                >
                  <X size={14} />
                  <span className="max-sm:sr-only">Cancel</span>
                </button>
                <button
                  onClick={saveGridEdit}
                  disabled={savingGrid}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-port-accent text-white hover:bg-port-accent/80 transition-colors text-sm min-h-[40px] disabled:opacity-50"
                >
                  <Save size={14} />
                  <span className="max-sm:sr-only">{savingGrid ? 'Saving…' : 'Save layout'}</span>
                </button>
              </>
            )}
            <Link
              to="/ambient"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-port-card border border-port-border hover:border-gray-600 transition-colors text-sm text-gray-400 hover:text-white min-h-[40px]"
              title="Ambient display mode"
            >
              <Monitor size={14} />
              <span className="max-sm:sr-only">Ambient</span>
            </Link>
          </>
        )}
      />
      <FirstRunCard />

      {dataError && !appsError && (
        <div role="status" className="flex items-center justify-between gap-3 p-4 bg-port-error/20 border border-port-error rounded-lg text-port-error">
          <span>{dataError}</span>
          <button type="button" onClick={fetchApps} className="shrink-0 px-3 py-1.5 min-h-10 rounded-lg border border-port-error hover:bg-port-error/20 text-sm">
            Retry
          </button>
        </div>
      )}
      {layoutsError && (
        <div className="flex items-center justify-between gap-3 p-4 bg-port-error/20 border border-port-error rounded-lg text-port-error">
          <span role="status" className="min-w-0 break-words">Layouts: {layoutsError}</span>
          <button type="button" onClick={() => fetchLayoutsRef.current?.()} disabled={layoutsLoading} className="shrink-0 px-3 py-1.5 min-h-10 rounded-lg border border-port-error hover:bg-port-error/20 text-sm disabled:opacity-50">
            Retry
          </button>
        </div>
      )}

      {layoutsLoading && !layoutsError && !activeLayout && (
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
        <>
          {editingGrid && (
            <div className="rounded-lg border border-port-accent/40 bg-port-accent/5 px-3 py-2 text-sm text-gray-300">
              {gridIsMobile ? (
                <>
                  Drag the <GripHorizontal size={12} className="inline mx-0.5" /> handle up or down
                  to reorder widgets — or focus it and press space, then the arrow keys. Reordering
                  re-packs the wide-screen arrangement to match; widths and heights are unchanged.
                </>
              ) : (
                <>
                  Drag the <Move size={12} className="inline mx-0.5" /> handle to move widgets, or
                  the <span className="inline-block px-1">↘</span> handle to resize — or focus
                  either one and press space, then the arrow keys, then enter (escape cancels).
                  Widgets size themselves to their content and float up into the space above —
                  setting a widget&apos;s height pins it, and the{' '}
                  <ChevronsDownUp size={12} className="inline mx-0.5" /> handle hands it back.
                </>
              )}
              {' '}Click <strong className="text-white">Save layout</strong> when you&apos;re done.
            </div>
          )}
          <DashboardGrid
            items={renderGrid}
            editable={editingGrid}
            onChange={setDraftGrid}
            onLayoutModeChange={setGridIsMobile}
            renderItem={renderWidget}
          />
        </>
      )}

      {editorOpen && layoutsConfirmed && layouts.length > 0 && (
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
