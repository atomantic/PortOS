import { useMemo, useEffect } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { openWorldDayMix, mixHex, getAccentColor } from './openWorldConstants';
import { useOpenWorldPalette } from './OpenWorldPaletteContext';
import { computeStreets, PARCELS, PLAZA } from '../../utils/openWorldPlan';

// The street network from the master plan (openWorldPlan.js): an octagonal ring road around
// downtown, spokes out to every district, the grand avenue to the harbor, a plaza
// sidewalk ring, crosswalk bands, and a faint tinted ground pad under each district.
// Everything merges into THREE draw calls total (asphalt / neon edge strips / paint),
// using native merged geometry — never drei <Line> (broken in this three-stdlib combo).

const STRIP_WIDTH = 0.16;

// A flat rectangle at ground level: PlaneGeometry(length × width) rotated into XZ and
// aimed along `angle` (atan2(dz,dx) convention — rotateY(-angle) maps +x onto it).
const flatRect = (x, z, length, width, angle, y) => {
  const geom = new THREE.PlaneGeometry(length, width);
  geom.rotateX(-Math.PI / 2);
  geom.rotateY(-angle);
  geom.translate(x, y, z);
  return geom;
};

export default function OpenWorldStreets({ settings }) {
  const { accent, neonAccents } = useOpenWorldPalette();
  const dayMix = openWorldDayMix(settings);

  const streets = useMemo(() => computeStreets(), []);

  // Asphalt: every street segment, one merged geometry.
  const asphaltGeom = useMemo(() => {
    const rects = streets.segments.map((s) => flatRect(s.x, s.z, s.length, s.width, s.angle, 0.02));
    return mergeGeometries(rects);
  }, [streets]);

  // Neon edge strips: a thin glowing border along each side of every segment.
  const stripGeom = useMemo(() => {
    const rects = [];
    for (const s of streets.segments) {
      const off = s.width / 2 + STRIP_WIDTH;
      const px = -Math.sin(s.angle) * off;
      const pz = Math.cos(s.angle) * off;
      rects.push(flatRect(s.x + px, s.z + pz, s.length, STRIP_WIDTH, s.angle, 0.025));
      rects.push(flatRect(s.x - px, s.z - pz, s.length, STRIP_WIDTH, s.angle, 0.025));
    }
    return mergeGeometries(rects);
  }, [streets]);

  // Paint layer: crosswalk bands + the plaza sidewalk ring + tinted district pads,
  // vertex-colored so one material covers all of it.
  const paintGeom = useMemo(() => {
    const parts = [];
    const paintColor = new THREE.Color('#aab4c2');
    const pushColored = (geom, color) => {
      const count = geom.getAttribute('position').count;
      const arr = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        arr[i * 3] = color.r;
        arr[i * 3 + 1] = color.g;
        arr[i * 3 + 2] = color.b;
      }
      geom.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      parts.push(geom);
    };

    for (const c of streets.crosswalks) {
      pushColored(flatRect(c.x, c.z, c.length, c.width, c.angle, 0.028), paintColor);
    }

    // Dashed center marks make the southern drop-in lane read as a drivable approach
    // instead of a dark rectangle, especially on the first mobile frame.
    for (const arrival of streets.segments.filter((segment) => segment.kind === 'arrival')) {
      const dashLength = 1.5;
      const dashGap = 3.4;
      const count = Math.floor(arrival.length / (dashLength + dashGap));
      const cos = Math.cos(arrival.angle);
      const sin = Math.sin(arrival.angle);
      for (let i = 0; i < count; i++) {
        const along = -arrival.length / 2 + dashLength / 2 + i * (dashLength + dashGap);
        pushColored(
          flatRect(arrival.x + cos * along, arrival.z + sin * along, dashLength, 0.12, arrival.angle, 0.032),
          new THREE.Color(mixHex('#f2d49c', '#ffffff', dayMix * 0.35)),
        );
      }
    }

    // A faceted plaza floor gives the central AI Core a readable stage even when
    // there are no live app towers yet. The outer sidewalk ring remains separate,
    // so the avenue and ring road still read as the town's navigation landmarks.
    const plaza = new THREE.CircleGeometry(PLAZA.radius, 12);
    plaza.rotateX(-Math.PI / 2);
    plaza.translate(0, 0.022, 0);
    pushColored(plaza, new THREE.Color(mixHex('#2e4b55', '#c7b995', dayMix)));

    const ring = new THREE.RingGeometry(streets.plazaRing.inner, streets.plazaRing.outer, 48);
    ring.rotateX(-Math.PI / 2);
    ring.translate(0, 0.018, 0);
    pushColored(ring, paintColor.clone().multiplyScalar(0.6));

    // District ground pads — a quiet color wash so each quarter reads as a zone.
    // The pad color is each district's deterministic neon accent (same picker the
    // buildings use), well under the labels so it never competes with them.
    for (const [id, parcel] of Object.entries(PARCELS)) {
      if (parcel.dynamic || parcel.water || parcel.noPad) continue;
      const tint = new THREE.Color(getAccentColor({ name: id }, neonAccents)).multiplyScalar(0.5);
      pushColored(flatRect(parcel.anchor[0], parcel.anchor[2], parcel.w, parcel.d, 0, 0.012), tint);
    }

    return mergeGeometries(parts);
  }, [streets, neonAccents]);

  useEffect(() => () => {
    asphaltGeom.dispose();
    stripGeom.dispose();
    paintGeom.dispose();
  }, [asphaltGeom, stripGeom, paintGeom]);

  // Night: deep blue asphalt with accent-glow borders. Day: slate-blue roads keep
  // their contrast against the sage ground instead of disappearing into a gray slab.
  const asphaltColor = mixHex('#152536', '#536d7a', dayMix);
  const stripOpacity = 0.55 * (1 - dayMix) + 0.25 * dayMix;
  const paintOpacity = 0.16 + 0.18 * dayMix;

  return (
    <group>
      <mesh geometry={asphaltGeom}>
        <meshStandardMaterial color={asphaltColor} roughness={0.92} metalness={0.08} />
      </mesh>
      <mesh geometry={stripGeom}>
        <meshBasicMaterial color={mixHex(accent, '#f1d5a5', dayMix)} transparent opacity={stripOpacity} toneMapped={false} />
      </mesh>
      <mesh geometry={paintGeom}>
        <meshBasicMaterial vertexColors transparent opacity={paintOpacity} />
      </mesh>
    </group>
  );
}
