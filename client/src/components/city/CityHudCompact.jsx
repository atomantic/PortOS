import { useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Gauge, Bell, Clock, Activity, Map as MapIcon, Filter, Palette, Compass, Camera, History, Settings, X } from 'lucide-react';
import useDrawerTab from '../../hooks/useDrawerTab';
import { buildAttentionItems, CityIntelContent } from './CityIntelPane';
import CityVitalsList from './CityVitalsList';
import CityMiniMap from './CityMiniMap';
import CityFilterBar from './CityFilterBar';
import CityFocusPanel from './CityFocusPanel';
import { CITY_PANE_IDS, CITY_INTEL_PANE_IDS, CITY_PANE_LABELS } from './cityPanes';
import { birthDateCta } from '../../utils/characterXp';

// A 44×44 dock control. `active`/`aria-pressed` mark a toggled disclosure launcher;
// omit `active` for one-shot actions (photo, history) that just fire a callback.
function DockButton({ icon: Icon, label, active, badge = 0, badgeCritical = false, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      className={`relative shrink-0 w-11 h-11 flex items-center justify-center rounded-md border transition-colors ${
        active
          ? 'border-cyan-400/70 bg-cyan-500/15 text-cyan-300 shadow-[0_0_6px_rgba(6,182,212,0.3)]'
          : 'border-cyan-500/25 text-cyan-500/70 hover:text-cyan-300 hover:border-cyan-400/50'
      }`}
    >
      <Icon size={18} aria-hidden="true" />
      {badge > 0 && (
        <span
          className={`absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full font-pixel text-[8px] flex items-center justify-center ${
            badgeCritical ? 'bg-port-error text-white' : 'bg-cyan-500 text-black'
          }`}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

function StatusDot({ on, label, onClass, offClass = 'bg-gray-600' }) {
  return (
    <span className="flex items-center gap-1" title={label} aria-label={label}>
      <span className={`w-2.5 h-2.5 rounded-full ${on ? onClass : offClass}`} />
    </span>
  );
}

const LEGEND_ROWS = [
  { color: 'bg-cyan-500', label: 'ONLINE' },
  { color: 'bg-red-500', label: 'STOPPED' },
  { color: 'bg-violet-500', label: 'NOT STARTED' },
  { color: 'bg-slate-500', label: 'ARCHIVED' },
];

// Compact / phone HUD. Keeps the 3D scene the focus: by default only a small clock
// chip, a status chip and a bottom dock are shown (well under 30% coverage). Every
// secondary surface (vitals, attention, timeline, activity, map, filter, legend) is
// a single mutually-exclusive disclosure sheet driven by the `cityPane` URL param —
// so only one can be open, the open one is deep-linkable, and clearing it returns to
// the unobstructed scene.
export default function CityHudCompact({
  time,
  vitals,
  connected,
  cosStatus,
  character,
  filter,
  onFilterChange,
  onJumpToFirst,
  matchCount,
  apps,
  cosAgents,
  reviewCounts,
  instances,
  systemHealth,
  notificationCounts,
  eventLogs,
  onToggleExploration,
  explorationMode,
  onSelectApp,
  onEnterPhotoMode,
  onEnterPlayback,
  focusedAppId,
  focusedApp,
  focusNotFound,
  focusAgents,
  onCloseFocus,
  onOpenApp,
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [activePane, setActivePane] = useDrawerTab('cityPane', null, CITY_PANE_IDS);
  const togglePane = (id) => setActivePane(activePane === id ? null : id);
  const isFocused = Boolean(focusedApp || focusNotFound);

  const items = useMemo(
    () => buildAttentionItems({ apps, cosAgents, reviewCounts, instances, systemHealth, notificationCounts }),
    [apps, cosAgents, reviewCounts, instances, systemHealth, notificationCounts],
  );
  const criticalCount = items.filter(i => i.severity === 'critical').length;
  const hasApps = (apps || []).length > 0;
  // No usable level → the birth-date CTA distinguishes a genuinely unset date ("set") from a
  // present-but-unusable one ("fix" — invalid/future/unreadable) so we don't tell the user to
  // set a date they already entered (#2757). Null when a real level exists.
  const birthCta = character && character.level == null ? birthDateCta(character.birthDateStatus) : null;

  const onSettings = location.pathname === '/city/settings';
  const goSettings = () => navigate(onSettings ? `/city${location.search}` : `/city/settings${location.search}`);

  const renderPaneBody = () => {
    if (CITY_INTEL_PANE_IDS.includes(activePane)) {
      return <CityIntelContent tab={activePane} items={items} eventLogs={eventLogs} />;
    }
    if (activePane === 'vitals') {
      return <div className="p-3"><CityVitalsList {...vitals} /></div>;
    }
    if (activePane === 'map') {
      return hasApps
        ? <div className="p-3 flex justify-center"><CityMiniMap apps={apps} onSelectApp={onSelectApp} selectedAppId={focusedAppId} alwaysShow /></div>
        : <div className="p-6 text-center font-pixel text-[9px] text-cyan-500/40 tracking-wide">No buildings to map</div>;
    }
    if (activePane === 'filter') {
      return (
        <div className="p-3">
          <CityFilterBar filter={filter} onChange={onFilterChange} onJumpToFirst={onJumpToFirst} matchCount={matchCount} />
        </div>
      );
    }
    if (activePane === 'legend') {
      return (
        <div className="p-3 grid grid-cols-2 gap-2">
          {LEGEND_ROWS.map(row => (
            <div key={row.label} className="flex items-center gap-1.5">
              <span className={`w-2.5 h-2.5 rounded-xs ${row.color}`} />
              <span className="font-pixel text-[9px] text-gray-300 tracking-wide">{row.label}</span>
            </div>
          ))}
        </div>
      );
    }
    return null;
  };

  return (
    <>
      {/* Top-left: compact clock + health → opens vitals */}
      <div className="absolute top-2 left-2 pointer-events-auto">
        <button
          type="button"
          onClick={() => togglePane('vitals')}
          aria-label="Time and system vitals"
          aria-pressed={activePane === 'vitals'}
          className={`relative bg-black/85 backdrop-blur-sm border rounded-lg px-3 min-h-[44px] flex items-center gap-2 transition-colors ${
            activePane === 'vitals' ? 'border-cyan-400/70' : 'border-cyan-500/40'
          }`}
        >
          <span className={`w-2 h-2 rounded-full ${vitals.sentinel.dot} shadow-[0_0_4px_currentColor]`} />
          <span className="font-pixel text-cyan-400 text-sm tracking-wider" style={{ textShadow: '0 0 8px rgba(6,182,212,0.5)' }}>
            {time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
          <span className="font-pixel text-[9px] text-cyan-500 tracking-wide">{vitals.activeApps}/{vitals.totalApps}</span>
        </button>
      </div>

      {/* Top-right: connection + CoS + level */}
      <div className="absolute top-2 right-2 pointer-events-auto flex items-center gap-1.5">
        <div
          className="bg-black/85 backdrop-blur-sm border border-cyan-500/40 rounded-lg px-2.5 min-h-[44px] flex items-center gap-2"
          role="status"
          aria-label={`Link ${connected ? 'online' : 'offline'}, Chief of Staff ${cosStatus?.running ? 'running' : 'idle'}`}
        >
          <StatusDot on={connected} label={connected ? 'Link online' : 'Link offline'} onClass="bg-port-success shadow-[0_0_8px_rgba(34,197,94,0.6)]" offClass="bg-port-error" />
          <StatusDot on={cosStatus?.running} label={cosStatus?.running ? 'CoS running' : 'CoS idle'} onClass="bg-cyan-400 animate-pulse shadow-[0_0_8px_rgba(6,182,212,0.6)]" />
        </div>
        {character?.level != null ? (
          <button
            type="button"
            onClick={() => navigate('/character')}
            aria-label={`Character sheet — level ${character.level}`}
            title="Open character sheet"
            className="bg-black/85 backdrop-blur-sm border border-cyan-500/40 rounded-lg px-2.5 min-h-[44px] flex items-center font-pixel text-[11px] text-cyan-300 tracking-wider"
          >
            LV {character.level}
          </button>
        ) : birthCta ? (
          // Character loaded but no usable level (age-based, #2673). Prompt the user to set the
          // birth date — or FIX it when present-but-unusable (#2757) — routing to the age editor
          // where the field lives.
          <button
            type="button"
            onClick={() => navigate(birthCta.path)}
            aria-label={`${birthCta.title} to show your level`}
            title={birthCta.title}
            className="bg-black/85 backdrop-blur-sm border border-cyan-500/40 rounded-lg px-2.5 min-h-[44px] flex items-center font-pixel text-[11px] text-cyan-300/70 tracking-wider"
          >
            {birthCta.badgeLabel}
          </button>
        ) : null}
      </div>

      {/* Focused building detail sheet (issue #2593) — replaces the disclosure sheet while a
          borough is focused so the two never overlap. */}
      {isFocused && (
        <CityFocusPanel
          app={focusedApp}
          notFound={focusNotFound}
          agents={focusAgents}
          onClose={onCloseFocus}
          onOpenApp={onOpenApp}
          isDesktop={false}
        />
      )}

      {/* Disclosure sheet — one surface at a time, above the dock */}
      {!isFocused && activePane && (
        <div className="absolute inset-x-2 bottom-16 pointer-events-auto">
          <div className="bg-black/90 backdrop-blur-md border border-cyan-500/35 rounded-lg flex flex-col max-h-[55vh] overflow-hidden">
            <div className="flex items-center justify-between pl-3 pr-1 py-1.5 border-b border-cyan-500/20 shrink-0">
              <span className="font-pixel text-[11px] text-cyan-400 tracking-widest" style={{ textShadow: '0 0 8px rgba(6,182,212,0.4)' }}>
                {(CITY_PANE_LABELS[activePane] || '').toUpperCase()}
              </span>
              <button
                type="button"
                onClick={() => setActivePane(null)}
                aria-label="Close panel"
                title="Close"
                className="w-11 h-11 flex items-center justify-center text-gray-400 hover:text-cyan-400 transition-colors"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            <div className="flex-1 flex flex-col min-h-0 overflow-y-auto">
              {renderPaneBody()}
            </div>
          </div>
        </div>
      )}

      {/* Bottom dock — every HUD function within two taps */}
      <div className="absolute bottom-2 left-2 right-2 pointer-events-auto">
        <div
          className="flex items-center gap-1.5 bg-black/85 backdrop-blur-sm border border-cyan-500/30 rounded-lg px-1.5 py-1.5 overflow-x-auto scrollbar-hide touch-pan-x"
          role="toolbar"
          aria-label="City controls"
        >
          <DockButton icon={Gauge} label="System vitals" active={activePane === 'vitals'} onClick={() => togglePane('vitals')} />
          <DockButton icon={Bell} label="Attention" active={activePane === 'attention'} badge={items.length} badgeCritical={criticalCount > 0} onClick={() => togglePane('attention')} />
          <DockButton icon={Clock} label="Timeline" active={activePane === 'timeline'} onClick={() => togglePane('timeline')} />
          <DockButton icon={Activity} label="Activity log" active={activePane === 'activity'} onClick={() => togglePane('activity')} />
          {hasApps && <DockButton icon={MapIcon} label="Map" active={activePane === 'map'} onClick={() => togglePane('map')} />}
          <DockButton icon={Filter} label="Filter apps" active={activePane === 'filter'} onClick={() => togglePane('filter')} />
          <DockButton icon={Palette} label="Legend" active={activePane === 'legend'} onClick={() => togglePane('legend')} />

          <div className="w-px h-6 bg-cyan-500/20 shrink-0" />

          <DockButton
            icon={Compass}
            label={explorationMode ? 'Fly out to orbital view' : 'Drop in to street level'}
            active={explorationMode}
            onClick={onToggleExploration}
          />
          {onEnterPhotoMode && <DockButton icon={Camera} label="Photo mode" onClick={onEnterPhotoMode} />}
          {onEnterPlayback && <DockButton icon={History} label="History playback" onClick={onEnterPlayback} />}
          <DockButton icon={Settings} label="City settings" active={onSettings} onClick={goSettings} />
        </div>
      </div>
    </>
  );
}
