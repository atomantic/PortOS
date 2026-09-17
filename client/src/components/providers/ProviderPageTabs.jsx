import RouteTabsHeader from '../ui/RouteTabsHeader';

/**
 * The AI Providers page's three views (#7567, epic #7561), each its own URL so
 * a card is linkable and reachable from ⌘K and voice:
 *
 *   - **Presets** — the stored records the `{ providerId, model, effort }`
 *     pickers name, grouped by harness, plus the compatibility matrix.
 *   - **Harnesses** — the programs that drive a model and whether each is
 *     switched on, plus the credential-bootstrap apps a composite can spawn through.
 *   - **Services** — instances of a service definition: plan, credential, catalog.
 *
 * Exported so the page test can enumerate the views without a second list.
 */
export const PROVIDER_PAGE_TABS = Object.freeze([
  { id: 'presets', label: 'Presets', to: '/ai/presets' },
  { id: 'harnesses', label: 'Harnesses', to: '/ai/harnesses' },
  { id: 'services', label: 'Services', to: '/ai/services' },
]);

/** Which view a pathname under `/ai` opens. The index and every overlay off it are presets. */
export const providerPageTabForPath = (pathname) => {
  const bare = String(pathname || '').replace(/\/+$/, '');
  if (/^\/ai\/harnesses(\/|$)/.test(bare)) return 'harnesses';
  if (/^\/ai\/services(\/|$)/.test(bare)) return 'services';
  return 'presets';
};

export default function ProviderPageTabs({ activeTab }) {
  return <RouteTabsHeader tabs={PROVIDER_PAGE_TABS} activeTab={activeTab} ariaLabel="AI provider views" />;
}
