import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import OverlayTextCheck from './OverlayTextCheck.jsx';

const counts = (errors = 0, warnings = 0) => ({ errors, warnings });
const finding = (n, kind = 'overlap', severity = 'error') => ({ id: `f${n}`, kind, severity, atSec: 60 + n, times: [60 + n], count: 2,
  sceneLabel: 'Cliff', texts: ['20 MILLION YEARS', 'WHOLE SPECIES'], message: `Finding ${n}: “20 MILLION YEARS” collides with “WHOLE SPECIES”.` });

describe('OverlayTextCheck', () => {
  it('offers a first check, then shows the findings with times that play the preview, folding past three', () => {
    const onCheck = vi.fn();
    const onSeek = vi.fn();
    const { rerender } = render(<OverlayTextCheck report={{ status: 'none', current: false, findings: [], counts: counts() }} onCheck={onCheck} onSeek={onSeek} />);
    fireEvent.click(screen.getByRole('button', { name: 'Check overlay text' }));
    expect(onCheck).toHaveBeenCalledOnce();

    rerender(<OverlayTextCheck report={{ status: 'running', current: true, findings: [], counts: counts() }} onCheck={onCheck} onSeek={onSeek} />);
    expect(screen.getByRole('button', { name: 'Checking…' }).disabled).toBe(true);

    const findings = [finding(1), finding(2, 'contrast', 'warning'), finding(3, 'small', 'warning'), finding(4, 'off-frame')];
    rerender(<OverlayTextCheck report={{ status: 'complete', current: true, textSamples: 40, findings, counts: counts(2, 2) }} onCheck={onCheck} onSeek={onSeek} />);
    expect(screen.getByRole('status').textContent).toBe('2 problems, 2 to improve.');
    expect(screen.getByRole('list', { name: 'Overlay text findings' }).children).toHaveLength(3);
    expect(screen.getByText('1 more')).toBeTruthy();
    expect(screen.getByText('Hard to read')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Play 1:01.00 in the preview' }));
    expect(onSeek).toHaveBeenCalledWith(61);
  });

  it('says when the text is clean, when the result is for an earlier version, and why a check failed', () => {
    const { rerender } = render(<OverlayTextCheck report={{ status: 'complete', current: true, textSamples: 1234, findings: [], counts: counts() }} onCheck={() => {}} />);
    expect(screen.getByRole('status').textContent).toBe('No problems in 1,234 frames with text.');
    rerender(<OverlayTextCheck report={{ status: 'complete', current: false, textSamples: 3, findings: [finding(1)], counts: counts(1) }} onCheck={() => {}} />);
    expect(screen.getByText(/earlier version/)).toBeTruthy();
    rerender(<OverlayTextCheck report={{ status: 'failed', current: false, error: 'Managed browser is unavailable', findings: [], counts: counts() }} onCheck={() => {}} />);
    expect(screen.getByRole('status').textContent).toBe('The check failed: Managed browser is unavailable');
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy();
  });
});
