import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { Cpu, Cloud } from 'lucide-react';
import BackendChipStrip from './BackendChipStrip';

const availableBackends = [
  { id: 'local', label: 'Local', icon: Cpu },
  { id: 'cloud', label: 'Cloud', icon: Cloud },
];

function Picker({ disabled = false }) {
  const [value, setValue] = useState('local');
  return <BackendChipStrip availableBackends={availableBackends} value={value} onChange={setValue} disabled={disabled} />;
}

it('exposes the current choice through keyboard selection and preserves it while disabled', async () => {
  const user = userEvent.setup();
  const view = render(<Picker />);
  expect(screen.getByRole('button', { name: 'Local', pressed: true })).toBeInTheDocument();
  const cloud = screen.getByRole('button', { name: 'Cloud', pressed: false });
  cloud.focus();
  await user.keyboard('{Enter}');
  expect(screen.getByRole('button', { name: 'Cloud', pressed: true })).toHaveFocus();
  expect(screen.getByRole('button', { name: 'Local', pressed: false })).toBeInTheDocument();

  view.rerender(<Picker disabled />);
  const local = screen.getByRole('button', { name: 'Local', pressed: false });
  expect(local).toBeDisabled();
  await user.click(local);
  expect(screen.getByRole('button', { name: 'Cloud', pressed: true })).toBeDisabled();
});
