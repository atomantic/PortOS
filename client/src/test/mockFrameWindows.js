import { vi } from 'vitest';

// Protocol tests supply messages themselves. Keep one inert window identity per
// iframe without enabling Happy DOM's remote page loading; restore spies at teardown.
export function mockFrameWindows() {
  const windows = new WeakMap();
  vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockImplementation(function () {
    if (!windows.has(this)) windows.set(this, { postMessage: vi.fn() });
    return windows.get(this);
  });
}
