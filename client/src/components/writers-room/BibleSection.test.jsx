import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../services/apiWritersRoom', () => ({
  listWritersRoomObjects: vi.fn(),
  createWritersRoomObject: vi.fn(),
  updateWritersRoomObject: vi.fn(),
  deleteWritersRoomObject: vi.fn(),
  listWritersRoomPlaces: vi.fn(),
  createWritersRoomPlace: vi.fn(),
  updateWritersRoomPlace: vi.fn(),
  deleteWritersRoomPlace: vi.fn(),
  listWritersRoomCharacters: vi.fn(),
  createWritersRoomCharacter: vi.fn(),
  updateWritersRoomCharacter: vi.fn(),
  deleteWritersRoomCharacter: vi.fn(),
}));

vi.mock('../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import ObjectsBible from './ObjectsBible';
import PlacesBible from './PlacesBible';
import CharactersBible from './CharactersBible';
import toast from '../ui/Toast';
import {
  listWritersRoomObjects,
  createWritersRoomObject,
  updateWritersRoomObject,
  deleteWritersRoomObject,
  listWritersRoomPlaces,
  createWritersRoomPlace,
  updateWritersRoomPlace,
  deleteWritersRoomPlace,
  listWritersRoomCharacters,
  createWritersRoomCharacter,
  updateWritersRoomCharacter,
  deleteWritersRoomCharacter,
} from '../../services/apiWritersRoom';

// BibleSection.jsx is the shared implementation behind ObjectsBible /
// PlacesBible / CharactersBible — each just supplies a `config`. Drive all
// three through the same scenarios instead of duplicating the file per kind.
const SCENARIOS = [
  {
    label: 'ObjectsBible',
    Component: ObjectsBible,
    itemsPropName: 'objects',
    onChangePropName: 'onObjectsChange',
    primaryKey: 'name',
    primaryLabel: 'Name',
    api: {
      list: listWritersRoomObjects,
      create: createWritersRoomObject,
      update: updateWritersRoomObject,
      remove: deleteWritersRoomObject,
    },
    existingItem: {
      id: 'obj-1', name: 'The Locket', aliases: [], description: 'A tarnished silver locket.',
      significance: '', notes: '', source: 'user',
    },
    createPrimaryValue: 'The Fedora',
    createPayload: { name: 'The Fedora', aliases: [], description: '', significance: '', notes: '' },
    createdRecord: {
      id: 'obj-2', name: 'The Fedora', aliases: [], description: '', significance: '', notes: '', source: 'user',
    },
    updateFieldLabel: 'Description',
    updateFieldKey: 'description',
    updateFieldValue: 'A weathered gray fedora.',
    updatePayload: { name: 'The Locket', aliases: [], description: 'A weathered gray fedora.', significance: '', notes: '' },
  },
  {
    label: 'PlacesBible',
    Component: PlacesBible,
    itemsPropName: 'places',
    onChangePropName: 'onPlacesChange',
    primaryKey: 'slugline',
    primaryLabel: 'Slugline',
    api: {
      list: listWritersRoomPlaces,
      create: createWritersRoomPlace,
      update: updateWritersRoomPlace,
      remove: deleteWritersRoomPlace,
    },
    existingItem: {
      id: 'place-1', slugline: 'INT. KITCHEN — NIGHT', name: 'The Kitchen',
      description: 'A cozy kitchen with warm light.', palette: '', era: '', weather: '',
      recurringDetails: '', notes: '', source: 'user',
    },
    createPrimaryValue: 'EXT. GARDEN — DAY',
    createPayload: {
      slugline: 'EXT. GARDEN — DAY', name: '', description: '', palette: '', era: '', weather: '',
      recurringDetails: '', notes: '',
    },
    createdRecord: {
      id: 'place-2', slugline: 'EXT. GARDEN — DAY', name: '', description: '', palette: '', era: '',
      weather: '', recurringDetails: '', notes: '', source: 'user',
    },
    updateFieldLabel: 'Description',
    updateFieldKey: 'description',
    updateFieldValue: 'A garden filled with roses.',
    updatePayload: {
      slugline: 'INT. KITCHEN — NIGHT', name: 'The Kitchen', description: 'A garden filled with roses.',
      palette: '', era: '', weather: '', recurringDetails: '', notes: '',
    },
  },
  {
    label: 'CharactersBible',
    Component: CharactersBible,
    itemsPropName: 'characters',
    onChangePropName: 'onCharactersChange',
    primaryKey: 'name',
    primaryLabel: 'Name',
    api: {
      list: listWritersRoomCharacters,
      create: createWritersRoomCharacter,
      update: updateWritersRoomCharacter,
      remove: deleteWritersRoomCharacter,
    },
    existingItem: {
      id: 'char-1', name: 'Ada', aliases: [], role: 'protagonist', physicalDescription: 'Tall, dark hair.',
      personality: '', background: '', notes: '', source: 'user',
    },
    createPrimaryValue: 'Bly',
    createPayload: { name: 'Bly', aliases: [], role: '', physicalDescription: '', personality: '', background: '', notes: '' },
    createdRecord: {
      id: 'char-2', name: 'Bly', aliases: [], role: '', physicalDescription: '', personality: '',
      background: '', notes: '', source: 'user',
    },
    updateFieldLabel: 'Physical description',
    updateFieldKey: 'physicalDescription',
    updateFieldValue: 'Short, silver hair, sharp eyes.',
    updatePayload: {
      name: 'Ada', aliases: [], role: 'protagonist', physicalDescription: 'Short, silver hair, sharp eyes.',
      personality: '', background: '', notes: '',
    },
  },
];

describe.each(SCENARIOS)('$label (BibleSection)', (s) => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
  });

  const displayText = (item) => item[s.primaryKey];

  it('uncontrolled mode: fetches on mount and renders the fetched items', async () => {
    s.api.list.mockResolvedValue([s.existingItem]);

    render(<s.Component workId="work-1" />);

    await screen.findByText(displayText(s.existingItem));
    expect(s.api.list).toHaveBeenCalledWith('work-1');
  });

  it('controlled mode: does not fetch on mount and routes edits through onItemsChange instead of its own fetch', async () => {
    const onChange = vi.fn();
    const updated = { ...s.existingItem, [s.updateFieldKey]: s.updateFieldValue };
    s.api.update.mockResolvedValue(updated);

    const props = { workId: 'work-1', [s.itemsPropName]: [s.existingItem], [s.onChangePropName]: onChange };
    render(<s.Component {...props} />);

    await screen.findByText(displayText(s.existingItem));
    // Give any accidental mount-time fetch a tick to fire before asserting absence.
    await waitFor(() => expect(s.api.list).not.toHaveBeenCalled());

    await userEvent.click(screen.getByRole('button', { name: `Edit ${displayText(s.existingItem)}` }));
    const field = screen.getByLabelText(s.updateFieldLabel);
    await userEvent.clear(field);
    await userEvent.type(field, s.updateFieldValue);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(s.api.update).toHaveBeenCalled());
    await waitFor(() => expect(onChange).toHaveBeenCalledWith([updated]));
    expect(s.api.list).not.toHaveBeenCalled();
  });

  it('create: submits the identity field and appends the returned record to the list', async () => {
    s.api.list.mockResolvedValue([]);
    s.api.create.mockResolvedValue(s.createdRecord);

    render(<s.Component workId="work-1" />);
    await screen.findByText(/no .* yet/i);

    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    const field = screen.getByLabelText(s.primaryLabel);
    await userEvent.type(field, s.createPrimaryValue);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(s.api.create).toHaveBeenCalledWith('work-1', s.createPayload, { silent: true }));
    await screen.findByText(displayText(s.createdRecord));
  });

  it('update: editing a field on an existing item persists via the update API and reflects in the UI', async () => {
    s.api.list.mockResolvedValue([s.existingItem]);
    const updated = { ...s.existingItem, [s.updateFieldKey]: s.updateFieldValue };
    s.api.update.mockResolvedValue(updated);

    render(<s.Component workId="work-1" />);
    await screen.findByText(displayText(s.existingItem));

    await userEvent.click(screen.getByRole('button', { name: `Edit ${displayText(s.existingItem)}` }));
    const field = screen.getByLabelText(s.updateFieldLabel);
    await userEvent.clear(field);
    await userEvent.type(field, s.updateFieldValue);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(s.api.update).toHaveBeenCalledWith('work-1', s.existingItem.id, s.updatePayload, { silent: true }));
    await screen.findByText(s.updateFieldValue);
  });

  it('failed delete: surfaces an error toast and keeps the item in the list', async () => {
    s.api.list.mockResolvedValue([s.existingItem]);
    s.api.remove.mockRejectedValue(new Error('network down'));

    render(<s.Component workId="work-1" />);
    await screen.findByText(displayText(s.existingItem));

    await userEvent.click(screen.getByRole('button', { name: `Edit ${displayText(s.existingItem)}` }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(s.api.remove).toHaveBeenCalledWith('work-1', s.existingItem.id, { silent: true }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Delete failed: network down'));
    // Editor stays open (delete failed) and the record is still rendered once
    // cancelled back out to the row view.
    await userEvent.click(screen.getByRole('button', { name: 'Cancel edit' }));
    expect(screen.getByText(displayText(s.existingItem))).toBeInTheDocument();
  });

  // The row Edit button used to render as a bare 11px pencil icon, which is a
  // ~11px tap target on a phone (#3565). Assert the utility tokens rather than
  // computed geometry — jsdom doesn't apply Tailwind.
  it('a11y: the row Edit button meets the 44px touch-target floor', async () => {
    s.api.list.mockResolvedValue([s.existingItem]);

    render(<s.Component workId="work-1" />);
    await screen.findByText(displayText(s.existingItem));

    const editBtn = screen.getByRole('button', { name: `Edit ${displayText(s.existingItem)}` });
    expect(editBtn.className).toContain('min-h-[44px]');
    expect(editBtn.className).toContain('min-w-[44px]');
  });

  it('a11y: the identity field exposes an accessible name matching its config label', async () => {
    s.api.list.mockResolvedValue([]);
    render(<s.Component workId="work-1" />);
    await screen.findByText(/no .* yet/i);

    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('textbox', { name: s.primaryLabel })).toBeInTheDocument();
  });
});
