"""Shot 1: the whole stage from the front, pushing slowly in under the song's title."""

import bpy
from mathutils import Vector

from portos_film import timing

from kit import look, stage as stage_kit

PALETTE = "dusk"
SUMMARY = "The band on a round stage under a low sun, seen whole."
ACTION = "Three figures bounce on the beat while a fan of light bars rises and falls with the music."
STAGING = "Symmetrical wide: the figures centered on the riser, the sun directly behind the middle one, the title in the upper third."
CAMERA = "Slow push in from far and high to eye level, 32 mm."


def _title(stage, text):
    curve = bpy.data.curves.new("Title", "FONT")
    curve.body = text
    curve.align_x = "CENTER"
    curve.align_y = "CENTER"
    # Long titles shrink to stay inside the frame.
    curve.size = max(0.16, min(0.6, 11.0 / max(1, len(text))))
    curve.extrude = 0.01
    made = bpy.data.objects.new("Title", curve)
    # Rides with the camera in the upper third of the frame, so the push in never loses it.
    made.parent = stage.camera
    made.location = (0.0, 1.7, -7.0)
    material = look.material("Title", (1.0, 0.95, 0.85), glow=4.0)
    curve.materials.append(material)
    stage.collection.objects.link(made)
    return made, material


def build(ctx, shot, stage):
    stage.camera = stage_kit.add_camera(stage, lens=32.0)
    stage.title, stage.title_material = _title(stage, str(ctx.song.get("title") or "Starter film")[:60])


def frame(ctx, shot, stage, t):
    progress = timing.remap(t, shot["start"], shot["end"])
    glide = timing.ease(progress, "in_out", power=2.0)
    stage.camera.location = Vector((0.0, -17.0, 5.2)).lerp(Vector((0.0, -10.5, 2.4)), glide)
    stage_kit.aim(stage.camera, (0.0, 0.0, 2.6 - glide * 0.6))
    # The title fades up over the first second and out after six.
    shown = timing.remap(t - shot["start"], 0.0, 1.0) * timing.remap(t - shot["start"], 7.0, 5.5)
    look.set_glow(stage.title_material, 5.0 * shown)
    size = 0.001 + shown
    stage.title.scale = (size, size, size)
