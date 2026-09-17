import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { FormField } from './FormField';

describe('FormField', () => {
  it('associates the label with the first control via generated id', () => {
    render(
      <FormField label="Display Name">
        <input defaultValue="" />
      </FormField>
    );
    // getByLabelText resolves only when htmlFor/id are correctly paired.
    const input = screen.getByLabelText('Display Name');
    expect(input.tagName).toBe('INPUT');
    expect(input.id).toBeTruthy();
  });

  it('focuses the field when its label is clicked', async () => {
    const user = userEvent.setup();
    render(
      <FormField label="Email">
        <input defaultValue="" />
      </FormField>
    );
    await user.click(screen.getByText('Email'));
    expect(screen.getByLabelText('Email')).toHaveFocus();
  });

  it('works with a select control', () => {
    render(
      <FormField label="Type">
        <select defaultValue="a">
          <option value="a">A</option>
          <option value="b">B</option>
        </select>
      </FormField>
    );
    expect(screen.getByLabelText('Type').tagName).toBe('SELECT');
  });

  it('injects the id into the first child only, leaving siblings untouched', () => {
    render(
      <FormField label="Notes">
        <textarea defaultValue="" />
        <p>One per line</p>
      </FormField>
    );
    const field = screen.getByLabelText('Notes');
    expect(field.tagName).toBe('TEXTAREA');
    expect(screen.getByText('One per line').id).toBe('');
  });

  it('binds the label to an explicit child id (association still holds)', () => {
    render(
      <FormField label="Custom">
        <input id="my-fixed-id" defaultValue="" />
      </FormField>
    );
    // The caller-provided id is preserved AND the label points at it, so the
    // association is made without clobbering the explicit id.
    const input = screen.getByLabelText('Custom');
    expect(input.id).toBe('my-fixed-id');
  });

  it('applies caller-provided wrapper and label classes', () => {
    render(
      <FormField label="Styled" className="wrap-x" labelClassName="lbl-x">
        <input defaultValue="" />
      </FormField>
    );
    const label = screen.getByText('Styled');
    expect(label).toHaveClass('lbl-x');
    expect(label.parentElement).toHaveClass('wrap-x');
  });

  it('renders a ReactNode label (e.g. badge + text)', () => {
    render(
      <FormField label={<><span>●</span>Light</>}>
        <input defaultValue="" />
      </FormField>
    );
    expect(screen.getByLabelText('●Light')).toBeTruthy();
  });

  it('associates a hint with the control via aria-describedby', () => {
    render(
      <FormField label="Speech Rate" hint="0.5 = slow, 1.0 = normal, 2.0 = fast">
        <input type="number" min="0.5" max="2.0" step="0.1" defaultValue="1.0" />
      </FormField>
    );
    const input = screen.getByLabelText('Speech Rate');
    const hint = screen.getByText('0.5 = slow, 1.0 = normal, 2.0 = fast');

    // Hint must have an id.
    expect(hint.id).toBeTruthy();

    // Control must reference the hint via aria-describedby.
    expect(input).toHaveAttribute('aria-describedby', hint.id);
  });

  it('preserves existing aria-describedby tokens and appends the hint', () => {
    render(
      <FormField label="Provider" hint="This service may be unavailable during maintenance">
        <select aria-describedby="provider-note" defaultValue="auto">
          <option value="auto">Auto</option>
          <option value="manual">Manual</option>
        </select>
      </FormField>
    );
    const select = screen.getByLabelText('Provider');
    const hint = screen.getByText('This service may be unavailable during maintenance');

    // Control must have both the original aria-describedby and the hint id.
    expect(select).toHaveAttribute('aria-describedby');
    const describedBy = select.getAttribute('aria-describedby');
    expect(describedBy).toContain('provider-note');
    expect(describedBy).toContain(hint.id);
  });

  it('associates hint with an explicit control id', () => {
    render(
      <FormField label="STT Engine" hint="Browser-based engines have limited language support">
        <select id="stt-selector" defaultValue="browser">
          <option value="browser">Browser</option>
          <option value="api">API</option>
        </select>
      </FormField>
    );
    const select = screen.getByLabelText('STT Engine');
    const hint = screen.getByText('Browser-based engines have limited language support');

    // Label should point at the explicit id.
    expect(select.id).toBe('stt-selector');

    // Control must reference the hint via aria-describedby.
    expect(select).toHaveAttribute('aria-describedby', hint.id);
  });

  it('does not create a dangling hint id when hint is absent', () => {
    render(
      <FormField label="Name">
        <input defaultValue="" />
      </FormField>
    );
    const input = screen.getByLabelText('Name');

    // Without a hint, aria-describedby should not be set.
    expect(input).not.toHaveAttribute('aria-describedby');
  });

  it('renders hint content without an id when hint prop is falsy', () => {
    render(
      <FormField label="Notes">
        <textarea defaultValue="" />
      </FormField>
    );
    const textarea = screen.getByLabelText('Notes');

    // No aria-describedby when hint is omitted.
    expect(textarea).not.toHaveAttribute('aria-describedby');
  });

  it('treats empty string hint as no hint to avoid orphan IDREFs', () => {
    const { container } = render(
      <FormField label="Field" hint="">
        <input defaultValue="" />
      </FormField>
    );
    const input = screen.getByLabelText('Field');
    const paragraphs = container.querySelectorAll('p');

    // No paragraph should be rendered for an empty hint.
    expect(paragraphs).toHaveLength(0);

    // No aria-describedby should be set.
    expect(input).not.toHaveAttribute('aria-describedby');
  });

  it('treats false hint as no hint', () => {
    const { container } = render(
      <FormField label="Field" hint={false}>
        <input defaultValue="" />
      </FormField>
    );
    const input = screen.getByLabelText('Field');
    const paragraphs = container.querySelectorAll('p');

    // No paragraph should be rendered for a false hint.
    expect(paragraphs).toHaveLength(0);

    // No aria-describedby should be set.
    expect(input).not.toHaveAttribute('aria-describedby');
  });
});
