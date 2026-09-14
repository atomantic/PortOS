import { describe, expect, it } from 'vitest';
import {
  APPLIED_NUMERACY_FAMILIES,
  generateAppliedNumeracyDrill,
  parseAppliedNumeracyAnswer,
  scoreAppliedNumeracyDrill,
} from './postAppliedNumeracy.js';

describe('Applied Numeracy', () => {
  it('generates reproducible packs from a seed', () => {
    const config = { seed: 4443, count: 5, difficulty: 2 };
    expect(generateAppliedNumeracyDrill(config)).toEqual(generateAppliedNumeracyDrill(config));
  });

  it.each(APPLIED_NUMERACY_FAMILIES)('scores a server-rebuilt %s fixture', (family) => {
    const drill = generateAppliedNumeracyDrill({ seed: 12, family, count: 1, difficulty: 2 });
    const result = scoreAppliedNumeracyDrill(
      [{ answered: drill.questions[0].answerDisplay, responseMs: 1000 }],
      120000,
      drill.config,
    );
    expect(result.questions[0]).toMatchObject({ correct: true, prompt: drill.questions[0].prompt });
    expect(result.accuracy).toBe(1);
  });

  it('accepts equivalent fractions but rejects a zero denominator', () => {
    const drill = generateAppliedNumeracyDrill({ seed: 8, family: 'ratio', count: 1, difficulty: 3 });
    const [, blue, yellow] = drill.questions[0].prompt.match(/(\d+) blue tiles and (\d+) yellow/);
    const fraction = `${blue}/${Number(blue) + Number(yellow)}`;
    const result = scoreAppliedNumeracyDrill([{ answered: fraction, responseMs: 1000 }], 120000, drill.config);

    expect(result.questions[0].correct).toBe(true);
    expect(parseAppliedNumeracyAnswer('-2.5')).toEqual({ value: -2.5, unit: null });
    expect(parseAppliedNumeracyAnswer('3/0')).toBe(null);
  });

  it('reads a bare number as the requested unit while still converting named units', () => {
    const drill = generateAppliedNumeracyDrill({ seed: 10, family: 'unit', count: 1, difficulty: 1 });
    const question = drill.questions[0];
    const units = Object.entries(question.unitOptions);
    const [alternateUnit, alternateFactor] = units.find(([unit]) => unit !== question.unit);
    const equivalent = question.expected * question.unitOptions[question.unit] / alternateFactor;

    const accepted = scoreAppliedNumeracyDrill([{ answered: `${equivalent} ${alternateUnit}`, responseMs: 1000 }], 120000, drill.config);
    const bareNumber = scoreAppliedNumeracyDrill([{ answered: String(question.expected), responseMs: 1000 }], 120000, drill.config);
    // The unit is assumed, not ignored: the same digits under another unit stay wrong.
    const bareWrongMagnitude = scoreAppliedNumeracyDrill([{ answered: String(equivalent), responseMs: 1000 }], 120000, drill.config);
    const wrongUnit = scoreAppliedNumeracyDrill([{ answered: `${question.expected} bananas`, responseMs: 1000 }], 120000, drill.config);

    expect(accepted.questions[0].correct).toBe(true);
    expect(bareNumber.questions[0].correct).toBe(true);
    expect(bareWrongMagnitude.questions[0].correct).toBe(false);
    expect(wrongUnit.questions[0].correct).toBe(false);
  });

  it('ignores a redundant noun on a question that has no unit of its own', () => {
    const drill = generateAppliedNumeracyDrill({ seed: 22, family: 'rate', count: 1, difficulty: 2 });
    const question = drill.questions[0];
    const result = scoreAppliedNumeracyDrill([{ answered: `${question.expected} cards`, responseMs: 1000 }], 120000, drill.config);

    expect(question.unit).toBeUndefined();
    expect(result.questions[0].correct).toBe(true);
  });

  it('keeps the expected value out of the prompt label', () => {
    // The label must carry no digits at all — the leak it guards against was an
    // example built from the answer ("for example, 4000 ml").
    const drill = generateAppliedNumeracyDrill({ seed: 10, count: 10, difficulty: 2 });
    drill.questions.forEach((question) => {
      expect(question.promptLabel).not.toMatch(/\d/);
    });
  });

  it('honors inclusive absolute and relative tolerance boundaries', () => {
    const absolute = generateAppliedNumeracyDrill({ seed: 5, family: 'estimate', count: 1, difficulty: 1 });
    const absoluteQuestion = absolute.questions[0];
    const absoluteResult = scoreAppliedNumeracyDrill([{
      answered: String(absoluteQuestion.expected + absoluteQuestion.tolerance.absolute), responseMs: 1000,
    }], 120000, absolute.config);
    const relative = generateAppliedNumeracyDrill({ seed: 5, family: 'estimate', count: 1, difficulty: 2 });
    const relativeQuestion = relative.questions[0];
    const relativeResult = scoreAppliedNumeracyDrill([{
      answered: String(relativeQuestion.expected * (1 + relativeQuestion.tolerance.relative)), responseMs: 1000,
    }], 120000, relative.config);

    expect(absoluteResult.questions[0].correct).toBe(true);
    expect(relativeResult.questions[0].correct).toBe(true);
  });

  it('ignores client-supplied prompts and answer keys', () => {
    const drill = generateAppliedNumeracyDrill({ seed: 22, family: 'rate', count: 1, difficulty: 2 });
    const result = scoreAppliedNumeracyDrill([{
      prompt: 'client replacement', expected: 999999, answered: '999999', correct: true, responseMs: 1000,
    }], 120000, drill.config);

    expect(result.questions[0].prompt).toBe(drill.questions[0].prompt);
    expect(result.questions[0].correct).toBe(false);
  });
});
