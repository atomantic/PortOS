// jsdom has no layout engine, so these pin the Tailwind classes that keep the Digital Twin
// tabs inside a 360-390px viewport (#17736): shrinkable flex children, wrapping rows, 44px hit areas.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  getProviders: vi.fn(),
  getModelPersonalityHistory: vi.fn(),
  getModelPersonalitySettings: vi.fn(),
  getGoals: vi.fn(),
  getLongevity: vi.fn(),
  getDigitalTwinDocuments: vi.fn(),
  getDigitalTwinDocument: vi.fn(),
}));
vi.mock('../../../services/apiProviders.js', () => ({ getProviders: api.getProviders }));
vi.mock('../../../services/apiModelPersonality.js', () => ({
  getModelPersonalityHistory: api.getModelPersonalityHistory,
  getModelPersonalitySettings: api.getModelPersonalitySettings,
  deleteModelPersonalityResult: vi.fn(),
}));
vi.mock('../../../services/apiGoals.js', () => ({
  getGoals: api.getGoals,
  getLongevity: api.getLongevity,
  deriveLongevity: vi.fn(),
  createGoal: vi.fn(),
  updateGoal: vi.fn(),
  deleteGoal: vi.fn(),
  setBirthDate: vi.fn(),
  addGoalMilestone: vi.fn(),
  completeGoalMilestone: vi.fn(),
}));
vi.mock('../../../services/apiDigitalTwin.js', () => ({
  getDigitalTwinDocuments: api.getDigitalTwinDocuments,
  getDigitalTwinDocument: api.getDigitalTwinDocument,
  updateSoulDocument: vi.fn(),
  createSoulDocument: vi.fn(),
  deleteSoulDocument: vi.fn(),
}));
vi.mock('../../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../hooks/useChartColors.js', () => ({ default: () => ({}) }));

import PersonalityTab from './PersonalityTab.jsx';
import GoalsTab from './GoalsTab.jsx';
import DocumentsTab from './DocumentsTab.jsx';

const classes = (el) => Array.from(el.classList);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PersonalityTab Past Runs at phone width', () => {
  it('lets the expand button shrink so a long model id truncates and the score + delete stay on screen', async () => {
    api.getProviders.mockResolvedValue({ providers: [] });
    api.getModelPersonalitySettings.mockResolvedValue({ historyCap: 100, defaultIncludeAlignment: true });
    api.getModelPersonalityHistory.mockResolvedValue([{
      runId: 'run-1', providerId: 'p1', model: 'vendor/a-very-long-model-identifier-that-would-overflow-v2-2026',
      timestamp: '2026-01-01T00:00:00.000Z', alignment: { alignmentScore: 0.8 },
    }]);
    render(<MemoryRouter><PersonalityTab /></MemoryRouter>);

    const label = await screen.findByText(/a-very-long-model-identifier/);
    expect(classes(label)).toContain('truncate');
    const expand = label.closest('button');
    expect(classes(expand)).toEqual(expect.arrayContaining(['flex-1', 'min-w-0']));
    expect(classes(expand.querySelector('svg'))).toContain('shrink-0');
    expect(classes(screen.getByText('80%'))).toContain('shrink-0');
  });
});

describe('DocumentsTab editor header at phone width', () => {
  it('wraps the header and keeps the title row from collapsing to zero width', async () => {
    const doc = { id: 'doc-1', title: 'Core Values', category: 'core', enabled: true, weight: 5, content: 'x', lastModified: '2026-01-01T00:00:00.000Z' };
    api.getDigitalTwinDocuments.mockResolvedValue([doc]);
    api.getDigitalTwinDocument.mockResolvedValue(doc);
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={['/digital-twin/documents']}><DocumentsTab onRefresh={vi.fn()} /></MemoryRouter>);

    await user.click(await screen.findByRole('button', { name: /Core Values/ }));
    const title = await screen.findByRole('heading', { name: 'Core Values' });
    const titleRow = title.parentElement;
    expect(classes(titleRow)).toContain('min-w-[140px]');
    const header = titleRow.parentElement;
    expect(classes(header)).toContain('flex-wrap');
    const actions = screen.getByRole('button', { name: 'Delete' }).parentElement;
    expect(classes(actions)).toContain('flex-wrap');
    expect(classes(actions)).not.toContain('shrink-0');
  });
});

describe('GoalsTab at phone width', () => {
  const goal = { id: 'g1', title: 'Ship it', category: 'mastery', horizon: '5-year', status: 'active', milestones: [{ id: 'm1', title: 'First', targetDate: '2026-12-01' }] };
  beforeEach(() => {
    api.getGoals.mockResolvedValue({ birthDate: '1990-01-01', goals: [goal] });
    api.getLongevity.mockResolvedValue(null);
  });

  it('stacks the add-milestone row and gives every control a touch-sized hit area', async () => {
    render(<GoalsTab />);
    fireEvent.click(await screen.findByText('Ship it'));

    const titleInput = await screen.findByLabelText('New milestone title for Ship it');
    const dateInput = screen.getByLabelText('New milestone target date for Ship it');
    const row = titleInput.parentElement;
    expect(classes(row)).toEqual(expect.arrayContaining(['flex-col', 'sm:flex-row']));
    expect(classes(titleInput)).toEqual(expect.arrayContaining(['min-w-0', 'flex-1']));
    expect(classes(dateInput)).toEqual(expect.arrayContaining(['w-full', 'sm:w-36']));

    for (const name of ['Add', 'Complete', 'Delete', 'Re-derive', 'Update Birth Date', 'Add Goal']) {
      const btn = screen.getByRole('button', { name: new RegExp(`^${name}$`) });
      expect(classes(btn), name).toEqual(expect.arrayContaining(['min-h-[40px]', 'pointer-coarse:min-h-11']));
    }

    const check = screen.getByRole('button', { name: 'Mark First complete' });
    expect(classes(check)).toEqual(expect.arrayContaining(['min-h-[44px]', 'min-w-[44px]']));
    expect(classes(check)).not.toContain('w-4');
  });

  it('wraps the header rows and stacks Horizon/Category on phones', async () => {
    render(<GoalsTab />);
    const heading = await screen.findByRole('heading', { name: 'Life Expectancy' });
    expect(classes(heading.parentElement.parentElement)).toContain('flex-wrap');

    fireEvent.click(screen.getByRole('button', { name: /Add Goal/ }));
    const horizon = screen.getByLabelText('Horizon');
    expect(classes(horizon.closest('.grid'))).toEqual(expect.arrayContaining(['grid-cols-1', 'sm:grid-cols-2']));
    await waitFor(() => expect(screen.getByLabelText('Category')).toBeInTheDocument());
  });
});
