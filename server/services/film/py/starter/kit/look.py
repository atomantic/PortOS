"""Materials, sky and glow shared by every shot of the starter film."""

import bpy

# One palette per shot: `sky` behind everything, `key` and the two `rim` lights,
# and the `cast` colors of the three figures.
PALETTES = {
    "dusk": {
        "sky": (0.012, 0.014, 0.045),
        "floor": (0.03, 0.03, 0.05),
        "key": (1.0, 0.82, 0.62),
        "rim": [(0.15, 0.75, 1.0), (1.0, 0.25, 0.6)],
        "sun": (1.0, 0.45, 0.15),
        "cast": [(0.95, 0.35, 0.25), (0.98, 0.78, 0.22), (0.2, 0.7, 0.85)],
    },
    "neon": {
        "sky": (0.02, 0.008, 0.04),
        "floor": (0.035, 0.02, 0.05),
        "key": (0.85, 0.9, 1.0),
        "rim": [(0.1, 1.0, 0.75), (0.75, 0.2, 1.0)],
        "sun": (0.95, 0.2, 0.75),
        "cast": [(0.25, 0.95, 0.75), (0.95, 0.3, 0.8), (0.35, 0.5, 1.0)],
    },
    "gold": {
        "sky": (0.03, 0.016, 0.01),
        "floor": (0.05, 0.035, 0.025),
        "key": (1.0, 0.9, 0.72),
        "rim": [(1.0, 0.6, 0.15), (0.55, 0.3, 1.0)],
        "sun": (1.0, 0.72, 0.25),
        "cast": [(0.98, 0.72, 0.2), (0.92, 0.9, 0.85), (0.65, 0.35, 0.95)],
    },
}


def _rgba(color):
    return (color[0], color[1], color[2], 1.0)


def _principled(material):
    # Materials carry a node tree from Blender 5; older versions make one on request.
    if material.node_tree is None:
        material.use_nodes = True
    return material.node_tree.nodes.get("Principled BSDF")


def material(name, color, roughness=0.5, metallic=0.0, glow=0.0):
    """A surface in `color`; `glow` above 0 makes it emit that color."""
    made = bpy.data.materials.new(name)
    shader = _principled(made)
    shader.inputs["Base Color"].default_value = _rgba(color)
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Emission Color"].default_value = _rgba(color)
    shader.inputs["Emission Strength"].default_value = glow
    return made


def set_glow(made, strength):
    _principled(made).inputs["Emission Strength"].default_value = strength


def sky(scene, color, strength=1.0):
    world = bpy.data.worlds.new("Starter sky")
    if world.node_tree is None:
        world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value = _rgba(color)
    background.inputs["Strength"].default_value = strength
    scene.world = world


def grade(scene):
    """A contrasty film-like view of the scene; falls back to Blender's default where the look is missing."""
    try:
        scene.view_settings.view_transform = "AgX"
        scene.view_settings.look = "AgX - Punchy"
    except TypeError as error:
        print("Starter grade skipped: %s" % error, flush=True)


def bloom(scene):
    """Soft glow around the brightest pixels, through the compositor. Skipped where the API differs."""
    try:
        tree = bpy.data.node_groups.new("Starter glow", "CompositorNodeTree")
        tree.interface.new_socket(name="Image", in_out="OUTPUT", socket_type="NodeSocketColor")
        layers = tree.nodes.new("CompositorNodeRLayers")
        layers.scene = scene
        glare = tree.nodes.new("CompositorNodeGlare")
        glare.inputs["Type"].default_value = "Bloom"
        glare.inputs["Threshold"].default_value = 1.4
        glare.inputs["Strength"].default_value = 0.35
        glare.inputs["Size"].default_value = 0.45
        output = tree.nodes.new("NodeGroupOutput")
        tree.links.new(layers.outputs["Image"], glare.inputs["Image"])
        tree.links.new(glare.outputs["Image"], output.inputs["Image"])
        scene.compositing_node_group = tree
        scene.render.use_compositing = True
        return True
    except Exception as error:  # an older or newer compositor API: the film still renders
        print("Starter glow skipped: %s" % error, flush=True)
        return False
