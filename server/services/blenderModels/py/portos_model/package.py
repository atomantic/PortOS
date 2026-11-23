"""portos_model: a small kit for PortOS Blender models (issue #17879).

PortOS writes and ships this package; it uses standard bpy only. The package
file is package.py, not __init__.py: the worker stages files with names that
start with a letter or digit, so the driver registers it as `portos_model`
(install_kit in portos_model_driver.py). A model's src/model.py imports it:

    from portos_model import bolt_circle, hinge_barrel, lathe, pipe, mark_bake_only
    from portos_model import worn_metal_material

Part builders return one mesh object (linked into the scene, named by `name`)
for the model to parent and give a material. Shader node groups are created on
first use and reused; they use Cycles-only nodes (Bevel, Ambient Occlusion), so
they show in a bake and in Cycles, and the baked images are what survive export.
"""

from .bake import mark_bake_only
from .parts import bolt_circle, hinge_barrel, lathe, pipe
from .wear import edge_wear_group, grime_group, rust_group, worn_metal_material

__all__ = [
    "mark_bake_only", "bolt_circle", "hinge_barrel", "lathe", "pipe",
    "edge_wear_group", "grime_group", "rust_group", "worn_metal_material",
]
