import { render, screen, fireEvent } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { CodeReviewDefaultsProvider, useCodeReviewDefaults } from './useCodeReviewDefaults';
import { reviewerModelsFromDefaults, reviewerEffortsFromDefaults } from '../lib/reviewerModels';
import ReviewerPicker from '../components/cos/ReviewerPicker';
import * as api from '../services/api';

vi.mock('../services/api', () => ({ getCodeReviewDefaults: vi.fn() }));

it('renders inherited provider pins and emits only the edited field, including an explicit clear', async () => {
  api.getCodeReviewDefaults.mockResolvedValue({
    reviewers: ['provider:example-api'], providerModels: { 'provider:example-api': 'custom-coder' },
    providerEfforts: { 'provider:example-api': 'high' },
    providerReviewUnsupported: { 'provider:example-api': 'REVIEWER_UNSUPPORTED' },
  });
  const onChange = vi.fn();
  function Editor() {
    const defaults = useCodeReviewDefaults();
    const value = { ...defaults, reviewerModels: reviewerModelsFromDefaults(defaults), reviewerEfforts: reviewerEffortsFromDefaults(defaults) };
    return <ReviewerPicker {...value} defaults={value} onChange={onChange} />;
  }
  render(<CodeReviewDefaultsProvider><Editor /></CodeReviewDefaultsProvider>);
  expect(await screen.findByLabelText('Model for example-api')).toHaveValue('custom-coder');
  expect(screen.getByLabelText('Reasoning effort for example-api')).toHaveValue('high');
  expect(screen.getByText(/Set its command or switch it to API mode/)).toBeInTheDocument();
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText('Make example-api non-blocking'));
  expect(onChange.mock.lastCall[0]).toEqual({ optionalReviewers: ['provider:example-api'] });
  fireEvent.change(screen.getByLabelText('Model for example-api'), { target: { value: '' } });
  expect(onChange.mock.lastCall[0]).toEqual({ reviewerModels: {} });
});
