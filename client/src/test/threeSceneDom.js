// Keep React in charge of scene component lifecycles while representing only
// the inspected Three.js properties as DOM data attributes.
export function withThreeSceneDom(runtime, hostTypes) {
  const wrap = (create) => (type, props, ...args) => {
    if (!hostTypes.includes(type)) return create(type, props, ...args);
    const { children, onClick, ...sceneProps } = props;
    const attributes = { 'data-three': type };
    for (const name of ['attach', 'name', 'position', 'ior', 'transmission', 'thickness', 'sheen', 'iridescence', 'anisotropy', 'envMapIntensity', 'emissive', 'opacity']) {
      if (sceneProps[name] != null) attributes[`data-${name.toLowerCase()}`] = String(sceneProps[name]);
    }
    return create('div', { ...attributes, onClick, children }, ...args);
  };

  return {
    ...runtime,
    ...(runtime.jsx ? { jsx: wrap(runtime.jsx), jsxs: wrap(runtime.jsxs) } : { jsxDEV: wrap(runtime.jsxDEV) }),
  };
}
