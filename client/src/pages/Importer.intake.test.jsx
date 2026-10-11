import { useState } from 'react';
import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { IntakeForm } from './Importer';

afterEach(cleanup);

function Intake({ onAnalyze, analyzing = false }) {
  const [intake, setIntake] = useState({
    universeName: '', seriesName: '', source: '', contentType: 'novel', targetIssueCount: '',
  });
  return <IntakeForm
    intake={intake} setIntake={setIntake}
    universeItems={[]} seriesItems={[]}
    sourceCharLimit={20} analyzing={analyzing}
    onAnalyze={onAnalyze} onClassify={vi.fn()}
    providers={[]} llmProvider="" llmModel="" llmModels={[]}
    onProviderChange={vi.fn()} onModelChange={vi.fn()}
  />;
}

// Catches accidental paid calls from Enter and lost validity/busy gates when
// Analyze moves outside the scrolling intake fields.
it('requires valid intake and explicit Analyze activation, and gates busy analysis', async () => {
  const user = userEvent.setup();
  const onAnalyze = vi.fn();
  const { rerender } = render(<Intake onAnalyze={onAnalyze} />);
  const analyze = screen.getByRole('button', { name: 'Analyze', exact: true });
  expect(analyze.disabled).toBe(true);
  await user.type(screen.getByLabelText('Universe Name'), 'Test universe');
  await user.type(screen.getByLabelText('Series Name'), 'Test series');
  expect(analyze.disabled).toBe(true);
  await user.type(screen.getByLabelText('Source Text'), 'Test source');
  expect(analyze.disabled).toBe(false);
  await user.click(screen.getByLabelText('Series Name'));
  await user.keyboard('{Enter}');
  fireEvent.submit(analyze.closest('form'));
  expect(onAnalyze).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Source Text'), { target: { value: 'x'.repeat(21) } });
  expect(analyze.disabled).toBe(true);
  expect(screen.getByText(/Source exceeds/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Source Text'), { target: { value: 'Valid source' } });
  await user.click(analyze);
  expect(onAnalyze).toHaveBeenCalledTimes(1);
  rerender(<Intake onAnalyze={onAnalyze} analyzing />);
  const busy = screen.getByRole('button', { name: 'Analyzing…' });
  expect(busy.disabled).toBe(true);
  await user.click(busy);
  expect(onAnalyze).toHaveBeenCalledTimes(1);
});
