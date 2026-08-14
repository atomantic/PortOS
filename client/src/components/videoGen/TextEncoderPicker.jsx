/**
 * Prompt-conditioner picker for models that offer a choice (#4081).
 *
 * MiniMax H3 reads the unnormalized hidden state after Qwen3-VL language layer
 * 49 and never evaluates the rest of the language model, so the conditioner can
 * be swapped for another checkpoint carrying the same layers — which changes how
 * the model *reads* a prompt without touching the diffusion weights. This is the
 * control for that choice.
 *
 * Presentational: options, selection, and download status are all owned by the
 * VideoGen page. It renders only when the model offers a real choice; the server
 * ships the true option list (including a lone stock entry), so the
 * hide-when-there-is-nothing-to-pick rule lives here rather than in the
 * server-side accessor every validation predicate is built on.
 *
 * A substitute is a separate multi-GB pull, so its Download badge sits inline
 * with the select rather than behind the collapsed Advanced panel — the user has
 * to see the cost at the moment they pick it, and the page gates Generate on the
 * same status.
 */
import { FormField } from '../ui/FormField';
import ModelSelect from '../ModelSelect';
import ModelDownloadBadge from '../media/ModelDownloadBadge';
import FactLink from './FactLink';
import { formatBytes } from '../../utils/formatters.js';

// The option text carries its own download size, so the shared ModelSelect gets
// a getLabel rather than the default `m.name` (these entries have `label`).
const optionLabel = (option) => (
  option.sizeBytes ? `${option.label} (~${formatBytes(option.sizeBytes)} download)` : option.label
);

export default function TextEncoderPicker({
  options = [],
  value,
  onChange,
  status = null,
  onDownload,
  onCancel,
  disabled = false,
}) {
  if (options.length < 2) return null;
  const selected = options.find((option) => option.id === value) || options[0];
  // Built-in conditioners ship inside the model's own weights, so they have no
  // separate download of their own to badge.
  const needsDownload = !selected.builtIn && (status === null || status.cached === false || status.downloading);
  const card = selected.disclosure?.modelCardUrl;
  const license = selected.disclosure?.weightsLicense;

  return (
    <FormField
      className="mt-2"
      label="Text encoder"
      labelClassName="block text-xs font-medium text-gray-400 mb-1"
    >
      <ModelSelect
        id="video-text-encoder"
        models={options}
        value={selected.id}
        onChange={(e) => onChange(e.target.value)}
        getLabel={optionLabel}
        disabled={disabled}
      />
      {selected.description && (
        <p className="text-[10px] text-gray-500 leading-snug mt-1">{selected.description}</p>
      )}
      {/* An uncensored conditioner is a deliberate choice, not a default —
          state what changed rather than leaving it to the model card. */}
      {selected.advisory && (
        <p className="text-[10px] text-port-warning leading-snug mt-1">{selected.advisory}</p>
      )}
      {/* Same provenance affordance a MODEL gets (ModelDisclosure/FactLink): a
          substitute is someone else's tens-of-GB checkpoint, so its card and
          license stay one click away instead of being facts only the registry
          knows. */}
      {(card || license) && (
        <p className="text-[10px] text-gray-500 leading-snug mt-1 flex flex-wrap items-center gap-x-2">
          {card && <FactLink href={card}>Model card</FactLink>}
          {license && <FactLink href={license.url}>{license.name}</FactLink>}
        </p>
      )}
      {needsDownload && (
        <ModelDownloadBadge
          status={status}
          onDownload={() => onDownload?.(selected.id)}
          onCancel={onCancel}
          estimateLabel={selected.sizeBytes ? `~${formatBytes(selected.sizeBytes)}` : undefined}
        />
      )}
    </FormField>
  );
}
