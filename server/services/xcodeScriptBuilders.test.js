import { describe, it, expect } from 'vitest';
import { activateAppLine, osascriptSystemEvents } from './xcodeScriptBuilders.js';

describe('xcodeScriptBuilders', () => {
  describe('activateAppLine', () => {
    it('emits a single-quoted osascript activate line', () => {
      expect(activateAppLine('MyApp')).toBe(
        `osascript -e 'tell application "MyApp" to activate'`
      );
    });

    it('interpolates the target name verbatim (no sanitizing)', () => {
      expect(activateAppLine('My_App')).toBe(
        `osascript -e 'tell application "My_App" to activate'`
      );
    });
  });

  describe('osascriptSystemEvents', () => {
    it('wraps the body in a System Events / process tell block (escaped, double-quoted)', () => {
      const out = osascriptSystemEvents('MyApp', {
        redirect: ' 2>/dev/null',
        body: ['            select row 1']
      });
      expect(out).toBe(
        '    osascript -e "\n' +
        '    tell application \\"System Events\\"\n' +
        '        tell process \\"MyApp\\"\n' +
        '            select row 1\n' +
        '        end tell\n' +
        '    end tell" 2>/dev/null'
      );
    });

    it('prepends an activate tell when activate is true', () => {
      const out = osascriptSystemEvents('MyApp', {
        activate: true,
        redirect: ' 2>/dev/null || true',
        body: ['            click at {1, 2}']
      });
      expect(out).toBe(
        '    osascript -e "\n' +
        '    tell application \\"MyApp\\" to activate\n' +
        '    tell application \\"System Events\\"\n' +
        '        tell process \\"MyApp\\"\n' +
        '            click at {1, 2}\n' +
        '        end tell\n' +
        '    end tell" 2>/dev/null || true'
      );
    });

    it('defaults to no activate and no redirect', () => {
      const out = osascriptSystemEvents('MyApp', { body: ['            beep'] });
      expect(out).not.toContain('to activate');
      expect(out.endsWith('end tell"')).toBe(true);
    });

    it('emits one line per body entry in order', () => {
      const out = osascriptSystemEvents('MyApp', {
        body: ['            line one', '            line two']
      });
      expect(out).toContain('            line one\n            line two');
    });
  });
});
