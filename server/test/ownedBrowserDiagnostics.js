import { existsSync } from 'node:fs';

// Test-owned lifecycle observations only: never retain browser output or print
// the profile path. A close event does not establish that every helper exited.
export function createOwnedBrowserDiagnostics() {
  const children = [];
  const observe = (owned, event) => {
    if (owned.events.length < 16) owned.events.push(`${event}@${Math.round(performance.now() - owned.started)}ms`);
    else owned.truncated = true;
  };
  return {
    children,
    track(child, args) {
      const arg = args?.find(value => value.startsWith('--user-data-dir=') && value.includes('portos-composition-browser-'));
      if (!arg) return;
      const owned = { profile: arg.slice('--user-data-dir='.length), exited: false, closed: false,
        removal: 'not-started', presentAfterRemoval: 'unknown', events: [], started: performance.now(), truncated: false };
      children.push(owned);
      child.once('exit', () => { owned.exited = true; observe(owned, 'exit'); });
      child.once('close', () => { owned.closed = true; observe(owned, 'close'); });
    },
    async remove(remove, path, ...args) {
      const owned = children.find(item => item.profile === path);
      if (!owned) return remove(path, ...args);
      owned.removal = 'pending';
      observe(owned, 'remove-start');
      try {
        const result = await remove(path, ...args);
        owned.removal = 'resolved';
        owned.presentAfterRemoval = existsSync(path);
        observe(owned, 'remove-resolved');
        return result;
      } catch (error) {
        const code = ['ENOTEMPTY', 'EBUSY', 'EPERM', 'EMFILE', 'EACCES', 'ENOENT'].includes(error?.code) ? error.code : 'other';
        owned.removal = `rejected:${code}`;
        owned.presentAfterRemoval = existsSync(path);
        observe(owned, 'remove-rejected');
        throw error;
      }
    },
    describe(owned) {
      return `owned lifecycle: exit=${owned.exited} close=${owned.closed} removal=${owned.removal}`
        + ` presentAfterRemoval=${owned.presentAfterRemoval} presentNow=${existsSync(owned.profile)}`
        + ` events=${owned.events.join(',')} truncated=${owned.truncated}`;
    },
  };
}
