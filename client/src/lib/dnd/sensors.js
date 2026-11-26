// Own document-level listeners for one gesture, including activation thresholds, click suppression and synchronous keyboard control.

export const PointerSensor = 'pointer';
export const MouseSensor = 'mouse';
export const TouchSensor = 'touch';
export const KeyboardSensor = 'keyboard';
export const useSensor = (sensor, options = {}) => ({ sensor, options });
export const useSensors = (...sensors) => sensors;

const defaultCodes = { start: ['Space', 'Enter'], end: ['Space', 'Enter', 'Tab'], cancel: ['Escape'] };

export function activators(sensors, begin) {
  const listeners = {};
  for (const { sensor, options } of sensors) {
    const listen = (name, kind) => {
      listeners[name] = event => {
        const native = event.nativeEvent;
        const handle = event.currentTarget;
        if (native.defaultPrevented || (kind === 'keyboard' && event.target !== handle)) return;
        // A timeline block is both a handle and the parent of a Remove button.
        const control = event.target.closest?.('button,a,input,textarea,select,[contenteditable="true"]');
        if (control && control !== handle && handle.contains(control)) return;
        if (kind === 'keyboard') {
          if (event.repeat || !(options.keyboardCodes ?? defaultCodes).start.includes(event.code)) return;
        }
        if (kind === 'touch' && native.touches.length !== 1) return;
        if ((kind === 'mouse' || kind === 'pointer') && (native.button !== 0 || native.isPrimary === false)) return;
        begin(kind, options, native, handle);
      };
    };
    if (sensor === KeyboardSensor) listen('onKeyDown', 'keyboard');
    if (sensor === PointerSensor) {
      listen('onPointerDown', 'pointer');
      if (typeof window.PointerEvent !== 'function') {
        listen('onMouseDown', 'mouse');
        listen('onTouchStart', 'touch');
      }
    }
    if (sensor === MouseSensor) listen('onMouseDown', 'mouse');
    if (sensor === TouchSensor) listen('onTouchStart', 'touch');
  }
  return listeners;
}

export function attachSensor(kind, options, event, handle, actions) {
  const doc = handle.ownerDocument;
  const listeners = [];
  const on = (target, name, fn, config) => {
    target.addEventListener(name, fn, config);
    listeners.push(() => target.removeEventListener(name, fn, config));
  };
  let timer;
  let started = false;
  let closed = false;
  const dispose = () => {
    closed = true;
    clearTimeout(timer);
    listeners.splice(0).forEach(remove => remove());
  };
  const source = kind === 'touch' ? event.touches[0] : event;
  const origin = { x: source.clientX, y: source.clientY };
  const keyboard = kind === 'keyboard';
  const start = () => {
    if (closed || started) return;
    started = true;
    actions.start(keyboard ? null : origin);
  };
  const finish = cancelled => {
    if (closed) return;
    dispose();
    if (started && !keyboard && !cancelled) {
      // The synthetic click immediately following release must not select a clip or follow a link.
      const suppress = click => { click.preventDefault(); click.stopImmediatePropagation(); };
      doc.addEventListener('click', suppress, true);
      setTimeout(() => doc.removeEventListener('click', suppress, true), 0);
    }
    actions.finish(started, cancelled);
  };
  on(doc.defaultView, 'blur', () => finish(true));
  on(doc, 'keydown', key => {
    if (key === event) return;
    const codes = options.keyboardCodes ?? defaultCodes;
    if (codes.cancel.includes(key.code)) {
      key.preventDefault();
      finish(true);
    } else if (keyboard && codes.end.includes(key.code)) {
      key.preventDefault();
      if (!key.repeat) finish(false);
    } else if (keyboard && key.code.startsWith('Arrow')) {
      key.preventDefault();
      actions.step(key, options.coordinateGetter);
    }
  }, true);

  if (keyboard) {
    event.preventDefault();
    start();
    return dispose;
  }

  on(doc, 'scroll', actions.scroll, true);
  const sameInput = e => kind !== 'pointer' || e.pointerId === event.pointerId;
  const constraint = options.activationConstraint ?? {};
  on(doc, kind + 'move', move => {
    if (!sameInput(move)) return;
    const point = kind === 'touch' ? Array.from(move.touches).find(t => t.identifier === source.identifier) : move;
    if (!point) return;
    const current = { x: point.clientX, y: point.clientY };
    const delta = { x: current.x - origin.x, y: current.y - origin.y };
    const distance = Math.hypot(delta.x, delta.y);
    if (!started) {
      if (constraint.delay != null) {
        if (distance > constraint.tolerance) finish(true);
        return;
      }
      if (distance <= (constraint.distance ?? 0)) return;
      start();
    }
    if (move.cancelable) move.preventDefault();
    actions.move(delta, current);
  }, { passive: false });
  on(doc, kind === 'touch' ? 'touchend' : kind + 'up', up => {
    if (sameInput(up)) finish(false);
  });
  on(doc, kind + 'cancel', cancel => { if (sameInput(cancel)) finish(true); });
  on(doc, 'dragstart', native => native.preventDefault());
  on(doc, 'contextmenu', native => { if (started) native.preventDefault(); });
  if (constraint.delay != null) timer = setTimeout(start, constraint.delay);
  else if (!constraint.distance) start();
  return dispose;
}
