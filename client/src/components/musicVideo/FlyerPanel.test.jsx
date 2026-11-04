/**
 * Printable flyer card: the QR is a placeholder until the release has a
 * YouTube link, then encodes it (or the director's own link); text saves
 * with the publish kit on blur, and Print opens the flyer in its own tab.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import FlyerPanel from './FlyerPanel.jsx';
import { buildFlyerHtml, resolveFlyer } from '../../lib/musicVideoFlyer.js';

const project = (kit = {}) => ({ id: 'mv-1', name: 'Example Song', publishKit: kit });
const hook = () => ({ saveCopy: vi.fn(async () => ({})) });

afterEach(() => vi.restoreAllMocks());

describe('FlyerPanel', () => {
  it('shows the placeholder until a YouTube link exists and saves edited text on blur', async () => {
    const publishKit = hook();
    render(<FlyerPanel project={project()} publishKit={publishKit} />);
    expect(screen.getByText(/dashed placeholder until the YouTube link is in/)).toBeInTheDocument();
    const title = screen.getByLabelText('Title');
    expect(title).toHaveValue('Example Song');
    fireEvent.change(title, { target: { value: 'EXAMPLE SONG' } });
    fireEvent.blur(title);
    expect(publishKit.saveCopy).toHaveBeenCalledWith({ flyer: { title: 'EXAMPLE SONG' } });
    expect(await screen.findByText('All changes saved')).toBeInTheDocument();
  });

  it('follows the recorded YouTube post, refuses a link without a scheme, and prints in a new tab', () => {
    const publishKit = hook();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<FlyerPanel project={project({ posts: { youtube: { url: 'https://youtu.be/abc' } } })} publishKit={publishKit} />);
    expect(screen.getByText('The QR code opens the YouTube video.')).toBeInTheDocument();
    const link = screen.getByLabelText('QR link (optional)');
    fireEvent.change(link, { target: { value: 'example.com/watch' } });
    fireEvent.blur(link);
    expect(screen.getByText('Start the link with https://')).toBeInTheDocument();
    expect(publishKit.saveCopy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Print' }));
    expect(open).toHaveBeenCalledWith(expect.stringMatching(/^blob:/), '_blank', 'noopener');
  });
});

describe('buildFlyerHtml', () => {
  it('prints a QR for the custom link over the YouTube one and escapes the director\'s text', () => {
    const flyer = resolveFlyer(project({ links: { youtube: 'https://youtu.be/abc' }, flyer: { url: 'https://example.com/w', title: 'A <b>' } }), { youtubeUrl: 'https://youtu.be/abc' });
    expect(flyer).toMatchObject({ qrSource: 'custom', qrUrl: 'https://example.com/w', image: 'none' });
    const html = buildFlyerHtml(flyer);
    expect(html).toContain('@page { size: letter; margin: 0; }');
    expect(html).toContain('<h1>A &lt;b&gt;</h1>');
    expect(html).toContain('aria-label="QR code for https://example.com/w"');
    expect(html).not.toContain('class="qr placeholder"');
  });
});
