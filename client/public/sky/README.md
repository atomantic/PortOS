City sky textures
=================

- `city-night-galaxy-8k.jpg`
  - 8192×4096 equirectangular (2:1) Milky Way panorama used as the City night sky.
  - Wired through three.js's environment system in `CityGalaxySky.jsx`: assigned to
    `scene.background` (the 360° spheremap backdrop) and, via `PMREMGenerator`, to
    `scene.environment` (image-based lighting on the PBR building/ground materials).
  - Source: "Stars Milky Way" 8K texture, Solar System Scope
    (https://www.solarsystemscope.com/textures/). License: **CC BY 4.0**.
    Attribution: *Textures by Solar System Scope (solarsystemscope.com), CC BY 4.0.*
  - Brightness/saturation graded up for the City's stylized night (the raw panorama is a
    realistic, dark sky); regenerate from the original with `sharp().modulate(...)`.
  - Replaced the prior AI-generated `city-night-galaxy-sphere.png` (1774×887), which was
    too low-resolution for a full-sky background — a ~50° FOV samples only ~14% of the
    panorama width, so the small source was visibly pixelated when upscaled.
