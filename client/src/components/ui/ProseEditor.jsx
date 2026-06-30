import { forwardRef } from 'react';

// Shared prose-writing textarea — the Writers Room editing surface lifted out
// so other prose surfaces (the pipeline prose stage) get the same reading-
// comfortable feel: a serif face, relaxed leading, spellcheck, and a heading-
// hint placeholder, instead of the code-style mono textarea the script-shaped
// text stages use. Plain text in/out — the value is a markdown string, exactly
// as a bare <textarea> would produce, so nothing downstream changes.
//
// This component owns ONLY the prose typography (serif + leading) + spellcheck
// + the optional light "reading paper" theme. Host chrome — width, height,
// border, background, padding, text size, rows, AND focus treatment — comes
// through `className` (and any other passthrough props), so each caller keeps
// its own frame. (Focus is deliberately NOT baked in: a shared primitive that
// silently strips the focus outline is an a11y footgun — a full-bleed host like
// WorkEditor opts into `focus:outline-none`, while a bordered field keeps the
// browser default unless it supplies its own ring.)

const DEFAULT_PLACEHOLDER = 'Start writing… Use # Chapter, ## Scene, ### Beat headings to outline.';

const ProseEditor = forwardRef(function ProseEditor({
  value,
  onChange,
  placeholder = DEFAULT_PLACEHOLDER,
  readingTheme = 'dark',
  className = '',
  spellCheck = true,
  ...rest
}, ref) {
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      spellCheck={spellCheck}
      // The light reading theme paints the textarea like paper; dark (default)
      // inherits the surrounding surface, so no inline style is needed.
      style={readingTheme === 'light'
        ? { '--port-input-bg': 'var(--wr-reading-paper)', color: 'var(--wr-reading-ink)' }
        : undefined}
      className={`font-serif leading-relaxed ${className}`.trim()}
      {...rest}
    />
  );
});

export default ProseEditor;
