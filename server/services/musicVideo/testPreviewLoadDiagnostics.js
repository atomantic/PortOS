// Test-only observer: retain phase facts before owned-page cleanup without
// copying document source, URLs, error messages or console arguments.
const LIMIT = 1000;
const count = value => Number.isInteger(value) && value >= 0 ? Math.min(value, LIMIT) : 'unavailable';
const flag = value => typeof value === 'boolean' ? value : 'unavailable';

export async function _withTestPreviewLoadDiagnostics(page, load) {
  const started = Date.now();
  const facts = { domContentLoaded: false, load: false, crashed: false, closed: false,
    scriptRequested: 0, scriptFinished: 0, scriptFailed: 0,
    consoleWarning: 0, consoleError: 0, typeError: 0, syntaxError: 0, otherError: 0 };
  const increment = key => { facts[key] = Math.min(LIMIT, facts[key] + 1); };
  const events = {
    domcontentloaded: () => { facts.domContentLoaded = true; },
    load: () => { facts.load = true; },
    crash: () => { facts.crashed = true; },
    close: () => { facts.closed = true; },
    request: request => { if (request.resourceType() === 'script') increment('scriptRequested'); },
    requestfinished: request => { if (request.resourceType() === 'script') increment('scriptFinished'); },
    requestfailed: request => { if (request.resourceType() === 'script') increment('scriptFailed'); },
    console: message => {
      if (message.type() === 'warning') increment('consoleWarning');
      if (message.type() === 'error') increment('consoleError');
    },
    pageerror: error => increment(error.name === 'TypeError' ? 'typeError' : error.name === 'SyntaxError' ? 'syntaxError' : 'otherError'),
  };
  for (const [event, listener] of Object.entries(events)) page.on(event, listener);
  let phase = 'load';
  try {
    // The caller keeps its existing Playwright load and semantic deadlines.
    // Observations never replace load with a weaker lifecycle event.
    await load(() => { phase = 'composition-readiness'; });
  } catch (error) {
    const failure = { phase, elapsedMs: Math.min(Date.now() - started, 3600000), ...facts,
      pageClosed: page.isClosed(), browserConnected: page.context().browser()?.isConnected() ?? false };
    let timer;
    try {
      const documentFacts = await Promise.race([
        Promise.resolve().then(() => page.evaluate(() => {
          let moduleCount = 0, externalScriptCount = 0;
          for (let i = 0; i < Math.min(document.scripts.length, 1000); i++) {
            const script = document.scripts[i];
            if (script.type === 'module') moduleCount++;
            if (script.hasAttribute('src')) externalScriptCount++;
          }
          return { readyState: document.readyState,
            compositionReady: typeof window.portosComposition?.seek === 'function',
            scriptCount: document.scripts.length, moduleCount, externalScriptCount };
        })),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), 250); }),
      ]);
      // Treat page evaluation as untrusted even in a synthetic proof. Only
      // these scalars can leave the page; never stringify the returned object.
      failure.documentProbe = documentFacts ? 'captured' : 'deadline';
      if (documentFacts) Object.assign(failure, {
        readyState: ['loading', 'interactive', 'complete'].includes(documentFacts.readyState) ? documentFacts.readyState : 'unavailable',
        compositionReady: flag(documentFacts.compositionReady),
        scriptCount: count(documentFacts.scriptCount),
        moduleCount: count(documentFacts.moduleCount),
        externalScriptCount: count(documentFacts.externalScriptCount),
      });
    } catch { failure.documentProbe = 'unavailable'; }
    finally { clearTimeout(timer); }
    // Attach to the original failure so reporters retain these facts even if
    // cleanup subsequently fails. No console/error body enters the snapshot.
    error.message += `; preview lifecycle: ${JSON.stringify(failure)}`;
    throw error;
  } finally {
    for (const [event, listener] of Object.entries(events)) page.off(event, listener);
  }
}
