import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Wifi } from 'lucide-react';

import Pill from './Pill';

describe('Pill', () => {
  it('renders children with the default muted tone, sm size, and a border', () => {
    render(<Pill>hello</Pill>);
    const el = screen.getByText('hello');
    expect(el.className).toContain('text-gray-300');
    expect(el.className).toContain('bg-port-bg');
    expect(el.className).toContain('text-xs');
    expect(el.className).toContain('px-2');
    // Token membership, not substring — `border-port-border` also contains "border".
    expect(el.className.split(/\s+/)).toContain('border');
    expect(el.className).toContain('border-port-border');
  });

  it('applies the requested tone color trio', () => {
    render(<Pill tone="accent">x</Pill>);
    const el = screen.getByText('x');
    expect(el.className).toContain('text-port-accent');
    expect(el.className).toContain('bg-port-accent/10');
    expect(el.className).toContain('border-port-accent/20');
  });

  it('switches to the compact xs size', () => {
    render(<Pill size="xs">x</Pill>);
    const el = screen.getByText('x');
    expect(el.className).toContain('text-[10px]');
    expect(el.className).toContain('px-1.5');
  });

  it('drops the border AND the border-color utility when bordered is false', () => {
    render(<Pill tone="success" bordered={false}>x</Pill>);
    const el = screen.getByText('x');
    // No standalone `border` class and no leftover border-color.
    expect(el.className.split(/\s+/)).not.toContain('border');
    expect(el.className).not.toContain('border-port-success/20');
    // Text + bg tint survive.
    expect(el.className).toContain('text-port-success');
    expect(el.className).toContain('bg-port-success/10');
  });

  it('renders a leading icon at the size-appropriate dimension', () => {
    const { container } = render(<Pill size="xs" icon={Wifi}>https</Pill>);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg).toHaveAttribute('width', '10');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
  });

  it('adds font-mono when mono is set', () => {
    render(<Pill mono>code</Pill>);
    expect(screen.getByText('code').className).toContain('font-mono');
  });

  it('emits no color classes for tone="bare" so className can drive colors', () => {
    render(<Pill tone="bare" bordered={false} className="text-green-500 bg-green-900">x</Pill>);
    const el = screen.getByText('x');
    expect(el.className).toContain('text-green-500');
    expect(el.className).toContain('bg-green-900');
    expect(el.className).not.toContain('text-gray-300');
  });

  it('tone="bare" keeps the default border width so a className border-color paints it', () => {
    render(<Pill tone="bare" className="border-port-warning/30">x</Pill>);
    const el = screen.getByText('x');
    expect(el.className.split(/\s+/)).toContain('border');
    expect(el.className).toContain('border-port-warning/30');
  });

  it('passes through arbitrary props like title', () => {
    render(<Pill title="tooltip">x</Pill>);
    expect(screen.getByText('x')).toHaveAttribute('title', 'tooltip');
  });
});
