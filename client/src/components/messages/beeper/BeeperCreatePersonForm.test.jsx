import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import BeeperCreatePersonForm from './BeeperCreatePersonForm';

/**
 * The confirm-and-rename form "Create new…" opens instead of posting
 * immediately (fork issue #97 part A). Wiring from `BeeperThread` into this
 * component is covered in `BeeperThread.test.jsx`; these pin the form's own
 * contract in isolation.
 */

const PARTICIPANT = { sourceUserId: 'user-1', displayName: 'Sam Example', handle: '+15550100' };

const renderForm = (overrides = {}) => {
  const props = {
    participant: PARTICIPANT,
    onCreate: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  const utils = render(<BeeperCreatePersonForm {...props} />);
  return { ...utils, props };
};

afterEach(cleanup);

describe('BeeperCreatePersonForm — prefill and fields', () => {
  it('prefills the name from the participant\'s display name, editable', () => {
    renderForm();
    const nameInput = screen.getByLabelText('Name');
    expect(nameInput).toHaveValue('Sam Example');

    fireEvent.change(nameInput, { target: { value: 'Corrected Name' } });
    expect(nameInput).toHaveValue('Corrected Name');
  });

  it('falls back to the handle when there is no display name', () => {
    renderForm({ participant: { sourceUserId: 'user-2', displayName: '', handle: '@example_handle' } });
    expect(screen.getByLabelText('Name')).toHaveValue('@example_handle');
  });

  it('defaults the ring to tribe and offers every RINGS option', () => {
    renderForm();
    const ringSelect = screen.getByLabelText('Ring');
    expect(ringSelect).toHaveValue('tribe');
    expect(screen.getByRole('option', { name: 'Support' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Core' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Tribe' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Village' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'External' })).toBeInTheDocument();
  });

  it('starts with an empty, optional relationship field', () => {
    renderForm();
    expect(screen.getByLabelText('Relationship')).toHaveValue('');
  });
});

describe('BeeperCreatePersonForm — Create', () => {
  it('is disabled while the name is blank', () => {
    renderForm({ participant: { sourceUserId: 'user-3', displayName: '', handle: '' } });
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  it('calls onCreate with the trimmed name, ring and relationship, and only on Create', () => {
    const onCreate = vi.fn();
    renderForm({ onCreate });

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Corrected Name  ' } });
    fireEvent.change(screen.getByLabelText('Ring'), { target: { value: 'core' } });
    fireEvent.change(screen.getByLabelText('Relationship'), { target: { value: '  Neighbor  ' } });
    expect(onCreate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(onCreate).toHaveBeenCalledWith({ name: 'Corrected Name', ring: 'core', relationship: 'Neighbor' });
  });

  it('is disabled while a link is in flight, and never calls onCreate from a click', () => {
    const onCreate = vi.fn();
    renderForm({ onCreate, disabled: true });

    const createButton = screen.getByRole('button', { name: 'Create' });
    expect(createButton).toBeDisabled();
    fireEvent.click(createButton);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('submits on Enter from the name field', () => {
    const onCreate = vi.fn();
    renderForm({ onCreate });

    fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Enter' });

    expect(onCreate).toHaveBeenCalledWith({ name: 'Sam Example', ring: 'tribe', relationship: '' });
  });

  it('does not submit on Enter while the name is blank', () => {
    const onCreate = vi.fn();
    renderForm({ onCreate, participant: { sourceUserId: 'user-4', displayName: '', handle: '' } });

    fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Enter' });

    expect(onCreate).not.toHaveBeenCalled();
  });
});

describe('BeeperCreatePersonForm — Cancel', () => {
  it('calls onCancel on click', () => {
    const onCancel = vi.fn();
    renderForm({ onCancel });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onCancel).toHaveBeenCalled();
  });

  it('calls onCancel on Escape from any field', () => {
    const onCancel = vi.fn();
    renderForm({ onCancel });

    fireEvent.keyDown(screen.getByLabelText('Relationship'), { key: 'Escape' });

    expect(onCancel).toHaveBeenCalled();
  });
});
