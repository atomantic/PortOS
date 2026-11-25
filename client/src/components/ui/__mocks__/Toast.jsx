import { vi } from 'vitest';

export const toast = Object.assign(vi.fn(), {
  success: vi.fn(),
  error: vi.fn(),
  loading: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  dismiss: vi.fn(),
});

export function Toaster() {
  return null;
}

export const COLLAPSE_AFTER_MS = 8000;
export default toast;
