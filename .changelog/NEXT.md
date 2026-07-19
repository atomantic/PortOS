# Unreleased Changes

## Changed

- CyberCity exploration mode now renders the player character using the bundled rigged GLB avatar (three.js's RobotExpressive, the same `data/avatar/model.glb` the CoS "Cyber Muse" avatar uses) instead of the hand-built procedural cyber-runner. Skeletal clips crossfade off the movement rig's state: `idle` → Idle, `walk` → Walking, `run` → Running, `hover` → Jump. Walking/Running are routed to their neutralized "in place" treadmill variants (the rig owns world position), and the runner keeps its own textures with a themed accent ground-glow footprint. The GLB avatar is Suspense- and error-boundary-wrapped so a streaming or missing model degrades to "no visible runner" instead of blanking or crashing the city canvas.
- CyberCity exploration mode now supports jumping with the Space bar — a gravity-based hop (E/Q free-fly still takes precedence). In exploration mode Space is captured before it reaches the global voice push-to-talk hotkey, so jumping no longer toggles the voice agent.
