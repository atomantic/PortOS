import { Suspense, useState } from 'react';
import { useKeyboardHelp } from '../hooks/useKeyboardHelp';
import { lazyWithReload } from '../utils/lazyWithReload';

// Keep KeyboardHelp (Modal + shortcut reference table) out of the cold-load
// bundle until the user first presses `?`. `entryClosure.test.js` guards this.
const LazyKeyboardHelp = lazyWithReload(() => import('./KeyboardHelp'));

export default function KeyboardHelpGate() {
  const { open, setOpen } = useKeyboardHelp();
  const [everOpened, setEverOpened] = useState(false);

  if (open && !everOpened) {
    setEverOpened(true);
  }

  if (!everOpened) return null;

  return (
    <Suspense fallback={null}>
      <LazyKeyboardHelp open={open} setOpen={setOpen} />
    </Suspense>
  );
}
