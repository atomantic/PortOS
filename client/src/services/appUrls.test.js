import { describe, it, expect } from 'vitest';
import { getLaunchUrls, getPrimaryLaunchUrl } from './appUrls';

// The "Open UI" affordance in AppDetailView renders a button per non-null launch
// URL and hides entirely when there are none. A portless desktop app (a game
// window, #2991) must therefore surface NO launch URL — never a link to
// `undefined` — while a port-bearing app still does.
describe('getLaunchUrls — portless vs port-bearing (#2991)', () => {
  it('returns all-null for a portless desktop app', () => {
    const urls = getLaunchUrls({ id: 'the-game', type: 'desktop', uiPort: null, apiPort: null, devUiPort: null, tlsPort: null });
    expect(urls).toEqual({ https: null, http: null, dev: null });
    // The single-click launcher likewise has nothing to open.
    expect(getPrimaryLaunchUrl({ id: 'the-game', type: 'desktop' })).toBeNull();
  });

  it('returns an http launch URL when the app has a uiPort', () => {
    const urls = getLaunchUrls({ id: 'web-app', type: 'express', uiPort: 3000 });
    expect(urls.http).toBe(`http://${window.location.hostname}:3000`);
    expect(getPrimaryLaunchUrl({ id: 'web-app', type: 'express', uiPort: 3000 }))
      .toBe(`http://${window.location.hostname}:3000`);
  });

  it('prefers https when a tlsPort is present', () => {
    const urls = getLaunchUrls({ id: 'web-app', type: 'express', uiPort: 3000, tlsPort: 8443 });
    expect(urls.https).toBe(`https://${window.location.hostname}:8443`);
    expect(getPrimaryLaunchUrl({ id: 'web-app', type: 'express', uiPort: 3000, tlsPort: 8443 }))
      .toBe(`https://${window.location.hostname}:8443`);
  });
});
