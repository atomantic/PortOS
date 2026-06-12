/**
 * Minimal EventSource stand-in for jsdom (which has none). Tests drive
 * onmessage / onerror by hand:
 *
 *   beforeEach(() => { MockEventSource.reset(); global.EventSource = MockEventSource; });
 *   afterEach(() => { delete global.EventSource; });
 *
 * `emit(payload)` delivers a JSON frame, `emitRaw(data)` delivers the string
 * as-is, and `fail()` simulates a terminal connection failure (non-2xx /
 * non-event-stream response: the browser sets readyState CLOSED and will NOT
 * auto-retry). Pass `fail(MockEventSource.CONNECTING)` for a transient blip
 * the browser's built-in reconnect would recover from.
 */
export class MockEventSource {
  constructor(url) {
    this.url = url;
    this.onmessage = null;
    this.onerror = null;
    this.onopen = null;
    this.closed = false;
    this.readyState = MockEventSource.OPEN;
    MockEventSource.instances.push(this);
  }

  close() { this.closed = true; this.readyState = MockEventSource.CLOSED; }

  emit(payload) { this.onmessage?.({ data: JSON.stringify(payload) }); }

  emitRaw(data) { this.onmessage?.({ data }); }

  fail(readyState = MockEventSource.CLOSED) { this.readyState = readyState; this.onerror?.(); }

  static reset() { MockEventSource.instances = []; }
}
MockEventSource.CONNECTING = 0;
MockEventSource.OPEN = 1;
MockEventSource.CLOSED = 2;
MockEventSource.instances = [];

export const lastEventSource = () =>
  MockEventSource.instances[MockEventSource.instances.length - 1];
