import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import VideoCastLinks from './VideoCastLinks.jsx';
import { linkVideoSubjects, listCatalogIngredientsByIds, listVideoSubjectLinks, updateCatalogIngredient } from '../../services/api';

vi.mock('../../services/api', () => ({ listVideoSubjectLinks: vi.fn(), linkVideoSubjects: vi.fn(), listCatalogIngredientsByIds: vi.fn(), updateCatalogIngredient: vi.fn() }));
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

  // Uniquely catches a linked subject and its catalog record disagreeing with no warning or one-tap fix either way.
  it('flags a description that differs from the catalog and fixes either side', async () => {
    const linked = { id: 'mvc-a', kind: 'character', name: 'Example Lead (17)', description: 'Short red hair.', ingredientId: 'cat-chr-1',
      castForm: { id: 'teen', label: 'Teen', age: 17 },
      linked: { id: 'cat-chr-1', name: 'Example Lead', forms: [{ id: 'teen', label: 'Teen' }], appearance: { field: 'form', formId: 'teen', text: 'Long black braids.' } } };
    listVideoSubjectLinks.mockResolvedValue({ subjects: [linked] });
    listCatalogIngredientsByIds.mockResolvedValue([{ id: 'cat-chr-1', payload: { physicalDescription: 'Adult.', forms: [{ id: 'teen', label: 'Teen', age: '17', description: 'Long black braids.' }] } }]);
    updateCatalogIngredient.mockResolvedValue({ id: 'cat-chr-1' });
    render(<MemoryRouter><VideoCastLinks projectId="mv-1" universeId="u-1" /></MemoryRouter>);
    expect(await screen.findByText('Description differs from Example Lead · Teen in the catalog')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Casting' })).toHaveAttribute('href', '/casting?scope=u-1&story=music-video%3Amv-1');

    fireEvent.click(screen.getByRole('button', { name: 'Use the catalog description for Example Lead (17)' }));
    await waitFor(() => expect(linkVideoSubjects).toHaveBeenCalledWith('mv-1', [{ subjectId: 'mvc-a', ingredientId: 'cat-chr-1', formId: 'teen', useCatalogText: true }], { silent: true }));

    fireEvent.click(await screen.findByRole('button', { name: 'Update the catalog from Example Lead (17)' }));
    await waitFor(() => expect(updateCatalogIngredient).toHaveBeenCalledWith('cat-chr-1', { payload: {
      physicalDescription: 'Adult.', forms: [{ id: 'teen', label: 'Teen', age: '17', description: 'Short red hair.' }],
    } }, { silent: true }));
  });
});
