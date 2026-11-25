import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../../services/apiDigitalTwin.js', () => ({
  getDigitalTwinPersonas: vi.fn(),
  getActiveDigitalTwinPersona: vi.fn(),
  setActiveDigitalTwinPersona: vi.fn(),
}));
vi.mock('../../ui/Toast');

import PersonasTab from './PersonasTab';
import {
  getDigitalTwinPersonas,
  getActiveDigitalTwinPersona,
  setActiveDigitalTwinPersona,
} from '../../../services/apiDigitalTwin.js';

const PERSONA = { id: 'persona-1', name: 'Example Persona', instructions: 'Be brief.' };

beforeEach(() => {
  vi.clearAllMocks();
  getDigitalTwinPersonas.mockResolvedValue([PERSONA]);
  getActiveDigitalTwinPersona.mockResolvedValue({ id: PERSONA.id });
  setActiveDigitalTwinPersona.mockResolvedValue({});
});

describe('PersonasTab failed reads stay distinct from empty ones (#12783)', () => {
  it('shows a retryable error, not "No personas yet", when the persona list fails', async () => {
    const user = userEvent.setup();
    getDigitalTwinPersonas.mockRejectedValueOnce(new Error('personas offline'));
    render(<PersonasTab />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load personas — personas offline');
    expect(screen.queryByText(/No personas yet/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New Persona/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Example Persona')).toBeInTheDocument();
  });

  it('does not treat a failed active-pointer read as "nothing is active"', async () => {
    const user = userEvent.setup();
    getActiveDigitalTwinPersona.mockRejectedValueOnce(new Error('pointer offline'));
    render(<PersonasTab />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the active persona');
    // The toggle would otherwise read activeId=null and "activate" the already-active persona.
    expect(screen.queryByText('Example Persona')).not.toBeInTheDocument();
    expect(setActiveDigitalTwinPersona).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Example Persona')).toBeInTheDocument();
  });

  it('keeps the empty copy for a genuinely empty list', async () => {
    getDigitalTwinPersonas.mockResolvedValue([]);
    getActiveDigitalTwinPersona.mockResolvedValue(null);
    render(<PersonasTab />);

    expect(await screen.findByText(/No personas yet/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
