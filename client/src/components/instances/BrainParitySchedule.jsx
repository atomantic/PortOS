/**
 * Scheduled brain-parity sweep control (issue #4519).
 *
 * The per-peer `BrainParityPanel` only audits when someone presses Check, and
 * the divergence it looks for is by definition silent — so an install that
 * never presses it never learns. This is the opt-in cadence: one default-
 * disabled autonomous job (`job-brain-parity-sweep`) that runs the audit
 * against every federating peer.
 *
 * Deliberately install-level rather than per peer/category: the audit covers
 * exactly one category (brain), and the sweep intentionally includes peers whose
 * brain sync category is OFF — that is where divergence accumulates, so a
 * per-peer opt-out would exclude the peers most worth checking. Per-peer
 * granularity stays on demand via each card's Check button.
 *
 * Lives here on Instances rather than only in CoS → Jobs because this is where
 * a user is looking when they wonder whether their brains actually agree.
 */

import { useEffect, useState } from 'react';
import { CalendarClock, ToggleLeft, ToggleRight } from 'lucide-react';
import toast from '../ui/Toast';
import { getCosJob, toggleCosJob, updateCosJob } from '../../services/api';
import { JOB_INTERVAL_OPTIONS } from '../../utils/cronHelpers';
import { timeAgo } from '../../utils/formatters';

export const PARITY_SWEEP_JOB_ID = 'job-brain-parity-sweep';

export default function BrainParitySchedule() {
  // `undefined` = not loaded yet, `null` = this install has no such job (a
  // server too old to ship it). Distinct states so a pending fetch never
  // renders as "unsupported" — and an unsupported install renders nothing
  // rather than a control whose writes would 404.
  const [job, setJob] = useState(undefined);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    // `silent` — an install without the job is an expected outcome here, not an
    // error worth toasting on every Instances page load.
    getCosJob(PARITY_SWEEP_JOB_ID, { silent: true })
      .then((data) => { if (active) setJob(data ?? null); })
      .catch(() => { if (active) setJob(null); });
    return () => { active = false; };
  }, []);

  if (job === undefined || job === null) return null;

  const handleToggle = async () => {
    setSaving(true);
    const result = await toggleCosJob(PARITY_SWEEP_JOB_ID, { silent: true }).catch((err) => {
      toast.error(err.message);
      return null;
    });
    if (result?.job) {
      setJob(result.job);
      toast.success(result.job.enabled ? 'Parity sweep scheduled' : 'Parity sweep disabled');
    }
    setSaving(false);
  };

  const handleInterval = async (interval) => {
    setSaving(true);
    // Send `interval` alone — the server recomputes `intervalMs` from it, so
    // posting a client-side millisecond value would just risk disagreeing with
    // the canonical mapping.
    const result = await updateCosJob(PARITY_SWEEP_JOB_ID, { interval }, { silent: true }).catch((err) => {
      toast.error(err.message);
      return null;
    });
    if (result?.job) setJob(result.job);
    setSaving(false);
  };

  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-port-border bg-port-card/40 px-3 py-2">
      <CalendarClock size={14} className="text-gray-500 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-xs text-gray-300">Scheduled parity sweep</p>
        <p className="text-[10px] text-gray-500">
          {job.enabled
            ? 'Audits every federating peer on a schedule. Results land on each peer card below.'
            : 'Off. Parity is only checked when you press Check on a peer card.'}
          {job.lastRun && ` Last run ${timeAgo(job.lastRun)}.`}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <label htmlFor="parity-sweep-interval" className="sr-only">Parity sweep interval</label>
        <select
          id="parity-sweep-interval"
          value={job.interval || 'weekly'}
          onChange={(e) => handleInterval(e.target.value)}
          disabled={saving || !job.enabled}
          className="bg-port-bg border border-port-border rounded px-2 py-1 text-[11px] text-gray-300 disabled:opacity-50"
        >
          {JOB_INTERVAL_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>

        <button
          type="button"
          onClick={handleToggle}
          disabled={saving}
          aria-pressed={!!job.enabled}
          className="inline-flex items-center gap-1 text-[11px] text-gray-300 hover:text-white transition-colors disabled:opacity-50"
          title={job.enabled ? 'Disable the scheduled parity sweep' : 'Enable the scheduled parity sweep'}
        >
          {job.enabled
            ? <ToggleRight size={18} className="text-port-success" />
            : <ToggleLeft size={18} className="text-gray-600" />}
          {job.enabled ? 'On' : 'Off'}
        </button>
      </div>
    </div>
  );
}
