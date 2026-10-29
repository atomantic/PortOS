import { describe, expect, it } from 'vitest';
import { formatHeight, heightScaleLine, resolveHeight, typicalHeightCm } from './characterHeight.js';

const parseHeightCm = (text) => resolveHeight(text, '').cm;

describe('characterHeight', () => {
  it('reads the height formats a director types', () => {
    expect(parseHeightCm('122 cm')).toBe(122);
    expect(parseHeightCm('about 4 ft (122 cm)')).toBe(122);
    expect(parseHeightCm('1.22 m')).toBe(122);
    expect(parseHeightCm('4 ft 2 in')).toBe(127);
    expect(parseHeightCm(`5'7"`)).toBe(170);
    expect(parseHeightCm('5 feet')).toBe(152);
    expect(parseHeightCm('50 inches')).toBe(127);
    expect(parseHeightCm('small for her age')).toBeNull();
    expect(parseHeightCm('999 cm')).toBeNull();
  });

  it('defaults only a child age, and keeps the director\'s own words', () => {
    expect(typicalHeightCm('7')).toBe(122);
    expect(typicalHeightCm('Age 17')).toBe(169);
    expect(typicalHeightCm('27')).toBeNull();
    expect(typicalHeightCm('')).toBeNull();
    expect(formatHeight(122)).toBe('4 ft (122 cm)');
    expect(formatHeight(170)).toBe('5 ft 7 in (170 cm)');
    expect(resolveHeight('', '7')).toEqual({ text: 'about 4 ft (122 cm)', cm: 122 });
    expect(resolveHeight('tiny, 3 ft 9 in', '7')).toEqual({ text: 'tiny, 3 ft 9 in', cm: 114 });
    expect(resolveHeight('', '27')).toBeNull();
  });

  it('sizes a child and an adult against a car, an adult and a doorway', () => {
    const child = heightScaleLine('Nora at age 7', resolveHeight('', '7'));
    expect(child).toContain('Scale: Nora at age 7 is about 4 ft (122 cm) tall');
    expect(child).toContain('shorter than the roof of a parked car');
    expect(child).toContain('their head at about an adult\'s chest');
    expect(child).toContain('a doorway');
    const adult = heightScaleLine('Nora', resolveHeight('5 ft 7 in', ''));
    expect(adult).toContain('a parked car\'s roof reaches about their chest');
    expect(adult).not.toContain('adult\'s');
    expect(heightScaleLine('Nora', resolveHeight('average', ''))).toBe('Scale: Nora is average tall. Keep that true size against the cars, doors, furniture and any people in the frame');
    expect(heightScaleLine('Nora', null)).toBe('');
  });
});
