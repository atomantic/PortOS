import { act, fireEvent, screen } from '@testing-library/react';
import { awaitEnabled } from './enabledBarrier.js';

// DownloadPreflightConfirm renders its confirm button the instant the modal
// opens — disabled, mid-`loading` — and only enables it once the preview()
// promise settles the size/destination assessment (#6266). See
// enabledBarrier.js for why this waits for enabled rather than just present.
// Settle with `act(async () => {})` afterward, because waiting the extra tick
// for "enabled" is itself enough to leave the confirm handler's own promise
// chain (e.g. the status reload a successful install kicks off) unflushed
// past whatever the caller asserts next.
export async function clickStartDownload(name = 'Start download') {
  const button = await awaitEnabled(() => screen.getByRole('button', { name }));
  fireEvent.click(button);
  await act(async () => {});
  return button;
}
