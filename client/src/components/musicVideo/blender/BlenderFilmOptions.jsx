import { inputCls, labelCls } from './blenderStyles.js';

const describeDefault = (field) => {
  if (field.type === 'boolean') return field.default ? 'on' : 'off';
  if (field.type === 'choice') return field.choices?.find((choice) => choice.value === field.default)?.label || String(field.default);
  return field.default === '' ? 'empty' : String(field.default);
};

function OptionField({ field, disabled, onChange }) {
  const id = `mv-blender-option-${field.key}`;
  const helpId = `${id}-help`;
  const hasHelp = Boolean(field.help || field.problem || !field.isDefault);
  const described = hasHelp ? helpId : undefined;
  const help = hasHelp && (
    <p id={helpId} className="mt-0.5 break-words text-xs text-port-text-muted">
      {field.help} {!field.isDefault && <span>The film&apos;s default is {describeDefault(field)}.</span>}
      {field.problem && <span role="alert" className="block text-port-error">{field.problem}</span>}
    </p>
  );
  if (field.type === 'boolean') {
    return (
      <div className="min-w-0">
        <label htmlFor={id} className="flex min-h-[44px] items-center gap-1.5 text-sm pointer-fine:sm:min-h-0">
          <input id={id} type="checkbox" checked={field.value === true} disabled={disabled} aria-describedby={described}
            onChange={(event) => onChange(field.key, event.target.checked)} />
          {field.label}
        </label>
        {help}
      </div>
    );
  }
  return (
    <div className="min-w-0">
      <label htmlFor={id} className={labelCls}>{field.label}</label>
      {field.type === 'choice' && (
        <select id={id} value={field.value} disabled={disabled} className={inputCls} aria-describedby={described}
          onChange={(event) => onChange(field.key, event.target.value)}>
          {(field.choices || []).map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
        </select>
      )}
      {field.type === 'number' && (
        <input id={id} type="number" inputMode="decimal" min={field.min} max={field.max} step={field.step ?? 'any'} disabled={disabled}
          value={Number.isFinite(field.value) ? field.value : ''} aria-invalid={field.problem ? true : undefined} aria-describedby={described}
          onChange={(event) => onChange(field.key, event.target.value === '' ? Number.NaN : Number(event.target.value))} className={inputCls} />
      )}
      {field.type === 'text' && (
        <input id={id} type="text" maxLength={2000} disabled={disabled} value={typeof field.value === 'string' ? field.value : ''}
          aria-invalid={field.problem ? true : undefined} aria-describedby={described}
          onChange={(event) => onChange(field.key, event.target.value)} className={inputCls} />
      )}
      {help}
    </div>
  );
}

/**
 * The options the film's scripts declare (`describe(ctx)["options"]`): a look,
 * a palette, a debug overlay. Each is drawn by its type and saved with the
 * render settings (one Save for both); the scripts read the saved values as
 * `ctx.options` when a shot is built. Renders nothing for a film that declares
 * none.
 */
export default function BlenderFilmOptions({ blender }) {
  const fields = blender.optionFields || [];
  if (!fields.length) return null;
  return (
    <div role="group" aria-label="Film options" className="min-w-0 space-y-2 border-t border-port-border pt-3">
      <h4 className="text-sm font-medium">Film options</h4>
      {/* Bounded columns: a film with one option gets a field sized for it, not one stretched across the panel. */}
      <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),20rem))] gap-2">
        {fields.map((field) => <OptionField key={field.key} field={field} disabled={blender.settingsSaving} onChange={blender.editOption} />)}
      </div>
      <p className="text-xs text-port-text-muted">
        Declared by the film&apos;s scripts and read when each shot is built. Changing an option marks every preview, final and still out
        of date, so the shots render again with the new value.
      </p>
    </div>
  );
}
