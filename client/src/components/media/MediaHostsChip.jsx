import { useId, useState } from 'react';
import { Server, Crown } from 'lucide-react';
import toast from '../ui/Toast';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import { refreshMediaHolders } from '../../hooks/useMediaHolders';
import { makeMediaPrimary } from '../../services/api';

const CHIP = 'px-1.5 py-0.5 rounded inline-flex items-center gap-0.5';
const names = (list) => list.map((h) => h.name).join(', ');

function summarize(result) {
  const parts = [];
  if (result.released?.length) parts.push(`removed from ${names(result.released)}`);
  if (result.pending?.length) parts.push(`waiting on ${names(result.pending)}`);
  if (result.kept?.length) parts.push(`kept on ${result.kept.map((h) => `${h.name} (${h.reason})`).join(', ')}`);
  return parts.length ? `Primary set; copy ${parts.join('; ')}` : 'Primary set';
}

/**
 * Where a render lives when another machine holds it too: "Hosted on <peer>"
 * for a single remote holder, "N hosts" with the list of machines when several
 * hold it. Each listed machine offers Make primary, which keeps that copy and
 * deletes the others after an inline confirmation naming exactly which go.
 */
export default function MediaHostsChip({ entry, disabled = false }) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState(null);
  const [busy, setBusy] = useState(false);
  const panelId = useId();
  if (!entry || !Array.isArray(entry.holders) || entry.holders.length === 0) return null;
  const { holders } = entry;

  if (holders.length === 1) {
    const [only] = holders;
    if (only.self) return null;
    return (
      <span className={`${CHIP} bg-port-border text-gray-400`} title={`Streams from ${only.name}; no copy on this machine`}>
        <Server className="w-2.5 h-2.5" aria-hidden="true" />Hosted on {only.name}
      </span>
    );
  }

  const removing = choice ? holders.filter((h) => h.instanceId !== choice.instanceId) : [];
  const confirm = async () => {
    setBusy(true);
    const target = choice;
    setChoice(null);
    const result = await makeMediaPrimary({ kind: entry.kind, filename: entry.filename, instanceId: target.instanceId }, { silent: true })
      .catch((err) => {
        toast.error(err.message || 'Make primary failed');
        return null;
      });
    setBusy(false);
    if (!result) return;
    (result.kept?.length ? toast.error : toast.success)(summarize(result));
    void refreshMediaHolders();
  };

  return (
    <>
      <button
        type="button"
        onClick={() => { setOpen((v) => !v); setChoice(null); }}
        aria-expanded={open}
        aria-controls={panelId}
        title={`Held by ${names(holders)}`}
        className={`${CHIP} bg-port-warning/20 text-port-warning hover:bg-port-warning/30 focus:outline-none focus-visible:ring-1 focus-visible:ring-port-warning`}
      >
        <Server className="w-2.5 h-2.5" aria-hidden="true" />{holders.length} hosts
      </button>
      {open && (
        <div id={panelId} role="region" aria-label="Machines holding this render" className="basis-full mt-1 rounded border border-port-border bg-port-bg p-1.5 space-y-1 text-[11px] text-gray-300">
          <ul className="space-y-1">
            {holders.map((h) => (
              <li key={h.instanceId} className="flex flex-wrap items-center justify-between gap-1">
                <span className="min-w-0 break-words inline-flex items-center gap-1">
                  {h.primary && <Crown className="w-3 h-3 text-port-warning shrink-0" aria-label="Primary" />}
                  {h.name}
                  {h.releasePending && <span className="text-port-warning">· delete pending</span>}
                </span>
                {!disabled && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setChoice(h)}
                    className="min-h-[44px] px-2 rounded border border-port-border hover:bg-port-border/60 disabled:opacity-50"
                    title={`Keep the copy on ${h.name} and delete the others`}
                  >
                    Make primary
                  </button>
                )}
              </li>
            ))}
          </ul>
          {choice && (
            <InlineConfirmRow
              question={`Keep the copy on ${choice.name}? Deletes the copy on ${names(removing)}.`}
              confirmText="Make primary"
              confirmTitle="Each other machine moves its copy to its Trash and streams this render from the primary"
              onConfirm={confirm}
              onCancel={() => setChoice(null)}
            />
          )}
        </div>
      )}
    </>
  );
}
