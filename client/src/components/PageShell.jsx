import { Outlet } from 'react-router';
import { Suspense } from 'react';
import PageLoader from './PageLoader';
import PageErrorBoundary from './PageErrorBoundary';

// The two `<main>` shells a page can render inside, chosen by where its <Route>
// sits in App.jsx (a pathless layout route), never by matching the pathname.
//
// Full-width: the page owns its scroll — normally `PageLayout`, a flush
// `PageHeader` bar over a `flex-1 overflow-auto` body — so main adds no gutter
// and no second scroller. Padded: document/form pages (`/apps/create`) that rely
// on main's own padding and scrolling.
const MAIN_BASE_CLASS = 'focus:outline-none flex-1 min-h-0 print:overflow-visible print:min-h-0';
export const FULL_WIDTH_MAIN_CLASS = 'relative overflow-clip-safe';
export const PADDED_MAIN_CLASS = 'overflow-auto p-4 md:p-6';

function MainShell({ shell, className }) {
  return (
    <main id="main-content" tabIndex={-1} data-shell={shell} className={`${MAIN_BASE_CLASS} ${className}`}>
      <PageErrorBoundary>
        <Suspense fallback={<PageLoader />}>
          <Outlet />
        </Suspense>
      </PageErrorBoundary>
    </main>
  );
}

export function FullWidthMain() {
  return <MainShell shell="full" className={FULL_WIDTH_MAIN_CLASS} />;
}

export function PaddedMain() {
  return <MainShell shell="padded" className={PADDED_MAIN_CLASS} />;
}
