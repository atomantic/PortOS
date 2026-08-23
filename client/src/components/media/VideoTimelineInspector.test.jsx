import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { NumberField, FadeFields, RemoveButton } from './VideoTimelineInspector';

describe('NumberField — bounds are declared once and enforced on commit', () => {
  const renderField = (props = {}) => {
    const onCommit = vi.fn();
    render(<NumberField id="f" label="Hold (s)" value={3} min={0.05} max={600} onCommit={onCommit} {...props} />);
    return { onCommit, input: screen.getByLabelText('Hold (s)') };
  };

  it('puts the same bounds on the input that it clamps with', () => {
    const { input } = renderField();
    expect(input).toHaveAttribute('min', '0.05');
    expect(input).toHaveAttribute('max', '600');
  });

  it('commits on blur, not per keystroke — editing must not round-trip each stroke', () => {
    const { onCommit, input } = renderField();
    fireEvent.change(input, { target: { value: '12' } });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(12);
  });

  it('clamps a committed value into range rather than sending it to a 400', () => {
    const { onCommit, input } = renderField();
    fireEvent.change(input, { target: { value: '9999' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(600);
  });

  it('clamps below the minimum too', () => {
    const { onCommit, input } = renderField();
    fireEvent.change(input, { target: { value: '-5' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(0.05);
  });

  it('treats an emptied field as a discard, not a commit of the minimum', () => {
    // A number input yields '' for anything unparseable, so this covers the
    // non-numeric case too. Committing here would silently write 0.05.
    const { onCommit, input } = renderField();
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input).toHaveValue(3);
  });

  it('does not fire a save when the field is focused and blurred untouched', () => {
    const { onCommit, input } = renderField();
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('describes the field with its hint without folding it into the label', () => {
    const hint = "Clamped to the file's real length at render";
    const { input } = renderField({ hint });
    // getByLabelText resolving means the hint did not become part of the name.
    expect(screen.getByText(hint)).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-describedby', 'f-hint');
  });
});

describe('FadeFields — bounded by the entry AND by the server cap', () => {
  const renderFades = (duration) => {
    const onCommit = vi.fn();
    render(<FadeFields idPrefix="seg" entry={{ fadeInSec: 0, fadeOutSec: 0 }} duration={duration} onCommit={onCommit} />);
    return { onCommit, fadeIn: screen.getByLabelText('Fade in (s)') };
  };

  it('bounds a short entry by its own duration', () => {
    expect(renderFades(4).fadeIn).toHaveAttribute('max', '4');
  });

  it('bounds a long entry by the server 30s fade cap, not its duration', () => {
    // A 120s still would otherwise accept a 90s fade that the save 400s,
    // leaving the project unsavable until the user guessed the real limit.
    const { onCommit, fadeIn } = renderFades(120);
    expect(fadeIn).toHaveAttribute('max', '30');
    fireEvent.change(fadeIn, { target: { value: '90' } });
    fireEvent.blur(fadeIn);
    expect(onCommit).toHaveBeenCalledWith({ fadeInSec: 30 });
  });

  it('collapses to zero for a zero-length entry rather than going negative', () => {
    expect(renderFades(0).fadeIn).toHaveAttribute('max', '0');
  });
});

describe('RemoveButton', () => {
  it('is a labelled button that calls its handler', () => {
    const onClick = vi.fn();
    render(<RemoveButton label="Remove overlay" onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: /Remove overlay/ }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
