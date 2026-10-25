import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import A2vLoraStageControls from './A2vLoraStageControls';

it('offers an explicit motion-friendly preset, discloses effective strengths and keeps reset available on an incompatible model', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const { rerender } = render(<A2vLoraStageControls value={[0, 1]} onChange={onChange} supported loras={[{ filename: 'example.safetensors', scale: 0.8 }]} />);
  expect(screen.getByText(/motion 0.00, detail 0.80/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /Motion-friendly/ }));
  expect(onChange).toHaveBeenLastCalledWith([0, 1]);
  rerender(<A2vLoraStageControls value={[0, 1]} onChange={onChange} supported={false} />);
  expect(screen.getByRole('status')).toHaveTextContent(/Reset to defaults/);
  expect(screen.getByLabelText('Motion: 0%')).toBeDisabled();
  await user.click(screen.getByRole('button', { name: /Default/ }));
  expect(onChange).toHaveBeenLastCalledWith([1, 1]);
});
