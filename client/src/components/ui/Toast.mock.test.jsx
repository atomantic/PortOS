import { expect, it, vi } from 'vitest';
import mockToast, * as mocked from './Toast';

vi.mock('./Toast');

it('resolves the shared mock with the same Toast API as the real module', async () => {
  const actual = await vi.importActual('./Toast');
  const mockFunctionKeys = Object.keys(vi.fn());
  const toastKeys = Object.keys(mockToast).filter(key => !mockFunctionKeys.includes(key));

  expect(Object.keys(mocked).sort()).toEqual(Object.keys(actual).sort());
  expect(toastKeys.sort()).toEqual(Object.keys(actual.toast).sort());
  expect(mockToast).toBe(mocked.toast);
  expect(vi.isMockFunction(mockToast)).toBe(true);
  expect(mocked.Toaster()).toBeNull();
  expect(mocked.COLLAPSE_AFTER_MS).toBe(actual.COLLAPSE_AFTER_MS);
});
