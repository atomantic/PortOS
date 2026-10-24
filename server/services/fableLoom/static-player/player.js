import { createSession, mediaUrl } from './runtime.js';

const root = globalThis.document?.getElementById('player');
const failure = globalThis.document?.getElementById('failure');
const title = globalThis.document?.getElementById('title');
const prose = globalThis.document?.getElementById('prose');
const narration = globalThis.document?.getElementById('narration');
const ending = globalThis.document?.getElementById('ending');
const status = globalThis.document?.getElementById('status');
const choices = globalThis.document?.getElementById('choices');
const composer = globalThis.document?.getElementById('composer');
const message = globalThis.document?.getElementById('message');
const video = globalThis.document?.getElementById('stage');
const play = globalThis.document?.getElementById('play');

function text(element, value) {
  if (element) element.textContent = value ?? '';
}

function showFailure(value) {
  if (!failure) return;
  failure.hidden = !value;
  text(failure, value || '');
}

function outcome(turn, speechStatus) {
  return {
    status: speechStatus,
    turnId: turn.turnId,
    nodeId: turn.nodeId,
    episodeId: turn.episodeId,
    generation: turn.generation,
  };
}

function speak(turn, hooks) {
  if (typeof hooks.completeSpeech === 'function') return Promise.resolve(hooks.completeSpeech(turn));
  if (!turn.text) return Promise.resolve(outcome(turn, 'empty'));
  text(narration, turn.text);
  if (narration) narration.hidden = false;
  const synth = globalThis.speechSynthesis;
  const Utterance = globalThis.SpeechSynthesisUtterance;
  if (!synth || typeof Utterance !== 'function') return Promise.resolve(outcome(turn, 'unavailable'));
  return new Promise((resolve) => {
    let settled = false;
    let timer = 0;
    const finish = (speechStatus) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      resolve(outcome(turn, speechStatus));
    };
    try {
      const utter = new Utterance(turn.text);
      utter.onend = () => finish('completed');
      utter.onerror = () => finish('failed');
      // Some browsers never fire onend or onerror. A bounded failure leaves the scene in place.
      const limit = Math.min(60000, 5000 + turn.text.length * 100);
      timer = globalThis.setTimeout(() => {
        try { synth.cancel(); } catch { /* a stalled voice may already be gone */ }
        finish('failed');
      }, limit);
      synth.cancel();
      synth.speak(utter);
    } catch {
      finish('failed');
    }
  });
}

function bind(session) {
  let shown = null;
  let detachLoad = () => {};
  function paint() {
    const snap = session.snapshot();
    if (root) {
      root.dataset.node = snap.nodeId || '';
      root.dataset.phase = snap.phase;
      root.dataset.turn = snap.turnPhase;
      root.dataset.ended = snap.ended ? 'true' : 'false';
    }
    text(title, snap.title);
    globalThis.document.title = snap.title || 'Story';
    text(prose, snap.prose);
    text(narration, snap.narration);
    if (narration) narration.hidden = !snap.narration;
    const showEnding = snap.phase === 'ended' && snap.ended;
    if (ending) ending.hidden = !showEnding;
    text(ending, showEnding ? snap.endingLabel : '');
    text(status, snap.status || (snap.turnPhase === 'idle' ? '' : snap.turnPhase));
    if (composer) composer.hidden = snap.turnPhase !== 'listening';
    if (message) message.disabled = snap.turnPhase !== 'listening';
    choices?.replaceChildren(...snap.choices.map((choice) => {
      const button = globalThis.document.createElement('button');
      button.type = 'button';
      button.dataset.choice = choice.id;
      text(button, choice.intent);
      if (choice.description) button.title = choice.description;
      button.addEventListener('click', () => {
        session.choose(choice.id).then(() => paint()).catch(() => paint());
      });
      return button;
    }));
    if (!snap.media || !mediaUrl(snap.media.url.replace(/^\.\.\//, ''))) {
      shown = null;
      detachLoad();
      detachLoad = () => {};
      if (video) {
        video.hidden = true;
        video.removeAttribute('src');
        delete video.dataset.clip;
      }
      if (play) play.hidden = true;
    } else if (video && shown !== snap.media.generation) {
      shown = snap.media.generation;
      detachLoad();
      const generation = snap.media.generation;
      const looping = snap.media.loop === true;
      const onEnded = () => {
        if (looping) return;
        detachLoad();
        detachLoad = () => {};
        session.onMediaEnded(generation);
        paint();
      };
      const onError = () => {
        if (!video.getAttribute('src')) return;
        detachLoad();
        detachLoad = () => {};
        session.noteMediaFailure(generation);
        paint();
      };
      detachLoad = () => {
        video.removeEventListener('ended', onEnded);
        video.removeEventListener('error', onError);
      };
      video.addEventListener('ended', onEnded);
      video.addEventListener('error', onError);
      video.hidden = snap.phase === 'ended';
      video.dataset.clip = String(generation);
      video.src = snap.media.url;
      video.loop = looping;
      if (play) play.hidden = true;
      video.play().then(() => {
        if (play) play.hidden = true;
      }).catch(() => {
        if (shown === generation && play) play.hidden = false;
      });
    }
  }
  play?.addEventListener('click', () => {
    video?.play().then(() => {
      play.hidden = true;
    }).catch(() => {
      play.hidden = false;
    });
  });
  choices?.addEventListener('keydown', (event) => {
    const buttons = [...choices.querySelectorAll('button')];
    const index = buttons.indexOf(globalThis.document.activeElement);
    if (index < 0) return;
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!next) return;
    event.preventDefault();
    buttons[(index + next + buttons.length) % buttons.length].focus();
  });
  composer?.addEventListener('submit', (event) => {
    event.preventDefault();
    const typed = message?.value ?? '';
    if (message) message.value = '';
    session.submit(typed).then(() => paint()).catch(() => paint());
  });
  return paint;
}

async function boot() {
  try {
    if (!root) return;
    const hooks = globalThis.FableLoomPlayer || {};
    const address = new URL('../manifest.json', import.meta.url);
    const response = await globalThis.fetch(address);
    if (!response.ok) throw new Error('The story package is missing manifest.json.');
    const manifest = await response.json();
    const requested = new URL(globalThis.location.href).searchParams.get('episode');
    let repaint = () => {};
    const session = createSession(manifest, {
      episodeId: requested || undefined,
      resolveTurn: typeof hooks.resolveTurn === 'function' ? hooks.resolveTurn : undefined,
      onSpeak: (turn) => speak(turn, hooks),
      onChange: () => repaint(),
    });
    repaint = bind(session);
    globalThis.FableLoomPlayer = { ...hooks, session, repaint };
    repaint();
  } catch (error) {
    showFailure(error instanceof Error ? error.message : 'The story package could not be read.');
  }
}

void boot();
