import { describe, expect, it } from 'vitest';
import { closestCenter, rectIntersection } from './collisions.js';
import { keyboardAwareCollisionDetection } from '../dndKeyboardCoordinates.js';

const rect = (left, width) => ({ left, top: 0, width, height: 20, right: left + width, bottom: 20 });
const droppableRects = new Map([['large', rect(0, 80)], ['small', rect(20, 20)]]);
const args = { collisionRect: rect(20, 20), droppableRects, droppableContainers: [{ id: 'large' }, { id: 'small' }] };

describe('drop targets', () => {
  it('ranks overlap by intersection over union and centers by distance', () => {
    expect(rectIntersection(args).map(hit => hit.id)).toEqual(['small', 'large']);
    expect(closestCenter(args).map(hit => hit.id)).toEqual(['small', 'large']);
    const outside = { ...args, collisionRect: rect(80, 20) };
    expect(keyboardAwareCollisionDetection({ ...outside, pointerCoordinates: { x: 90, y: 10 } })).toEqual([]);
    expect(keyboardAwareCollisionDetection(outside)[0].id).toBe('large');
  });
});
