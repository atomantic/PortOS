import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AlertTriangle } from 'lucide-react';

import Banner from './Banner';

describe('Banner', () => {
  it('renders children with the default warning tone, sm size, and rounded border', () => {
    render(<Banner>hi</Banner>);
    const body = screen.getByText('hi');
    const wrapper = body.closest('div.flex');
    expect(wrapper.className).toContain('bg-port-warning/10');
    expect(wrapper.className).toContain('border-port-warning/30');
    expect(wrapper.className).toContain('text-port-warning');
    expect(wrapper.className).toContain('text-xs');
    expect(wrapper.className).toContain('px-3');
    expect(wrapper.className).toContain('py-2');
    expect(wrapper.className.split(/\s+/)).toContain('rounded');
  });

  it('applies the requested tone', () => {
    render(<Banner tone="error">x</Banner>);
    const wrapper = screen.getByText('x').closest('div.flex');
    expect(wrapper.className).toContain('bg-port-error/10');
    expect(wrapper.className).toContain('border-port-error/30');
    expect(wrapper.className).toContain('text-port-error');
  });

  it('uses rounded-lg + larger padding/icon at size="lg"', () => {
    render(<Banner size="lg" icon={AlertTriangle}>x</Banner>);
    const wrapper = screen.getByText('x').closest('div.flex');
    expect(wrapper.className).toContain('p-4');
    expect(wrapper.className).toContain('text-sm');
    expect(wrapper.className).toContain('rounded-lg');
  });

  it('renders the icon with the tone color class', () => {
    const { container } = render(<Banner tone="info" icon={AlertTriangle}>x</Banner>);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg.getAttribute('class')).toContain('text-port-accent');
  });

  it('marks the icon aria-hidden by default so screen readers skip the decorative glyph', () => {
    const { container } = render(<Banner icon={AlertTriangle}>x</Banner>);
    const svg = container.querySelector('svg');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
  });

  it('exposes the icon to assistive tech when iconAriaHidden={false}', () => {
    const { container } = render(<Banner icon={AlertTriangle} iconAriaHidden={false}>x</Banner>);
    const svg = container.querySelector('svg');
    expect(svg.getAttribute('aria-hidden')).toBeNull();
  });

  it('renders a bold title above the children when supplied', () => {
    render(<Banner title="Heads up">details below</Banner>);
    const titleEl = screen.getByText('Heads up');
    expect(titleEl.className).toContain('font-medium');
    expect(screen.getByText('details below')).toBeTruthy();
  });

  it('renders an actions slot when supplied', () => {
    render(<Banner actions={<button>Do it</button>}>msg</Banner>);
    expect(screen.getByRole('button', { name: 'Do it' })).toBeTruthy();
  });

  it('merges passthrough className after tone classes', () => {
    render(<Banner className="mb-6 custom-flag">x</Banner>);
    const wrapper = screen.getByText('x').closest('div.flex');
    expect(wrapper.className).toContain('mb-6');
    expect(wrapper.className).toContain('custom-flag');
  });

  it('defaults to items-start alignment and drops the icon nudge at center', () => {
    const { container, rerender } = render(<Banner icon={AlertTriangle}>x</Banner>);
    let wrapper = container.querySelector('div.flex');
    expect(wrapper.className.split(/\s+/)).toContain('items-start');
    let svg = container.querySelector('svg');
    expect(svg.getAttribute('class')).toContain('mt-0.5');

    rerender(<Banner align="center" icon={AlertTriangle}>x</Banner>);
    wrapper = container.querySelector('div.flex');
    expect(wrapper.className.split(/\s+/)).toContain('items-center');
    // Tailwind resolves duplicate items-* by CSS source order, so the
    // component must emit exactly one — no items-start leaking through.
    expect(wrapper.className.split(/\s+/)).not.toContain('items-start');
    svg = container.querySelector('svg');
    expect(svg.getAttribute('class')).not.toContain('mt-0.5');
  });
  // A Banner is almost always rendered conditionally after an async action, so
  // an inert <div> announces nothing when it appears (WCAG 4.1.3).
  it.each([
    ['error', 'alert'],
    ['warning', 'status'],
    ['success', 'status'],
    ['info', 'status'],
  ])('renders tone=%s inside a %s live region', (tone, role) => {
    render(<Banner tone={tone}>x</Banner>);
    expect(screen.getByRole(role).textContent).toContain('x');
  });

  it('falls back to the status role for an unknown tone, matching the warning class fallback', () => {
    render(<Banner tone="bogus">x</Banner>);
    expect(screen.getByRole('status').textContent).toContain('x');
  });

  it('lets a call site override the role it passes through', () => {
    render(<Banner tone="error" role="note">x</Banner>);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('note')).toBeTruthy();
  });

  // Tone is otherwise hue-only: an icon-less error and success banner with the
  // same copy are identical to a colorblind user and to a screen reader.
  it.each([
    ['error', 'Error'],
    ['warning', 'Warning'],
    ['success', 'Success'],
    ['info', 'Note'],
  ])('prefixes tone=%s with the visually-hidden word "%s"', (tone, word) => {
    const { container } = render(<Banner tone={tone}>Backup failed</Banner>);
    // Accessible text, not a class assertion — what a reader actually hears.
    expect(container.textContent).toBe(`${word}: Backup failed`);
    expect(screen.getByText(`${word}:`, { exact: false }).className).toContain('sr-only');
  });

  it('omits the tone word when srLabel={false}', () => {
    const { container } = render(<Banner tone="error" srLabel={false}>Error: already said it</Banner>);
    expect(container.textContent).toBe('Error: already said it');
    expect(container.querySelector('.sr-only')).toBeNull();
  });

  // The sr-only span and the role are purely additive — the visual rendering
  // must be byte-identical to what the component emitted before they existed,
  // so these pin the WHOLE class string rather than a contains() fragment.
  it.each([
    [{ tone: 'warning', size: 'sm', align: 'start' }, 'px-3 py-2 text-xs border rounded border-port-warning/30 bg-port-warning/10 text-port-warning flex items-start gap-2'],
    [{ tone: 'error', size: 'md', align: 'center' }, 'px-4 py-3 text-sm border rounded-lg border-port-error/30 bg-port-error/10 text-port-error flex items-center gap-2'],
    [{ tone: 'success', size: 'lg', align: 'start' }, 'p-4 text-sm border rounded-lg border-port-success/30 bg-port-success/10 text-port-success flex items-start gap-3'],
    [{ tone: 'info', size: 'sm', align: 'center' }, 'px-3 py-2 text-xs border rounded border-port-accent/30 bg-port-accent/10 text-port-accent flex items-center gap-2'],
  ])('renders %o with an unchanged class string', (props, expected) => {
    const { container } = render(<Banner {...props}>x</Banner>);
    expect(container.querySelector('div.flex').className).toBe(expected);
  });
});
