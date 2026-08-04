import { describe, it, expect } from 'vitest';
import {
  toSnakeCase,
  parseFhirLabResult,
  processClinicalRecords,
  mergeBloodTests
} from './appleHealthClinical.js';

// === Test Helpers ===

function makeFhirObservation({ code, display, value, unit, date, refLow, refHigh, status, category } = {}) {
  return JSON.stringify({
    resourceType: 'Observation',
    status: status || 'final',
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: category || 'laboratory' }] }],
    code: { coding: [{ system: 'http://loinc.org', code, display }], text: display },
    effectiveDateTime: date || '2025-01-15T10:30:00Z',
    valueQuantity: { value, unit: unit || 'mg/dL', system: 'http://unitsofmeasure.org' },
    ...(refLow != null || refHigh != null ? {
      referenceRange: [{
        ...(refLow != null && { low: { value: refLow, unit: unit || 'mg/dL' } }),
        ...(refHigh != null && { high: { value: refHigh, unit: unit || 'mg/dL' } })
      }]
    } : {})
  });
}

// =============================================================================
// toSnakeCase TESTS
// =============================================================================

describe('toSnakeCase', () => {
  it('converts display name to snake_case', () => {
    expect(toSnakeCase('Glucose')).toBe('glucose');
  });

  it('strips bracketed content', () => {
    expect(toSnakeCase('Glucose [Mass/volume] in Blood')).toBe('glucose');
  });

  it('strips "in Serum" suffix', () => {
    expect(toSnakeCase('Creatinine in Serum or Plasma')).toBe('creatinine');
  });

  it('strips "by method" suffix', () => {
    expect(toSnakeCase('LDL Cholesterol by calculation')).toBe('ldl_cholesterol');
  });

  it('handles empty/null input', () => {
    expect(toSnakeCase('')).toBe('');
    expect(toSnakeCase(null)).toBe('');
    expect(toSnakeCase(undefined)).toBe('');
  });

  it('collapses multiple non-alpha chars', () => {
    expect(toSnakeCase('A/G Ratio')).toBe('a_g_ratio');
  });
});

// =============================================================================
// parseFhirLabResult TESTS
// =============================================================================

describe('parseFhirLabResult', () => {
  it('parses a valid lab observation with LOINC code', () => {
    const json = makeFhirObservation({ code: '2345-7', display: 'Glucose', value: 95, refLow: 70, refHigh: 99 });
    const result = parseFhirLabResult(json);
    expect(result).toEqual({
      date: '2025-01-15',
      key: 'glucose',
      value: 95,
      unit: 'mg/dL',
      refLow: 70,
      refHigh: 99,
      label: 'Glucose'
    });
  });

  it('uses snake_case fallback for unmapped LOINC codes', () => {
    const json = makeFhirObservation({ code: '99999-9', display: 'Vitamin D [Mass/volume] in Serum', value: 45, unit: 'ng/mL' });
    const result = parseFhirLabResult(json);
    expect(result.key).toBe('vitamin_d');
  });

  it('returns null for non-Observation resources', () => {
    const json = JSON.stringify({ resourceType: 'Patient', name: [{ family: 'Doe' }] });
    expect(parseFhirLabResult(json)).toBeNull();
  });

  it('returns null for non-laboratory observations', () => {
    const json = makeFhirObservation({ code: '2345-7', display: 'Glucose', value: 95, category: 'vital-signs' });
    expect(parseFhirLabResult(json)).toBeNull();
  });

  it('returns null for cancelled observations', () => {
    const json = makeFhirObservation({ code: '2345-7', display: 'Glucose', value: 95, status: 'cancelled' });
    expect(parseFhirLabResult(json)).toBeNull();
  });

  it('returns null for non-numeric values', () => {
    const json = JSON.stringify({
      resourceType: 'Observation',
      status: 'final',
      category: [{ coding: [{ code: 'laboratory' }] }],
      code: { coding: [{ system: 'http://loinc.org', code: '2345-7' }] },
      effectiveDateTime: '2025-01-15',
      valueString: 'Negative'
    });
    expect(parseFhirLabResult(json)).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseFhirLabResult('not json')).toBeNull();
    expect(parseFhirLabResult('')).toBeNull();
  });

  it('extracts date from effectiveDateTime', () => {
    const json = makeFhirObservation({ code: '3094-0', display: 'BUN', value: 15, date: '2024-06-20T08:00:00-07:00' });
    expect(parseFhirLabResult(json).date).toBe('2024-06-20');
  });

  it('handles missing reference ranges', () => {
    const json = makeFhirObservation({ code: '2345-7', display: 'Glucose', value: 95 });
    const result = parseFhirLabResult(json);
    expect(result.refLow).toBeNull();
    expect(result.refHigh).toBeNull();
  });
});

// =============================================================================
// processClinicalRecords TESTS
// =============================================================================

