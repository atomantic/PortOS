import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MidiVisualization from './MidiVisualization.jsx';
import { __clearMidiNotesCache } from '../../hooks/useMidiNotes.js';

// Tiny hand-built SMF fixture: a sustained C-major triad (C4 E4 G4) for one
// quarter at the default 120 BPM. Same builder approach as midiNotes.test.js.
const buildTriadMidi = () => {
  const str = (s) => [...s].map((c) => c.charCodeAt(0));
  const u32 = (v) => [(v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
  const u16 = (v) => [(v >> 8) & 0xff, v & 0xff];
  const body = [
    0, 0x90, 60, 100, 0, 0x90, 64, 100, 0, 0x90, 67, 100,
    0x83, 0x60, 0x80, 60, 0, // delta 480 (varlen 0x83 0x60), then note-offs
    0, 0x80, 64, 0,
    0, 0x80, 67, 0,
    0, 0xff, 0x2f, 0x00,
  ];
  return new Uint8Array([
    ...str('MThd'), ...u32(6), ...u16(0), ...u16(1), ...u16(480),
    ...str('MTrk'), ...u32(body.length), ...body,
  ]);
};

// jsdom has no canvas/ResizeObserver and reports 0 widths — stub the minimum
// (same pattern as PianoRoll.test.jsx).
const makeCtx = () => ({
  clearRect: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(), fillText: vi.fn(),
  save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), closePath: vi.fn(),
  rect: vi.fn(), clip: vi.fn(), roundRect: vi.fn(), fill: vi.fn(), stroke: vi.fn(),
  moveTo: vi.fn(), arcTo: vi.fn(), setTransform: vi.fn(), drawImage: vi.fn(),
  fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', globalAlpha: 1,
});

describe('<MidiVisualization>', () => {
  let ctx;
  beforeEach(() => {
    __clearMidiNotesCache();
    ctx = makeCtx();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      arrayBuffer: () => Promise.resolve(buildTriadMidi().buffer),
    })));
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete HTMLElement.prototype.clientWidth;
  });

  it('renders nothing without a url', () => {
    const { container } = render(<MidiVisualization url="" />);
    expect(container.firstChild).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('loads, parses, and paints the roll with footer stats and sr summary', async () => {
    render(<MidiVisualization url="/uploads/test.mid" filename="test.mid" model="medium" />);
    // Loading state first, then the parsed roll.
    expect(screen.getByText(/Parsing MIDI/)).toBeTruthy();
    await screen.findByText(/3 notes · /);
    expect(ctx.fill).toHaveBeenCalled(); // note bars painted
    expect(screen.getByText(/C4–G4/)).toBeTruthy();
    expect(screen.getByText(/MuScriptor medium/)).toBeTruthy();
    // Chord lane detected the triad — toggle button present and sr summary names it.
    expect(screen.getByRole('button', { name: /chord/i })).toBeTruthy();
    expect(screen.getByText(/Detected chords include C\b/)).toBeTruthy();
    // Download link points at the file.
    const link = screen.getByLabelText('Download MIDI file');
    expect(link.getAttribute('href')).toBe('/uploads/test.mid');
  });

  it('shows an inline error with retry when the file fails to parse', async () => {
    fetch.mockImplementation(() => Promise.resolve({
      ok: true,
      arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3, 4]).buffer),
    }));
    render(<MidiVisualization url="/uploads/bad.mid" />);
    await screen.findByText(/Not a MIDI file/);
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });

  it('collapses and re-expands without refetching (module cache)', async () => {
    render(<MidiVisualization url="/uploads/test.mid" />);
    await screen.findByText(/3 notes · /);
    expect(fetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText('Collapse MIDI visualization'));
    expect(screen.queryByText(/3 notes · /)).toBeNull();
    fireEvent.click(screen.getByLabelText('Expand MIDI visualization'));
    await screen.findByText(/3 notes · /);
    expect(fetch).toHaveBeenCalledTimes(1); // served from the parse cache
  });

  it('zoom controls are real labeled buttons', async () => {
    render(<MidiVisualization url="/uploads/test.mid" />);
    await screen.findByText(/3 notes · /);
    fireEvent.click(screen.getByLabelText('Zoom in'));
    fireEvent.click(screen.getByLabelText('Zoom out'));
    fireEvent.click(screen.getByLabelText('Fit to width'));
    expect(ctx.clearRect).toHaveBeenCalled();
  });
});
