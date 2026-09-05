/** Bounded, deterministic island scenery. No textures, downloads, or AI calls. */
export function appendEidoverseIslandLandscape(quad) {
  const steps = 128;
  const tau = Math.PI * 2;
  const coast = (angle) => 1 + 0.07 * Math.sin(3 * angle) + 0.04 * Math.cos(7 * angle);
  const point = (radius, height, angle, irregular = true) => [
    Math.sin(angle) * radius * (irregular ? coast(angle) : 1), height,
    Math.cos(angle) * radius * (irregular ? coast(angle) : 1),
  ];
  const face = (points, color, material = 0) => {
    const [a, b, c] = points;
    const u = b.map((value, i) => value - a[i]), v = c.map((value, i) => value - a[i]);
    const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.hypot(...normal) || 1;
    quad(points, normal.map(value => value / length), color, material);
  };
  // The inner skirt starts beyond the halls, then covers every corner of the
  // original 180m terrain. A beach slopes into the water instead of a cut edge.
  const bands = [[65, 0.03], [82, 0.8], [110, 1.8], [145, 1.2], [160, 0.8], [178, -1.2]];
  for (let band = 0; band < bands.length - 1; band += 1) {
    for (let i = 0; i < steps; i += 1) {
      const a = i / steps * tau, b = (i + 1) / steps * tau;
      const [inner, low] = bands[band], [outer, high] = bands[band + 1];
      face([point(inner, low, a), point(outer, high, a), point(outer, high, b), point(inner, low, b)],
        band >= 3 ? '#cfbc91' : ['#527044', '#5d794b', '#698151'][band]);
    }
  }
  // Eight kilometres of ocean keep its edge beyond the useful horizon. Near
  // water carries a turquoise shelf; offshore water stays a quieter deep blue.
  for (const [inner, outer, color] of [[155, 205, '#4caaaa'], [205, 290, '#398e9e'], [290, 8000, '#326a83']]) {
    for (let i = 0; i < steps; i += 1) {
      const a = i / steps * tau, b = (i + 1) / steps * tau;
      face([point(inner, -0.65, a), point(outer, -0.65, a), point(outer, -0.65, b), point(inner, -0.65, b)], color, 2);
    }
  }
  // Separated islands leave sea passages and open horizon between silhouettes.
  // Several rings of asymmetric ridges read as a landscape rather than cones.
  for (const [index, [angle, distance, width, height]] of [
    [0.25, 680, 210, 160], [0.82, 1100, 270, 240], [1.6, 780, 150, 125],
    [2.45, 1400, 330, 280], [3.35, 920, 220, 180], [3.95, 1500, 290, 260],
    [4.65, 650, 150, 110], [5.5, 1250, 250, 225],
  ].entries()) {
    const cx = Math.sin(angle) * distance, cz = Math.cos(angle) * distance;
    const rings = [[1, -0.7], [0.82, height * 0.13], [0.52, height * 0.45], [0.22, height * 0.83], [0, height]];
    const vertex = (ring, theta) => {
      const [radius, y] = rings[ring];
      const ripple = 1 + 0.16 * Math.sin(theta * 5 + index) + 0.09 * Math.cos(theta * 3);
      return [cx + Math.sin(theta) * width * radius * ripple + (1 - radius) * width * 0.22,
        y * (1 + radius * 0.2 * Math.sin(theta * 3 + index)), cz + Math.cos(theta) * width * radius * ripple];
    };
    for (let ring = 0; ring < rings.length - 1; ring += 1) for (let i = 0; i < 40; i += 1) {
      const a = i / 40 * tau, b = (i + 1) / 40 * tau;
      face([vertex(ring + 1, a), vertex(ring, a), vertex(ring, b), vertex(ring + 1, b)],
        ['#697f72', '#63796e', '#7c8985', height > 200 ? '#d0d8d3' : '#8d9a95'][ring]);
    }
  }
}
