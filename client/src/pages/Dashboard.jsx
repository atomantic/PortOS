import { useState, useEffect, useCallback, useMemo, useRef, Suspense } from 'react';
import { Link } from 'react-router-dom';
import BrailleSpinner from '../components/BrailleSpinner';
import PageSkeleton from '../components/ui/PageSkeleton';
import LayoutPicker from '../components/dashboard/LayoutPicker';
import LayoutEditor from '../components/dashboard/LayoutEditor';
import WidgetSuggestions from '../components/dashboard/WidgetSuggestions';
import DashboardGrid, { reconcileGrid, synthesizeGrid } from '../components/dashboard/DashboardGrid.jsx';
import { WIDGETS_BY_ID, FALLBACK_LAYOUT } from '../components/dashboard/widgetRegistry.jsx';
import WidgetSkeleton from '../components/dashboard/WidgetSkeleton';
import { SchematicLabel } from '../components/micrographics';
import { DASHBOARD_LAYOUT_CHANGED } from '../constants/events.js';
import { Monitor, Move, Save, X } from 'lucide-react';
import * as api from '../services/api';
import socket from '../services/socket';
import toast from '../components/ui/Toast';
import { pickActiveLayoutId, recordManualLayoutPick } from '../utils/timeWindow.js';

export default function Dashboard() {
  const [apps, setApps] = useState([]);
  const [health, setHealth] = useState(null);
  const [usage, setUsage] = useState(null);
  const [tribeCare, setTribeCare] = useState(null);
  const [feeds, setFeeds] = useState(null);
  const [meatspaceLogging, setMeatspaceLogging] = useState(null);
  const [dailyDriver, setDailyDriver] = useState(null);
  const [loading, setLoading] = useState(true);
  const [dataError, setDataError] = useState(null);
  const [layoutsError, setLayoutsError] = useState(null);

  const [layouts, setLayouts] = useState([]);
  const [layoutsLoading, setLayoutsLoading] = useState(true);
  const [layoutLimits, setLayoutLimits] = useState(null);
  const [activeLayoutId, setActiveLayoutId] = useState(null);
  // Last active-layout id the SERVER confirmed (initial GET, a successful
  // setActive PUT, or a delete response). Failed optimistic switches revert
  // to this — never to a `previousId` snapshot, which can itself be an
  // optimistic-but-uncommitted id when two switches fail back-to-back (the
  // 2nd switch's `previousId` is the 1st's never-landed value). A ref, not
  // state: it's read inside async `.catch` revert callbacks, so it must
  // always reflect current truth without stale-closure capture, and it
  // never needs to trigger a re-render on its own.
  const serverConfirmedLayoutIdRef = useRef(null);
  // Monotonic counter incremented on every active-layout switch attempt
  // (initial auto-switch, selectLayout, duplicateLayout). It gates only the
  // FAILURE revert: a switch reverts the displayed layout on PUT failure only
  // when it's still the latest switch — so an earlier switch's late failure
  // can't yank the display out from under a newer switch (even one targeting
  // the same id, where `current === id` alone would wrongly match). The
  // SUCCESS path does NOT gate on generation: the server's layoutsWriteTail
  // serializes PUTs and their responses, so the last success to resolve is the
  // server's final active layout — every acceptance must be recorded, even a
  // superseded one, or a later failure could revert to a stale id. Mirrors the
  // `{ target, generation }` pending-request convention used elsewhere.
  const switchGenerationRef = useRef(0);
  const [editorOpen, setEditorOpen] = useState(false);
  // Grid edit mode is local — entered via the "Arrange" button. Holds an
  // in-flight grid snapshot the user can Save/Cancel without touching the
  // server until they commit.
  const [editingGrid, setEditingGrid] = useState(false);
  const [draftGrid, setDraftGrid] = useState(null);
  const [savingGrid, setSavingGrid] = useState(false);

  const fetchData = useCallback(async () => {
    setDataError(null);
    const [appsData, healthData, usageData, tribeCareData, feedsData, meatspaceLoggingData, dailyDriverData] = await Promise.all([
      api.getApps().catch((err) => { setDataError(err.message); return []; }),
      api.checkHealth().catch(() => null),
      api.getUsage().catch(() => null),
      api.getTribeCareSummary({ silent: true }).catch(() => null),
      api.getFeedStats({ silent: true }).catch(() => null),
      api.getMeatspaceLoggingStats({ silent: true }).catch(() => null),
      // GET records the first-visit-of-day signal (issue #2666); a failure just
      // hides the Daily Driver card via its gate. No LLM calls here.
      api.getDailyDriverState().catch(() => null),
    ]);
    setApps(appsData);
    setHealth(healthData);
    setUsage(usageData);
    setTribeCare(tribeCareData);
    setFeeds(feedsData);
    setMeatspaceLogging(meatspaceLoggingData);
    setDailyDriver(dailyDriverData);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
    const handleAppsChanged = () => fetchData();
    socket.on('apps:changed', handleAppsChanged);
    return () => socket.off('apps:changed', handleAppsChanged);
  }, [fetchData]);

  // One-shot per mount — guards against re-evaluation stomping manual picks.
  // Serialization across concurrent writers (auto-window + manual pick +
  // palette pick) lives server-side in dashboardLayouts.js's `layoutsWriteTail`;
  // no client-side queue needed.
  const autoSwitchedRef = useRef(false);

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
        // The server's stored active id is the confirmed baseline until/unless
        // the auto-switch PUT below lands.
        serverConfirmedLayoutIdRef.current = data.activeLayoutId;
        const desiredActiveId = pickActiveLayoutId(data.activeLayoutId, data.layouts, autoSwitchedRef.current);
        setActiveLayoutId(desiredActiveId);
        if (desiredActiveId === data.activeLayoutId) {
          autoSwitchedRef.current = true;
        } else {
          // Server's layoutsWriteTail serializes against concurrent manual
          // picks, so this fire-and-forget can't clobber a later click. Only
          // mark "auto-switched" after the PUT settles so a failing server
          // gets retried on the next mount.
          const switchGen = ++switchGenerationRef.current;
          api.setActiveDashboardLayout(desiredActiveId)
            .then(() => {
              if (cancelled) return;
              autoSwitchedRef.current = true;
              // Always record the server's acceptance: even if a user switch
              // superseded this one, the server did accept desiredActiveId, and
              // the write-tail guarantees the last success to resolve wins.
              serverConfirmedLayoutIdRef.current = desiredActiveId;
            })
            .catch(() => {
              if (cancelled) return;
              // A user switch (even to this same id) supersedes the auto-switch
              // and owns the displayed state — don't revert out from under it.
              if (switchGenerationRef.current !== switchGen) return;
              setActiveLayoutId((current) => (current === desiredActiveId ? data.activeLayoutId : current));
            });
        }
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
    // PM2 read failed for these — status unavailable, NOT confidently stopped.
    // Counted so the buckets sum to `total` instead of silently dropping them.
    unknown: activeApps.filter((a) => a.degraded || a.overallStatus === 'unknown').length,
  }), [activeApps]);

  const dashboardState = useMemo(
    () => ({ apps, sortedApps, activeApps, appStats, health, usage, tribeCare, feeds, meatspaceLogging, dailyDriver, refetch: fetchData }),
    [apps, sortedApps, activeApps, appStats, health, usage, tribeCare, feeds, meatspaceLogging, dailyDriver, fetchData]
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
    const ok = await api
      .saveDashboardLayout(activeLayout.id, { name: activeLayout.name, widgets: activeLayout.widgets, grid: draftGrid })
      .then((result) => { setLayouts(result.layouts); return true; }, () => false);
    setSavingGrid(false);
    if (!ok) return;
    setEditingGrid(false);
    setDraftGrid(null);
    toast.success('Layout saved');
  };

  const selectLayout = async (id) => {
    const switchGen = ++switchGenerationRef.current;
    setActiveLayoutId(id);
    recordManualLayoutPick(id);
    // Server-side write tail serializes against any in-flight auto-window
    // PUT so this write always lands after it. On success record the id as the
    // server-confirmed baseline (always — the write-tail makes the last success
    // to resolve the server's final state). On failure revert (functional
    // setState so a later selection isn't clobbered) to that baseline — not to
    // a local snapshot, which after a prior failed switch may be an id the
    // server never accepted — and only when this is still the latest switch.
    await api.setActiveDashboardLayout(id)
      .then(() => { serverConfirmedLayoutIdRef.current = id; })
      .catch(() => {
        // Only the latest switch may revert. A newer switch — even to this
        // SAME id (which leaves `current === id` true) — supersedes this one
        // and owns the displayed state; its own resolution will settle it.
        if (switchGenerationRef.current !== switchGen) return;
        setActiveLayoutId((current) => (current === id ? serverConfirmedLayoutIdRef.current : current));
      });
  };

  // Preserve the existing grid on widget add/remove so positional edits
  // don't get wiped when the user toggles a widget in the LayoutEditor.
  // reconcileGrid drops removed widgets and appends any new ones at the
  // bottom, mirroring what the renderer does at view time.
  const saveLayout = async ({ id, name, widgets, activateWindow }) => {
    const existing = layouts.find((l) => l.id === id);
    const baseGrid = (existing?.grid && existing.grid.length > 0)
      ? existing.grid
      : synthesizeGrid(existing?.widgets ?? widgets);
    const nextGrid = reconcileGrid(baseGrid, widgets);
    const result = await api.saveDashboardLayout(id, { name, widgets, grid: nextGrid, activateWindow });
    setLayouts(result.layouts);
  };

  const duplicateLayout = async ({ id, name, widgets, activateWindow }) => {
    // New layouts inherit the current renderGrid so "Save as new…" from a
    // visually-arranged dashboard captures what the user actually sees.
    const sourceGrid = renderGrid && renderGrid.length > 0 ? renderGrid : synthesizeGrid(widgets);
    const grid = reconcileGrid(sourceGrid, widgets);
    const result = await api.saveDashboardLayout(id, { name, widgets, grid, activateWindow });
    setLayouts(result.layouts);
    // Bump the switch generation only now — AFTER the save resolved and right
    // before the actual active-layout switch. Bumping at function entry would
    // let a still-in-flight save prematurely supersede (and thus suppress the
    // failure revert of) an unrelated in-flight selectLayout that fails in the
    // meantime — and if the save itself rejects, no switch happens at all.
    const switchGen = ++switchGenerationRef.current;
    setActiveLayoutId(id);
    // Lock in for the day so a window-driven auto-switch on the next mount
    // doesn't bump the user off the brand-new layout they just created.
    recordManualLayoutPick(id);
    // Server-side write tail serializes against any in-flight auto-window
    // PUT. On success record the new layout as the server-confirmed baseline
    // (always); on failure revert (functional setState) to the prior confirmed
    // baseline rather than a possibly-uncommitted local snapshot — and only
    // when this is still the latest switch.
    await api.setActiveDashboardLayout(id)
      .then(() => { serverConfirmedLayoutIdRef.current = id; })
      .catch(() => {
        // Only the latest switch may revert. A newer switch — even to this
        // SAME id (which leaves `current === id` true) — supersedes this one
        // and owns the displayed state; its own resolution will settle it.
        if (switchGenerationRef.current !== switchGen) return;
        setActiveLayoutId((current) => (current === id ? serverConfirmedLayoutIdRef.current : current));
      });
  };

  const deleteLayoutById = async (id) => {
    const result = await api.deleteDashboardLayout(id);
    setLayouts(result.layouts);
    setActiveLayoutId(result.activeLayoutId);
    // The server chose the post-delete active layout — it's now the
    // confirmed baseline a later failed switch should revert to.
    serverConfirmedLayoutIdRef.current = result.activeLayoutId;
    toast.success('Layout deleted');
  };

  if (loading) {
    return (
      <div>
        <div className="mb-3">
          <SchematicLabel module="DASH" status="BOOTING" glyph="orbit" state="active" />
        </div>
        <PageSkeleton label="Loading dashboard" titleWidthClass="w-40" layout="grid" cards={6} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-row items-center justify-between gap-2 sm:gap-4">
        <h2 className="flex items-center gap-2.5 text-2xl font-bold text-white">
          Dashboard
          <span
            className="relative inline-flex h-2.5 w-2.5"
            title={health ? 'Server online' : 'Server offline'}
            aria-label={health ? 'Server online' : 'Server offline'}
          >
            {health && (
              <span className="absolute inline-flex h-full w-full rounded-full bg-port-success opacity-60 animate-ping" />
            )}
            <span
              className={`relative inline-flex rounded-full h-2.5 w-2.5 ${health ? 'bg-port-success shadow-[0_0_8px_rgb(var(--port-success))]' : 'bg-port-error shadow-[0_0_8px_rgb(var(--port-error))]'}`}
            />
          </span>
        </h2>
        <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3">
          {layouts.length > 0 && !editingGrid && (
            <LayoutPicker
              layouts={layouts}
              activeLayoutId={activeLayoutId}
              onSelect={selectLayout}
              onEdit={() => setEditorOpen(true)}
            />
          )}
          {!editingGrid && activeLayout && visibleWidgets.length > 0 && (
            <button
              onClick={startGridEdit}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-port-card border border-port-border hover:border-gray-600 transition-colors text-sm text-gray-400 hover:text-white min-h-[40px]"
              title="Drag and resize widgets"
            >
              <Move size={14} />
              <span className="hidden sm:inline">Arrange</span>
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
                <span className="hidden sm:inline">Cancel</span>
              </button>
              <button
                onClick={saveGridEdit}
                disabled={savingGrid}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-port-accent text-white hover:bg-port-accent/80 transition-colors text-sm min-h-[40px] disabled:opacity-50"
              >
                <Save size={14} />
                <span className="hidden sm:inline">{savingGrid ? 'Saving…' : 'Save layout'}</span>
              </button>
            </>
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

      {!editingGrid && activeLayout && activeLayout.id !== FALLBACK_LAYOUT.id && (
        <WidgetSuggestions
          presentWidgetIds={activeLayout.widgets}
          dashboardState={dashboardState}
          onAdd={(widgetId) => saveLayout({
            id: activeLayout.id,
            name: activeLayout.name,
            widgets: [...activeLayout.widgets, widgetId],
            activateWindow: activeLayout.activateWindow ?? null,
          })}
        />
      )}

      {visibleWidgets.length > 0 && (
        <>
          {editingGrid && (
            <div className="rounded-lg border border-port-accent/40 bg-port-accent/5 px-3 py-2 text-sm text-gray-300">
              Drag the <Move size={12} className="inline mx-0.5" /> handle to move widgets, or
              the <span className="inline-block px-1">↘</span> handle to resize. Click <strong className="text-white">Save layout</strong> when you&apos;re done.
            </div>
          )}
          <DashboardGrid
            items={renderGrid}
            editable={editingGrid}
            onChange={setDraftGrid}
            renderItem={(item) => {
              const meta = WIDGETS_BY_ID[item.id];
              if (!meta) return null;
              // Per-cell Suspense so a slow widget can't block sibling cells.
              const widget = (
                <Suspense fallback={<WidgetSkeleton label={meta.label} />}>
                  <meta.Component dashboardState={dashboardState} />
                </Suspense>
              );
              if (!meta.module) return widget;
              // Tab sits inside the wrapper (DashboardGrid clips with
              // overflow-hidden); sm:pt-4 reserves a header zone so
              // the tab doesn't overlap widget header content.
              return (
                <div className="relative h-full sm:pt-4">
                  <span className="hidden sm:inline">
                    <SchematicLabel
                      module={meta.module.id}
                      status={meta.module.status}
                      glyph={meta.module.glyph}
                      state="active"
                      variant="tab"
                    />
                  </span>
                  {widget}
                </div>
              );
            }}
          />
        </>
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
