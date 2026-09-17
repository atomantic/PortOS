/**
 * The ONE place a manual "Run Now" outcome becomes user-visible copy (#7529).
 * Both consumers (the commission list and the detail page) call it so they can
 * never drift on the case that matters here: a fire whose run-history write
 * failed.
 *
 * That case used to be invisible. The scheduler returned `status: 'started'`
 * with `run: null` and both pages toasted an unconditional success promising the
 * render would show up — but the commission's render history is derived from
 * PERSISTED run ids, so nothing ever appeared there, no rating control existed,
 * and no notification was attempted (surfacing is gated on a real run). The
 * project was real and running the whole time; only its bookkeeping was lost.
 * `historyWarning` is the server saying exactly that, so the toast says it too
 * and hands over the project link, which is the only surviving route to the work.
 */

import { ExternalLink, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router';

import toast from '../ui/Toast';

// Long enough to read two lines and click the link, matching the app's other
// actionable render-prop toasts.
const WARNING_DURATION_MS = 12000;

const WARNING_LABEL = 'Run history not saved';

/** The primary outcome line — the same information the plain toasts carry. */
function outcomeSummary(result, startedMessage) {
  if (result?.status === 'started') return startedMessage;
  if (result?.status === 'skipped') return `Run skipped: ${result.reason}`;
  return `Run failed: ${result?.error || 'unknown error'}`;
}

function HistoryWarningToast({ t, projectId, outcome }) {
  return (
    <div className="flex items-start gap-2">
      <TriangleAlert className="w-4 h-4 mt-0.5 shrink-0 text-amber-400" aria-hidden="true" />
      <div className="text-sm">
        <p className="font-medium text-gray-100">{WARNING_LABEL}</p>
        <p className="text-gray-400">
          {outcome === 'started'
            ? 'Generation started, but this run could not be written to the commission’s history, so it will not show up in the render history.'
            : `This run was ${outcome}, but the outcome could not be written to the commission’s history.`}
        </p>
        {projectId ? (
          <Link
            to={`/creative-director/${projectId}`}
            onClick={() => toast.dismiss(t.id)}
            className="inline-flex items-center gap-1 mt-1 text-port-accent hover:underline"
          >
            Open the project <ExternalLink className="w-3 h-3" aria-hidden="true" />
          </Link>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Toast a manual-run outcome.
 *
 * With a `historyWarning` the warning REPLACES the normal line rather than
 * stacking beneath it: the success line's promise ("its render appears below")
 * is the precise thing that is no longer true, and two toasts for one click
 * would just race the dedup window. A degraded skip/fail still reports its
 * reason as a plain toast alongside — that information is independent of the
 * ledger and losing it would trade one blind spot for another.
 *
 * @param {object|null} result - the `/run` response body
 * @param {string} startedMessage - the success copy when history persisted
 */
export function toastRunOutcome(result, startedMessage) {
  const warning = result?.historyWarning;
  if (!warning) {
    if (result?.status === 'started') toast.success(startedMessage);
    else toast.error(outcomeSummary(result, startedMessage));
    return;
  }
  // The reason a skip/fail happened is not what the ledger lost — keep it.
  if (result?.status !== 'started') toast.error(outcomeSummary(result, startedMessage));
  toast((t) => (
    <HistoryWarningToast
      t={t}
      projectId={warning.projectId || result?.projectId || null}
      outcome={warning.outcome || result?.status || 'started'}
    />
  ), { duration: WARNING_DURATION_MS, icon: null, label: WARNING_LABEL });
}
