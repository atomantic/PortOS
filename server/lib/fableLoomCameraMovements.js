/**
 * Camera-direction vocabulary shared by FableLoom's AI prompts and editor.
 * Values are stable persisted ids; labels and prompt text may improve without
 * migrating existing scene nodes.
 */

export const FABLELOOM_CAMERA_MOVEMENTS = Object.freeze([
  { value: 'locked-off', label: 'Locked-off / static', prompt: 'Locked-off tripod shot; the camera remains completely still.' },
  { value: 'slow-dolly-in', label: 'Slow dolly in', prompt: 'Camera slowly moves forward toward the subject.' },
  { value: 'slow-dolly-out', label: 'Slow dolly out', prompt: 'Camera slowly moves backward away from the subject.' },
  { value: 'fast-dolly-in', label: 'Fast dolly in', prompt: 'Camera rapidly pushes toward the subject with urgent motion.' },
  { value: 'dolly-zoom', label: 'Dolly zoom / vertigo', prompt: 'Camera dollies while zooming in the opposite direction, warping background scale.' },
  { value: 'zoom-in', label: 'Optical zoom in', prompt: 'Stationary camera smoothly magnifies the subject with the lens.' },
  { value: 'zoom-out', label: 'Optical zoom out', prompt: 'Stationary camera smoothly widens the field of view with the lens.' },
  { value: 'crash-zoom', label: 'Crash zoom', prompt: 'A sudden snap zoom punches into the key detail.' },
  { value: 'macro-zoom', label: 'Extreme macro zoom', prompt: 'The view transitions from the subject into an extreme macro detail.' },
  { value: 'pan-left', label: 'Pan left', prompt: 'Camera pivots horizontally to the left from a fixed position.' },
  { value: 'pan-right', label: 'Pan right', prompt: 'Camera pivots horizontally to the right from a fixed position.' },
  { value: 'whip-pan', label: 'Whip pan', prompt: 'Camera whips sideways with strong directional motion blur.' },
  { value: 'tilt-up', label: 'Tilt up', prompt: 'Camera pivots vertically upward from a fixed position.' },
  { value: 'tilt-down', label: 'Tilt down', prompt: 'Camera pivots vertically downward from a fixed position.' },
  { value: 'truck-left', label: 'Truck left', prompt: 'Camera travels laterally to the left on a parallel track.' },
  { value: 'truck-right', label: 'Truck right', prompt: 'Camera travels laterally to the right on a parallel track.' },
  { value: 'pedestal-up', label: 'Pedestal up', prompt: 'Camera rises vertically while keeping its angle and distance.' },
  { value: 'pedestal-down', label: 'Pedestal down', prompt: 'Camera lowers vertically while keeping its angle and distance.' },
  { value: 'crane-up', label: 'Crane up / high reveal', prompt: 'Camera cranes upward into a high-angle reveal.' },
  { value: 'crane-down', label: 'Crane down / landing', prompt: 'Camera cranes down and settles near the subject.' },
  { value: 'orbit-180', label: 'Orbit 180°', prompt: 'Camera makes a half-circle around the subject.' },
  { value: 'orbit-360', label: 'Orbit 360°', prompt: 'Camera makes one complete circle around the subject.' },
  { value: 'cinematic-arc', label: 'Slow cinematic arc', prompt: 'Camera follows a slow, wide curved path around the subject.' },
  { value: 'reveal-from-behind', label: 'Reveal from behind', prompt: 'Camera slides from behind a foreground object to reveal the scene.' },
  { value: 'fly-through', label: 'Fly-through', prompt: 'Camera passes through an opening and continues into the scene.' },
  { value: 'following-shot', label: 'Following tracking shot', prompt: 'Camera follows behind the moving subject at matching speed.' },
  { value: 'leading-shot', label: 'Leading tracking shot', prompt: 'Camera moves backward ahead of the subject at matching speed.' },
  { value: 'side-tracking', label: 'Side tracking shot', prompt: 'Camera travels parallel beside the moving subject.' },
  { value: 'steadicam-follow', label: 'Steadicam follow', prompt: 'Stabilized camera glides with the subject through the environment.' },
  { value: 'handheld', label: 'Handheld documentary', prompt: 'Natural handheld drift and restrained shake create documentary immediacy.' },
  { value: 'pov-walk', label: 'POV walk', prompt: 'First-person camera advances with subtle human head-bob.' },
  { value: 'worm-eye-track', label: "Worm's-eye tracking", prompt: 'Ground-level camera tracks forward while looking up.' },
  { value: 'drone-flyover', label: 'Drone flyover', prompt: 'High aerial camera flies forward over the environment.' },
  { value: 'drone-reveal', label: 'Drone rise and reveal', prompt: 'Aerial camera rises and tilts down to unveil the larger scene.' },
  { value: 'drone-orbit', label: 'Large-scale drone orbit', prompt: 'Aerial camera sweeps in a broad circle around the landscape.' },
  { value: 'drone-dive', label: 'FPV drone dive', prompt: 'Fast first-person aerial camera dives down a vertical structure.' },
  { value: 'top-down-twist', label: "Top-down / God's-eye twist", prompt: 'Camera looks straight down while slowly rotating.' },
  { value: 'dutch-roll', label: 'Dutch roll', prompt: 'Camera rolls on its lens axis into a disorienting Dutch angle.' },
  { value: 'barrel-roll', label: 'Barrel roll', prompt: 'Camera rotates a full turn on its lens axis while moving forward.' },
  { value: 'rack-focus', label: 'Rack focus', prompt: 'Focus shifts decisively between foreground and background subjects; camera position stays fixed.' },
  { value: 'focus-reveal', label: 'Reveal from blur', prompt: 'The shot begins fully defocused and gradually resolves to sharp focus.' },
  { value: 'ots-drift', label: 'Over-the-shoulder drift', prompt: 'Camera holds an over-the-shoulder composition with a subtle lateral drift.' },
  { value: 'push-past', label: 'Push past foreground', prompt: 'Camera pushes past a close foreground element to uncover the subject.' },
  { value: 'slider-parallax', label: 'Slider parallax', prompt: 'A short lateral slider move creates controlled foreground-background parallax.' },
  { value: 'body-mount', label: 'Body-mounted / SnorriCam', prompt: 'Camera stays rigidly mounted to the moving subject while the world swings behind them.' },
  { value: 'bullet-time', label: 'Bullet-time orbit', prompt: 'Action nearly freezes while the camera moves around the moment.' },
  { value: 'hyperlapse', label: 'Moving hyperlapse', prompt: 'Camera advances through accelerated time with compressed environmental motion.' },
]);

export const FABLELOOM_CAMERA_MOVEMENT_VALUES = Object.freeze(
  FABLELOOM_CAMERA_MOVEMENTS.map(({ value }) => value),
);

export const normalizeFableLoomCameraMovement = (raw) => {
  if (typeof raw !== 'string') return '';
  const candidate = raw.trim();
  const normalized = candidate.toLowerCase();
  const match = FABLELOOM_CAMERA_MOVEMENTS.find(({ value, label }) => (
    value.toLowerCase() === normalized || label.toLowerCase() === normalized
  ));
  return match?.value || candidate;
};

export const fableLoomCameraMovementCatalogForPrompt = () => FABLELOOM_CAMERA_MOVEMENTS
  .map(({ value, label, prompt }) => `- ${value} (${label}): ${prompt}`)
  .join('\n');
