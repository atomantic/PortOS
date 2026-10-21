import { describe, it, expect, beforeAll } from 'vitest';
import { installActionFeedback, trackRequest, getPendingActionCount } from './actionFeedback.js';

const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('actionFeedback', () => {
  beforeAll(() => installActionFeedback(document));

  it('marks the tapped button busy until the request it started settles', async () => {
    document.body.innerHTML = '<button id="b"><span id="icon">x</span></button>';
    const button = document.getElementById('b');
    const req = deferred();
    button.addEventListener('click', () => trackRequest(req.promise));

    document.getElementById('icon').click();
    expect(button.getAttribute('data-pending')).toBe('true');
    expect(getPendingActionCount()).toBe(1);

    req.reject(new Error('boom'));
    await req.promise.catch(() => {});
    await nextTask();
    expect(button.hasAttribute('data-pending')).toBe(false);
    expect(getPendingActionCount()).toBe(0);
  });

  it('attributes a form submit to its submit button', async () => {
    document.body.innerHTML = '<form id="f"><input name="q" /><button id="send">Send</button></form>';
    const form = document.getElementById('f');
    const req = deferred();
    form.addEventListener('submit', (e) => { e.preventDefault(); trackRequest(req.promise); });

    form.requestSubmit();
    expect(document.getElementById('send').getAttribute('data-pending')).toBe('true');
    req.resolve();
    await req.promise;
    await nextTask();
    expect(document.getElementById('send').hasAttribute('data-pending')).toBe(false);
  });

  it('never touches a component-managed aria-busy', async () => {
    document.body.innerHTML = '<button id="b" aria-busy="true">Run</button>';
    const button = document.getElementById('b');
    const req = deferred();
    button.addEventListener('click', () => trackRequest(req.promise));
    button.click();
    req.resolve();
    await req.promise;
    await nextTask();
    expect(button.hasAttribute('data-pending')).toBe(false);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });

  it('leaves background requests (no tap in this task) unattributed', async () => {
    document.body.innerHTML = '<button id="b">Go</button>';
    document.getElementById('b').click();
    await nextTask();
    const req = deferred();
    trackRequest(req.promise);
    expect(document.getElementById('b').hasAttribute('data-pending')).toBe(false);
    expect(getPendingActionCount()).toBe(0);
    req.resolve();
  });
});
