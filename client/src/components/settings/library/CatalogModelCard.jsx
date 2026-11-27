import { AlertTriangle, Download, ExternalLink, RefreshCw, Star } from 'lucide-react';
import FormField from '../../ui/FormField';
import BrailleSpinner from '../../BrailleSpinner';
import CapabilityBadges from '../../models/CapabilityBadges.jsx';
import { formatAgeDays, formatContextLength, formatCount, timeAgo, recommendedRamGb, formatDateNumeric } from '../../../utils/formatters';
import { categoryLabel } from './useLocalLlmCatalog';

// A model suited to AGENT / CoS tasks (coding agents, the Creative Director
// treatment/plan agents) needs BOTH native tool calling AND enough coding /
// instruction-following muscle to drive a multi-step loop. A chat-only
// tool-caller (e.g. a small function-calling voice brain) clears `tools` but
// isn't an agent workhorse, and a `code` model without `tools` narrates instead
// of acting — so we require both. Keyed off catalog capabilities (server truth),
// NOT a hard-coded model list, so new agentic models light up automatically.
const isAgentRecommendedModel = (capabilities) =>
  Array.isArray(capabilities)
  && capabilities.includes('tools')
  && capabilities.includes('code');

// Server-computed per-quant fit verdict → badge styling + short label. Drives
// the RAM-fit hint on the quant picker so a too-large build reads as a warning.
const FIT_META = {
  comfortable: { label: 'fits comfortably', cls: 'text-port-success' },
  tight: { label: 'tight fit', cls: 'text-port-warning' },
  'too-large': { label: 'exceeds RAM', cls: 'text-port-error' },
  // Only ever produced by a MEASUREMENT — the size estimate cannot know that a
  // backend refuses a model outright, and no amount of free RAM changes it.
  incompatible: { label: 'backend refused it', cls: 'text-port-error' },
};

// The fit badge is a size ESTIMATE (weights + ~20% overhead vs. usable memory)
// until the model has actually been run here, at which point the measurement
// replaces it. The tooltip has to say which one the reader is looking at —
// "fits comfortably" from arithmetic and "fits comfortably" from a real run are
// very different claims — and it names the disagreement when there is one,
// because that is the most useful thing the measurement can say.
function fitTitle(source, entry) {
  if (source !== 'measured') {
    const stale = entry?.measuredFit && entry?.stale
      ? ` A previous measurement (${FIT_META[entry.measuredFit]?.label || entry.measuredFit}) was taken on a different machine state, so the estimate stands.`
      : '';
    return `Estimated fit on this machine — model weights + ~20% overhead vs. usable memory.${stale}`;
  }
  const measuredAt = entry?.assessedAt ? ` on ${formatDateNumeric(entry.assessedAt)}` : '';
  const disagree = entry?.disagrees
    ? ` The size estimate said "${FIT_META[entry.estimatedFit]?.label || entry.estimatedFit}".`
    : '';
  return `Measured on this machine${measuredAt} — PortOS ran this model rather than estimating from its file size.${disagree}`;
}

// Model format badge — GGUF (llama.cpp, cross-backend) vs. MLX (Apple's native
// format, LM Studio on Apple Silicon only). Shown so the user knows what they're
// installing when both formats appear in the same result list.
const FORMAT_META = {
  gguf: { label: 'GGUF', title: 'GGUF — llama.cpp format, runs on Ollama and LM Studio', cls: 'border-port-border text-gray-400' },
  mlx: { label: 'MLX', title: "MLX — Apple's native format, installs via LM Studio on Apple Silicon", cls: 'border-port-accent/40 text-port-accent' },
};


