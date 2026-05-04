import { describe, it, expect } from 'vitest';
import {
  vaultInputSchema,
  vaultUpdateSchema,
  notePathSchema,
  createNoteSchema,
  updateNoteSchema,
  searchQuerySchema,
  scanQuerySchema
} from './notesValidation.js';

describe('notesValidation', () => {
  describe('notePathSchema (safeRelativePath)', () => {
    it('accepts a simple forward-slash relative path', () => {
      expect(notePathSchema.safeParse({ path: 'folder/file.md' }).success).toBe(true);
    });

    it('accepts a single filename', () => {
      expect(notePathSchema.safeParse({ path: 'file.md' }).success).toBe(true);
    });

    it('accepts filenames containing dots that are not traversal segments', () => {
      // `notes..md` is a single segment, not a `..` segment; it must be allowed.
      expect(notePathSchema.safeParse({ path: 'notes..md' }).success).toBe(true);
      expect(notePathSchema.safeParse({ path: 'v1..v2.md' }).success).toBe(true);
      expect(notePathSchema.safeParse({ path: 'folder/notes..md' }).success).toBe(true);
    });

    it('rejects parent-directory traversal segments', () => {
      expect(notePathSchema.safeParse({ path: '../secret' }).success).toBe(false);
      expect(notePathSchema.safeParse({ path: 'folder/../secret' }).success).toBe(false);
      expect(notePathSchema.safeParse({ path: '..' }).success).toBe(false);
    });

    it('rejects current-directory segments', () => {
      expect(notePathSchema.safeParse({ path: './file.md' }).success).toBe(false);
      expect(notePathSchema.safeParse({ path: 'folder/./file.md' }).success).toBe(false);
    });

    it('rejects posix absolute paths', () => {
      expect(notePathSchema.safeParse({ path: '/etc/passwd' }).success).toBe(false);
    });

    it('rejects backslashes (UNC and Windows separators)', () => {
      expect(notePathSchema.safeParse({ path: 'folder\\file.md' }).success).toBe(false);
      expect(notePathSchema.safeParse({ path: '\\\\host\\share' }).success).toBe(false);
    });

    it('rejects Windows drive-letter prefixes', () => {
      expect(notePathSchema.safeParse({ path: 'C:/Users' }).success).toBe(false);
      expect(notePathSchema.safeParse({ path: 'd:foo' }).success).toBe(false);
    });

    it('rejects empty paths', () => {
      expect(notePathSchema.safeParse({ path: '' }).success).toBe(false);
    });

    it('rejects paths longer than 1000 characters', () => {
      const tooLong = 'a'.repeat(1001);
      expect(notePathSchema.safeParse({ path: tooLong }).success).toBe(false);
    });
  });

  describe('vaultInputSchema', () => {
    it('accepts path alone (name optional)', () => {
      expect(vaultInputSchema.safeParse({ path: '/Users/me/Notes' }).success).toBe(true);
    });

    it('accepts path + name', () => {
      const r = vaultInputSchema.safeParse({ path: '/x', name: 'Personal' });
      expect(r.success).toBe(true);
    });

    it('rejects missing path', () => {
      expect(vaultInputSchema.safeParse({ name: 'Personal' }).success).toBe(false);
    });

    it('vaultUpdateSchema accepts an empty object', () => {
      expect(vaultUpdateSchema.safeParse({}).success).toBe(true);
    });
  });

  describe('createNoteSchema', () => {
    it('defaults content to an empty string', () => {
      const r = createNoteSchema.safeParse({ path: 'a/b.md' });
      expect(r.success).toBe(true);
      expect(r.data.content).toBe('');
    });

    it('accepts explicit content', () => {
      const r = createNoteSchema.safeParse({ path: 'a/b.md', content: '# Hello' });
      expect(r.success).toBe(true);
      expect(r.data.content).toBe('# Hello');
    });

    it('rejects content above the 500000 char cap', () => {
      const huge = 'x'.repeat(500001);
      expect(createNoteSchema.safeParse({ path: 'a.md', content: huge }).success).toBe(false);
    });

    it('inherits safeRelativePath rules on the path field', () => {
      expect(createNoteSchema.safeParse({ path: '../escape', content: '' }).success).toBe(false);
    });
  });

  describe('updateNoteSchema', () => {
    it('requires a content string', () => {
      expect(updateNoteSchema.safeParse({}).success).toBe(false);
      expect(updateNoteSchema.safeParse({ content: '' }).success).toBe(true);
      expect(updateNoteSchema.safeParse({ content: 'updated' }).success).toBe(true);
    });
  });

  describe('searchQuerySchema', () => {
    it('defaults limit to 50', () => {
      const r = searchQuerySchema.safeParse({ q: 'hello' });
      expect(r.success).toBe(true);
      expect(r.data.limit).toBe(50);
    });

    it('coerces a numeric string to a number', () => {
      const r = searchQuerySchema.safeParse({ q: 'hello', limit: '25' });
      expect(r.success).toBe(true);
      expect(r.data.limit).toBe(25);
    });

    it('rejects empty query strings', () => {
      expect(searchQuerySchema.safeParse({ q: '' }).success).toBe(false);
    });

    it('rejects limit above the 200 cap', () => {
      expect(searchQuerySchema.safeParse({ q: 'x', limit: 999 }).success).toBe(false);
    });
  });

  describe('scanQuerySchema', () => {
    it('applies sane defaults', () => {
      const r = scanQuerySchema.safeParse({});
      expect(r.success).toBe(true);
      expect(r.data.limit).toBe(500);
      expect(r.data.offset).toBe(0);
    });

    it('coerces numeric strings to numbers', () => {
      const r = scanQuerySchema.safeParse({ limit: '100', offset: '20' });
      expect(r.success).toBe(true);
      expect(r.data.limit).toBe(100);
      expect(r.data.offset).toBe(20);
    });

    it('rejects negative offset', () => {
      expect(scanQuerySchema.safeParse({ offset: -1 }).success).toBe(false);
    });

    it('rejects limit above the 1000 cap', () => {
      expect(scanQuerySchema.safeParse({ limit: 1001 }).success).toBe(false);
    });
  });
});
