import { formatDurationMs, formatMonthDay } from '../../utils/formatters';
import { StatButton, metricColor } from './openWorldHudBits';

// The System Vitals rows (uptime, health CPU/MEM/DISK, agents, stopped, archived,
// review, nodes, notifs, tasks, streak + the SYS.OK footer). Extracted from the
// desktop clock-rail so the SAME rows back both the desktop cockpit's vitals panel
// AND the compact/phone `vitals` disclosure surface — no divergent copies.
export default function OpenWorldVitalsList({
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
  onOpenDestination,
}) {
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
        onClick={() => onOpenDestination?.('wellness')}
        className="w-full flex items-center justify-between gap-3 -mx-1 px-1 py-1 min-h-[44px] sm:min-h-0 rounded hover:bg-cyan-500/5 transition-colors"
        title={warnings?.length ? warnings.map(w => w.message).join(' · ') : 'Teleport to Wellness District'}
        aria-label="System health — teleport to Wellness District"
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
        onClick={() => onOpenDestination?.('ai-core')}
        title="Teleport to AI Core"
      />

      {stoppedApps > 0 && (
        <StatButton label="STOPPED" valueClass="text-red-400" value={stoppedApps} onClick={() => onOpenDestination?.('downtown')} title="Teleport to Downtown" />
      )}

      {archivedApps > 0 && (
        <StatButton label="ARCHIVED" valueClass="text-gray-500" value={archivedApps} onClick={() => onOpenDestination?.('downtown')} title="Teleport to Downtown" />
      )}

      {(pendingReview > 0 || alertCount > 0) && (
        <StatButton
          label="REVIEW"
          valueClass={alertCount > 0 ? 'text-orange-400' : 'text-cyan-400'}
          value={`${pendingReview} PENDING${alertCount > 0 ? ` · ${alertCount} ALERT${alertCount === 1 ? '' : 'S'}` : ''}`}
          onClick={() => onOpenDestination?.('task-queue')}
          title="Teleport to Task Queue"
        />
      )}

      <StatButton
        label="NODES"
        valueClass={onlinePeers > 0 ? 'text-violet-400' : 'text-gray-500'}
        value={`${onlinePeers}/${totalNodes} LINKED`}
        onClick={() => onOpenDestination?.('data-harbor')}
        title="Teleport to Data Harbor"
      />

      {notificationCounts?.unread > 0 && (
        <StatButton label="NOTIFS" valueClass="text-cyan-400" value={`${notificationCounts.unread} UNREAD`} onClick={() => onOpenDestination?.('downtown')} title="Teleport to Downtown" />
      )}

      {productivityData?.todaySucceeded > 0 && (
        <StatButton label="TASKS" valueClass="text-purple-400" value={`${productivityData.todaySucceeded} TODAY`} onClick={() => onOpenDestination?.('productivity')} title="Teleport to Productivity" />
      )}

      {productivityData?.currentDailyStreak > 0 && (
        <StatButton
          label="STREAK"
          valueClass={productivityData.currentDailyStreak >= 3 ? 'text-orange-400' : 'text-gray-400'}
          value={`${productivityData.currentDailyStreak}d`}
          onClick={() => onOpenDestination?.('productivity')}
          title="Teleport to Productivity"
        />
      )}

      {/* Divider */}
      <div className="border-t border-cyan-500/15 mt-1.5 pt-1.5">
        <div className="flex items-center justify-between">
          <span className="font-pixel text-[9px] text-cyan-500/40 tracking-widest">SYS.OK</span>
          <span className="font-pixel text-[9px] text-cyan-500/40 tracking-widest">
            {formatMonthDay(new Date()).toUpperCase()}
          </span>
        </div>
      </div>
    </div>
  );
}
