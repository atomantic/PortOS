import { IMAGE_GEN_MODE, RENDER_TARGET_BACKEND_AUTO, modeLabel, supportsCloudModelOverride } from '../../lib/imageGenBackends';
import useFieldDraft from '../../hooks/useFieldDraft';

const DEFAULT_MODES = [IMAGE_GEN_MODE.LOCAL, IMAGE_GEN_MODE.CODEX, IMAGE_GEN_MODE.GROK, IMAGE_GEN_MODE.AGY];

// Per-record render pin editor (#3231 Phase 3) — one row pinning a record's
// default image backend + (for model-override-capable cloud CLIs) a model.
// Mirrors the Settings → Image Gen "Render defaults" row: the model input only
// appears when the pinned backend accepts one, and ANY backend change clears
// the pinned model — model ids are namespaced per provider, and the server's
// leak guard can't catch a mode+model pinned together (see ImageGenTab).
//
// `onChange` always receives BOTH keys (`{ imageMode, imageModelId }`), with
// null for "no pin" — key-present-with-null is the intentional clear per the
// absent-vs-empty convention, so callers can PATCH the payload verbatim.
// `options` (`[{ id, label }]`) swaps in a host-derived backend list (e.g. the
// sprites page's availability-filtered set); `showAuto={false}` drops the
// "Auto" entry for hosts whose picker always names a concrete backend.
export default function RecordRenderPinRow({
  idPrefix,
  label = 'Render backend',
  imageMode = null,
  imageModelId = null,
  onChange,
  modes = DEFAULT_MODES,
  options = null,
  autoLabel = 'Auto (default)',
  showAuto = true,
}) {
  const pinnedMode = imageMode && imageMode !== RENDER_TARGET_BACKEND_AUTO ? imageMode : '';
  const optionList = options || modes.map((m) => ({ id: m, label: modeLabel(m) }));
  const modelDraft = useFieldDraft(imageModelId, (v) => {
    onChange({ imageMode: pinnedMode || null, imageModelId: v.trim() || null });
  });
  return (
    <div className="grid min-w-0 w-full grid-cols-1 gap-2 sm:w-auto sm:grid-cols-[auto_auto_1fr] sm:items-center">
      <label htmlFor={`${idPrefix}-mode`} className="text-xs font-medium text-gray-400">{label}</label>
      <select
        id={`${idPrefix}-mode`}
        value={pinnedMode}
        onChange={(e) => onChange({ imageMode: e.target.value || null, imageModelId: null })}
        className="w-full max-w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent sm:w-auto sm:min-w-[11rem]"
      >
        {showAuto ? <option value="">{autoLabel}</option> : (!pinnedMode && <option value="" disabled>Pick a backend</option>)}
        {optionList.map((o) => <option key={o.id} value={o.id}>{o.label || o.id}</option>)}
      </select>
      {supportsCloudModelOverride(pinnedMode) ? (
        <input
          id={`${idPrefix}-model`}
          type="text"
          value={modelDraft.value}
          onChange={modelDraft.onChange}
          onBlur={modelDraft.onBlur}
          placeholder="Model (optional)"
          aria-label={`${label} model`}
          className="w-full max-w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent sm:w-auto sm:min-w-[11rem]"
        />
      ) : <span className="hidden sm:block" />}
    </div>
  );
}
