import { Suspense, useState } from 'react';
import { useCmdKSearch } from '../hooks/useCmdKSearch';
import { lazyWithReload } from '../utils/lazyWithReload';

// Keep CmdKSearch (700+ lines, catalog/dashboard/palette APIs, highlight/search
// helpers) out of the cold-load bundle until the user first invokes ⌘K / Ctrl+K
// or clicks the search trigger. `entryClosure.test.js` guards this boundary.
const LazyCmdKSearch = lazyWithReload(() => import('./CmdKSearch'));

export default function CmdKSearchGate() {
  const { open, setOpen } = useCmdKSearch();
  const [everOpened, setEverOpened] = useState(false);

  if (open && !everOpened) {
    setEverOpened(true);
  }

  if (!everOpened) return null;

  return (
    <Suspense fallback={null}>
      <LazyCmdKSearch open={open} setOpen={setOpen} />
    </Suspense>
  );
}
