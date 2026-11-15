import { forwardRef, useId } from 'react';

const DISABLED_CLS = 'opacity-50 cursor-not-allowed pointer-events-none';
const FOCUS_RING = 'peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-port-accent peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-port-bg';

/**
 * A control that opens the OS file picker — styled as a button, or as a whole
 * drop zone when you pass drag handlers through.
 *
 * Why this exists instead of a button that reaches into a ref and clicks a
 * hidden input: a *programmatic* click on an `<input type="file">` is a synthetic,
 * untrusted event, and several browsers refuse to open the picker for it —
 * most notably Safari/WebKit when PortOS is running as an installed
 * (`display: standalone`) PWA, which is exactly how it tends to get opened from
 * a remote machine over the tailnet. Activating a `<label for>` is a *native*
 * label activation instead: the browser opens the picker itself, with no
 * reliance on user-activation heuristics, in every engine.
 *
 * The input is visually hidden but stays focusable and exposed to the
 * accessibility tree (it is the labelled control) — do NOT hide a file input
 * with `className="hidden"` (`display: none` drops it from the tab order and
 * the a11y tree) or with `aria-hidden`/`tabIndex={-1}`. The visible label
 * carries the focus ring via `peer-focus-visible:`. `a11y/fileInputsToasts.conventions.test.js`
 * enforces this repo-wide.
 *
 * The input's value is cleared after every change — deferred until an async
 * `onChange` settles, since clearing `value` also empties `input.files` — so
 * re-picking the SAME file fires `change` again (otherwise a failed upload
 * can't be retried by re-selecting the same file). Call sites must NOT clear
 * `e.target.value` themselves.
 *
 * Extra props are spread onto the visible `<label>`, and the forwarded ref
 * points at it — that is what lets a drop zone pass `onDrop`/`onDragOver` and
 * still get native picker activation from a click.
 *
 * @param {Object} props
 * @param {(e: React.ChangeEvent<HTMLInputElement>) => void} props.onChange - change handler; `e.target.files` holds the picked files
 * @param {React.ReactNode} props.children - label content (icon + text)
 * @param {string} [props.accept] - `accept` attribute for the input
 * @param {boolean} [props.multiple] - allow multi-select
 * @param {boolean} [props.disabled] - disable the control
 * @param {string} [props.className] - classes for the visible label
 * @param {string} [props.ariaLabel] - accessible name. Omit it when the visible
 *   text already says enough; supply it to disambiguate a bare "Upload" among
 *   several on one screen. It OVERRIDES the label text, so per WCAG 2.5.3
 *   (Label in Name) it must CONTAIN the visible text — "Upload artist portrait"
 *   for a button reading "Upload" is fine; "Browse files to upload" for one
 *   reading "Browse Files" is not, and strands voice-control users.
 * @param {string} [props.id] - explicit input id (defaults to a generated one)
 * @param {string} [props.name] - input name
 */
const FilePickerButton = forwardRef(function FilePickerButton({
  onChange,
  children,
  accept,
  multiple = false,
  disabled = false,
  className = '',
  ariaLabel,
  id,
  name,
  ...labelProps
}, ref) {
  const generatedId = useId();
  const inputId = id || `file-picker-${generatedId}`;

  const handleChange = (e) => {
    const input = e.target;
    const reset = () => { input.value = ''; };
    // Promise.resolve() normalizes sync and async handlers alike: a handler
    // that awaits before reading `input.files` must finish before the clear.
    // Settle on BOTH outcomes rather than `.finally()` — nothing else consumes
    // the handler's promise, so a rethrow here becomes an unhandled rejection.
    // Call sites own their own error reporting (they all toast in a `.catch`).
    Promise.resolve(onChange?.(e)).then(reset, reset);
  };

  return (
    // `display: contents` wrapper, NOT a fragment: Tailwind compiles `peer-*` to
    // the GENERAL sibling combinator (`.peer:focus-visible ~ *`), so with a bare
    // fragment two pickers in one row (see TaskAddForm's Screenshot + Attach)
    // would light up BOTH labels when either input is focused — the first
    // input's `~ *` reaches the second label. Scoping each input/label pair to
    // its own DOM parent cuts that reach, and `contents` generates no box, so
    // the label is still a direct flex/grid item of the caller's container.
    <span className="contents">
      <input
        id={inputId}
        name={name}
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        onChange={handleChange}
        aria-label={ariaLabel}
        className="sr-only peer"
      />
      <label
        {...labelProps}
        ref={ref}
        htmlFor={inputId}
        className={`${className} ${disabled ? DISABLED_CLS : 'cursor-pointer'} ${FOCUS_RING}`}
      >
        {children}
      </label>
    </span>
  );
});

export default FilePickerButton;
