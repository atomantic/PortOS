import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Mock the socket module so we can capture emit() and drive on() handlers.
const handlers = new Map();
const emitted = [];
vi.mock('../services/socket.js', () => ({
  default: {
    emit: (event, payload) => emitted.push({ event, payload }),
    on: (event, fn) => { handlers.set(event, fn); },
    off: (event, fn) => { if (handlers.get(event) === fn) handlers.delete(event); },
  },
}));

import { useVoiceUiSync } from './useVoiceUiSync.js';

const Harness = ({ enabled }) => {
  useVoiceUiSync(enabled);
  return null;
};

const renderHook = (enabled) => render(
  <MemoryRouter initialEntries={['/tasks']}>
    <Harness enabled={enabled} />
  </MemoryRouter>,
);

describe('useVoiceUiSync — lazy text protocol', () => {
  beforeEach(() => {
    handlers.clear();
    emitted.length = 0;
    document.body.innerHTML = '<main><h1>Tasks</h1><p>Hello page text.</p><button>Add</button></main>';
    // jsdom geometry stubs so buildIndex() / extractVisibleText() see elements.
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
      configurable: true,
      get() { return this.parentNode; },
    });
    HTMLElement.prototype.getBoundingClientRect = function () {
      return { width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0 };
    };
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('subscribes to voice:ui:read-request when enabled', () => {
    renderHook(true);
    expect(handlers.has('voice:ui:read-request')).toBe(true);
  });

  it('does not subscribe when disabled', () => {
    renderHook(false);
    expect(handlers.has('voice:ui:read-request')).toBe(false);
  });

  it('replies to voice:ui:read-request with voice:ui:read-response carrying text + requestId', () => {
    renderHook(true);
    const onReadRequest = handlers.get('voice:ui:read-request');
    expect(typeof onReadRequest).toBe('function');

    emitted.length = 0; // ignore any scheduled index emits
    onReadRequest({ requestId: 'uitext_1' });

    const resp = emitted.find((e) => e.event === 'voice:ui:read-response');
    expect(resp).toBeTruthy();
    expect(resp.payload.requestId).toBe('uitext_1');
    expect(resp.payload.text).toMatch(/Hello page text/);
  });

  it('emits a lazy index (no text, textOnDemand:true) on the initial flush', () => {
    vi.useFakeTimers();
    renderHook(true);
    // INITIAL_DELAY_MS schedule fires the first index push.
    vi.advanceTimersByTime(300);
    const idx = emitted.find((e) => e.event === 'voice:ui:index');
    expect(idx).toBeTruthy();
    expect(idx.payload.text).toBeUndefined();
    expect(idx.payload.textOnDemand).toBe(true);
  });

  it('unsubscribes the read-request handler on cleanup', () => {
    const view = renderHook(true);
    expect(handlers.has('voice:ui:read-request')).toBe(true);
    view.unmount();
    expect(handlers.has('voice:ui:read-request')).toBe(false);
  });
});
