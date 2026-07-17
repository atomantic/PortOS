import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Coverage for the human-centered Character reframe (#2677): the page centers the human
// (name/avatar/age-level, with skills/goals/metrics as primary content), prompts for a birth
// date when the age-level is unknown, and demotes the D&D damage/rest/dice/XP mechanics into a
// collapsed "legacy" section that is closed by default. The RPG endpoints/events[] are kept
// for back-compat — this suite only asserts the framing, not their removal.

const get = vi.fn();

vi.mock('../services/api', () => ({
  default: { get: (...a) => get(...a), post: vi.fn(), put: vi.fn() },
  generateAvatar: vi.fn(() => Promise.resolve({})),
}));

// GoalsCard (#2675) owns its own mount-effect fetch — stub it so this suite stays scoped to
// the framing and settles synchronously (a live child trips the act(...) guard).
vi.mock('../components/character/GoalsCard', () => ({ default: () => null }));

vi.mock('../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));

vi.mock('../components/ui/Toast', () => ({
  default: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

// Spy on navigation so the birth-date prompt's deep link is assertable.
const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useNavigate: () => navigate };
});

import CharacterSheet from './CharacterSheet';

const BASE_CHAR = {
  name: 'Ada Lovelace',
  class: 'Analyst',
  level: 42,
  hp: 15,
  maxHp: 15,
  xp: 1200,
  ageYears: 42.5,
  avatarPath: null,
  events: [],
  metrics: [],
  skills: [],
};

const renderChar = async (overrides = {}) => {
  get.mockResolvedValue({ ...BASE_CHAR, ...overrides });
  render(
    <MemoryRouter>
      <CharacterSheet />
    </MemoryRouter>,
  );
  // Wait for load to resolve; the header is always present once loaded.
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Character' })).toBeInTheDocument());
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('human-centered framing', () => {
  it('renders a human "Character" header, not "Character Sheet"', async () => {
    await renderChar();
    expect(screen.getByRole('heading', { name: 'Character' })).toBeInTheDocument();
    expect(screen.queryByText('Character Sheet')).not.toBeInTheDocument();
  });

  it('shows the age-level badge when a level is derived', async () => {
    await renderChar({ level: 42 });
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('Level')).toBeInTheDocument();
    expect(screen.queryByText('Set your birth date')).not.toBeInTheDocument();
  });

  it('falls back to human-centered placeholders for an unnamed person', async () => {
    // The server seeds an empty name/class on a fresh install (createDefaultCharacter), and
    // migration 198 clears the legacy 'Adventurer'/'Developer' defaults on existing installs —
    // so the page only ever sees an empty value for "unset" and renders the placeholder.
    await renderChar({ name: '', class: '' });
    expect(screen.getByText('Your name')).toBeInTheDocument();
    expect(screen.getByText('Add a title')).toBeInTheDocument();
  });
});

describe('birth-date prompt', () => {
  it('prompts to set a birth date when the level is null, deep-linking to the age editor', async () => {
    await renderChar({ level: null, ageYears: null });
    const prompt = screen.getByText('Set your birth date');
    expect(prompt).toBeInTheDocument();
    // The badge number is gone — no NaN / "—" level shown as a value.
    expect(screen.queryByText('Level')).not.toBeInTheDocument();

    fireEvent.click(prompt);
    expect(navigate).toHaveBeenCalledWith('/meatspace/age');
  });
});

describe('demoted D&D mechanics', () => {
  it('hides the RPG damage/rest/xp actions behind a collapsed legacy section by default', async () => {
    await renderChar();
    // Collapsed by default → the RPG actions are not in the DOM.
    expect(screen.queryByText('Take Damage')).not.toBeInTheDocument();
    expect(screen.queryByText('Event Log')).not.toBeInTheDocument();
    // But the section toggle is present.
    expect(screen.getByRole('button', { name: /RPG mechanics/i })).toBeInTheDocument();
  });

  it('reveals the legacy mechanics when the section is expanded', async () => {
    await renderChar();
    fireEvent.click(screen.getByRole('button', { name: /RPG mechanics/i }));
    expect(screen.getByText('Take Damage')).toBeInTheDocument();
    expect(screen.getByText('Event Log')).toBeInTheDocument();
    expect(screen.getByText('Sync JIRA')).toBeInTheDocument();
  });
});
