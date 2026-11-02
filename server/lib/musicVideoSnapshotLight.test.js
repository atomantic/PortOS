import { describe, it, expect } from 'vitest';
import { AMATEUR_SNAPSHOT_LIGHT, SCENE_LIGHT_ON_PEOPLE, isAmateurLook, peopleLightLine } from './musicVideoSnapshotLight.js';

describe('Music Video lighting on people', () => {
  it('recognizes amateur snapshot and home-video looks', () => {
    expect(isAmateurLook('Faded consumer color; harsh direct pop-up flash; VHS-C chroma bleed')).toBe(true);
    expect(isAmateurLook('', 'Found 1986 teen snapshots and home video')).toBe(true);
    expect(isAmateurLook('Glossy anamorphic cinema, teal and orange')).toBe(false);
    expect(isAmateurLook('Clean cinematic lighting; avoid VHS and amateur aesthetics')).toBe(false);
    expect(isAmateurLook('Faded Kodak Gold; harsh pop-up flash; no HDR, no gloss')).toBe(true);
    expect(isAmateurLook('VHS-C home video with no studio lights')).toBe(true);
    expect(isAmateurLook('Clean digital cinema; avoid VHS, camcorder grain, or Polaroid effects')).toBe(false);
  });

  it('allows bad light for an amateur look, and keeps people in the scene light when asked', () => {
    expect(peopleLightLine(['cheap 35mm snapshot prints'])).toBe(AMATEUR_SNAPSHOT_LIGHT);
    expect(peopleLightLine(['glossy studio pop video'])).toBe('');
    expect(peopleLightLine(['glossy studio pop video'], { always: true })).toBe(SCENE_LIGHT_ON_PEOPLE);
  });
});
