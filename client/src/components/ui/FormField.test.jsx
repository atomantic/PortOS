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
});
