import ImageModelField, { imageModeHasModel } from './ImageModelField';
import {
  IMAGE_PIN_MODES, RENDER_TARGET_BACKEND_AUTO, modeLabel,
} from '../../lib/imageGenBackends';

const FIELD = 'w-full max-w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent';

// Per-record render pin editor (#3231 Phase 3) — one row pinning a record's
// default image backend and the model that backend renders on. Mirrors the
// Settings → Image Gen "Render defaults" row, and ANY backend change clears
// the pinned model — model ids are namespaced per provider, and the server's
// leak guard can't catch a mode+model pinned together (see ImageGenTab).
//
// Which model control appears follows the pinned backend. An override-capable
// cloud CLI takes a free-text id, because its catalog is the provider's rather
// than ours. A LOCAL pin takes a select over this install's own image-model
// catalog, probed here (`useLocalImageModels`, which also reports what a blank
// pin resolves to) rather than passed down, so every surface hosting this row
// gets the same picker without threading two props through — a text box would
// only invite a typo the render 400s on. Nothing is fetched until a local pin
// is actually selected. A fal.ai pin takes a select over the curated fal
// catalog for the same reason. Grok, which accepts no model override, gets
// neither.
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
  modes = IMAGE_PIN_MODES,
  options = null,
  autoLabel = 'Auto (default)',
  showAuto = true,
}) {
  const pinnedMode = imageMode && imageMode !== RENDER_TARGET_BACKEND_AUTO ? imageMode : '';
  const optionList = options || modes.map((m) => ({ id: m, label: modeLabel(m) }));
  const setModel = (modelId) => onChange({ imageMode: pinnedMode || null, imageModelId: modelId });
  return (
    <div className="grid min-w-0 w-full grid-cols-1 gap-2 sm:w-auto sm:grid-cols-[auto_auto_1fr] sm:items-center">
      <label htmlFor={`${idPrefix}-mode`} className="text-xs font-medium text-gray-400">{label}</label>
      <select
        id={`${idPrefix}-mode`}
        value={pinnedMode}
        onChange={(e) => onChange({ imageMode: e.target.value || null, imageModelId: null })}
        className={`${FIELD} sm:w-auto sm:min-w-[11rem]`}
      >
        {showAuto ? <option value="">{autoLabel}</option> : (!pinnedMode && <option value="" disabled>Pick a backend</option>)}
        {optionList.map((o) => <option key={o.id} value={o.id}>{o.label || o.id}</option>)}
      </select>
      {imageModeHasModel(pinnedMode) ? (
        <ImageModelField
          id={`${idPrefix}-model`}
          mode={pinnedMode}
          value={imageModelId}
          ariaLabel={`${label} model`}
          className={`${FIELD} sm:w-52`}
          onChange={setModel}
        />
      ) : <span className="hidden sm:block" />}
    </div>
  );
}
