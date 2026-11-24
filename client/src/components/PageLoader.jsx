import BrailleSpinner from './BrailleSpinner';

// Fallback for lazy routes. Shared by App's outer boundary (chromeless routes)
// and PageShell's inner one, so an authenticated route suspends inside <main>
// while the sidebar and command palette stay usable.
export default function PageLoader() {
  return (
    <div className="flex items-center justify-center h-64">
      <BrailleSpinner text="Loading" />
    </div>
  );
}
