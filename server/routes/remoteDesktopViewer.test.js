import { runInNewContext } from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const broker = vi.hoisted(() => ({ hasSession: vi.fn() }));
vi.mock('../services/remoteDesktop.js', () => ({ remoteDesktopBroker: broker }));

const { default: viewerRoutes } = await import('./remoteDesktopViewer.js');

const app = express();
app.use('/remote-desktop', viewerRoutes);
app.use(errorMiddleware);

const TOKEN = 'a'.repeat(43);

/**
 * Create a minimal DOM element stub capable of exercising the viewer module script.
 * @param {object} [options] - Initial properties (`hidden`, `inert`, `dataset`, `attributes`).
 * @returns {object} Element stub with event dispatching, classList, focus/select tracking.
 */
function createStubElement({ hidden = false, inert = false, dataset = {}, attributes = {}, doc = null } = {}) {
  const listeners = new Map();
  const classes = new Set();
  const attrMap = new Map(Object.entries(attributes));
  const children = [];
  const el = {
    hidden,
    inert,
    value: '',
    textContent: '',
    selected: false,
    dataset,
    classList: {
      toggle(name, force) {
        const next = force === undefined ? !classes.has(name) : Boolean(force);
        if (next) classes.add(name);
        else classes.delete(name);
        return next;
      },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    setAttribute(name, value) { attrMap.set(name, String(value)); },
    getAttribute(name) { return attrMap.get(name) ?? null; },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatchEvent(event) {
      for (const fn of listeners.get(event.type) ?? []) fn(event);
    },
    focus() {
      if (doc) doc.activeElement = el;
    },
    select() {
      el.focus();
      el.selected = true;
    },
    closest() { return null; },
    contains(other) { return other === el || children.includes(other); },
    appendChild(child) { children.push(child); return child; },
    querySelectorAll() { return children; },
  };
  return el;
}

/**
 * Execute the viewer HTML inline module script against a stub DOM and mock RFB constructor.
 * @param {string} html - Rendered viewer HTML response.
 * @returns {object} Stub elements, document, RFB instances, and event helpers.
 */
function mountViewerScript(html) {
  const match = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  if (!match) throw new Error('Expected module script in viewer HTML');
  const scriptBody = match[1].replace(/^\s*import RFB from ['"][^'"]+['"];\s*/m, '');

  const docListeners = new Map();
  const doc = {
    activeElement: null,
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    dispatchEvent(event) {
      for (const fn of docListeners.get(event.type) ?? []) fn(event);
    },
    querySelector(selector) { return bySelector[selector] ?? null; },
    querySelectorAll(selector) { return listSelectors[selector] ?? []; },
  };

  const screen = createStubElement({ inert: true, doc });
  const toolbar = createStubElement({ hidden: true, inert: true, doc });
  const sink = createStubElement({ inert: true, doc });
  const gate = createStubElement({ hidden: false, doc });
  const form = createStubElement({ doc });
  const password = createStubElement({ doc });
  const connect = createStubElement({ doc });
  const error = createStubElement({ doc });
  const status = createStubElement({ doc });
  const keyboard = createStubElement({ doc });
  const cad = createStubElement({ doc });
  const disconnect = createStubElement({ doc });
  gate.appendChild(password);
  gate.appendChild(connect);

  const modifiers = [
    createStubElement({ dataset: { modifier: 'MetaLeft', keysym: '65511' }, attributes: { 'aria-pressed': 'false' }, doc }),
    createStubElement({ dataset: { modifier: 'ControlLeft', keysym: '65507' }, attributes: { 'aria-pressed': 'false' }, doc }),
    createStubElement({ dataset: { modifier: 'AltLeft', keysym: '65513' }, attributes: { 'aria-pressed': 'false' }, doc }),
  ];
  const keys = [
    createStubElement({ dataset: { key: 'Tab', keysym: '65289' }, doc }),
    createStubElement({ dataset: { key: 'Escape', keysym: '65307' }, doc }),
  ];

  const bySelector = {
    '#screen': screen,
    '#gate': gate,
    '#credentials': form,
    '#password': password,
    '#error': error,
    '#toolbar': toolbar,
    '#status': status,
    '#keyboardSink': sink,
    '#keyboard': keyboard,
    '#cad': cad,
    '#disconnect': disconnect,
  };
  const listSelectors = {
    '[data-modifier]': modifiers,
    '[data-key]': keys,
  };

  const rfbInstances = [];
  /** Mock noVNC RFB constructor tracking listeners, keys, and lifecycle calls. */
  function FakeRFB(target, url, opts) {
    const rfbListeners = new Map();
    const instance = {
      target,
      url,
      opts,
      sentKeys: [],
      sentCredentials: [],
      disconnected: 0,
      addEventListener(type, fn) {
        if (!rfbListeners.has(type)) rfbListeners.set(type, []);
        rfbListeners.get(type).push(fn);
      },
      emit(type, detail) {
        for (const fn of rfbListeners.get(type) ?? []) fn({ type, detail });
      },
      sendKey(keysym, code, down) { instance.sentKeys.push({ keysym, code, down }); },
      sendCredentials(creds) { instance.sentCredentials.push(creds); },
      sendCtrlAltDel() {},
      disconnect() { instance.disconnected += 1; },
    };
    rfbInstances.push(instance);
    return instance;
  }

  runInNewContext(scriptBody, {
    RFB: FakeRFB,
    document: doc,
    location: { protocol: 'https:', host: 'example.com' },
    encodeURIComponent,
    Number,
    Map,
  });

  return { doc, screen, toolbar, sink, gate, form, password, connect, error, status, modifiers, keys, rfbInstances };
}

beforeEach(() => { broker.hasSession.mockReset(); });

// The viewer page is served before any API auth: the broker-issued token is the
// only thing standing between a LAN caller and the VNC bridge page.
describe('GET /remote-desktop', () => {
  it('serves the viewer bound to a live session token, uncached and without a referrer', async () => {
    broker.hasSession.mockReturnValue(true);
    const res = await request(app).get(`/remote-desktop?token=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.text).toContain(TOKEN);
    expect(res.text).not.toContain('__REMOTE_DESKTOP_TOKEN__');
    expect(res.text).toContain("history.replaceState(null, '', location.pathname)");
    expect(res.text.indexOf('history.replaceState')).toBeLessThan(res.text.indexOf('type="module"'));
    expect(broker.hasSession).toHaveBeenCalledWith(TOKEN);
  });

  it('ships accessible viewport, landmarks, dialog semantics, contrast, focus ring, and modifier labels', async () => {
    broker.hasSession.mockReturnValue(true);
    const res = await request(app).get(`/remote-desktop?token=${TOKEN}`);
    expect(res.status).toBe(200);

    // Viewport allows pinch-to-zoom on all browsers
    const viewport = res.text.match(/<meta\s+name="viewport"[^>]*>/i)?.[0] ?? '';
    expect(viewport).toContain('width=device-width,initial-scale=1,viewport-fit=cover');
    expect(viewport).not.toContain('maximum-scale=1');

    // Contrast, focus-visible ring, and >= 44px button target size
    expect(res.text).not.toContain('#536dfe');
    expect(res.text).toContain('#3852e0');
    expect(res.text).toContain('button:focus-visible, input:focus-visible { outline: 2px solid #93c5fd; outline-offset: 2px; }');
    expect(res.text).toContain('min-height: 44px');

    // Main landmark, application canvas, toolbar, live status, inert defaults
    expect(res.text).toMatch(/<main>[\s\S]*<div id="screen" role="application" aria-label="Remote desktop canvas" inert><\/div>[\s\S]*<\/main>/);
    expect(res.text).toContain('<div id="toolbar" role="toolbar" aria-label="Remote desktop controls" hidden inert>');
    expect(res.text).toContain('<span id="status" role="status" aria-live="polite">Connecting…</span>');
    expect(res.text).toContain('<textarea id="keyboardSink" autocapitalize="none" autocomplete="off" autocorrect="off" spellcheck="false" aria-label="Remote keyboard input" inert></textarea>');

    // Dialog semantics on #gate and Command / aria-pressed on modifiers
    expect(res.text).toContain('<div id="gate" role="dialog" aria-modal="true" aria-labelledby="gate-title">');
    expect(res.text).toContain('<h1 id="gate-title">Remote Desktop</h1>');
    expect(res.text).toContain('<button data-modifier="MetaLeft" data-keysym="65511" type="button" aria-label="Command" aria-pressed="false">⌘</button>');
    expect(res.text).toContain('<button data-modifier="ControlLeft" data-keysym="65507" type="button" aria-pressed="false">Ctrl</button>');
    expect(res.text).toContain('<button data-modifier="AltLeft" data-keysym="65513" type="button" aria-pressed="false">Opt</button>');
  });

  it('isolates background controls with inert, traps Tab inside #gate, and syncs modifier aria-pressed state', async () => {
    broker.hasSession.mockReturnValue(true);
    const res = await request(app).get(`/remote-desktop?token=${TOKEN}`);
    const view = mountViewerScript(res.text);

    // Gate starts open: background regions stay inert and #password receives focus
    expect(view.gate.hidden).toBe(false);
    expect(view.screen.inert).toBe(true);
    expect(view.toolbar.inert).toBe(true);
    expect(view.sink.inert).toBe(true);
    expect(view.doc.activeElement).toBe(view.password);

    // Tab/Shift+Tab cycle strictly between #password and #connect while gate is open
    const shiftTabOnFirst = { type: 'keydown', key: 'Tab', shiftKey: true, prevented: false, preventDefault() { this.prevented = true; } };
    view.doc.dispatchEvent(shiftTabOnFirst);
    expect(shiftTabOnFirst.prevented).toBe(true);
    expect(view.doc.activeElement).toBe(view.connect);

    const tabOnLast = { type: 'keydown', key: 'Tab', shiftKey: false, prevented: false, preventDefault() { this.prevented = true; } };
    view.doc.dispatchEvent(tabOnLast);
    expect(tabOnLast.prevented).toBe(true);
    expect(view.doc.activeElement).toBe(view.password);

    // Connecting unhides #toolbar visually while keeping background inert until connected
    view.password.value = 'secret-pass';
    view.form.dispatchEvent({ type: 'submit', preventDefault() {} });
    expect(view.rfbInstances).toHaveLength(1);
    expect(view.toolbar.hidden).toBe(false);
    expect(view.toolbar.inert).toBe(true);
    expect(view.screen.inert).toBe(true);
    expect(view.sink.inert).toBe(true);

    const rfb = view.rfbInstances[0];
    rfb.emit('connect');
    expect(view.gate.hidden).toBe(true);
    expect(view.screen.inert).toBe(false);
    expect(view.toolbar.inert).toBe(false);
    expect(view.sink.inert).toBe(false);
    expect(view.status.textContent).toBe('Connected');
    expect(view.password.value).toBe('');

    // Tab trap is inactive once gate closes
    const tabWhenClosed = { type: 'keydown', key: 'Tab', shiftKey: false, prevented: false, preventDefault() { this.prevented = true; } };
    view.doc.dispatchEvent(tabWhenClosed);
    expect(tabWhenClosed.prevented).toBe(false);

    // Modifier clicks toggle aria-pressed and key clicks release modifiers
    const cmd = view.modifiers[0];
    expect(cmd.getAttribute('aria-pressed')).toBe('false');
    cmd.dispatchEvent({ type: 'click' });
    expect(cmd.getAttribute('aria-pressed')).toBe('true');
    expect(cmd.classList.contains('active')).toBe(true);

    view.keys[0].dispatchEvent({ type: 'click' });
    expect(cmd.getAttribute('aria-pressed')).toBe('false');
    expect(cmd.classList.contains('active')).toBe(false);

    // Re-opening gate on credentialsrequired, securityfailure, and disconnect restores inert & focus
    rfb.emit('credentialsrequired');
    expect(view.gate.hidden).toBe(false);
    expect(view.screen.inert).toBe(true);
    expect(view.toolbar.inert).toBe(true);
    expect(view.sink.inert).toBe(true);
    expect(view.doc.activeElement).toBe(view.password);

    view.password.selected = false;
    rfb.emit('securityfailure', { reason: 'Bad password' });
    expect(view.gate.hidden).toBe(false);
    expect(view.toolbar.inert).toBe(true);
    expect(view.password.selected).toBe(true);
    expect(view.error.textContent).toBe('Bad password');

    cmd.dispatchEvent({ type: 'click' });
    expect(cmd.getAttribute('aria-pressed')).toBe('true');
    rfb.emit('disconnect', { clean: true });
    expect(view.gate.hidden).toBe(false);
    expect(view.screen.inert).toBe(true);
    expect(view.toolbar.inert).toBe(true);
    expect(view.sink.inert).toBe(true);
    expect(view.doc.activeElement).toBe(view.password);
    expect(cmd.getAttribute('aria-pressed')).toBe('false');
  });

  it('refuses an unknown or missing token without echoing it into a page', async () => {
    broker.hasSession.mockReturnValue(false);
    for (const path of [`/remote-desktop?token=${TOKEN}`, '/remote-desktop']) {
      const res = await request(app).get(path);
      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      expect(res.text).not.toContain(TOKEN);
    }
  });

  it('rejects a repeated token parameter before consulting the broker', async () => {
    const res = await request(app).get(`/remote-desktop?token=${TOKEN}&token=${TOKEN}`);
    expect(res.status).toBe(400);
    expect(broker.hasSession).not.toHaveBeenCalled();
  });
});
