import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children, ...props }) => (
    <div
      data-testid="threejs-canvas"
      data-alpha={String(props.gl?.alpha)}
      data-dpr={Array.isArray(props.dpr) ? props.dpr.join(',') : String(props.dpr)}
      data-shadows={String(props.shadows)}
      data-camera-position={props.camera?.position?.join(',')}
    >
      {children}
    </div>
  ),
  useFrame: vi.fn(),
}));
// A chainable stand-in for drei's Bounds api, so the explode re-fit is
// observable without a real renderer.
const boundsApi = vi.hoisted(() => {
  const api = {};
  api.refresh = vi.fn(() => api);
  api.clip = vi.fn(() => api);
  api.fit = vi.fn(() => api);
  return api;
});
vi.mock('@react-three/drei', () => ({
  Bounds: ({ children }) => children,
  useBounds: () => boundsApi,
  OrbitControls: () => null,
}));

// r3f object props stringify to "[object Object]" under the DOM renderer, so the
// only way to see WHICH geometry the preview attached is to record it as the real
// builder hands it back.
const built = vi.hoisted(() => []);
vi.mock('../../lib/threejsSculpt', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createSculptBufferGeometry: (definition) => {
      const geometry = actual.createSculptBufferGeometry(definition);
      built.push(geometry);
      return geometry;
    },
  };
});

import ThreejsModelPreview from './ThreejsModelPreview';

const SPEC = {
  name: 'Example model',
  schemaVersion: 1,
  background: '#111827',
  camera: { position: [0, 0, 3], fov: 45, target: [0, 0, 0] },
  lights: [],
  materials: {},
  parts: [],
};

const material = (overrides) => ({
  type: 'standard',
  color: '#8b5a2b',
  metalness: 0,
  roughness: 0.6,
  emissive: '#000000',
  emissiveIntensity: 0,
  opacity: 1,
  transparent: false,
  wireframe: false,
  clearcoat: 0,
  clearcoatRoughness: 0,
  ior: 1.5,
  transmission: 0,
  thickness: 0,
  sheen: 0,
  iridescence: 0,
  anisotropy: 0,
  ...overrides,
});

const part = (id, geometry, materialId, overrides = {}) => ({
  id,
  name: id,
  geometry,
  material: materialId,
  position: [0, 0, 0],
  rotationDegrees: [0, 0, 0],
  scale: [1, 1, 1],
  castShadow: true,
  receiveShadow: true,
  children: [],
  ...overrides,
});

// The preview keeps the picked part in the URL, so every render needs a router.
const renderPreview = (ui, entry = '/') =>
  render(ui, { wrapper: ({ children }) => <MemoryRouter initialEntries={[entry]}>{children}</MemoryRouter> });

const LocationProbe = () => <output data-testid="location-probe">{useLocation().search}</output>;

const box = { type: 'box', width: 1, height: 1, depth: 1 };
const positionOf = (container, name) =>
  container.querySelector(`group[name="${name}"]`).getAttribute('position').split(',').map(Number);
const setExplode = (value) => fireEvent.change(screen.getByLabelText('Explode'), { target: { value: String(value) } });

