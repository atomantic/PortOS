import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ImageVerificationDetails from './ImageVerificationDetails';
import * as api from '../../services/apiImageVerifier';

vi.mock('../../services/apiImageVerifier', () => ({
  verifyImageNow: vi.fn(),
  overrideVerification: vi.fn(),
}));

describe('ImageVerificationDetails', () => {
  it('renders unverified state and triggers verification', async () => {
    const item = { filename: 'test-image.png', prompt: 'a beautiful bird' };
    const onVerificationChange = vi.fn();
    api.verifyImageNow.mockResolvedValueOnce({
      verdict: 'pass',
      summary: 'Clean anatomy, 5 digits detected',
      defects: [],
      hands: [{ location: 'Left hand', visibleDigits: 5, status: 'pass' }],
    });

    render(
      <ImageVerificationDetails
        item={item}
        onVerificationChange={onVerificationChange}
      />
    );

    expect(screen.getByText('Quality & Anatomy Verification')).toBeTruthy();
    const verifyBtn = screen.getByRole('button', { name: /Verify Image/i });
    expect(verifyBtn).toBeTruthy();

    fireEvent.click(verifyBtn);
    await waitFor(() => {
      expect(api.verifyImageNow).toHaveBeenCalledWith({
        filename: 'test-image.png',
        profileId: 'strict_anatomy',
        prompt: 'a beautiful bird',
      });
      expect(onVerificationChange).toHaveBeenCalled();
    });
  });

  it('renders verified state with defects and supports operator override', async () => {
    const item = {
      filename: 'defective.png',
      prompt: 'person with hands',
      verification: {
        verdict: 'fail',
        summary: 'Extra fingers detected on left hand',
        defects: [
          { dimension: 'hands_and_fingers', claim: '6 fingers visible', region: 'Left hand' },
        ],
        hands: [{ location: 'Left hand', visibleDigits: 6, status: 'fail' }],
      },
    };
    const onVerificationChange = vi.fn();
    api.overrideVerification.mockResolvedValueOnce({
      ...item.verification,
      verdict: 'pass',
      overridden: true,
    });

    render(
      <ImageVerificationDetails
        item={item}
        onVerificationChange={onVerificationChange}
      />
    );

    expect(screen.getByText('Defect Flagged')).toBeTruthy();
    expect(screen.getByText(/Extra fingers detected on left hand/i)).toBeTruthy();
    expect(screen.getByText(/6 fingers visible/i)).toBeTruthy();
    expect(screen.getByText(/6 digits · ⚠/i)).toBeTruthy();

    const overrideBtn = screen.getByRole('button', { name: /Force Pass \(False Alarm\)/i });
    expect(overrideBtn).toBeTruthy();

    fireEvent.click(overrideBtn);
    await waitFor(() => {
      expect(api.overrideVerification).toHaveBeenCalledWith({
        filename: 'defective.png',
        verdict: 'pass',
        notes: 'Operator verified clean / false positive override',
      });
      expect(onVerificationChange).toHaveBeenCalled();
    });
  });
});
