import { RotateCw, ExternalLink, CheckCircle2, XCircle, ListChecks } from 'lucide-react';
import Drawer from '../Drawer';
import { timeAgo, formatDateShort } from '../../utils/formatters';
import { CASE_STATE_TONE, ACTION_TONES, manualCaseActions, labelFor, CASE_STATES } from './constants';

// Action icon by descriptor `icon` token (positive resolution vs dismiss).
const ACTION_ICONS = { check: CheckCircle2, x: XCircle };

// Read-only case inspector + manual controls (issue #2146). Deep-linked open
// state is owned by the parent (a `?case=<id>` search param), so this component
// is a pure controlled view. The backend does not persist a full state-history
// log, so "history" here is the timeline we DO have: created → last-updated →
// next-recheck, plus the current reason/channel/disclosure/evidence.
export default function BrokerCaseDrawer({
  open, onClose, caseData, broker, onRecheck, onTransition, busy = false,
}) {
  // Stale/deleted deep link — the case is gone but the URL still points at it.
  const notFound = open && !caseData;

  const evidence = caseData?.evidence || {};
  const listingUrls = Array.isArray(evidence.listing_urls) ? evidence.listing_urls : [];
  const playbook = Array.isArray(broker?.optout?.playbook) ? broker.optout.playbook : [];
  const optoutUrl = broker?.optout?.url || evidence.optout_url || null;
  const searchUrl = evidence.search_url || null;

  // Which manual transitions make sense from the current state. The action
  // descriptors (label/tone/icon) live in the shared CASE_ACTIONS presentation
  // table; legality is gated by the server-supplied `allowedTransitions`, so the
  // drawer and digest strip can't drift from the server's state machine.
  const state = caseData?.state;
  const isBlocked = state === 'blocked';
  const actions = manualCaseActions(state, caseData?.allowedTransitions);

  const Row = ({ label, children }) => (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wide text-gray-500">{label}</span>
      <div className="text-sm text-gray-200 break-words">{children}</div>
    </div>
  );

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Broker case"
      subtitle={caseData?.brokerName || broker?.name}
      size="md"
    >
      {notFound ? (
        <div className="text-center text-sm text-gray-500 py-10">
          This case no longer exists. It may have been re-scanned or removed.
        </div>
      ) : caseData ? (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`text-xs px-2 py-0.5 rounded border ${CASE_STATE_TONE[state] || ''}`}>
              {labelFor(CASE_STATES, state)}
            </span>
            {broker?.tier !== undefined && (
              <span className="text-[10px] px-1.5 py-0.5 rounded border border-port-border text-gray-400">Tier {broker.tier}</span>
            )}
            {broker?.clusterParent && (
              <span className="text-[10px] px-1.5 py-0.5 rounded border border-port-accent/30 text-port-accent">
                child of {broker.clusterParent}
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Row label="First seen">{caseData.createdAt ? formatDateShort(caseData.createdAt) : '—'}</Row>
            <Row label="Last updated">{caseData.updatedAt ? timeAgo(caseData.updatedAt) : '—'}</Row>
            <Row label="Next re-check">{caseData.nextRecheckAt ? formatDateShort(caseData.nextRecheckAt) : '—'}</Row>
            <Row label="Channel">{caseData.channel || '—'}</Row>
          </div>

          {caseData.reason && <Row label="Reason">{caseData.reason}</Row>}

          {isBlocked && (
            <div className="text-xs text-gray-300 bg-port-warning/5 border border-port-warning/30 rounded p-2.5 space-y-1.5">
              <p>
                This broker blocks automated checks, so your exposure here is <span className="text-white">unknown</span> —
                not confirmed. Open the same search in your own browser (real browsers pass these walls),
                then record what you find below.
              </p>
              {searchUrl && (
                <a
                  href={searchUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-port-accent hover:underline"
                >
                  <ExternalLink size={12} /> Check manually in your browser
                </a>
              )}
            </div>
          )}

          <Row label="Disclosed fields">
            {(caseData.disclosedFields || []).length
              ? (caseData.disclosedFields || []).map((f) => (
                <span key={f} className="inline-block text-[10px] px-1.5 py-0.5 mr-1 mb-1 rounded border border-port-border text-gray-400">{f}</span>
              ))
              : <span className="text-gray-500">None disclosed</span>}
          </Row>

          <Row label="Evidence">
            {evidence.match_basis && (
              <div className="text-xs text-gray-400 mb-1">Match basis: {evidence.match_basis}</div>
            )}
            {listingUrls.length ? (
              <ul className="space-y-1">
                {listingUrls.map((u) => (
                  <li key={u}>
                    <a href={u} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-port-accent hover:underline break-all">
                      <ExternalLink size={12} /> {u}
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-gray-500 text-xs">No listing URLs recorded</span>
            )}
            {evidence.screenshot && (
              <a href={evidence.screenshot} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-port-accent hover:underline mt-1">
                <ExternalLink size={12} /> Confirmation screenshot
              </a>
            )}
          </Row>

          {playbook.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                <ListChecks size={13} /> Broker opt-out playbook
              </div>
              <ol className="list-decimal list-inside space-y-1 text-xs text-gray-300">
                {playbook.map((step, i) => <li key={i}>{step}</li>)}
              </ol>
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-2 border-t border-port-border">
            <button
              onClick={() => onRecheck?.(caseData)}
              disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded border border-port-border text-gray-300 hover:text-white hover:bg-port-card disabled:opacity-50"
            >
              <RotateCw size={14} /> Force re-check
            </button>
            {actions.map((action) => {
              const Icon = ACTION_ICONS[action.icon] || CheckCircle2;
              return (
                <button
                  key={action.target}
                  onClick={() => onTransition?.(caseData, action.target)}
                  disabled={busy}
                  className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded border ${ACTION_TONES[action.tone]?.button || ''} disabled:opacity-50`}
                >
                  <Icon size={14} /> {action.label}
                </button>
              );
            })}
            {optoutUrl && (
              <a
                href={optoutUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded border border-port-border text-gray-300 hover:text-white hover:bg-port-card"
              >
                <ExternalLink size={14} /> Open opt-out page
              </a>
            )}
          </div>
        </div>
      ) : null}
    </Drawer>
  );
}