describe('ThreejsModelPreview', () => {
  it('offers preset and custom preview backgrounds without changing the scene spec', () => {
    renderPreview(<ThreejsModelPreview spec={SPEC} />);

    expect(screen.getByRole('button', { name: 'Black' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Green screen' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByLabelText('Custom preview background color')).toHaveValue('#111827');

    fireEvent.click(screen.getByRole('button', { name: 'White' }));
    expect(screen.getByRole('button', { name: 'White' })).toHaveAttribute('aria-pressed', 'true');
    expect(SPEC.background).toBe('#111827');

    fireEvent.click(screen.getByRole('button', { name: 'Transparent' }));
    expect(screen.getByTestId('threejs-canvas')).toHaveAttribute('data-alpha', 'true');
    expect(screen.getByLabelText('Custom preview background color')).toHaveValue('#000000');
  });

  it('adapts presentation quality locally without changing the generated spec', () => {
    const originalSpec = structuredClone(SPEC);
    renderPreview(<ThreejsModelPreview spec={SPEC} />);

    expect(screen.getByLabelText('Quality')).toHaveValue('auto');
    expect(screen.getByText('Auto · high')).toBeInTheDocument();
    expect(screen.getByTestId('threejs-canvas')).toHaveAttribute('data-dpr', '1,1.5');
    expect(screen.getByTestId('threejs-canvas')).toHaveAttribute('data-shadows', 'soft');

    fireEvent.change(screen.getByLabelText('Quality'), { target: { value: 'low' } });

    expect(screen.getByText('Fixed · low')).toBeInTheDocument();
    expect(screen.getByTestId('threejs-canvas')).toHaveAttribute('data-dpr', '0.75,1');
    expect(screen.getByTestId('threejs-canvas')).toHaveAttribute('data-shadows', 'basic');
    expect(SPEC).toEqual(originalSpec);
  });

  it('keeps deterministic camera and material inspections in validated URL state without changing the spec', () => {
    const spec = { ...SPEC, materials: { body: material() }, parts: [part('body', box, 'body')] };
    renderPreview(<><ThreejsModelPreview spec={spec} family={{ orbitViews: ['side profile'], reviewAxes: ['panel gap continuity'] }} /><LocationProbe /></>, '/?auditCamera=near&auditMode=wireframe');

    expect(screen.getByRole('button', { name: 'Near' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Wireframe' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('threejs-canvas')).toHaveAttribute('data-camera-position', '0,0,1.7999999999999998');
    expect(screen.getByText(/Family review: side profile/)).toBeInTheDocument();
    expect(screen.getByText(/panel gap continuity/)).toBeInTheDocument();
    expect(screen.getByText(/never change the saved model/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Family review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Part boundaries' }));
    expect(screen.getByTestId('location-probe')).toHaveTextContent('auditCamera=family');
    expect(screen.getByTestId('location-probe')).toHaveTextContent('auditMode=boundaries');
    expect(spec).toEqual({ ...SPEC, materials: { body: material() }, parts: [part('body', box, 'body')] });
  });

  it('falls back to the authored final view when an audit URL is stale', () => {
    renderPreview(<ThreejsModelPreview spec={SPEC} />, '/?auditCamera=unknown&auditMode=unknown');

    expect(screen.getByRole('button', { name: 'Authored' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Final' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('preserves an authored overhead direction in near and far bookmarks', () => {
    renderPreview(<ThreejsModelPreview spec={{ ...SPEC, camera: { ...SPEC.camera, position: [0, 3, 0] } }} />, '/?auditCamera=near');

    expect(screen.getByTestId('threejs-canvas')).toHaveAttribute('data-camera-position', '0,1.7999999999999998,0');
  });

  it('renders extrude and tube parts as built buffer geometries', () => {
    const { container } = renderPreview(<ThreejsModelPreview spec={{
      ...SPEC,
      materials: { body: material() },
      parts: [
        part('plate', {
          type: 'extrude',
          outline: [[-1, -1], [1, -1], [1, 1], [-1, 1]],
          holes: [[[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]]],
          depth: 0.4,
          bevelEnabled: false,
          bevelThickness: 0.1,
          bevelSize: 0.1,
          bevelSegments: 2,
          curveSegments: 8,
          steps: 1,
        }, 'body'),
        part('cable', {
          type: 'tube',
          path: [[0, 0, 0], [0, 1, 0.5], [0.6, 1.6, 0]],
          radius: 0.08,
          tubularSegments: 24,
          radialSegments: 8,
          closed: false,
          curveType: 'centripetal',
          tension: 0.5,
        }, 'body'),
      ],
    }} />);

    expect(container.querySelectorAll('primitive[attach="geometry"]')).toHaveLength(2);
    expect(built.map((geometry) => geometry.type)).toEqual(['ExtrudeGeometry', 'TubeGeometry']);
    expect(built.every((geometry) => geometry.getAttribute('position').count > 0)).toBe(true);
  });

  it('forwards physical material channels only to physical materials', () => {
    const { container } = renderPreview(<ThreejsModelPreview spec={{
      ...SPEC,
      materials: {
        glass: material({ type: 'physical', ior: 1.45, transmission: 0.8, thickness: 0.6, sheen: 0.3, iridescence: 0.7, anisotropy: 0.9 }),
        paint: material(),
      },
      parts: [
        part('pane', { type: 'box', width: 1, height: 1, depth: 1 }, 'glass'),
        part('frame', { type: 'box', width: 1, height: 1, depth: 1 }, 'paint'),
      ],
    }} />);

    const physical = container.querySelector('meshPhysicalMaterial');
    expect(physical.getAttribute('ior')).toBe('1.45');
    expect(physical.getAttribute('transmission')).toBe('0.8');
    expect(physical.getAttribute('thickness')).toBe('0.6');
    expect(physical.getAttribute('sheen')).toBe('0.3');
    expect(physical.getAttribute('iridescence')).toBe('0.7');
    expect(physical.getAttribute('anisotropy')).toBe('0.9');

    const standard = container.querySelector('meshStandardMaterial');
    expect(standard.getAttribute('ior')).toBeNull();
    expect(standard.getAttribute('transmission')).toBeNull();
  });
});

// A knife: one blade carrying surface relief that must not fly off on its own,
// plus a separate handle so there is something to separate FROM.
const knifeSpec = () => ({
  ...SPEC,
  materials: { steel: material() },
  parts: [
    part('blade', box, 'steel', {
      name: 'Blade',
      position: [-1, 0, 0],
      children: [part('serrations', box, 'steel', { name: 'Serrations', position: [0, 0.5, 0], explodeWithParent: true })],
    }),
    part('handle', box, 'steel', { name: 'Handle', position: [1, 0, 0] }),
  ],
});

describe('ThreejsModelPreview disassembly', () => {
  beforeEach(() => {
    boundsApi.fit.mockClear();
  });

  it('separates the parts by scaling the layout about the centre, keeping relief on its part', () => {
    const { container } = renderPreview(<ThreejsModelPreview spec={knifeSpec()} />);

    expect(positionOf(container, 'Blade')).toEqual([-1, 0, 0]);
    expect(positionOf(container, 'Handle')).toEqual([1, 0, 0]);

    setExplode(1);

    // Assembled spread is ±1, so a full explode puts each part at ±(2 + clearance) —
    // a real gap opens between them rather than the pair sliding together.
    const [bladeX] = positionOf(container, 'Blade');
    const [handleX] = positionOf(container, 'Handle');
    expect(bladeX).toBeCloseTo(-2.18, 6);
    expect(handleX).toBeCloseTo(2.18, 6);

    // Relief rides the blade — its own transform never changes.
    expect(positionOf(container, 'Serrations')).toEqual([0, 0.5, 0]);
  });

  it('re-fits the camera when the layout actually grows', () => {
    renderPreview(<ThreejsModelPreview spec={knifeSpec()} />);
    boundsApi.fit.mockClear();

    setExplode(0.5);
    expect(boundsApi.refresh).toHaveBeenCalled();
    expect(boundsApi.fit).toHaveBeenCalledTimes(1);

    // Same layout, no wasted re-fit.
    setExplode(0.5);
    expect(boundsApi.fit).toHaveBeenCalledTimes(1);
  });

  it('disables the explode control when there is only one part to move', () => {
    renderPreview(<ThreejsModelPreview spec={{ ...SPEC, materials: { steel: material() }, parts: [part('solo', box, 'steel')] }} />);
    expect(screen.getByLabelText('Explode')).toBeDisabled();
  });

  it('resolves a click on surface relief up to the part it belongs to and highlights that subtree', () => {
    const { container } = renderPreview(<ThreejsModelPreview spec={knifeSpec()} />);

    expect(screen.queryByRole('button', { name: 'Clear part selection' })).not.toBeInTheDocument();

    fireEvent.click(container.querySelector('group[name="Serrations"] mesh'));

    // The sliver is not the answer — the blade it rides is.
    expect(screen.getByText('Blade')).toBeInTheDocument();
    expect(screen.getByText('blade')).toBeInTheDocument();

    const highlighted = container.querySelectorAll('meshStandardMaterial[emissive="#38bdf8"]');
    // Blade + its relief light up together; the handle stays as authored.
    expect(highlighted).toHaveLength(2);
    expect(container.querySelector('group[name="Handle"] meshStandardMaterial').getAttribute('emissive')).toBe('#000000');
  });

  it('moves a container-with-geometry\'s own shell without dragging its child part', () => {
    const { container } = renderPreview(<ThreejsModelPreview spec={{
      ...SPEC,
      materials: { steel: material() },
      parts: [part('body', box, 'steel', {
        name: 'Body',
        children: [
          part('trim', box, 'steel', { name: 'Trim', position: [0, 0, 1] }),
          part('engraving', box, 'steel', { name: 'Engraving', position: [0, 0.5, 0], explodeWithParent: true }),
        ],
      })],
    }} />);

    // Assembled: the body's group sits at the origin and its shell is not offset.
    expect(container.querySelector('group[name="Body"] > group:not([name])')).toBeNull();

    setExplode(1);

    // The body's GROUP must not move — that would carry the trim with it and
    // separate nothing. Its shell moves inside an offset group instead.
    expect(positionOf(container, 'Body')).toEqual([0, 0, 0]);
    const shell = container.querySelector('group[name="Body"] > group:not([name])');
    expect(shell.getAttribute('position').split(',').map(Number).some((value) => value !== 0)).toBe(true);
    expect(shell.querySelector('mesh')).not.toBeNull();
    // The shell's own engraving rides INSIDE that offset group — its authored
    // transform is untouched; it moves only because its wrapper does. Hoist it
    // out and the body separates from its own surface detail.
    expect(container.querySelector('group[name="Body"] > group:not([name]) > group[name="Engraving"]')).not.toBeNull();
    expect(positionOf(container, 'Engraving')).toEqual([0, 0.5, 0]);
    // And the trim moves on its own.
    expect(positionOf(container, 'Trim')).not.toEqual([0, 0, 1]);
  });

  it('keeps the picked part in the URL so it survives a reload and a stale id degrades', () => {
    const { container, unmount } = renderPreview(<ThreejsModelPreview spec={knifeSpec()} />, '/?part=handle');
    expect(screen.getByText('Handle')).toBeInTheDocument();
    expect(container.querySelectorAll('meshStandardMaterial[emissive="#38bdf8"]')).toHaveLength(1);
    unmount();

    // A link to a part this model no longer has must not render an empty label.
    renderPreview(<ThreejsModelPreview spec={knifeSpec()} />, '/?part=noSuchPart');
    expect(screen.queryByRole('button', { name: 'Clear part selection' })).not.toBeInTheDocument();
  });

  it('selects a plain part on its own and clears the selection', () => {
    const { container } = renderPreview(<ThreejsModelPreview spec={knifeSpec()} />);

    fireEvent.click(container.querySelector('group[name="Handle"] mesh'));
    expect(screen.getByText('Handle')).toBeInTheDocument();
    expect(container.querySelectorAll('meshStandardMaterial[emissive="#38bdf8"]')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Clear part selection' }));
    expect(container.querySelectorAll('meshStandardMaterial[emissive="#38bdf8"]')).toHaveLength(0);
  });
});

// The knife again, this time with a declared articulation graph: the handle is
// the root and the blade pivots about a named socket.
const articulatedKnifeSpec = () => ({
  ...knifeSpec(),
  sockets: [{ name: 'bladePivot', parentPartId: 'handle', position: [0, 0, 0], rotationDegrees: [0, 0, 0] }],
  articulation: {
    joints: [
      { id: 'rootJoint', partId: 'handle', parentJointId: null, pivotSocket: null },
      { id: 'bladeJoint', partId: 'blade', parentJointId: 'rootJoint', pivotSocket: 'bladePivot' },
    ],
    attachmentPartIds: [],
  },
});

describe('ThreejsModelPreview articulation status', () => {
  it('calls a spec with no articulation a static assembly, never animation-ready', () => {
    renderPreview(<ThreejsModelPreview spec={knifeSpec()} />);
    expect(screen.getByText('Static assembly')).toBeInTheDocument();
    expect(screen.queryByText(/Articulation-ready/)).not.toBeInTheDocument();
  });

  it('reports a usable graph with its joint and pivot counts', () => {
    renderPreview(<ThreejsModelPreview spec={articulatedKnifeSpec()} />);
    expect(screen.getByText('Articulation-ready · 2 joints · 1 pivot')).toBeInTheDocument();
  });

  // Schema-valid but rig-useless: the child joint has no axis, so the badge must
  // agree with the server's report instead of claiming a rig off mere presence.
  it('stays static when a child joint names no pivot socket, and says how many joints it saw', () => {
    const spec = articulatedKnifeSpec();
    spec.articulation.joints[1].pivotSocket = null;
    renderPreview(<ThreejsModelPreview spec={spec} />);
    expect(screen.getByText('Static assembly · 2 joints declared')).toBeInTheDocument();
  });

  it('names the joint driving a picked part, and the fact when it has no pivot', () => {
    const { container } = renderPreview(<ThreejsModelPreview spec={articulatedKnifeSpec()} />);

    fireEvent.click(container.querySelector('group[name="Blade"] mesh'));
    expect(screen.getByText('joint bladeJoint · pivot bladePivot')).toBeInTheDocument();

    fireEvent.click(container.querySelector('group[name="Handle"] mesh'));
    expect(screen.getByText('joint rootJoint · no pivot')).toBeInTheDocument();
  });

  it('renders a legacy spec with no articulation key without crashing the picker', () => {
    const { container } = renderPreview(<ThreejsModelPreview spec={knifeSpec()} />);
    fireEvent.click(container.querySelector('group[name="Handle"] mesh'));
    expect(screen.getByText('Handle')).toBeInTheDocument();
    expect(screen.queryByText(/^joint /)).not.toBeInTheDocument();
  });
});

const clipSpec = () => ({
  ...knifeSpec(),
  animation: {
    cues: [{ id: 'latchRelease', label: 'Latch lets go', kind: 'latch' }],
    clips: [
      {
        id: 'deploy',
        name: 'Deploy',
        role: 'deploy',
        durationSeconds: 2,
        loop: false,
        sequences: [
          {
            id: 'swingBlade',
            name: 'Swing blade',
            partId: 'blade',
            startSeconds: 0,
            endSeconds: 1,
            easing: 'linear',
            channels: { position: { from: [-1, 0, 0], to: [-1, 4, 0] } },
            cueId: 'latchRelease',
          },
          {
            id: 'dropHandle',
            name: 'Drop handle',
            partId: 'handle',
            startSeconds: 1,
            endSeconds: 2,
            easing: 'linear',
            channels: { visible: { from: true, to: false }, opacity: { from: 1, to: 0 } },
            cueId: null,
          },
        ],
      },
      {
        id: 'retract',
        name: 'Retract',
        role: 'retract',
        durationSeconds: 1,
        loop: false,
        sequences: [{
          id: 'foldBlade',
          name: 'Fold blade',
          partId: 'blade',
          startSeconds: 0,
          endSeconds: 1,
          easing: 'linear',
          channels: { position: { from: [-1, 4, 0], to: [-1, 0, 0] } },
          cueId: null,
        }],
      },
    ],
  },
});

const scrub = (value) => fireEvent.change(screen.getByLabelText('Time'), { target: { value: String(value) } });
const opacityOf = (container, name) =>
  container.querySelector(`group[name="${name}"] meshStandardMaterial`).getAttribute('opacity');

describe('ThreejsModelPreview clips', () => {
  let frames = [];
  let nowMs = 0;

  beforeEach(() => {
    frames = [];
    nowMs = 0;
    // A hand-driven frame queue, so playback is stepped deterministically
    // instead of waiting on the browser's own rAF cadence.
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => frames.push(callback));
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const advance = (ms) => {
    nowMs += ms;
    const pending = frames.splice(0);
    act(() => {
      for (const callback of pending) callback(nowMs);
    });
  };

  it('shows no transport for a model that declares no clips', () => {
    renderPreview(<ThreejsModelPreview spec={knifeSpec()} />);
    expect(screen.queryByLabelText('Clip')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Play clip')).not.toBeInTheDocument();
  });

  it('renders a declared clip at its start pose and keeps undriven parts as authored', () => {
    const { container } = renderPreview(<ThreejsModelPreview spec={clipSpec()} />);

    expect(screen.getByLabelText('Clip')).toHaveValue('deploy');
    expect(positionOf(container, 'Blade')).toEqual([-1, 0, 0]);
    // Undriven at t=0: the handle keeps the authored material, with no opacity
    // override in sight.
    expect(opacityOf(container, 'Handle')).toBe('1');
  });

  it('scrubs to any time deterministically, including the visibility step at a window end', () => {
    const { container } = renderPreview(<ThreejsModelPreview spec={clipSpec()} />);

    scrub(0.5);
    expect(positionOf(container, 'Blade')).toEqual([-1, 2, 0]);
    expect(screen.getByText('Swing blade')).toBeInTheDocument();

    scrub(1.5);
    // Past its window the blade holds where its sequence left it, while the
    // handle is half faded through the window that is still running. (The
    // `visible` step riding the same sequence is asserted in the evaluator's own
    // suite — React drops a boolean prop on an unrecognized element, so the DOM
    // stand-in for a three.js group cannot show it.)
    expect(positionOf(container, 'Blade')).toEqual([-1, 4, 0]);
    expect(opacityOf(container, 'Handle')).toBe('0.5');

    scrub(2);
    expect(opacityOf(container, 'Handle')).toBe('0');
  });

  it('never fires a cue while scrubbing', () => {
    const onCue = vi.fn();
    renderPreview(<ThreejsModelPreview spec={clipSpec()} onCue={onCue} />);

    scrub(0.5);
    scrub(0);
    scrub(1.2);
    expect(onCue).not.toHaveBeenCalled();
  });

  it('plays the clip forward, fires each crossed cue once, and stops at the end', () => {
    const onCue = vi.fn();
    const { container } = renderPreview(<ThreejsModelPreview spec={clipSpec()} onCue={onCue} />);

    fireEvent.click(screen.getByLabelText('Play clip'));
    advance(500);
    expect(positionOf(container, 'Blade')).toEqual([-1, 2, 0]);
    expect(onCue).toHaveBeenCalledTimes(1);
    expect(onCue).toHaveBeenCalledWith(expect.objectContaining({
      cueId: 'latchRelease',
      sequenceId: 'swingBlade',
      partId: 'blade',
      clipId: 'deploy',
      cue: expect.objectContaining({ label: 'Latch lets go', kind: 'latch' }),
    }));

    advance(500);
    expect(onCue).toHaveBeenCalledTimes(1);

    // Past the authored duration the clip stops on its final pose instead of
    // running on, and the transport flips back to offering Play.
    advance(2_000);
    expect(screen.getByLabelText('Play clip')).toBeInTheDocument();
    expect(screen.getByText('2.00/2.00s')).toBeInTheDocument();
    expect(frames).toHaveLength(0);
  });

  it('applies the speed multiplier to the playhead', () => {
    renderPreview(<ThreejsModelPreview spec={clipSpec()} />);

    fireEvent.change(screen.getByLabelText('Speed'), { target: { value: '2' } });
    fireEvent.click(screen.getByLabelText('Play clip'));
    advance(500);
    expect(screen.getByText('1.00/2.00s')).toBeInTheDocument();
  });

  it('stops back to the clip start and releases the frame loop on unmount', () => {
    const { unmount } = renderPreview(<ThreejsModelPreview spec={clipSpec()} />);

    fireEvent.click(screen.getByLabelText('Play clip'));
    advance(500);
    fireEvent.click(screen.getByLabelText('Stop clip'));
    expect(screen.getByText('0.00/2.00s')).toBeInTheDocument();
    expect(globalThis.cancelAnimationFrame).toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('Play clip'));
    globalThis.cancelAnimationFrame.mockClear();
    unmount();
    expect(globalThis.cancelAnimationFrame).toHaveBeenCalled();
  });

  it('keeps the open clip in the URL and rewinds when it changes', () => {
    const { container } = renderPreview(
      <><ThreejsModelPreview spec={clipSpec()} /><LocationProbe /></>,
      '/?clip=retract',
    );

    expect(screen.getByLabelText('Clip')).toHaveValue('retract');
    expect(positionOf(container, 'Blade')).toEqual([-1, 4, 0]);

    scrub(0.5);
    fireEvent.change(screen.getByLabelText('Clip'), { target: { value: 'deploy' } });
    expect(screen.getByTestId('location-probe')).toHaveTextContent('clip=deploy');
    expect(screen.getByText('0.00/2.00s')).toBeInTheDocument();
  });

  it('falls back to the first clip when the URL names one this model does not have', () => {
    renderPreview(<ThreejsModelPreview spec={clipSpec()} />, '/?clip=noSuchClip');
    expect(screen.getByLabelText('Clip')).toHaveValue('deploy');
  });

  it('leaves explode and part picking working while a clip is posed', () => {
    const { container } = renderPreview(<ThreejsModelPreview spec={clipSpec()} />);

    scrub(1);
    setExplode(1);
    // The clip's pose and the disassembly offset compose rather than replacing
    // each other: the blade sits at its posed Y with the explode offset on top.
    const [bladeX, bladeY] = positionOf(container, 'Blade');
    expect(bladeY).toBe(4);
    expect(bladeX).toBeCloseTo(-2.18, 6);

    fireEvent.click(container.querySelector('group[name="Blade"] mesh'));
    expect(screen.getByText('Blade')).toBeInTheDocument();
  });
});

describe('ThreejsModelPreview clip framing and looping', () => {
  let frames = [];
  let nowMs = 0;

  beforeEach(() => {
    frames = [];
    nowMs = 0;
    boundsApi.fit.mockClear();
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => frames.push(callback));
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const advance = (ms) => {
    nowMs += ms;
    const pending = frames.splice(0);
    act(() => {
      for (const callback of pending) callback(nowMs);
    });
  };

  it('re-frames when a different clip opens, but never chases a playing one', () => {
    renderPreview(<ThreejsModelPreview spec={clipSpec()} />);
    boundsApi.fit.mockClear();

    // Scrubbing and playing move parts every frame — a camera that re-fit on
    // each of them would chase the mechanism instead of watching it.
    scrub(0.5);
    fireEvent.click(screen.getByLabelText('Play clip'));
    advance(300);
    expect(boundsApi.fit).not.toHaveBeenCalled();

    // Opening another clip is a discrete jump to a pose that can sit well
    // outside the assembled one, so that one does re-frame.
    fireEvent.change(screen.getByLabelText('Clip'), { target: { value: 'retract' } });
    expect(boundsApi.fit).toHaveBeenCalled();
  });

  it('fires every cue once across a frame gap longer than a looping clip', () => {
    const spec = clipSpec();
    spec.animation.clips[0].loop = true;
    const onCue = vi.fn();
    renderPreview(<ThreejsModelPreview spec={spec} onCue={onCue} />);

    fireEvent.click(screen.getByLabelText('Play clip'));
    // 7s on a 2s loop: three and a half cycles skipped in one frame. Every cue
    // fires once for the gap — not once per skipped cycle, and not zero times.
    advance(7_000);
    expect(onCue).toHaveBeenCalledTimes(1);
    expect(onCue).toHaveBeenCalledWith(expect.objectContaining({ cueId: 'latchRelease' }));
    // ...and the clip keeps running from where it wrapped to.
    expect(screen.getByText('1.00/2.00s')).toBeInTheDocument();

    advance(1_500);
    expect(onCue).toHaveBeenCalledTimes(2);
  });
});

describe('ThreejsModelPreview clip refresh', () => {
  it('rewinds and stops when a refinement rewrites the open clip under the same id', () => {
    const { rerender } = renderPreview(<ThreejsModelPreview spec={clipSpec()} />);
    scrub(1.2);
    expect(screen.getByText('1.20/2.00s')).toBeInTheDocument();

    // The detail page re-fetches every 2s while a generation runs: an equivalent
    // snapshot must not throw away where the user scrubbed to.
    rerender(<ThreejsModelPreview spec={clipSpec()} />);
    expect(screen.getByText('1.20/2.00s')).toBeInTheDocument();

    // A refinement that hands back a rewritten `deploy` is a different clip
    // wearing the same id — evaluating it at the old playhead would pose the
    // model somewhere the new clip never authored.
    const refined = clipSpec();
    refined.animation.clips[0].durationSeconds = 5;
    refined.animation.clips[0].sequences[0].endSeconds = 3;
    rerender(<ThreejsModelPreview spec={refined} />);
    expect(screen.getByText('0.00/5.00s')).toBeInTheDocument();
  });
});
