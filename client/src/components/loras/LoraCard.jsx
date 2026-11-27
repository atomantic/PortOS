import { useState } from 'react';
import { Link } from 'react-router';
import { Trash2, ExternalLink, Sparkles, Activity } from 'lucide-react';
import BrailleSpinner from '../BrailleSpinner';
import toast from '../ui/Toast';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import { formatBytes } from '../../utils/formatters';
import { isVideoLoraFamily } from '../../lib/runnerFamilies';
import { LORA_EFFECT_STATUSES, loraEffectDetail, loraEffectBadge } from '../../lib/loraEffect';
import { probeLoraEffect } from '../../services/apiImageVideo.js';
import { RUNNER_BADGE_CLASS, RUNNER_LABEL } from './loraDisplay';

// Responsive grid of installed LoRA cards. Extracted so the Installed section
// can render either one flat grid (filtered view) or several grouped grids
// (the "All" view) without duplicating the grid markup.
export function LoraGrid({ loras, deleting, onDelete, onMeasured, deleteConfirm }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {loras.map((lora) => (
        <LoraCard
          key={lora.filename}
          lora={lora}
          onDelete={() => onDelete(lora.filename)}
          onMeasured={onMeasured}
          deleting={deleting === lora.filename}
          deleteConfirm={deleteConfirm}
        />
      ))}
    </div>
  );
}

// Installed LoRAs split into Video / Image subsections for the "All" view, each
// with a labeled header mirroring the suggestion panel's grouping. Empty groups
// are omitted. Video is listed first (fewer, and the source of the layout
// confusion this grouping resolves).
export function InstalledGroups({ loras, deleting, onDelete, onMeasured, deleteConfirm }) {
  const video = loras.filter((l) => isVideoLoraFamily(l.runnerFamily));
  const image = loras.filter((l) => !isVideoLoraFamily(l.runnerFamily));
  const groups = [
    { key: 'video', label: 'Video LoRAs', items: video },
    { key: 'image', label: 'Image LoRAs', items: image },
  ].filter((g) => g.items.length > 0);
  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <div key={g.key}>
          <div className="flex items-baseline gap-3 mb-2">
            <h3 className="text-sm font-medium text-gray-300">{g.label}</h3>
            <span className="text-xs text-gray-600">{g.items.length}</span>
          </div>
          <LoraGrid loras={g.items} deleting={deleting} onDelete={onDelete} onMeasured={onMeasured} deleteConfirm={deleteConfirm} />
        </div>
      ))}
    </div>
  );
}

