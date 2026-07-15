import { useNavigate } from 'react-router-dom';
import { formatDurationMs } from '../../utils/formatters';
import { StatButton, metricColor } from './cityHudBits';

// The System Vitals rows (uptime, health CPU/MEM/DISK, agents, stopped, archived,
// review, nodes, notifs, tasks, streak + the SYS.OK footer). Extracted from the
// desktop clock-rail so the SAME rows back both the desktop cockpit's vitals panel
// AND the compact/phone `vitals` disclosure surface — no divergent copies.
export default function CityVitalsList({
  uptimeSeconds,
  sentinel,
  cpuPct,
  memPct,
  diskPct,
  warnings,
  activeAgentCount,
  stoppedApps,
  archivedApps,
  pendingReview,
  alertCount,
  onlinePeers,
  totalNodes,
  notificationCounts,
  productivityData,
}) {
  const navigate = useNavigate();

  return (
    <div className="space-y-1.5">
      <div className="font-pixel text-[10px] text-cyan-500/70 tracking-wider mb-1">
        SYSTEM VITALS
      </div>

      {/* Uptime */}
      <div className="flex items-center justify-between gap-6">
        <span className="font-pixel text-[10px] text-gray-400 tracking-wide">UPTIME</span>
        <span className="font-pixel text-[11px] text-cyan-400" style={{ textShadow: '0 0 6px rgba(6,182,212,0.4)' }}>
          {formatDurationMs(uptimeSeconds * 1000)}
        </span>
      </div>

      <button
        type="button"
        onClick={() => navigate('/')}
        className="w-full flex items-center justify-between gap-3 -mx-1 px-1 py-1 min-h-[44px] sm:min-h-0 rounded hover:bg-cyan-500/5 transition-colors"
        title={warnings?.length ? warnings.map(w => w.message).join(' · ') : 'System health — click to open dashboard'}
        aria-label="System health — open dashboard"
      >
        <span className="font-pixel text-[10px] text-gray-400 tracking-wide flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${sentinel.dot} shadow-[0_0_4px_currentColor]`} />
          HEALTH
        </span>
        <span className="font-pixel text-[10px] tracking-wide flex items-center gap-2">
          <span className={metricColor(cpuPct)}>{cpuPct != null ? `${cpuPct}%` : '—'}</span>
          <span className="text-gray-600">/</span>
          <span className={metricColor(memPct)}>{memPct != null ? `${memPct}%` : '—'}</span>
          <span className="text-gray-600">/</span>
          <span className={metricColor(diskPct)}>{diskPct != null ? `${diskPct}%` : '—'}</span>
        </span>
      </button>
      <div className="flex items-center justify-between gap-6 -mt-0.5">
        <span className="font-pixel text-[8px] text-gray-600 tracking-wider pl-3.5">CPU · MEM · DISK</span>
        <span className={`font-pixel text-[8px] ${sentinel.text} tracking-wider`}>{sentinel.label}</span>
      </div>

      <StatButton
        label="AGENTS"
        valueClass={activeAgentCount > 0 ? 'text-emerald-400' : 'text-gray-600'}
        value={`${activeAgentCount} ACTIVE`}
        prefix={activeAgentCount > 0 ? <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 mr-1 animate-pulse" /> : null}
        onClick={() => navigate('/cos')}
        title="Open Chief of Staff"
      />

      {stoppedApps > 0 && (
        <StatButton label="STOPPED" valueClass="text-red-400" value={stoppedApps} onClick={() => navigate('/apps')} title="View apps" />
      )}

      {archivedApps > 0 && (
        <StatButton label="ARCHIVED" valueClass="text-gray-500" value={archivedApps} onClick={() => navigate('/apps')} title="View apps" />
      )}

      {(pendingReview > 0 || alertCount > 0) && (
        <StatButton
          label="REVIEW"
          valueClass={alertCount > 0 ? 'text-orange-400' : 'text-cyan-400'}
          value={`${pendingReview} PENDING${alertCount > 0 ? ` · ${alertCount} ALERT${alertCount === 1 ? '' : 'S'}` : ''}`}
          onClick={() => navigate('/review')}
          title="Open Review Hub"
        />
      )}

      <StatButton
        label="NODES"
        valueClass={onlinePeers > 0 ? 'text-violet-400' : 'text-gray-500'}
        value={`${onlinePeers}/${totalNodes} LINKED`}
        onClick={() => navigate('/instances')}
        title="Open Federation / Instances"
      />

      {notificationCounts?.unread > 0 && (
        <StatButton label="NOTIFS" valueClass="text-cyan-400" value={`${notificationCounts.unread} UNREAD`} onClick={() => navigate('/')} title="Open dashboard alerts" />
      )}

      {productivityData?.todaySucceeded > 0 && (
        <StatButton label="TASKS" valueClass="text-purple-400" value={`${productivityData.todaySucceeded} TODAY`} onClick={() => navigate('/cos')} title="Open Chief of Staff" />
      )}

      {productivityData?.currentDailyStreak > 0 && (
        <StatButton
          label="STREAK"
          valueClass={productivityData.currentDailyStreak >= 3 ? 'text-orange-400' : 'text-gray-400'}
          value={`${productivityData.currentDailyStreak}d`}
          onClick={() => navigate('/cos')}
          title="Open Chief of Staff"
        />
      )}

      {/* Divider */}
      <div className="border-t border-cyan-500/15 mt-1.5 pt-1.5">
        <div className="flex items-center justify-between">
          <span className="font-pixel text-[9px] text-cyan-500/40 tracking-widest">SYS.OK</span>
          <span className="font-pixel text-[9px] text-cyan-500/40 tracking-widest">
            {new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase()}
          </span>
        </div>
      </div>
    </div>
  );
}
