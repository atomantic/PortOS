import { useId, Children, cloneElement, isValidElement } from 'react';

/**
 * Accessible config-form field wrapper.
 *
 * Generates a stable id via `useId()` and wires the `<label htmlFor>` to the
 * first child input/select/textarea's `id`, so clicking the label focuses the
 * field and screen readers announce the association (the repo's
 * "form labels need htmlFor/id pairing" convention).
 *
 * Styling is caller-owned so migrating an existing field is a lossless swap:
 * pass `className` for the wrapper and `labelClassName` to match the field's
 * current label classes. If the first child already has an `id`, that id wins
 * and the label points at it; otherwise the generated id is injected — either
 * way the label/control association holds.
 *
 * @param {string} label - Visible label text.
 * @param {import('react').ReactNode} [hint] - Optional hint rendered between label and field.
 * @param {import('react').ReactNode} children - The field control(s); the first element is bound to the label.
 * @param {string} [className] - Wrapper div className.
 * @param {string} [labelClassName] - Label className (defaults to the common config-form label style).
 */
export function FormField({
  label,
  hint,
  children,
  className = '',
  labelClassName = 'block text-sm text-gray-400 mb-1',
}) {
  const generatedId = useId();
  // The label must point at whatever id the first control actually has: reuse
  // the child's own id when present, otherwise inject the generated one.
  let controlId = generatedId;
  const augmented = Children.map(children, (child, i) => {
    if (i !== 0 || !isValidElement(child)) return child;
    if (child.props.id) {
      controlId = child.props.id;
      return child;
    }
    return cloneElement(child, { id: controlId });
  });
  return (
    <div className={className}>
      {label != null && <label htmlFor={controlId} className={labelClassName}>{label}</label>}
      {hint != null && <p className="text-xs text-gray-500 mb-1">{hint}</p>}
      {augmented}
    </div>
  );
}

export default FormField;
