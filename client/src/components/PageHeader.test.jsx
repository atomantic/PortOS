import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Brain } from 'lucide-react';
import PageHeader from './PageHeader';

describe('PageHeader', () => {
  it('renders the title as an h1', () => {
    render(<PageHeader title="Brain" />);
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent).toBe('Brain');
  });

  it('renders an icon when provided and marks it aria-hidden', () => {
    const { container } = render(<PageHeader icon={Brain} title="Brain" />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders no icon element when icon is omitted', () => {
    const { container } = render(<PageHeader title="Settings" />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('applies a custom icon color class', () => {
    const { container } = render(<PageHeader icon={Brain} iconColor="text-port-error" title="MeatSpace" />);
    expect(container.querySelector('svg').getAttribute('class')).toContain('text-port-error');
  });

  it('defaults the icon color to the accent token', () => {
    const { container } = render(<PageHeader icon={Brain} title="Brain" />);
    expect(container.querySelector('svg').getAttribute('class')).toContain('text-port-accent');
  });

  it('renders the subtitle when provided', () => {
    render(<PageHeader title="Calendar" subtitle="Unified calendar and event management" />);
    expect(screen.getByText('Unified calendar and event management')).toBeTruthy();
  });

  it('omits the subtitle paragraph when not provided', () => {
    const { container } = render(<PageHeader title="Settings" />);
    expect(container.querySelector('p')).toBeNull();
  });

  it('renders the actions slot', () => {
    render(
      <PageHeader
        title="Brain"
        actions={<span>12 links</span>}
      />
    );
    expect(screen.getByText('12 links')).toBeTruthy();
  });

  it('keeps the standardized padding + border on the outer container', () => {
    const { container } = render(<PageHeader title="Goals" />);
    const cls = container.firstChild.getAttribute('class');
    expect(cls).toContain('border-b');
    expect(cls).toContain('border-port-border');
    expect(cls).toContain('px-3');
    expect(cls).toContain('sm:px-4');
  });

  it('merges a caller-supplied className onto the container', () => {
    const { container } = render(<PageHeader title="Goals" className="bg-port-card" />);
    expect(container.firstChild.getAttribute('class')).toContain('bg-port-card');
  });
});
