import { useId, useState } from 'react';
import { Server, Crown } from 'lucide-react';
import toast from '../ui/Toast';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import { refreshMediaHolders } from '../../hooks/useMediaHolders';
import { makeMediaPrimary } from '../../services/apiMediaHolders.js';

const CHIP = 'px-1.5 py-0.5 rounded inline-flex items-center gap-0.5';
function hostName({ name, instanceId, self }) {
  if (self) return 'This machine';
  const label = typeof name === 'string' ? name.trim() : '';
  return label && label.toLowerCase() !== 'null' ? label : `Unnamed host (${instanceId})`;
}

const names = (list) => list.map(hostName).join(', ');

function summarize(result) {
  const parts = [];
  if (result.released?.length) parts.push(`removed from ${names(result.released)}`);
  if (result.pending?.length) parts.push(`waiting on ${names(result.pending)}`);
  if (result.kept?.length) parts.push(`kept on ${result.kept.map((h) => `${hostName(h)} (${h.reason})`).join(', ')}`);
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
  const [choiceId, setChoiceId] = useState(null);
  const [busy, setBusy] = useState(false);
  const panelId = useId();
  const cancel = (event) => {
    setChoiceId(null);
    event.currentTarget.closest('[role=region]')?.querySelector('button[aria-pressed=true]')?.focus();
  };
  if (!entry || !Array.isArray(entry.holders) || entry.holders.length === 0) return null;
  const { holders } = entry;

  if (holders.length === 1) {
    const [only] = holders;
    if (only.self) return null;
    return (
      <span className={`${CHIP} bg-port-border text-gray-400`} title={`Streams from ${hostName(only)}; no copy on this machine`}>
        <Server className="w-2.5 h-2.5" aria-hidden="true" />Hosted on {hostName(only)}
      </span>
    );
  }

  const choice = !disabled && holders.find((h) => h.instanceId === choiceId);
  const removing = choice ? holders.filter((h) => h.instanceId !== choice.instanceId) : [];
  const confirm = async () => {
    setBusy(true);
    const target = choice;
    setChoiceId(null);
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
        onClick={() => { setOpen((v) => !v); setChoiceId(null); }}
        aria-expanded={open}
        aria-controls={panelId}
        title={`Held by ${names(holders)}`}
        className={`${CHIP} bg-port-warning/20 text-port-warning hover:bg-port-warning/30 focus:outline-none focus-visible:ring-1 focus-visible:ring-port-warning`}
      >
        <Server className="w-2.5 h-2.5" aria-hidden="true" />{holders.length} hosts
      </button>
      {open && (
        <div id={panelId} role="region" aria-label="Machines holding this render" className="basis-full min-w-0 mt-1 rounded border border-port-border bg-port-bg p-1.5 space-y-1 text-[11px] text-gray-300">
          <ul className="space-y-1">
            {holders.map((h) => (
              <li key={h.instanceId} className="flex flex-wrap items-center justify-between gap-1">
                <span className="min-w-0 flex-[1_1_7rem] flex items-start gap-1">
                  {h.primary && <Crown className="w-3 h-3 text-port-warning shrink-0" aria-label="Primary" />}
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    {hostName(h)}
                    {h.releasePending && <span className="text-port-warning"> · delete pending</span>}
                  </span>
                </span>
                {!disabled && (
                  <button
                    type="button"
                    disabled={busy}
                    aria-pressed={choiceId === h.instanceId}
                    onClick={() => setChoiceId(h.instanceId)}
                    className="min-h-[44px] px-2 rounded border border-port-border hover:bg-port-border/60 aria-pressed:border-port-accent aria-pressed:bg-port-accent/10 disabled:opacity-50"
                    title={`Keep the copy on ${hostName(h)} and delete the others`}
                  >
                    Make primary
                  </button>
                )}
              </li>
            ))}
          </ul>
          {choice && (
            <InlineConfirmRow
              key={choice.instanceId}
              stacked
              autoFocus
              role="group"
              aria-label={`Confirm ${hostName(choice)} as primary`}
              aria-describedby={`${panelId}-consequences`}
              question={
                <span id={`${panelId}-consequences`} className="block space-y-1 [overflow-wrap:anywhere]">
                  <strong className="block">Keep the copy on {hostName(choice)}</strong>
                  <span className="block text-gray-300">Move copies to Trash on {names(removing)}.</span>
                </span>
              }
              confirmText="Make primary"
              onConfirm={confirm}
              onCancel={cancel}
            />
          )}
        </div>
      )}
    </>
  );
}
