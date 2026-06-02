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
});
