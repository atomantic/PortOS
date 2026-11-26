/**
 * The Chief of Staff avatar/status side panel in its desktop rail and mobile header variants (SVG/canvas avatar, ascii terminal, and the collapsed rail).
 *
 * Owns the mobile collapse preference and the lazy avatar registry, so three.js stays out of the page chunk until the chosen style needs it. The desktop-rail collapse state belongs to the page because its grid and skeleton also read it.
 */
import { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { ChevronDown, ChevronUp, PanelLeftClose } from 'lucide-react';
import useMediaQuery from '../../hooks/useMediaQuery';
import { isRiggedAvatarStyle, riggedRecordForStyle } from '../../hooks/useAvatarCapabilities';
import { WEBGL_AVATAR_STYLE_IDS } from '../../lib/avatarStyles';
import BrailleSpinner from '../BrailleSpinner';
import CoSCharacter from './CoSCharacter';
import StateLabel from './StateLabel';
import TerminalCoSPanel from './TerminalCoSPanel';
import StatusIndicator from './StatusIndicator';
import StatusBubble, { StatusPill, isGenericStatusMessage } from './StatusBubble';
import EventLog from './EventLog';
import CosStatsCards from './CosStatsCards';

// Three.js-based avatars lazy-loaded so the R3F stack isn't bundled unless the
// user's chosen avatar style actually needs it. `core` is a plain 2D canvas
// (no three.js) but stays lazy so the default SVG path loads nothing extra.
// Every registry id (`lib/avatarStyles.js`) EXCEPT `svg`/`ascii` renders through
// a lazily-loaded component here — those two fall through to the inline
// `CoSCharacter` default below. `ChiefOfStaff.test.jsx` fails if a registry id
// is missing from this map (or from the inline-rendered pair).
export const INLINE_RENDERED_AVATAR_STYLES = new Set(['svg', 'ascii']);

export const LAZY_AVATARS = {
  cyber:    lazy(() => import('./CyberCoSAvatar')),
  sigil:    lazy(() => import('./SigilCoSAvatar')),
  esoteric: lazy(() => import('./EsotericCoSAvatar')),
  nexus:    lazy(() => import('./NexusCoSAvatar')),
  muse:     lazy(() => import('./MuseCoSAvatar')),
  core:     lazy(() => import('./CoreCoSAvatar')),
  // Bundled CC0 Kenney Mini Characters — animated rigged GLB avatars.
  miniMaleC:   lazy(() => import('./MiniCharMaleC')),
  miniFemaleD: lazy(() => import('./MiniCharFemaleD')),
};

// A verified animated record renders through the same mini-character stage —
// the variant URL resolves to the record's GLB via /api/avatar, and playback
// falls back to a present clip per its coverage. Lazy like every other 3D
// avatar so three.js stays out of the main chunk until it is picked.
const LazyRiggedAvatar = lazy(() => import('./MiniCharacterCoSAvatar'));

// `CANVAS_AVATAR_STYLES` means "needs the WebGL/three.js stage" — derives
// directly from the registry's `webgl` flag (`lib/avatarStyles.js`).
const CANVAS_AVATAR_STYLES = WEBGL_AVATAR_STYLE_IDS;

// Shared brand gradient for the "CoS" wordmark headings (clipped to text).
const COS_TITLE_GRADIENT = 'linear-gradient(135deg, #6366f1, #8b5cf6, #06b6d4)';
const COS_TITLE_STYLE = {
  background: COS_TITLE_GRADIENT,
  WebkitBackgroundClip: 'text',
  WebkitTextFillColor: 'transparent',
  backgroundClip: 'text',
};

const AvatarFallback = () => <div className="flex items-center justify-center h-full"><BrailleSpinner /></div>;

function Avatar({ avatarStyle, agentState, speaking, riggedAvatars, background = false }) {
  // A rigged record plays on the mini-character stage: the variant URL
  // resolves to its animated GLB, and its coverage drives the fallback to
  // a present clip. A record deleted after being picked 404s its HEAD
  // probe, so the stage shows the missing-model hint instead of a canvas.
  if (isRiggedAvatarStyle(avatarStyle)) {
    const record = riggedRecordForStyle(riggedAvatars, avatarStyle);
    return (
      <Suspense fallback={<AvatarFallback />}>
        <LazyRiggedAvatar state={agentState} speaking={speaking} background={background} variant={avatarStyle} coverage={record?.coverage || null} />
      </Suspense>
    );
  }
  const LazyAvatar = LAZY_AVATARS[avatarStyle];
  if (LazyAvatar) {
    return (
      <Suspense fallback={<AvatarFallback />}>
        <LazyAvatar state={agentState} speaking={speaking} background={background} />
      </Suspense>
    );
  }
  return <CoSCharacter state={agentState} speaking={speaking} />;
}

/** Shared status loading and retry UI. */
export function CosStatusPlaceholder({ failed, onRetry }) {
  if (failed) {
    return (
      <div role="alert" className="p-3 text-sm text-gray-400">
        Could not load CoS status.
        <button type="button" onClick={onRetry} className="ml-2 text-port-accent">Retry CoS status</button>
      </div>
    );
  }
  return (
    <div role="status" aria-label="Loading CoS status" className="p-3">
      <BrailleSpinner text="Loading CoS status" />
    </div>
  );
}

// The phone-width header that toggles the panel body.
function MobilePanelToggle({ status, agentState, collapsed, onToggle, controls, className = '' }) {
  return (
    <button
      onClick={onToggle}
      className={`${className ? `${className} ` : ''}flex items-center justify-between w-full px-3 py-2 bg-port-card/60 border-b border-port-accent-2/20 min-h-[40px]`}
      aria-expanded={!collapsed}
      aria-controls={controls}
    >
      <div className="flex items-center gap-2">
        <h2 className="text-base font-bold" style={COS_TITLE_STYLE}>CoS</h2>
        <StatusIndicator running={status?.running} paused={status?.paused} />
      </div>
      <div className="flex items-center gap-1.5 text-gray-400">
        <StateLabel state={agentState} compact />
        {collapsed ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
      </div>
    </button>
  );
}

function TerminalPanel({ cos, desktopCollapsed, onToggleDesktop, desktopToggleRef, mobileCollapsed, onToggleMobile }) {
  const { status, agentState, speaking, statusMessage, eventLogs } = cos;
  const terminal = (
    <TerminalCoSPanel
      state={agentState}
      speaking={speaking}
      statusMessage={statusMessage}
      eventLogs={eventLogs}
      running={status?.running}
      onStart={cos.handleStart}
      onStop={cos.handleStop}
      stats={status?.stats}
    />
  );
  return (
    <>
      {/* Desktop: collapsed placeholder or full panel */}
      {desktopCollapsed ? (
        <div className="hidden cos-wide:block overflow-hidden min-w-0" />
      ) : (
        <div className="hidden cos-wide:block relative min-w-0 w-full max-w-full cos-wide:w-[320px] cos-wide:max-w-[320px]">
          <button
            ref={desktopToggleRef}
            type="button"
            onClick={onToggleDesktop}
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center absolute top-2 right-2 z-10 p-1.5 text-gray-500 hover:text-white transition-colors rounded-md hover:bg-white/5"
            aria-label="Collapse CoS panel"
            title="Collapse CoS panel"
          >
            <PanelLeftClose size={16} />
          </button>
          {terminal}
        </div>
      )}
      {/* Keep the mobile queue reachable while retaining terminal identity. */}
      <div className="cos-wide:hidden">
        <button onClick={onToggleMobile}
          className="flex items-center justify-between gap-2 w-full px-3 py-2 min-h-[44px]"
          aria-expanded={!mobileCollapsed} aria-controls="cos-terminal-mobile">
          <span>CoS <StatusIndicator running={status?.running} paused={status?.paused} /></span>
          {mobileCollapsed ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
        </button>
        <div id="cos-terminal-mobile" hidden={mobileCollapsed}>
          {terminal}
        </div>
      </div>
    </>
  );
}

// Desktop rail collapsed: a hidden placeholder there, the compact header (with
// its four-tile grid when expanded) on phones.
function CollapsedPanel({ cos, mobileCollapsed, onToggleMobile }) {
  return (
    <>
      <div className="hidden cos-wide:block overflow-hidden min-w-0" />
      <div className="cos-wide:hidden border-b border-port-accent-2/20 bg-gradient-to-b from-port-card/80 to-port-card/40">
        <MobilePanelToggle status={cos.status} agentState={cos.agentState} collapsed={mobileCollapsed} onToggle={onToggleMobile} controls={mobileCollapsed ? undefined : 'cos-agent-panel'} />
        {!mobileCollapsed && (
          <div id="cos-agent-panel" className="flex flex-1 min-w-0 p-2">
            {/* Mobile Stats Grid */}
            <div className="flex-1 grid grid-cols-2 gap-1.5 relative z-10 content-center">
              <CosStatsCards cos={cos} variant="collapsed" />
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function FullPanel({ cos, riggedAvatars, onToggleDesktop, desktopToggleRef, mobileCollapsed, onToggleMobile }) {
  const { status, agentState, speaking, statusMessage, eventLogs, avatarStyle } = cos;
  const hasCanvasAvatar = CANVAS_AVATAR_STYLES.has(avatarStyle) || isRiggedAvatarStyle(avatarStyle);
  const avatar = (background) => (
    <Avatar avatarStyle={avatarStyle} agentState={agentState} speaking={speaking} riggedAvatars={riggedAvatars} background={background} />
  );
  return (
    <div className="relative flex flex-col border-b cos-wide:border-b-0 cos-wide:border-r border-port-accent-2/20 bg-gradient-to-b from-port-card/80 to-port-card/40 shrink-0 w-full max-w-full min-w-0 cos-wide:w-[320px] cos-wide:max-w-[320px] overflow-x-hidden cos-wide:h-full cos-wide:overflow-y-auto scrollbar-hide">
      {/* Desktop Collapse Button */}
      <button
        ref={desktopToggleRef}
        type="button"
        onClick={onToggleDesktop}
        className="min-h-[44px] min-w-[44px] items-center justify-center hidden cos-wide:flex absolute top-2 right-2 z-20 p-1.5 text-gray-500 hover:text-white transition-colors rounded-md hover:bg-white/5"
        aria-label="Collapse CoS panel"
        title="Collapse CoS panel"
      >
        <PanelLeftClose size={16} />
      </button>

      {/* Mobile Collapse Toggle Header */}
      <MobilePanelToggle className="cos-wide:hidden" status={status} agentState={agentState} collapsed={mobileCollapsed} onToggle={onToggleMobile} controls="cos-agent-panel" />

      {/* Collapsible Content */}
      <div
        id="cos-agent-panel"
        className={`${mobileCollapsed ? 'hidden' : 'flex'} cos-wide:flex min-w-0 w-full max-w-full relative overflow-hidden ${hasCanvasAvatar ? 'flex-none min-h-[180px] sm:min-h-[190px] md:min-h-[190px] cos-wide:min-h-dvh-cap cos-wide:[--dvh-cap:460px] cos-wide:[--dvh-inset:1rem] xl:[--dvh-cap:620px]' : 'flex-1'}`}
      >
        {/* Background Effects */}
        <div
          className="absolute inset-0 z-0 pointer-events-none"
          style={{
            background: `
              radial-gradient(circle at 50% 20%, rgba(99, 102, 241, 0.1) 0%, transparent 50%),
              repeating-linear-gradient(0deg, transparent, transparent 50px, rgba(99, 102, 241, 0.03) 50px, rgba(99, 102, 241, 0.03) 51px)
            `
          }}
        />

        {hasCanvasAvatar && (
          // Cap the full-bleed avatar canvas to the panel's BASE height
          // (the same min-h the panel starts at) and anchor it to the top.
          // The panel itself uses min-h so it can grow to fit the stats grid
          // + event log without clipping; without this cap the inset-0 canvas
          // grows with the panel on desktop, dragging the framed avatar down
          // into the stats grid below it.
          <div className="absolute inset-0 cos-wide:bottom-auto cos-wide:h-dvh-cap cos-wide:[--dvh-cap:460px] cos-wide:[--dvh-inset:1rem] xl:[--dvh-cap:620px] z-[1] -translate-x-16 -translate-y-1 sm:translate-x-0 sm:-translate-y-6 md:-translate-y-8 cos-wide:-translate-y-28 xl:-translate-y-36">
            {avatar(true)}
          </div>
        )}

        {/* Avatar UI overlays the full-width canvas stage for 3D styles. */}
        <div
          className={`${
            hasCanvasAvatar
              ? 'absolute inset-y-0 left-0 w-[46%] p-2 sm:p-3'
              : 'relative flex-1 w-full p-2'
          } min-w-0 cos-wide:relative cos-wide:inset-auto cos-wide:w-full cos-wide:max-w-full cos-wide:flex-none cos-wide:min-h-full cos-wide:px-4 cos-wide:py-6 flex flex-col items-center z-10`}
        >
          <div className="hidden cos-wide:block text-sm font-semibold tracking-widest uppercase text-port-text-muted mb-1 font-mono">
            Digital Assistant
          </div>
          <h2
            className="hidden cos-wide:block text-lg sm:text-xl cos-wide:text-2xl xl:text-3xl font-bold mb-2 cos-wide:mb-4"
            style={COS_TITLE_STYLE}
          >
            Chief of Staff
          </h2>

          {isGenericStatusMessage(statusMessage) && <StatusPill state={agentState} message={statusMessage} />}
          {!hasCanvasAvatar && avatar(false)}
          {hasCanvasAvatar && <div className="flex-none h-[5.75rem] sm:h-[4rem] md:h-[3rem] cos-wide:h-[11rem] xl:h-[12rem]" aria-hidden="true" />}
          <div className="hidden cos-wide:block">
            <StateLabel state={agentState} />
          </div>
          <div className={`${hasCanvasAvatar ? 'sm:-mt-4 md:-mt-6 cos-wide:mt-0' : ''} hidden sm:block`}>
            {!isGenericStatusMessage(statusMessage) && <StatusBubble message={statusMessage} />}
          </div>

          {/* Desktop Stats Grid - integrated into CoS sidebar (matches mobile compressed layout) */}
          <div className="hidden cos-wide:grid grid-cols-2 gap-1.5 w-full min-w-0 mt-3 relative z-10">
            <CosStatsCards cos={cos} variant="sidebar" />
          </div>

          {status?.running && (
            <div className="hidden cos-wide:flex flex-1 min-h-0 w-full min-w-0 flex-col">
              <EventLog logs={eventLogs} />
            </div>
          )}
        </div>

        {/* Mobile Stats Grid - shows core stats in compact 2-column layout */}
        <div className={`${hasCanvasAvatar ? 'ml-[46%] w-[54%] flex-none self-start content-start' : 'flex-1 content-center'} grid grid-cols-2 gap-1.5 p-2 cos-wide:hidden relative z-10`}>
          <CosStatsCards cos={cos} variant="sidebar" />
        </div>
      </div>
    </div>
  );
}

/**
 * @param {object} props
 * @param {object} props.cos The `useCosPageData` result.
 * @param {string} props.activeTab Route tab; the Tasks tab starts the mobile panel collapsed.
 * @param {Array} props.riggedAvatars Verified animated avatar records for rigged styles.
 * @param {boolean} props.desktopCollapsed Whether the desktop rail is collapsed (owned by the page).
 * @param {() => void} props.onToggleDesktop Toggles the desktop rail.
 * @param {import('react').Ref<HTMLButtonElement>} props.desktopToggleRef Focus target when the desktop rail expands.
 */
export default function CosAgentPanel({ cos, activeTab, riggedAvatars, desktopCollapsed, onToggleDesktop, desktopToggleRef }) {
  // A landscape phone has no height to spare: the stacked agent panel would
  // push all tab content out of view, so short viewports start collapsed too.
  const shortViewport = useMediaQuery('(max-height: 500px)');
  const [mobileCollapsed, setMobileCollapsed] = useState(() => activeTab === 'tasks' || shortViewport);
  // Once the user toggles the panel their choice stops tracking the tab.
  const mobilePreferenceSet = useRef(false);
  useEffect(() => {
    if (!mobilePreferenceSet.current) setMobileCollapsed(activeTab === 'tasks' || shortViewport);
  }, [activeTab, shortViewport]);
  const onToggleMobile = () => {
    mobilePreferenceSet.current = true;
    setMobileCollapsed(value => !value);
  };

  if (typeof cos.status?.running !== 'boolean') {
    return (
      <div className="min-w-0 overflow-hidden border-b cos-wide:border-r border-port-border">
        {activeTab !== 'config' && (
          <div className={desktopCollapsed ? 'cos-wide:hidden' : ''}>
            <CosStatusPlaceholder failed={cos.statusReadFailed} onRetry={cos.fetchData} />
          </div>
        )}
      </div>
    );
  }
  if (cos.avatarStyle === 'ascii') {
    return <TerminalPanel cos={cos} desktopCollapsed={desktopCollapsed} onToggleDesktop={onToggleDesktop} desktopToggleRef={desktopToggleRef} mobileCollapsed={mobileCollapsed} onToggleMobile={onToggleMobile} />;
  }
  if (desktopCollapsed) {
    return <CollapsedPanel cos={cos} mobileCollapsed={mobileCollapsed} onToggleMobile={onToggleMobile} />;
  }
  return <FullPanel cos={cos} riggedAvatars={riggedAvatars} onToggleDesktop={onToggleDesktop} desktopToggleRef={desktopToggleRef} mobileCollapsed={mobileCollapsed} onToggleMobile={onToggleMobile} />;
}
