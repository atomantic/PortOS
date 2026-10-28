import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import VideoCastLinks from './VideoCastLinks.jsx';
import { linkVideoSubjects, listVideoSubjectLinks } from '../../services/api';

vi.mock('../../services/api', () => ({ listVideoSubjectLinks: vi.fn(), linkVideoSubjects: vi.fn() }));
vi.mock('../ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../IngredientPicker.jsx', () => ({
  default: ({ open: isOpen, type, onSelect }) => (isOpen ? (
    <div role="dialog" aria-label={`Pick ${type}`}>
      <button type="button" onClick={() => onSelect({ id: 'cat-chr-2', type: 'character', name: 'Example Elder', payload: { forms: [{ id: 'old', label: 'Old', age: '80' }] } })}>Example Elder</button>
    </div>
  ) : null),
}));

const suggestion = (formId, formLabel) => ({ ingredientId: 'cat-chr-1', name: 'Example Lead', forms: [], ...(formId ? { formId, formLabel } : {}) });
const subjects = [
  { id: 'mvc-a', kind: 'character', name: 'Example Lead (17)', linked: null, suggestion: suggestion('teen', 'Teen') },
  { id: 'mvc-b', kind: 'character', name: 'Example Lead', linked: null, suggestion: suggestion() },
  { id: 'mvc-c', kind: 'character', name: 'Stranger', linked: null, suggestion: null },
];

const renderLinks = (onLinked = vi.fn()) => {
  render(<MemoryRouter><VideoCastLinks projectId="mv-1" type="character" onLinked={onLinked} /></MemoryRouter>);
  return onLinked;
};

beforeEach(() => {
  vi.clearAllMocks();
  listVideoSubjectLinks.mockResolvedValue({ subjects });
  linkVideoSubjects.mockResolvedValue({ concept: { subjects: [] }, linked: 1, unlinked: 0 });
});

describe('linking a music video’s cast to the catalog', () => {
  // Uniquely catches a suggested link dropping the age form its name points at, or the parent not hearing about it.
  it('links one suggested subject with its age, or every suggestion at once', async () => {
    const onLinked = renderLinks();
    fireEvent.click(await screen.findByRole('button', { name: 'Link to Example Lead · Teen' }));
    await waitFor(() => expect(linkVideoSubjects).toHaveBeenCalledWith('mv-1', [{ subjectId: 'mvc-a', ingredientId: 'cat-chr-1', formId: 'teen' }], { silent: true }));
    await waitFor(() => expect(onLinked).toHaveBeenCalled());
    expect(listVideoSubjectLinks).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: 'Link all suggested (2)' }));
    await waitFor(() => expect(linkVideoSubjects).toHaveBeenLastCalledWith('mv-1', [
      { subjectId: 'mvc-a', ingredientId: 'cat-chr-1', formId: 'teen' },
      { subjectId: 'mvc-b', ingredientId: 'cat-chr-1' },
    ], { silent: true }));
  });

  // Uniquely catches a picked record with ages linking before its age is chosen.
  it('asks for the age of a picked record that has several', async () => {
    renderLinks();
    fireEvent.click(await screen.findByRole('button', { name: 'Pick a catalog record for Stranger' }));
    fireEvent.click(screen.getByRole('button', { name: 'Example Elder' }));
    expect(linkVideoSubjects).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Age or look for Stranger'), { target: { value: 'old' } });
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));
    await waitFor(() => expect(linkVideoSubjects).toHaveBeenCalledWith('mv-1', [{ subjectId: 'mvc-c', ingredientId: 'cat-chr-2', formId: 'old' }], { silent: true }));
  });
});
