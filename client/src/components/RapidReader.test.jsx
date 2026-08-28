import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { installVoiceHotkeySpy } from '../test/voiceHotkeySpy';
import RapidReader, { RapidReaderModal } from './RapidReader';

describe('RapidReader keyboard transport', () => {
  const voiceHotkey = installVoiceHotkeySpy();

  const renderReader = (props = {}) => render(
    <RapidReader text="alpha bravo charlie delta" chunkSize={1} {...props} />,
  );

  it('toggles play on Space without leaking the key to the global voice hotkey', () => {
    renderReader();
    expect(screen.getByLabelText('Play')).toBeInTheDocument();

    act(() => { fireEvent.keyDown(document.body, { key: ' ', code: 'Space' }); });

    expect(screen.getByLabelText('Pause')).toBeInTheDocument();
    expect(voiceHotkey()).not.toHaveBeenCalled();
  });

  it('claims Escape for its own close handler', () => {
    const onClose = vi.fn();
    renderReader({ onClose });

    act(() => { fireEvent.keyDown(document.body, { key: 'Escape' }); });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(voiceHotkey()).not.toHaveBeenCalled();
  });

  it('ignores Space aimed at a <select>, where it natively opens the dropdown', () => {
    // The old hand-rolled guard only knew INPUT/TEXTAREA/contentEditable, so Space on a
    // <select> hijacked the transport. `isEditableTarget` covers SELECT.
    const { container } = renderReader();
    const select = document.createElement('select');
    container.appendChild(select);

    act(() => { fireEvent.keyDown(select, { key: ' ', code: 'Space' }); });

    expect(screen.getByLabelText('Play')).toBeInTheDocument();
  });

  it('steps through the text with the arrow keys', () => {
    // The current word is split across spans to anchor its focal letter, so the token
    // counter ("2/4") is the readable signal for which word is showing.
    const { container } = renderReader();
    expect(container.textContent).toContain('1/4');

    act(() => { fireEvent.keyDown(document.body, { key: 'ArrowRight' }); });
    expect(container.textContent).toContain('2/4');

    act(() => { fireEvent.keyDown(document.body, { key: 'ArrowLeft' }); });
    expect(container.textContent).toContain('1/4');
    expect(voiceHotkey()).not.toHaveBeenCalled();
  });

  it('starts at a canonical word offset and keeps that place when chunk size changes', () => {
    const { container } = renderReader({ initialWordIndex: 2 });
    expect(container.textContent).toContain('3/4 words');

    fireEvent.click(screen.getByRole('button', { name: 'Show two words at a time' }));

    expect(container.textContent).toContain('3/4 words');
    expect(container.textContent).toContain('charlie');
  });

  it('saves the current canonical position from the bookmark button or B key', () => {
    const onBookmark = vi.fn();
    renderReader({ initialWordIndex: 2, onBookmark });

    fireEvent.click(screen.getByRole('button', { name: 'Save bookmark' }));
    act(() => { fireEvent.keyDown(document.body, { key: 'b', code: 'KeyB' }); });

    expect(onBookmark).toHaveBeenNthCalledWith(1, 2);
    expect(onBookmark).toHaveBeenNthCalledWith(2, 2);
  });

  it('stands down while an unrelated dialog is open', () => {
    const { container } = renderReader();
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    container.appendChild(dialog);

    act(() => { fireEvent.keyDown(document.body, { key: ' ', code: 'Space' }); });

    expect(screen.getByLabelText('Play')).toBeInTheDocument();
  });

  // A dialog focuses its first focusable descendant. That used to be the header
  // Close button — and Space on a focused button belongs to the browser, so the
  // reader's own Space dismissed the reader instead of pausing it (#4748).
  it('keeps initial focus off the modal Close button, so Space still pauses', () => {
    const onClose = vi.fn();
    render(<RapidReaderModal open text="alpha bravo charlie delta" title="Notes" onClose={onClose} />);

    expect(document.activeElement).not.toBe(screen.getByLabelText('Close rapid reader'));

    // Aimed at whatever actually holds focus, not at document.body — the whole
    // point is where the browser would route a real keystroke.
    act(() => { fireEvent.keyDown(document.activeElement, { key: ' ', code: 'Space' }); });

    expect(screen.getByLabelText('Play')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps its keys inside RapidReaderModal, whose own Modal is that dialog', () => {
    render(<RapidReaderModal open text="alpha bravo charlie delta" title="Notes" onClose={vi.fn()} />);

    // autoPlay is on in the modal, so the first Space pauses.
    act(() => { fireEvent.keyDown(document.body, { key: ' ', code: 'Space' }); });

    expect(screen.getByLabelText('Play')).toBeInTheDocument();
    expect(voiceHotkey()).not.toHaveBeenCalled();
  });
});

describe('RapidReader remaining-time readout', () => {
  installVoiceHotkeySpy();

  const wordsText = (count) => Array.from({ length: count }, (_, i) => `w${i}`).join(' ');

  it('counts down the words still to come and re-derives it when WPM changes', () => {
    // 600 words at 300 WPM: 599 left after the on-screen chunk → 119.8s → "02:00".
    const { container } = render(<RapidReader text={wordsText(600)} wpm={300} />);
    expect(container.textContent).toContain('1/600 words · 02:00 left');

    // The `-` hotkey drops WPM by 25, so the same remainder takes longer.
    act(() => { fireEvent.keyDown(document.body, { key: '-' }); });

    expect(container.textContent).toContain('1/600 words · 02:11 left');
  });

  it('renders an over-an-hour remainder as H:MM:SS', () => {
    // 3700 words at 60 WPM: 3699 left → 3699s → "1:01:39".
    const { container } = render(<RapidReader text={wordsText(3700)} wpm={60} />);
    expect(container.textContent).toContain('1:01:39 left');
  });
});
