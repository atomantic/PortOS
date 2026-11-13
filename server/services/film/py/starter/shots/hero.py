"""Shot 3: low and close on the middle figure, then back and up to the full stage for the end."""

from mathutils import Vector

from portos_film import timing

from kit import stage as stage_kit

PALETTE = "gold"
SUMMARY = "The singer from below, the sun as a halo, opening out to the full stage."
ACTION = "The middle figure bounces against the swelling sun; the camera pulls back as the song closes."
STAGING = "Low angle with the head against the sun, tilted a few degrees, levelling as the frame widens."
CAMERA = "Start low and close at 28 mm with a slight dutch tilt; pull back and rise to a level wide."


def build(ctx, shot, stage):
    stage.camera = stage_kit.add_camera(stage, lens=28.0)


def frame(ctx, shot, stage, t):
    progress = timing.remap(t, shot["start"], shot["end"])
    pull = timing.ease(progress, "in_out", power=2.5)
    stage.camera.location = Vector((0.9, -3.6, 0.55)).lerp(Vector((2.6, -12.5, 3.4)), pull)
    target = Vector((0.0, 0.3, 1.75)).lerp(Vector((0.0, 0.0, 2.2)), pull)
    stage_kit.aim(stage.camera, target)
    # Roll around the lens axis: tilted at the start, level by the end.
    stage.camera.rotation_euler.rotate_axis("Z", 0.14 * (1.0 - pull))
