import { describe, it, expect } from 'vitest';
import {
  buildBloodTestModel,
  buildLifestyleModel,
  buildClinicianReport,
  reportToMarkdown,
  getCategoryForKey,
  formatRange,
} from './clinicianReport.js';

describe('getCategoryForKey', () => {
  it('groups known markers into their panels', () => {
    expect(getCategoryForKey('glucose')).toBe('Metabolic Panel');
    expect(getCategoryForKey('ldl')).toBe('Lipids');
    expect(getCategoryForKey('wbc')).toBe('CBC');
    expect(getCategoryForKey('tsh')).toBe('Thyroid');
  });

  it('falls back to Other for unknown markers', () => {
    expect(getCategoryForKey('mystery_marker')).toBe('Other');
  });
});

describe('formatRange', () => {
  it('formats a range with unit', () => {
    expect(formatRange({ min: 70, max: 99, unit: 'mg/dL' })).toBe('70–99 mg/dL');
  });
  it('omits the unit when blank', () => {
    expect(formatRange({ min: 1, max: 2.5, unit: '' })).toBe('1–2.5');
  });
  it('returns empty string for no range', () => {
    expect(formatRange(null)).toBe('');
  });
});

describe('buildBloodTestModel', () => {
  it('groups markers, classifies status, and surfaces out-of-range flags', () => {
    const model = buildBloodTestModel({
      date: '2025-01-15',
      glucose: 110, // high (range 70-99)
      hdl: 55, // normal
      ldl: 90, // normal
      notANumber: 'skip me',
      missing: null,
    });
    expect(model.date).toBe('2025-01-15');
    const metabolic = model.categories.find(c => c.category === 'Metabolic Panel');
    expect(metabolic.markers.map(m => m.key)).toEqual(['glucose']);
    expect(metabolic.markers[0].status).toBe('high');
    expect(metabolic.markers[0].outOfRange).toBe(true);
    const lipids = model.categories.find(c => c.category === 'Lipids');
    expect(lipids.markers.every(m => !m.outOfRange)).toBe(true);
    expect(model.outOfRange.map(m => m.key)).toEqual(['glucose']);
  });

  it('returns null for non-objects', () => {
    expect(buildBloodTestModel(null)).toBeNull();
    expect(buildBloodTestModel(42)).toBeNull();
  });

  it('labels an undated record', () => {
    expect(buildBloodTestModel({ glucose: 80 }).date).toBe('Undated');
  });
});

describe('buildLifestyleModel', () => {
  it('renders specified lifestyle factors with labels and notes', () => {
    const rows = buildLifestyleModel({
      sex: 'male',
      lifestyle: {
        smokingStatus: 'former',
        exerciseMinutesPerWeek: 200,
        sleepHoursPerNight: 8,
        dietQuality: 'good',
        stressLevel: 'low',
        bmi: 23.1,
        chronicConditions: ['hypertension'],
      },
    });
    const byLabel = Object.fromEntries(rows.map(r => [r.label, r]));
    expect(byLabel['Biological sex'].value).toBe('Male');
    expect(byLabel.Smoking.value).toBe('Former');
    expect(byLabel.Exercise.value).toBe('200 min/week');
    expect(byLabel.BMI.note).toBe('Normal');
    expect(byLabel['Chronic conditions'].value).toBe('hypertension');
  });

  it('marks unspecified factors rather than dropping them', () => {
    const rows = buildLifestyleModel(null);
    const byLabel = Object.fromEntries(rows.map(r => [r.label, r]));
    expect(byLabel['Biological sex'].value).toBe('Not specified');
    expect(byLabel.Smoking.value).toBe('Not specified');
    expect(byLabel.BMI.value).toBe('Not specified');
  });

  it('ignores a non-array chronicConditions value', () => {
    const rows = buildLifestyleModel({ lifestyle: { chronicConditions: 'oops' } });
    expect(rows.some(r => r.label === 'Chronic conditions')).toBe(false);
  });
});

describe('buildClinicianReport + reportToMarkdown', () => {
  const fixture = {
    generatedAt: new Date('2025-02-01T12:00:00Z'),
    tests: [
      { date: '2024-06-01', glucose: 85 },
      { date: '2025-01-15', glucose: 110, hdl: 55 },
    ],
    config: { sex: 'female', lifestyle: { smokingStatus: 'never', bmi: 21 } },
  };

  it('orders blood tests newest-first', () => {
    const report = buildClinicianReport(fixture);
    expect(report.bloodTests.map(t => t.date)).toEqual(['2025-01-15', '2024-06-01']);
  });

  it('tolerates a non-array tests value', () => {
    const report = buildClinicianReport({ tests: 'nope', config: null });
    expect(report.bloodTests).toEqual([]);
  });

  it('renders markdown with lifestyle, panels, ranges, and flags', () => {
    const md = reportToMarkdown(buildClinicianReport(fixture));
    expect(md).toContain('# Clinician Summary — Blood & Lifestyle');
    expect(md).toContain('## Lifestyle');
    expect(md).toContain('| Marker | Value | Reference | Flag |');
    expect(md).toContain('70–99 mg/dL');
    expect(md).toContain('**Out of range:** Glucose 110 mg/dL (High)');
    expect(md.endsWith('\n')).toBe(true);
  });

  it('notes when no blood data exists', () => {
    const md = reportToMarkdown(buildClinicianReport({ tests: [], config: null }));
    expect(md).toContain('_No blood test data on record._');
  });

  it('returns empty string for a null report', () => {
    expect(reportToMarkdown(null)).toBe('');
  });

  it('escapes pipes and newlines in free-text cells so the table stays intact', () => {
    const md = reportToMarkdown(buildClinicianReport({
      tests: [],
      config: { lifestyle: { chronicConditions: ['asthma | mild', 'line1\nline2'] } },
    }));
    const conditionRow = md.split('\n').find(l => l.startsWith('| Chronic conditions'));
    expect(conditionRow).toContain('asthma \\| mild');
    expect(conditionRow).not.toMatch(/\n/);
    // The escaped row still has exactly the 3-column table shape (leading + trailing pipe + 2 separators).
    expect(conditionRow.match(/(?<!\\)\|/g)).toHaveLength(4);
  });
});
