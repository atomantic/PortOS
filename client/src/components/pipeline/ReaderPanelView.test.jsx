import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { PANEL_PERSONAS, PANEL_QUESTIONS } from '../../../../server/lib/editorial/panelDisagreement.js';

vi.mock('../../hooks/useReaderPanel', () => ({ useReaderPanel: vi.fn() }));

import { useReaderPanel } from '../../hooks/useReaderPanel';
import ReaderPanelView from './ReaderPanelView';

describe('ReaderPanelView', () => {
  it('renders one answer per server panel question and every persona name', () => {
    const answers = Object.fromEntries(PANEL_QUESTIONS.map((q) => [q.id, { text: `answer-${q.id}`, issues: [1] }]));
    useReaderPanel.mockReturnValue({
      panel: {
        status: 'complete',
        personas: PANEL_PERSONAS.map((p) => ({ persona: p.id, verdict: 'v', answers })),
        disagreements: {},
      },
      loading: false, running: false, starting: false,
      convene: vi.fn(), cancel: vi.fn(), progressText: '',
    });
    render(<MemoryRouter><ReaderPanelView seriesId="s1" hasContent /></MemoryRouter>);
    for (const q of PANEL_QUESTIONS) {
      expect(screen.getAllByText(`answer-${q.id}`)).toHaveLength(PANEL_PERSONAS.length);
      expect(screen.getAllByText(q.label, { exact: false }).length).toBeGreaterThan(0);
    }
    for (const p of PANEL_PERSONAS) expect(screen.getAllByText(p.label).length).toBeGreaterThan(0);
  });
});

describe('ReaderPanelView load states', () => {
  const base = { loading: false, running: false, starting: false, convene: vi.fn(), cancel: vi.fn(), progressText: '' };

  it('shows an error with Retry for a failed read, not the "hasn\'t met yet" empty copy', () => {
    const reload = vi.fn();
    useReaderPanel.mockReturnValue({ ...base, panel: null, loadError: new Error('boom'), reload });
    render(<MemoryRouter><ReaderPanelView seriesId="s1" hasContent /></MemoryRouter>);
    expect(screen.queryByText(/hasn’t met yet/)).toBeNull();
    expect(screen.getByRole('alert').textContent).toMatch(/Could not load the reader panel/);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Convene panel' }).disabled).toBe(false);
  });

  it('keeps the empty copy for a successful empty read', () => {
    useReaderPanel.mockReturnValue({ ...base, panel: null, loadError: null, reload: vi.fn() });
    render(<MemoryRouter><ReaderPanelView seriesId="s1" hasContent /></MemoryRouter>);
    expect(screen.getByText(/hasn’t met yet/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
