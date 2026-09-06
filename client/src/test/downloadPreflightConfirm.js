import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { expect } from 'vitest';

// DownloadPreflightConfirm renders its confirm button the instant the modal
// opens — disabled, mid-`loading` — and only enables it once the preview()
// promise settles the size/destination assessment (#6266). `findByRole`
// matches a disabled button too, so `fireEvent.click(await
// screen.findByRole('button', { name: 'Start download' }))` can land on the
// still-disabled button under CPU contention and silently no-op. Wait for
// enabled, not just present, before clicking — then settle with
// `act(async () => {})`, because waiting the extra tick for "enabled" is
// itself enough to leave the confirm handler's own promise chain (e.g. the
// status reload a successful install kicks off) unflushed past whatever the
// caller asserts next.
export async function clickStartDownload(name = 'Start download') {
  const button = await waitFor(() => {
    const el = screen.getByRole('button', { name });
    expect(el).toBeEnabled();
    return el;
  });
  fireEvent.click(button);
  await act(async () => {});
  return button;
}
