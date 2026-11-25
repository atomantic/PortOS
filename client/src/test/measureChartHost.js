import { vi } from 'vitest';

export function measureChartHost() {
  const measure = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    return this.classList.contains('recharts-responsive-container')
      ? new DOMRect(0, 0, 640, 320)
      : measure.call(this);
  });
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });

  return () => {
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockRestore();
    vi.unstubAllGlobals();
  };
}
