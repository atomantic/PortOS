import { describe, it, expect } from 'vitest';
import { isExtensionError } from './extensionErrors.js';

describe('isExtensionError', () => {
  describe('provenance — extension URL schemes', () => {
    const SCHEMES = [
      'chrome-extension://abcdefghijklmnop/inpage.js',
      'moz-extension://1234-5678/content.js',
      'safari-extension://com.example.ext/injected.js',
      'safari-web-extension://ABCD-1234/injected.js',
      'ms-browser-extension://abcd/content.js',
      'opera-extension://abcd/content.js',
      'webkit-masked-url://hidden/',
    ];

    for (const url of SCHEMES) {
      it(`flags ${url.split('://')[0]} in \`source\``, () => {
        expect(isExtensionError({ message: 'boom', source: url })).toBe(true);
      });

      it(`flags ${url.split('://')[0]} in \`stack\``, () => {
        expect(isExtensionError({
          message: 'boom',
          stack: `TypeError: boom\n    at inject (${url}:1:1)`,
        })).toBe(true);
      });
    }

    it('flags the legacy `extensions::` internal frame', () => {
      expect(isExtensionError({
        message: 'boom',
        stack: 'Error\n    at extensions::SafeBuiltins:12:34',
      })).toBe(true);
    });

    it('flags a Firefox/Safari-dialect stack (`fn@url`, no `at ` prefix)', () => {
      expect(isExtensionError({
        message: 'boom',
        stack: 'inject@moz-extension://abcd-1234/content.js:1:1\nfoo@https://portos/assets/index.js:2:2',
      })).toBe(true);
    });
  });

  describe('provenance is the ORIGINATING frame, not any frame', () => {
    // An extension that wraps or synchronously invokes our code (a patched
    // fetch, an injected provider, a dispatched event) leaves its frames BELOW
    // ours. Treating any frame as proof would silently drop a real PortOS bug.
    it('does NOT flag a PortOS error merely invoked from extension code', () => {
      expect(isExtensionError({
        message: "Cannot read properties of undefined (reading 'id')",
        stack: [
          "TypeError: Cannot read properties of undefined (reading 'id')",
          '    at renderRow (https://portos/assets/index-abc.js:10:5)',
          '    at wrappedFetch (chrome-extension://examplewalletextensionid00000000/inpage.js:1:1)',
        ].join('\n'),
      })).toBe(false);
    });

    it('still flags it when the extension frame IS the throw site', () => {
      expect(isExtensionError({
        message: "Cannot read properties of null (reading 'ethereum')",
        stack: [
          "TypeError: Cannot read properties of null (reading 'ethereum')",
          '    at inject (chrome-extension://examplewalletextensionid00000000/inpage.js:1:1)',
          '    at dispatch (https://portos/assets/index-abc.js:10:5)',
        ].join('\n'),
      })).toBe(true);
    });

    it('does not mistake the V8 message line for the originating frame', () => {
      // The `Type: message` line precedes the frames and must be skipped, or a
      // message mentioning an extension URL would be read as the throw site.
      expect(isExtensionError({
        message: 'boom',
        stack: 'Error: boom\n    at f (https://portos/assets/index.js:1:1)',
      })).toBe(false);
    });

    it('flags an extension URL named in the message with no stack', () => {
      expect(isExtensionError({
        message: 'Failed to fetch dynamically imported module: chrome-extension://abc/x.js',
      })).toBe(true);
    });

    it('matches the scheme case-insensitively', () => {
      expect(isExtensionError({ message: 'boom', source: 'CHROME-EXTENSION://ABC/x.js' })).toBe(true);
    });

    it('is not stateful across repeated calls (regex has no `g` flag)', () => {
      // A /g/ regex would alternate true/false via lastIndex. Same input must
      // give the same answer every time or filtering becomes a coin flip.
      const payload = { message: 'boom', source: 'chrome-extension://abc/inpage.js' };
      expect([1, 2, 3, 4].map(() => isExtensionError(payload))).toEqual([true, true, true, true]);
    });
  });

  describe('message signatures — stackless extension rejections', () => {
    // The screenshot case from the Review Hub: MetaMask rejects with a bare
    // string, so there is no stack or source to key off.
    it('flags a bare "Failed to connect to MetaMask" rejection', () => {
      expect(isExtensionError({ type: 'unhandledrejection', message: 'Failed to connect to MetaMask' })).toBe(true);
    });

    it('leaves un-evidenced extension-ish messages to the provenance check', () => {
      // The message list is intentionally minimal (see the module comment).
      // These chrome.runtime strings are real extension noise, but every
      // instance observed so far carries an extension frame, so provenance
      // already catches them and a blanket message rule would only add
      // silent-drop surface. They are filtered when a stack proves it...
      const runtimeNoise = 'The message port closed before a response was received.';
      expect(isExtensionError({ message: runtimeNoise })).toBe(false);
      // ...like this.
      expect(isExtensionError({
        message: runtimeNoise,
        stack: 'Error\n    at m (chrome-extension://abc/content.js:1:1)',
      })).toBe(true);
    });
  });

  describe('PortOS errors are never filtered', () => {
    it('does NOT flag `crypto.randomUUID is not a function`', () => {
      // Regression guard: this one looks like extension noise but is OUR bug
      // on insecure origins (see client/src/lib/uuid.js). Filtering it would
      // have hidden a real crash in every toast.
      expect(isExtensionError({
        type: 'unhandledrejection',
        message: 'crypto.randomUUID is not a function',
        url: 'http://example-host.ts.net:5554/apps/portos-demo',
      })).toBe(false);
    });

    it('does not flag an ordinary app error', () => {
      expect(isExtensionError({
        message: "Cannot read properties of undefined (reading 'id')",
        source: 'http://example-host.ts.net:5555/assets/index-abc123.js',
        stack: "TypeError\n    at Foo (http://example-host.ts.net:5555/assets/index-abc123.js:10:5)",
      })).toBe(false);
    });

    it('does not flag on `url` alone — the page is ours even when an extension throws on it', () => {
      // `url` is window.location.href. If a page URL could trigger the filter,
      // a hostile/odd route would silently disable error reporting.
      expect(isExtensionError({
        message: 'boom',
        url: 'http://example-host.ts.net:5555/apps/chrome-extension://spoof',
      })).toBe(false);
    });
  });

  describe('untrusted input', () => {
    it('returns false for non-object payloads', () => {
      for (const v of [null, undefined, 'string', 42, true, []]) {
        expect(isExtensionError(v)).toBe(false);
      }
    });

    it('ignores non-string fields rather than throwing', () => {
      expect(isExtensionError({ message: 42, stack: {}, source: ['x'] })).toBe(false);
    });
  });
});
