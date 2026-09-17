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
  compact = false,
}) {
  const generatedId = useId();
  // Only generate hintId if hint is present and non-empty to avoid orphan IDREFs.
  const hintId = hint != null && hint !== '' && hint !== false ? `${generatedId}-hint` : null;

  // The label must point at whatever id the first control actually has: reuse
  // the child's own id when present, otherwise inject the generated one.
  let controlId = generatedId;
  const augmented = Children.map(children, (child, i) => {
    if (i !== 0 || !isValidElement(child)) return child;

    // Build props for the child, starting with ID assignment.
    const childProps = {};
    if (child.props.id) {
      controlId = child.props.id;
    } else {
      controlId = generatedId;
      childProps.id = controlId;
    }

    // Handle aria-describedby: preserve existing tokens and append hint id.
    if (hintId) {
      const existingDescribedBy = child.props['aria-describedby'];
      const tokens = existingDescribedBy ? [existingDescribedBy.trim(), hintId] : [hintId];
      childProps['aria-describedby'] = tokens.join(' ');
    }

    // Only clone if we have props to assign; otherwise return the original child.
    return Object.keys(childProps).length > 0 ? cloneElement(child, childProps) : child;
  });

  return (
    <div className={className}>
      {label != null && <label htmlFor={controlId} className={compact ? 'block text-xs uppercase tracking-wider text-gray-500 mb-1' : labelClassName}>{label}</label>}
      {hint != null && hint !== '' && hint !== false && <p id={hintId} className={compact ? 'block text-[11px] text-gray-500 mt-1' : 'text-xs text-gray-500 mb-1'}>{hint}</p>}
      {augmented}
    </div>
  );
}

export default FormField;