export default function CatalogModelCard({
  model: m, selected, variantId, onVariantChange, busy, actionInProgress, install, installAudio,
}) {
  const isHf = m.source === 'huggingface';
  const isAudio = m.category === 'audio';
  const repositoryUrl = m.repository ? `https://huggingface.co/${m.repository}` : null;
  const variants = (!isAudio && Array.isArray(m.variants)) ? m.variants : [];
  const hasVariantPicker = variants.length > 1;
  // The server marks the RAM-aware default with `recommended`, so it
  // wins as the default selection. (For live HF results it equals
  // `m.id`; for curated entries `m.id` is the stable catalog id, which
  // may itself be a non-default variant — so `recommended` must take
  // precedence over `m.id` for the RAM-aware default.)
  const recommendedId = variants.find((v) => v.recommended)?.installId;
  // Only honor a saved selection if it still matches a current variant —
  // variant install ids are backend-specific (`repo@Q…` vs `hf.co/repo:Q…`),
  // so a selection made before a backend switch must not leak through as a
  // stale id (which would null out chosenVariant and install the wrong id).
  const validSelection = variants.some((v) => v.installId === variantId) ? variantId : null;
  const chosenId = validSelection || recommendedId || m.id;
  const chosenVariant = variants.find((v) => v.installId === chosenId) || null;
  // Installed state is per-quant (Ollama tracks each separately),
  // so gate Install on the SELECTED variant, not the result default.
  const chosenInstalled = chosenVariant ? chosenVariant.installed : m.installed;
  // A sharded quant can't be pulled by the active backend (Ollama
  // #5245) — disable Install with the server's reason rather than
  // letting the user hit the raw 400. (The server only sets
  // `unsupportedReason` when the variant is unsupported.)
  const chosenUnsupported = chosenVariant?.unsupportedReason ?? null;
  const size = chosenVariant?.size || m.size;
  const sizeBytes = chosenVariant?.sizeBytes ?? m.sizeBytes;
  // Curated entries fetched without `?variants=1` carry no
  // variant list at all — the server puts a measured fit on the
  // model itself there, so fall back to it rather than dropping
  // the only evidence that exists.
  const fitEntry = chosenVariant || m;
  const fit = fitEntry?.fit;
  const fitMeta = fit ? FIT_META[fit] : null;
  const fitMeasured = fitEntry?.fitSource === 'measured';
  const ram = recommendedRamGb(sizeBytes, size);
  const ctxLabel = formatContextLength(m.contextLength);
  const createdMs = new Date(m.createdAt).getTime();
  const updatedMs = new Date(m.updatedAt).getTime();
  return (
    <div className={`flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-3 rounded-lg p-3 ${m.featured ? 'bg-port-accent/5 border border-port-accent/60 ring-1 ring-port-accent/20' : 'bg-port-bg border border-port-border'}`}>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-white break-words">
          {m.name} <span className="text-xs text-gray-500">· {m.params}</span>
          {m.featured && (
            <span
              title={m.featured.description || 'Flagship local recommendation'}
              className="ml-1.5 align-middle inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded border border-port-accent/60 bg-port-accent/15 text-port-accent"
            >
              <Star size={9} className="fill-current" /> {m.featured.label || 'Featured'}
            </span>
          )}
          {FORMAT_META[m.format] && (
            <span
              title={FORMAT_META[m.format].title}
              className={`ml-1.5 align-middle text-[10px] px-1 py-0.5 rounded border ${FORMAT_META[m.format].cls}`}
            >
              {FORMAT_META[m.format].label}
            </span>
          )}
          {!m.reducedSafeguards && m.publisherReview !== 'unreviewed' && isAgentRecommendedModel(m.capabilities) && (
            <span
              title="Recommended for agent & CoS tasks — has native tool calling plus coding strength, so it can actually drive multi-step agent work (unlike chat-only or tool-less models)."
              className="ml-1.5 align-middle inline-flex items-center gap-0.5 text-[10px] px-1 py-0.5 rounded border border-port-accent/50 text-port-accent"
            >
              <Star size={9} className="fill-current" /> Agents
            </span>
          )}
        </div>
        <div className="text-xs text-gray-500 break-all">{chosenId}</div>
        <div className="text-xs text-gray-500 mt-0.5">{m.description}</div>
        {m.featured?.description && (
          <div className="text-xs text-port-accent mt-1">{m.featured.description}</div>
        )}
        {m.reducedSafeguards && (
          <p className="flex items-start gap-1.5 text-xs text-port-warning mt-2" role="note">
            <AlertTriangle size={15} className="shrink-0" aria-hidden="true" />
            {m.warning || 'Uncensored / abliterated: run carefully in a sandbox without secrets or publishing tools.'}
          </p>
        )}
        {m.publisherReview && (
          <p className="text-[11px] text-gray-400 mt-1">
            {m.publisherReview === 'reviewed-build' ? 'Publisher provenance checked' : m.publisherReview === 'established-publisher' ? 'Established publisher' : 'Publisher not reviewed — discovery result, not a recommendation'}
            {' · Popularity is not a malware-free guarantee.'}
          </p>
        )}
        {m.provenance && (
          <p className="text-[11px] text-gray-400 mt-1">
            Reviewed {m.provenance.checkedAt}: {formatCount(m.provenance.likes)} likes · {formatCount(m.provenance.downloads)} monthly downloads · {formatCount(m.provenance.followers)} publisher followers.{' '}
            <a className="text-port-accent hover:underline" href={`https://huggingface.co/${m.provenance.repository}/tree/${m.provenance.revision}`} target="_blank" rel="noopener noreferrer">Reviewed revision</a>
            {' · Installer uses the publisher’s current release; this is a dated review, not an immutable install pin.'}
          </p>
        )}
        {m.note && <div className="text-[11px] text-port-warning/90 mt-0.5">{m.note}</div>}
        {hasVariantPicker && (
          <FormField label="Quant" labelClassName="text-[11px] text-gray-500" className="flex items-center gap-1.5 flex-wrap mt-1">
            <select
              id={`quant-${m.key}`}
              value={chosenId}
              onChange={(e) => onVariantChange(m.key, e.target.value)}
              disabled={busy}
              className="text-[11px] bg-port-card border border-port-border rounded px-1.5 py-0.5 text-gray-300 max-w-[16rem]"
              title="Pick a quantization — higher quants are larger but higher fidelity"
            >
              {variants.map((v) => (
                <option key={v.installId} value={v.installId}>
                  {v.quant}{v.size ? ` · ${v.size}` : ''}{v.installed ? ' · installed' : ''}{v.recommended ? ' · recommended' : ''}{v.fit === 'too-large' ? ' · exceeds RAM' : ''}{v.fit === 'incompatible' ? ' · backend refused it' : ''}{v.fitSource === 'measured' ? ' · measured' : ''}{v.unsupported === 'sharded' ? ' · sharded (not on Ollama)' : ''}
                </option>
              ))}
            </select>
            {fitMeta && (
              <span className={`text-[11px] ${fitMeta.cls}`} title={fitTitle(fitEntry?.fitSource, fitEntry)}>
                {fitMeta.label}{fitMeasured ? ' (measured)' : ''}
              </span>
            )}
          </FormField>
        )}
        <div className="flex items-center gap-1.5 flex-wrap text-[11px] text-gray-600 mt-1">
          <span className="text-gray-500">{categoryLabel(m.category)}</span>
          <span>{size}</span>
          {/* Single-variant cards (e.g. MLX) have no quant picker, so
              surface the RAM-fit hint here instead of in the picker row. */}
          {fitMeta && !hasVariantPicker && (
            <span className={fitMeta.cls} title={fitTitle(fitEntry?.fitSource, fitEntry)}>
              {fitMeta.label}{fitMeasured ? ' (measured)' : ''}
            </span>
          )}
          {ctxLabel && (
            <span title="Native context window (max tokens)">{ctxLabel}</span>
          )}
          {ram && (
            <span title="Approx RAM/VRAM to run this model — weights + ~20% overhead">
              ~{ram} GB RAM
            </span>
          )}
          {isHf && <span>{formatCount(m.downloads, { fallback: '0' })} downloads</span>}
          {isHf && Number.isFinite(createdMs) && (
            <span
              title={`Published ${formatDateNumeric(createdMs)}${Number.isFinite(updatedMs) ? ` · updated ${timeAgo(m.updatedAt)}` : ''}`}
            >
              published {formatAgeDays(m.createdAt)}
            </span>
          )}
          {isHf && m.license && <span>{m.license}</span>}
          <CapabilityBadges capabilities={m.capabilities} />
        </div>
      </div>
      {/* Mobile: actions sit on their own row under the details so
          the name/id column isn't squeezed into a narrow column.
          Desktop keeps them stacked at the card's right edge. */}
      <div className="flex flex-row sm:flex-col items-center sm:items-end gap-2 sm:gap-1 shrink-0 justify-end flex-wrap">
        {chosenInstalled ? (
          <>
            <span className="text-xs px-2 py-1 text-port-success">Installed</span>
            {!isAudio && (selected !== 'lmstudio' || /@/.test(chosenId || '')) && (
              <button
                onClick={() => install(chosenId, { force: true })}
                disabled={busy}
                title="Pull this build again. Updated GGUF files keep the same name, so an existing install will not refresh until you redownload."
                className="px-2.5 py-1 pointer-coarse:min-h-11 text-xs bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
              >
                {actionInProgress === `install-${chosenId}` ? <BrailleSpinner /> : <RefreshCw size={12} />}
                Redownload
              </button>
            )}
          </>
        ) : m.installable === false ? (
          // Audio models with no PortOS runtime (or a fixed-checkpoint
          // engine like ACE-Step) are discovery-only — "Visit" below.
          null
        ) : (
          <button
            onClick={() => (isAudio ? installAudio(m) : install(chosenId))}
            disabled={busy || !!chosenUnsupported}
            title={chosenUnsupported || undefined}
            className="px-2.5 py-1 pointer-coarse:min-h-11 text-xs bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
          >
            {actionInProgress === `install-${chosenId}` ? <BrailleSpinner /> : <Download size={12} />}
            Install
          </button>
        )}
        {chosenUnsupported && !chosenInstalled && (
          <span className="text-[11px] text-port-warning text-right max-w-[12rem] leading-snug" title={chosenUnsupported}>
            Sharded — use LM Studio or a smaller quant
          </span>
        )}
        {repositoryUrl && (
          <a
            href={repositoryUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={m.gated ? 'Open Hugging Face to accept repository terms' : 'Open the model page on Hugging Face'}
            className="px-2.5 py-1 pointer-coarse:min-h-11 text-xs bg-port-border/60 hover:bg-port-border text-gray-300 rounded flex items-center gap-1"
          >
            <ExternalLink size={12} />
            {m.gated ? 'Accept terms' : 'Visit'}
          </a>
        )}
      </div>
    </div>
  );
}
