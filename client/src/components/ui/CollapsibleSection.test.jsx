import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Shirt } from 'lucide-react';
import CollapsibleSection from './CollapsibleSection';

describe('CollapsibleSection', () => {
  it('starts collapsed and toggles its children on click', () => {
    render(
      <CollapsibleSection label="Outfits">
        <p>body content</p>
      </CollapsibleSection>,
    );
    expect(screen.queryByText('body content')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Outfits/ }));
    expect(screen.getByText('body content')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Outfits/ }));
    expect(screen.queryByText('body content')).not.toBeInTheDocument();
  });

  it('tracks open state in aria-expanded', () => {
    render(<CollapsibleSection label="Relationships">body</CollapsibleSection>);
    const button = screen.getByRole('button', { name: /Relationships/ });
    expect(button).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('renders the summary only while collapsed, clipped to one line', () => {
    render(
      <CollapsibleSection label="Outfits" summary=": Wedding, Rainy day">
        body
      </CollapsibleSection>,
    );
    const summary = screen.getByText(': Wedding, Rainy day');
    expect(summary).toHaveClass('min-w-0');
    expect(summary).toHaveClass('truncate');

    fireEvent.click(screen.getByRole('button', { name: /Outfits/ }));
    expect(screen.queryByText(': Wedding, Rainy day')).not.toBeInTheDocument();
  });

  it('lets the label shrink once the summary is no longer beside it', () => {
    render(
      <CollapsibleSection label="Outfits" summary=": Wedding">body</CollapsibleSection>,
    );
    const button = screen.getByRole('button', { name: /Outfits/ });
    const label = screen.getByText('Outfits');
    expect(label).toHaveClass('shrink-0');

    // Expanded hides the summary, so nothing competes for the line and a long
    // label must be free to wrap rather than overflow the header.
    fireEvent.click(button);
    expect(label).toHaveClass('min-w-0');
    expect(label).not.toHaveClass('shrink-0');
  });

  it('honors defaultOpen', () => {
    render(
      <CollapsibleSection label="Analysis Summary" defaultOpen>
        <p>body content</p>
      </CollapsibleSection>,
    );
    expect(screen.getByText('body content')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Analysis Summary/ }))
      .toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps the chevron and leading icon from shrinking', () => {
    const { container } = render(
      <CollapsibleSection icon={Shirt} label="Outfits">body</CollapsibleSection>,
    );
    const svgs = container.querySelectorAll('button svg');
    expect(svgs).toHaveLength(2);
    svgs.forEach((svg) => expect(svg).toHaveClass('shrink-0'));
  });

  it('applies the size tone to the header', () => {
    const { container, rerender } = render(
      <CollapsibleSection label="Outfits" size="sm">body</CollapsibleSection>,
    );
    expect(container.querySelector('button')).toHaveClass('text-gray-500');

    rerender(<CollapsibleSection label="Outfits" size="md">body</CollapsibleSection>);
    expect(container.querySelector('button')).toHaveClass('text-gray-400');
  });
});
