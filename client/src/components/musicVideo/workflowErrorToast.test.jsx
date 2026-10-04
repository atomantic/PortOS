import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import toast from '../ui/Toast';
import { toastWorkflowError } from './workflowErrorToast.jsx';
import { ATTENTION_ANCHOR_ID } from '../../lib/musicVideoAttention.js';

vi.mock('../ui/Toast', () => ({ default: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn(), dismiss: vi.fn() }) }));

beforeEach(() => vi.clearAllMocks());

it('toasts an ordinary failure as plain text and reloads nothing', () => {
  const reload = vi.fn();
  toastWorkflowError(new Error('Provider refused'), 'Production request failed', { reload });
  expect(toast.error).toHaveBeenCalledWith('Provider refused');
  expect(reload).not.toHaveBeenCalled();
});

it('falls back to the caller\'s message when the error carries none', () => {
  toastWorkflowError({}, 'Production request failed');
  expect(toast.error).toHaveBeenCalledWith('Production request failed');
});

it('links a refusal for an open revision to the Needs attention banner (#9940)', () => {
  document.body.innerHTML = `<section id="${ATTENTION_ANCHOR_ID}"><button type="button">Resume</button></section>`;
  document.getElementById(ATTENTION_ANCHOR_ID).scrollIntoView = vi.fn();
  const reload = vi.fn(() => Promise.resolve());
  const err = Object.assign(new Error('Finish or cancel the open revision before starting production'), {
    code: 'REVISION_IN_PROGRESS', context: { revisionId: 'mvrev-example' },
  });
  toastWorkflowError(err, 'Production request failed', { reload });

  // The local record is refreshed so the banner can show a revision this tab never saw…
  expect(reload).toHaveBeenCalledTimes(1);
  const [content, options] = toast.error.mock.calls[0];
  expect(options.label).toMatch(/revision/i);
  // …and the toast carries a link that lands on its Resume/Cancel.
  render(content({ id: 'toast-1' }));
  expect(screen.getByText(/Finish or cancel the open revision/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Show revision' }));
  expect(document.getElementById(ATTENTION_ANCHOR_ID).scrollIntoView).toHaveBeenCalled();
  expect(document.activeElement).toBe(document.querySelector(`#${ATTENTION_ANCHOR_ID} button`));
  expect(toast.dismiss).toHaveBeenCalledWith('toast-1');
});

it('survives a failed reload and a banner that is not on screen', () => {
  document.body.innerHTML = '';
  const err = Object.assign(new Error('Open revision'), { code: 'REVISION_IN_PROGRESS' });
  expect(() => toastWorkflowError(err, 'x', { reload: () => Promise.reject(new Error('offline')) })).not.toThrow();
  render(toast.error.mock.calls[0][0]({ id: 'toast-2' }));
  expect(() => fireEvent.click(screen.getByRole('button', { name: 'Show revision' }))).not.toThrow();
});
