import RunwayModelSelect from './RunwayModelSelect';
import ModelSelect from '../ModelSelect';
import FalModelSelect from './FalModelSelect';
import useFieldDraft from '../../hooks/useFieldDraft';
import useLocalImageModels from '../../hooks/useLocalImageModels';
import {
  IMAGE_GEN_MODE, localModelSelectOptions, supportsCloudModelOverride,
} from '../../lib/imageGenBackends';

/** Whether `mode` shows a model control. Callers use this to keep a grid cell when it does not. */
export function imageModeHasModel(mode, { showLocal = true } = {}) {
  if (!mode) return false;
  if (showLocal && mode === IMAGE_GEN_MODE.LOCAL) return true;
  if (mode === IMAGE_GEN_MODE.RUNWAY || mode === IMAGE_GEN_MODE.FAL) return true;
  return supportsCloudModelOverride(mode);
}

// The model control for one image backend, shared by the record pin row and
// the shot editor's frame picker. A backend change must clear the model at
// the caller: ids are namespaced per provider. `commit="blur"` waits for
// focus to leave a typed id (a pin that saves on each change); `commit="change"`
// reports every edit (a local override the next render reads immediately).
// Nothing is fetched until a local backend is actually selected.
export default function ImageModelField({
  id, mode, value = null, onChange, className = '', ariaLabel, disabled = false,
  commit = 'blur', falDefaultLabel = 'Default (Settings)', showLocal = true, inline = false, label = 'Model',
}) {
  const isLocal = showLocal && mode === IMAGE_GEN_MODE.LOCAL;
  const { models, installDefault } = useLocalImageModels(isLocal);
  const named = inline ? (ariaLabel || label) : ariaLabel;
  const controlClass = `${className} disabled:opacity-50`;
  let control = null;
  if (isLocal) {
    control = (
      <LocalModelPin id={id} ariaLabel={named} className={controlClass} disabled={disabled}
        models={models} installDefault={installDefault} value={value} onChange={onChange} />
    );
  } else if (mode === IMAGE_GEN_MODE.RUNWAY) {
    control = (
      <RunwayModelSelect id={id} ariaLabel={named || 'Runway model'} value={value} disabled={disabled}
        onChange={onChange} className={controlClass} />
    );
  } else if (mode === IMAGE_GEN_MODE.FAL) {
    control = (
      <FalModelSelect id={id} ariaLabel={named} value={value || ''} disabled={disabled}
        defaultLabel={falDefaultLabel} onChange={onChange} className={controlClass} />
    );
  } else if (supportsCloudModelOverride(mode)) {
    control = (
      <CloudModelInput key={mode} id={id} value={value} disabled={disabled} commit={commit}
        ariaLabel={named} className={controlClass} onChange={onChange} />
    );
  }
  if (!control) return null;
  if (!inline) return control;
  return (
    <span className="flex min-w-0 max-w-full items-center gap-1">
      <label htmlFor={id} className="shrink-0 text-xs text-port-text-muted">{label}</label>
      {control}
    </span>
  );
}

function CloudModelInput({ id, value, onChange, className, ariaLabel, disabled, commit }) {
  const draft = useFieldDraft(value, (next) => onChange(typeof next === 'string' ? (next.trim() || null) : null));
  const shared = {
    id, type: 'text', disabled, placeholder: 'Model (optional)', 'aria-label': ariaLabel, className,
  };
  if (commit === 'change') {
    return <input {...shared} value={value || ''} onChange={(e) => onChange(e.target.value.trim() || null)} />;
  }
  return <input {...shared} value={draft.value} onChange={draft.onChange} onBlur={draft.onBlur} />;
}

function LocalModelPin({ id, ariaLabel, className, models, installDefault, value, onChange, disabled }) {
  const loading = models === null || installDefault === null;
  const { options, fallbackLabel } = localModelSelectOptions(models, value, installDefault ?? undefined);
  return (
    <ModelSelect
      id={id}
      ariaLabel={ariaLabel}
      models={options}
      value={value || ''}
      loading={loading}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value || null)}
      getLabel={(m) => m.name || m.id}
      emptyOption={`Default (${fallbackLabel})`}
      className={className}
    />
  );
}