function LoraCard({ lora, onDelete, onMeasured, deleting, deleteConfirm }) {
  const family = lora.runnerFamily;
  const familyLabel = family ? (RUNNER_LABEL[family] || family) : 'Unsupported base';
  const badgeClass = family ? (RUNNER_BADGE_CLASS[family] || 'bg-gray-600/20 text-gray-300 border-gray-500/30') : 'bg-port-warning/20 text-port-warning border-port-warning/30';
  const triggerWords = lora.triggerWords || [];
  const civitai = lora.civitai;
  // The gen pages read ?lora=<filename> as a preselect hint via query string;
  // keeps the manager → gen handoff URL-driven (deep-linkable). Video-family
  // LoRAs (ltx-video, minimax-h3) deep-link to Video Gen — routing them to Image
  // Gen would preselect a video adapter into an incompatible image render.
  const isVideoLora = isVideoLoraFamily(family);
  const testHref = `${isVideoLora ? '/media/video' : '/media/image'}?lora=${encodeURIComponent(lora.filename)}`;
  // The confirm pair also stays mounted while the delete is in flight (the hook
  // disarms the moment it fires), so the spinner replaces the row rather than
  // flashing the trash icon back for the duration of the request.
  const confirming = deleteConfirm.isConfirming(lora.filename) || deleting;
  // A sidecar-less install can reach the client with no `name` (the server
  // falls back to the filename, but peers and hand-dropped files predate that),
  // and "Delete undefined" is a bad thing to announce over a destructive action.
  const displayName = lora.name || lora.filename;

  // Read straight off the server's CACHED report (listLorasFull never probes) — an
  // explicit re-check hands the new one to `onMeasured`, which updates the list
  // entry, so the badge survives this card being unmounted by a filter change.
  const effect = lora.effectReport || null;
  const [checkingEffect, setCheckingEffect] = useState(false);
  const effectSummary = loraEffectDetail(effect);
  const runEffectCheck = async () => {
    setCheckingEffect(true);
    await probeLoraEffect(lora.filename, { force: true, silent: true })
      .then((report) => {
        onMeasured?.(lora.filename, report);
        const summary = loraEffectDetail(report);
        if (report?.status === LORA_EFFECT_STATUSES.ZERO) {
          toast.error(`${displayName} has no measurable effect — a render would look as if it were off`);
        } else if (report?.status === LORA_EFFECT_STATUSES.OK) {
          toast.success(`${displayName} is active — ${summary}`);
        } else {
          toast(summary || `${displayName}: ${loraEffectBadge(report?.status).label}`);
        }
      })
      .catch((err) => toast.error(err?.message || 'Effect check failed'))
      .finally(() => setCheckingEffect(false));
  };

  return (
    <div className="bg-port-card border border-port-border rounded-lg overflow-hidden flex flex-col">
      {lora.previewImageUrl ? (
        <img
          src={lora.previewImageUrl}
          alt=""
          className="w-full h-64 object-cover bg-port-bg"
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      ) : (
        <div className="w-full h-64 bg-port-bg flex items-center justify-center text-gray-700">
          <Sparkles size={32} />
        </div>
      )}
      <div className="p-3 flex-1 flex flex-col">
        <div className="flex items-start justify-between gap-2 mb-2">
          <h3 className="font-semibold text-white text-sm flex-1 break-words">{displayName}</h3>
          <span className={`text-[10px] px-2 py-0.5 rounded border whitespace-nowrap ${badgeClass}`} title={civitai?.baseModel || 'Unknown'}>
            {familyLabel}
          </span>
        </div>

        {/* Trained-in-PortOS lineage. */}
        {lora.source === 'trained' && lora.character && (
          <div className="mb-2">
            <span
              className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-port-success/15 text-port-success border border-port-success/30"
              title="Trained in PortOS"
            >
              <Sparkles size={11} /> Character: {lora.character.name}
            </span>
          </div>
        )}

        {triggerWords.length > 0 && (
          <div className="mb-2">
            <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Trigger words</div>
            <div className="flex flex-wrap gap-1">
              {triggerWords.map((w) => (
                <code key={w} className="text-[11px] bg-port-bg px-1.5 py-0.5 rounded text-gray-300 border border-port-border">{w}</code>
              ))}
            </div>
          </div>
        )}

        <div className="text-[11px] text-gray-500 grid grid-cols-2 gap-x-2 gap-y-0.5 mb-3">
          <span>Recommended scale</span><span className="text-gray-300 font-mono text-right">{Number(lora.recommendedScale ?? 1).toFixed(2)}</span>
          <span>Size</span><span className="text-gray-300 font-mono text-right">{formatBytes(lora.sizeBytes)}</span>
          {civitai?.creator && (<><span>Creator</span><span className="text-gray-300 truncate text-right" title={civitai.creator}>{civitai.creator}</span></>)}
          {civitai?.baseModel && (<><span>Base model</span><span className="text-gray-300 truncate text-right" title={civitai.baseModel}>{civitai.baseModel}</span></>)}
        </div>

        {effect && (
          <div className="text-[11px] mb-3 -mt-1">
            <span className={`font-medium ${loraEffectBadge(effect.status).tone}`}>
              {loraEffectBadge(effect.status).label}
            </span>
            {/* loraEffectDetail returns null when the badge already says
                everything, so a reason-less verdict doesn't render as
                "Unreadable — Unreadable". */}
            {effectSummary && <span className="text-gray-500"> — {effectSummary}</span>}
          </div>
        )}

        {/* Armed state replaces the whole action row instead of squeezing the
            confirm pair in beside Test/Civitai — a narrow card (or a phone at
            one column) has no room for both, and the row would wrap. */}
        {confirming ? (
          <div className="mt-auto">
            <ConfirmButtonPair
              prompt="Delete file?"
              confirmText="Delete"
              confirmIcon={Trash2}
              busy={deleting}
              busyText="Deleting"
              ariaLabel={`Confirm delete ${displayName}`}
              onConfirm={() => deleteConfirm.confirmDelete(onDelete)}
              onCancel={deleteConfirm.cancelDelete}
            />
          </div>
        ) : (
          <div className="mt-auto flex items-center gap-2">
            <Link
              to={testHref}
              className="flex-1 bg-port-accent text-white px-3 py-1.5 rounded text-xs font-medium hover:bg-port-accent/90 text-center"
            >
              Test
            </Link>
            {civitai?.url && (
              <a
                href={civitai.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded p-1.5 text-gray-400 hover:bg-port-bg hover:text-gray-200"
                title="Open on Civitai"
                aria-label="Open on Civitai"
              >
                <ExternalLink size={14} />
              </a>
            )}
            {lora.huggingface?.url && (
              <a
                href={lora.huggingface.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded p-1.5 text-gray-400 hover:bg-port-bg hover:text-gray-200"
                title="Open on HuggingFace"
                aria-label="Open on HuggingFace"
              >
                <ExternalLink size={14} />
              </a>
            )}
            <button
              onClick={runEffectCheck}
              disabled={checkingEffect}
              className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-gray-400 hover:text-gray-200 p-1.5 rounded hover:bg-port-bg disabled:opacity-50 disabled:cursor-not-allowed"
              title={`Check whether ${displayName} actually changes a render`}
              aria-label={`Check effect of ${displayName}`}
            >
              {checkingEffect ? <BrailleSpinner /> : <Activity size={14} />}
            </button>
            <button
              onClick={() => deleteConfirm.requestDelete(lora.filename)}
              className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-port-error hover:text-port-error/80 p-1.5 rounded hover:bg-port-error/10"
              title={`Delete ${displayName}`} aria-label={`Delete ${displayName}`}
            >
              <Trash2 size={14} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