describe('processClinicalRecords', () => {
  it('groups results by date and collects reference ranges', () => {
    const jsons = [
      makeFhirObservation({ code: '2345-7', display: 'Glucose', value: 95, date: '2025-01-15T10:00:00Z', refLow: 70, refHigh: 99 }),
      makeFhirObservation({ code: '3094-0', display: 'BUN', value: 15, date: '2025-01-15T10:00:00Z', refLow: 7, refHigh: 20 }),
      makeFhirObservation({ code: '2093-3', display: 'Cholesterol', value: 180, date: '2025-03-01T10:00:00Z', refLow: 0, refHigh: 200 })
    ];

    const result = processClinicalRecords(jsons);
    expect(result.tests).toHaveLength(2);
    expect(result.tests[0]).toEqual({ date: '2025-01-15', glucose: 95, bun: 15 });
    expect(result.tests[1]).toEqual({ date: '2025-03-01', cholesterol: 180 });
    expect(result.referenceRanges.glucose).toEqual({ min: 70, max: 99, unit: 'mg/dL', label: 'Glucose' });
    expect(result.totalParsed).toBe(3);
    expect(result.totalSkipped).toBe(0);
  });

  it('counts skipped non-lab records', () => {
    const jsons = [
      makeFhirObservation({ code: '2345-7', display: 'Glucose', value: 95 }),
      JSON.stringify({ resourceType: 'Patient' }),
      'invalid json'
    ];

    const result = processClinicalRecords(jsons);
    expect(result.totalParsed).toBe(1);
    expect(result.totalSkipped).toBe(2);
  });

  it('returns sorted tests by date', () => {
    const jsons = [
      makeFhirObservation({ code: '2345-7', display: 'Glucose', value: 100, date: '2025-06-01T10:00:00Z' }),
      makeFhirObservation({ code: '2345-7', display: 'Glucose', value: 90, date: '2025-01-01T10:00:00Z' })
    ];

    const result = processClinicalRecords(jsons);
    expect(result.tests[0].date).toBe('2025-01-01');
    expect(result.tests[1].date).toBe('2025-06-01');
  });
});

// =============================================================================
// mergeBloodTests TESTS
// =============================================================================

describe('mergeBloodTests', () => {
  it('adds new dates from FHIR data', () => {
    const existing = { tests: [{ date: '2023-09-05', bun: 16 }], referenceRanges: {} };
    const fhir = {
      tests: [{ date: '2025-01-15', glucose: 95, bun: 12 }],
      referenceRanges: { glucose: { min: 70, max: 99, unit: 'mg/dL', label: 'Glucose' } }
    };

    const result = mergeBloodTests(existing, fhir);
    expect(result.tests).toHaveLength(2);
    expect(result.tests[0].date).toBe('2023-09-05');
    expect(result.tests[1]).toEqual({ date: '2025-01-15', glucose: 95, bun: 12 });
  });

  it('does not overwrite existing values on same date', () => {
    const existing = {
      tests: [{ date: '2023-09-05', bun: 16, tsh: 1.249 }],
      referenceRanges: { bun: { min: 7, max: 25, label: 'BUN' } }
    };
    const fhir = {
      tests: [{ date: '2023-09-05', bun: 14, glucose: 95 }],
      referenceRanges: { bun: { min: 7, max: 20, label: 'BUN' }, glucose: { min: 70, max: 99, label: 'Glucose' } }
    };

    const result = mergeBloodTests(existing, fhir);
    expect(result.tests).toHaveLength(1);
    expect(result.tests[0].bun).toBe(16);       // kept existing
    expect(result.tests[0].tsh).toBe(1.249);    // kept existing
    expect(result.tests[0].glucose).toBe(95);    // added new
  });

  it('does not overwrite existing reference ranges', () => {
    const existing = {
      tests: [],
      referenceRanges: { bun: { min: 7, max: 25, label: 'BUN' } }
    };
    const fhir = {
      tests: [],
      referenceRanges: { bun: { min: 7, max: 20, label: 'BUN' }, glucose: { min: 70, max: 99, label: 'Glucose' } }
    };

    const result = mergeBloodTests(existing, fhir);
    expect(result.referenceRanges.bun.max).toBe(25);   // kept existing
    expect(result.referenceRanges.glucose.max).toBe(99); // added new
  });

  it('handles empty existing data', () => {
    const existing = { tests: [], referenceRanges: {} };
    const fhir = {
      tests: [{ date: '2025-01-15', glucose: 95 }],
      referenceRanges: { glucose: { min: 70, max: 99, label: 'Glucose' } }
    };

    const result = mergeBloodTests(existing, fhir);
    expect(result.tests).toHaveLength(1);
    expect(result.referenceRanges.glucose).toBeDefined();
  });

  it('sorts merged tests by date', () => {
    const existing = { tests: [{ date: '2025-06-01', bun: 10 }], referenceRanges: {} };
    const fhir = {
      tests: [{ date: '2024-01-01', glucose: 90 }],
      referenceRanges: {}
    };

    const result = mergeBloodTests(existing, fhir);
    expect(result.tests[0].date).toBe('2024-01-01');
    expect(result.tests[1].date).toBe('2025-06-01');
  });
});
