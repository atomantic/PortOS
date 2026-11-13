"""Shot 2: the camera circles the band at chest height while the lights trade hits."""

import math

from portos_film import music, timing

from kit import stage as stage_kit

PALETTE = "neon"
SUMMARY = "A long arc around the band, close enough to feel the lights."
ACTION = "The rim lights flash left and right on alternate beats; sparks drift past the lens."
STAGING = "The band stays centered while the background slides: bars, then sun, then bars."
CAMERA = "Orbit a third of a circle at chest height, drifting closer, 50 mm, shallow focus on the middle figure."


def build(ctx, shot, stage):
    stage.camera = stage_kit.add_camera(stage, lens=50.0)
    stage.camera.data.dof.use_dof = True
    stage.camera.data.dof.aperture_fstop = 2.0


def frame(ctx, shot, stage, t):
    progress = timing.remap(t, shot["start"], shot["end"])
    sweep = timing.ease(progress, "smooth")
    angle = math.radians(-150.0 + sweep * 120.0)
    radius = 9.5 - sweep * 2.0
    # A breath of handheld life on the beat, small enough to stay smooth.
    lift = math.sin(t * 0.9) * 0.15 + music.pulse(ctx.song, t, decay=5.0) * 0.03
    stage.camera.location = (math.cos(angle) * radius, math.sin(angle) * radius, 1.7 + lift)
    target = (0.0, 0.2, 1.35)
    stage_kit.aim(stage.camera, target)
    stage.camera.data.dof.focus_distance = (stage.camera.location - stage_kit.STAGE_CENTER).length
