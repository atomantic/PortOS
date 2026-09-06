import { expect, it } from 'vitest';
import { isPublicGuestRoute } from './publicGuestRoutes';
it('skips private bootstrap only for the two standalone audience routes', () => {
  expect(isPublicGuestRoute('/eidoverse/guest')).toBe(true);
  expect(isPublicGuestRoute('/Eidoverse/Guest/')).toBe(true);
  expect(isPublicGuestRoute('/fableloom/join')).toBe(true);
  expect(isPublicGuestRoute('/eidoverse')).toBe(false);
  expect(isPublicGuestRoute('/eidoverse/guest/owner')).toBe(false);
});
