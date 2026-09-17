import { describe, it, expect } from 'vitest';
import {
  JOB_FORM_FIELD_TYPES,
  jobFormFieldsSchema,
  jobFormValuesSchema,
  formatJobFormValues,
  appendJobFormValues,
} from './jobFormFields.js';

const textField = { key: 'topic', label: 'Topic', type: 'text' };

describe('jobFormFieldsSchema', () => {
  it('accepts one field of every declared type', () => {
    const fields = JOB_FORM_FIELD_TYPES.map((type, i) => ({
      key: `f${i}`,
      label: `Field ${i}`,
      type,
      ...(type === 'select' ? { options: [{ value: 'a' }, { value: 'b', label: 'Bee' }] } : {}),
    }));
    expect(jobFormFieldsSchema.safeParse(fields).success).toBe(true);
  });

  it('rejects duplicate field keys', () => {
    const result = jobFormFieldsSchema.safeParse([textField, { ...textField, label: 'Other' }]);
    expect(result.success).toBe(false);
  });

  it('rejects a key that is not a safe identifier', () => {
    expect(jobFormFieldsSchema.safeParse([{ ...textField, key: 'a topic' }]).success).toBe(false);
    expect(jobFormFieldsSchema.safeParse([{ ...textField, key: '1topic' }]).success).toBe(false);
  });

  it('requires options on a choice field and forbids them elsewhere', () => {
    expect(jobFormFieldsSchema.safeParse([{ key: 'k', label: 'K', type: 'select' }]).success).toBe(false);
    expect(jobFormFieldsSchema.safeParse([{ key: 'k', label: 'K', type: 'select', options: [] }]).success).toBe(false);
    expect(jobFormFieldsSchema.safeParse([{ ...textField, options: [{ value: 'a' }] }]).success).toBe(false);
  });

  it('rejects duplicate option values', () => {
    const result = jobFormFieldsSchema.safeParse([
      { key: 'k', label: 'K', type: 'select', options: [{ value: 'a' }, { value: 'a', label: 'Again' }] },
    ]);
    expect(result.success).toBe(false);
  });

  it('accepts the value shapes the inputs actually produce', () => {
    // A number input hands back a string, a checkbox a boolean, a cleared field ''.
    expect(jobFormValuesSchema.safeParse({ a: 'text', b: 3, c: '7', d: true, e: '', f: null }).success).toBe(true);
  });
});

describe('formatJobFormValues', () => {
  it('returns nothing when no field is declared or none is filled in', () => {
    expect(formatJobFormValues([], { topic: 'x' })).toBe('');
    expect(formatJobFormValues([textField], {})).toBe('');
    expect(formatJobFormValues([textField], { topic: '   ' })).toBe('');
  });

  it('omits a blank field instead of sending it as an empty parameter', () => {
    const fields = [textField, { key: 'notes', label: 'Notes', type: 'textarea' }];
    const section = formatJobFormValues(fields, { topic: 'tides', notes: '' });
    expect(section).toContain('- Topic: tides');
    expect(section).not.toContain('Notes');
  });

  it('keeps a false checkbox, because no is an answer', () => {
    const fields = [{ key: 'art', label: 'Include art', type: 'checkbox' }];
    expect(formatJobFormValues(fields, { art: false })).toContain('- Include art: No');
    expect(formatJobFormValues(fields, { art: true })).toContain('- Include art: Yes');
  });

  it('renders a choice by its label, falling back to the stored value', () => {
    const fields = [{ key: 'size', label: 'Size', type: 'select', options: [{ value: 'sq', label: 'Square' }, { value: 'tall' }] }];
    expect(formatJobFormValues(fields, { size: 'sq' })).toContain('- Size: Square');
    expect(formatJobFormValues(fields, { size: 'tall' })).toContain('- Size: tall');
  });

  it('gives a multi-line value its own heading rather than folding it into a bullet', () => {
    const fields = [textField, { key: 'brief', label: 'Brief', type: 'textarea' }];
    const section = formatJobFormValues(fields, { topic: 'tides', brief: 'line one\nline two' });
    expect(section).toContain('- Topic: tides');
    expect(section).toContain('### Brief\n\nline one\nline two');
  });

  it('follows the declared field order, not the key order of the values', () => {
    const fields = [{ key: 'b', label: 'Second', type: 'text' }, { key: 'a', label: 'First', type: 'text' }];
    const section = formatJobFormValues(fields, { a: '1', b: '2' });
    expect(section.indexOf('Second')).toBeLessThan(section.indexOf('First'));
  });

  it('ignores a value whose field was deleted', () => {
    expect(formatJobFormValues([textField], { topic: 'tides', removed: 'stale' })).not.toContain('stale');
  });
});

describe('appendJobFormValues', () => {
  it('leaves a prompt byte-identical when the job uses no configuration form', () => {
    expect(appendJobFormValues({}, 'do the thing')).toBe('do the thing');
    expect(appendJobFormValues({ formFields: [], formValues: {} }, 'do the thing')).toBe('do the thing');
    expect(appendJobFormValues({ formFields: [textField], formValues: {} }, 'do the thing')).toBe('do the thing');
  });

  it('does not stringify a missing prompt template', () => {
    const job = { formFields: [textField], formValues: { topic: 'tides' } };
    expect(appendJobFormValues(job, undefined)).not.toContain('undefined');
    expect(appendJobFormValues(job, undefined)).toContain('- Topic: tides');
  });

  it('appends the run configuration below the prompt', () => {
    const job = { formFields: [textField], formValues: { topic: 'tides' } };
    const prompt = appendJobFormValues(job, 'do the thing');
    expect(prompt.startsWith('do the thing')).toBe(true);
    expect(prompt).toContain('## Run configuration');
    expect(prompt).toContain('- Topic: tides');
  });
});
