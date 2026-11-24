/** Own the managed Chrome fixture shared by the document render browser suites. */
import { chromium } from 'playwright-core';
import { _cleanupTestBrowser, _createTestArtifactsRoot, _waitForTestChrome } from '../htmlComposition/testBrowserCleanup.js';

export function createDocumentRenderBrowserFixture(lifecycle) {
  let browser;
  let artifacts;
  let closing;
  return {
    async openFixture(proc) {
      lifecycle.chromeProcess = proc;
      lifecycle.fixtureWritersSettled = false;
      const ws = await _waitForTestChrome(proc);
      lifecycle.endpoint = new URL(ws).origin.replace('ws:', 'http:');
      artifacts = _createTestArtifactsRoot();
      browser = await chromium.connectOverCDP(lifecycle.endpoint, { artifactsDir: artifacts.path });
      return browser;
    },
    closeFixture() {
      const proc = lifecycle.chromeProcess;
      return closing ??= _cleanupTestBrowser({
        browser, proc, artifacts, cleanup: () => {},
        detachedProcessGroupId: process.platform === 'win32' ? undefined : proc?.pid,
      });
    },
  };
}
