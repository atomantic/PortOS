import { describe, expect, it } from 'vitest';
import { blankCommentBodies, blankLiterals } from './sourceScan.js';

describe('single-traversal source views', () => {
  it('preserves both lexer modes across literal, comment, and interpolation boundaries', () => {
    const sources = [
      '// comment with \" and `\ncall("https://example.com/*literal*/", /["\']/g); /* end */',
      'const label = `text // ${api.load(id, { silent: true })} ${`nested ${value}`}`;',
      'async function read() { return /[)}]/.test(value); } // tail',
      'const of = 4; f(of / n); obj.return / count; caféreturn / size;',
      'const text = "escaped \\\" quote"; /* multiline\ncomment */ next();',
      '/* unfinished comment',
      '// 💡 Unicode and CRLF\r\nconst x = "😀";\n',
    ];
    for (const src of sources) {
      const { code, blanked } = blankLiterals(src, { includeCommentOnly: true });
      expect(code).toBe(blankCommentBodies(src));
      expect(blanked).toBe(blankLiterals(src));
      expect(code.length).toBe(src.length);
      expect(blanked.length).toBe(src.length);
    }
  });
});
