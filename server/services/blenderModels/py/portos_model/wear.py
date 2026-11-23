"""Worn-surface shader node groups: edge wear, grime and rust.

Each group is built once per file and reused. They read the Bevel and Ambient
Occlusion nodes, which Cycles evaluates, so use them in a model's materials
and bake: only the baked images survive the glTF export.

    edge_wear_group   Base Color, Worn Color, Amount, Radius, Scale -> Color, Roughness, Mask
    grime_group       Base Color, Dirt Color, Amount, Distance, Scale -> Color, Roughness, Mask
    rust_group        Base Color, Amount, Scale -> Color, Roughness, Metallic, Mask
"""

import bpy

SOCKET_TYPES = {"color": "NodeSocketColor", "float": "NodeSocketFloat"}


def group_with(name, inputs, outputs):
    """A fresh node group with the given `(name, kind, default)` inputs and `(name, kind)` outputs, or None when it exists."""
    if name in bpy.data.node_groups:
        return None, bpy.data.node_groups[name]
    group = bpy.data.node_groups.new(name, "ShaderNodeTree")
    for label, kind, default in inputs:
        socket = group.interface.new_socket(label, in_out="INPUT", socket_type=SOCKET_TYPES[kind])
        socket.default_value = default
    for label, kind in outputs:
        group.interface.new_socket(label, in_out="OUTPUT", socket_type=SOCKET_TYPES[kind])
    return group, group


def node(tree, kind, x, y, **settings):
    created = tree.nodes.new(kind)
    created.location = (x, y)
    for key, value in settings.items():
        setattr(created, key, value)
    return created


def math_node(tree, operation, x, y, a=None, b=None, clamp=False):
    created = node(tree, "ShaderNodeMath", x, y, operation=operation, use_clamp=clamp)
    for index, value in enumerate((a, b)):
        if value is None:
            continue
        if hasattr(value, "node"):
            tree.links.new(value, created.inputs[index])
        else:
            created.inputs[index].default_value = value
    return created


def ramp(tree, x, y, low, high):
    """A map-range node taking `low`..`high` onto 0..1 (clamped)."""
    created = node(tree, "ShaderNodeMapRange", x, y)
    created.clamp = True
    created.inputs["From Min"].default_value = low
    created.inputs["From Max"].default_value = high
    return created


def noise_mask(tree, scale_socket, x, y, detail=6.0):
    created = node(tree, "ShaderNodeTexNoise", x, y)
    created.inputs["Detail"].default_value = detail
    created.inputs["Roughness"].default_value = 0.6
    tree.links.new(scale_socket, created.inputs["Scale"])
    return created


def edge_wear_group():
    """Paint shows through to bare metal along convex edges, broken up by noise."""
    group, existing = group_with(
        "PortOS Edge Wear",
        [("Base Color", "color", (0.35, 0.35, 0.38, 1.0)), ("Worn Color", "color", (0.75, 0.75, 0.78, 1.0)),
         ("Amount", "float", 0.5), ("Radius", "float", 0.004), ("Scale", "float", 45.0)],
        [("Color", "color"), ("Roughness", "float"), ("Mask", "float")],
    )
    if group is None:
        return existing
    tree = group
    source = node(tree, "NodeGroupInput", -900, 0)
    result = node(tree, "NodeGroupOutput", 700, 0)
    geometry = node(tree, "ShaderNodeNewGeometry", -900, -300)
    bevel = node(tree, "ShaderNodeBevel", -700, -300, samples=8)
    tree.links.new(source.outputs["Radius"], bevel.inputs["Radius"])
    dot = node(tree, "ShaderNodeVectorMath", -500, -300, operation="DOT_PRODUCT")
    tree.links.new(bevel.outputs["Normal"], dot.inputs[0])
    tree.links.new(geometry.outputs["Normal"], dot.inputs[1])
    # 1 on a flat face, less across a rounded edge.
    edge = math_node(tree, "SUBTRACT", -320, -300, 1.0, dot.outputs["Value"], clamp=True)
    edge_hard = ramp(tree, -140, -300, 0.0, 0.08)
    tree.links.new(edge.outputs["Value"], edge_hard.inputs["Value"])
    noise = noise_mask(tree, source.outputs["Scale"], -500, 100)
    broken = ramp(tree, -300, 100, 0.35, 0.7)
    tree.links.new(noise.outputs["Fac"], broken.inputs["Value"])
    shaped = math_node(tree, "MULTIPLY", 60, -150, edge_hard.outputs["Result"], broken.outputs["Result"])
    mask = math_node(tree, "MULTIPLY", 240, -150, shaped.outputs["Value"], source.outputs["Amount"], clamp=True)
    # Amount scales how far the wear reaches, so a strong amount also thickens the worn band.
    reach = math_node(tree, "MULTIPLY", 240, -330, shaped.outputs["Value"], 2.0)
    wider = math_node(tree, "MULTIPLY", 400, -330, reach.outputs["Value"], source.outputs["Amount"], clamp=True)
    final = math_node(tree, "MAXIMUM", 540, -240, mask.outputs["Value"], wider.outputs["Value"])
    mix = node(tree, "ShaderNodeMix", 400, 120, data_type="RGBA")
    tree.links.new(final.outputs["Value"], mix.inputs["Factor"])
    tree.links.new(source.outputs["Base Color"], mix.inputs["A"])
    tree.links.new(source.outputs["Worn Color"], mix.inputs["B"])
    rough = math_node(tree, "SUBTRACT", 540, -60, 0.6, math_node(tree, "MULTIPLY", 400, -60, final.outputs["Value"], 0.3).outputs["Value"], clamp=True)
    tree.links.new(mix.outputs["Result"], result.inputs["Color"])
    tree.links.new(rough.outputs["Value"], result.inputs["Roughness"])
    tree.links.new(final.outputs["Value"], result.inputs["Mask"])
    return tree


def grime_group():
    """Dirt gathers in crevices, streaked by noise."""
    group, existing = group_with(
        "PortOS Grime",
        [("Base Color", "color", (0.5, 0.5, 0.5, 1.0)), ("Dirt Color", "color", (0.06, 0.05, 0.04, 1.0)),
         ("Amount", "float", 0.5), ("Distance", "float", 0.03), ("Scale", "float", 18.0)],
        [("Color", "color"), ("Roughness", "float"), ("Mask", "float")],
    )
    if group is None:
        return existing
    tree = group
    source = node(tree, "NodeGroupInput", -800, 0)
    result = node(tree, "NodeGroupOutput", 700, 0)
    occlusion = node(tree, "ShaderNodeAmbientOcclusion", -600, -250, samples=8, inside=False)
    tree.links.new(source.outputs["Distance"], occlusion.inputs["Distance"])
    cavity = math_node(tree, "SUBTRACT", -400, -250, 1.0, occlusion.outputs["AO"], clamp=True)
    cavity_hard = ramp(tree, -220, -250, 0.0, 0.7)
    tree.links.new(cavity.outputs["Value"], cavity_hard.inputs["Value"])
    noise = noise_mask(tree, source.outputs["Scale"], -600, 100, detail=8.0)
    streaks = ramp(tree, -400, 100, 0.3, 0.8)
    tree.links.new(noise.outputs["Fac"], streaks.inputs["Value"])
    blend = math_node(tree, "ADD", -20, -100, math_node(tree, "MULTIPLY", -220, -60, cavity_hard.outputs["Result"], 0.7).outputs["Value"],
                      math_node(tree, "MULTIPLY", -220, 100, streaks.outputs["Result"], 0.3).outputs["Value"])
    mask = math_node(tree, "MULTIPLY", 180, -100, blend.outputs["Value"], source.outputs["Amount"], clamp=True)
    mix = node(tree, "ShaderNodeMix", 400, 120, data_type="RGBA")
    tree.links.new(mask.outputs["Value"], mix.inputs["Factor"])
    tree.links.new(source.outputs["Base Color"], mix.inputs["A"])
    tree.links.new(source.outputs["Dirt Color"], mix.inputs["B"])
    rough = math_node(tree, "ADD", 540, -60, 0.5, math_node(tree, "MULTIPLY", 400, -60, mask.outputs["Value"], 0.45).outputs["Value"], clamp=True)
    tree.links.new(mix.outputs["Result"], result.inputs["Color"])
    tree.links.new(rough.outputs["Value"], result.inputs["Roughness"])
    tree.links.new(mask.outputs["Value"], result.inputs["Mask"])
    return tree


def rust_group():
    """Orange-brown rust blooms where noise and crevices agree; rusted metal is no longer metallic."""
    group, existing = group_with(
        "PortOS Rust",
        [("Base Color", "color", (0.35, 0.35, 0.38, 1.0)), ("Amount", "float", 0.4), ("Scale", "float", 9.0)],
        [("Color", "color"), ("Roughness", "float"), ("Metallic", "float"), ("Mask", "float")],
    )
    if group is None:
        return existing
    tree = group
    source = node(tree, "NodeGroupInput", -800, 0)
    result = node(tree, "NodeGroupOutput", 700, 0)
    noise = noise_mask(tree, source.outputs["Scale"], -600, 100, detail=10.0)
    patches = math_node(tree, "SUBTRACT", -400, 100, noise.outputs["Fac"], math_node(tree, "SUBTRACT", -600, -150, 1.0, source.outputs["Amount"]).outputs["Value"])
    mask = math_node(tree, "MULTIPLY", -200, 100, patches.outputs["Value"], 6.0, clamp=True)
    tone = node(tree, "ShaderNodeTexNoise", -400, -200)
    tone.inputs["Scale"].default_value = 60.0
    ramp_color = node(tree, "ShaderNodeValToRGB", -200, -200)
    ramp_color.color_ramp.elements[0].color = (0.18, 0.06, 0.02, 1.0)
    ramp_color.color_ramp.elements[1].color = (0.55, 0.22, 0.06, 1.0)
    tree.links.new(tone.outputs["Fac"], ramp_color.inputs["Fac"])
    mix = node(tree, "ShaderNodeMix", 400, 120, data_type="RGBA")
    tree.links.new(mask.outputs["Value"], mix.inputs["Factor"])
    tree.links.new(source.outputs["Base Color"], mix.inputs["A"])
    tree.links.new(ramp_color.outputs["Color"], mix.inputs["B"])
    rough = math_node(tree, "ADD", 540, -60, 0.45, math_node(tree, "MULTIPLY", 400, -60, mask.outputs["Value"], 0.5).outputs["Value"], clamp=True)
    metal = math_node(tree, "SUBTRACT", 540, -200, 1.0, mask.outputs["Value"], clamp=True)
    tree.links.new(mix.outputs["Result"], result.inputs["Color"])
    tree.links.new(rough.outputs["Value"], result.inputs["Roughness"])
    tree.links.new(metal.outputs["Value"], result.inputs["Metallic"])
    tree.links.new(mask.outputs["Value"], result.inputs["Mask"])
    return tree


def worn_metal_material(name, base_color=(0.3, 0.3, 0.33), worn_color=(0.78, 0.78, 0.8), edge_wear=0.5, grime=0.4, rust=0.0):
    """A Principled material of painted metal: rust under edge wear under grime, each skipped at 0."""
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    tree = material.node_tree
    shader = next(entry for entry in tree.nodes if entry.type == "BSDF_PRINCIPLED")

    def stage(group, values, previous):
        entry = tree.nodes.new("ShaderNodeGroup")
        entry.node_tree = group
        for key, value in values.items():
            entry.inputs[key].default_value = value
        if previous is not None:
            tree.links.new(previous.outputs["Color"], entry.inputs["Base Color"])
        return entry

    last = None
    if rust > 0:
        last = stage(rust_group(), {"Base Color": (*base_color, 1.0), "Amount": rust}, last)
    if edge_wear > 0:
        last = stage(edge_wear_group(), {"Base Color": (*base_color, 1.0), "Worn Color": (*worn_color, 1.0), "Amount": edge_wear}, last)
    if grime > 0:
        last = stage(grime_group(), {"Base Color": (*base_color, 1.0), "Amount": grime}, last)
    if last is None:
        shader.inputs["Base Color"].default_value = (*base_color, 1.0)
    else:
        tree.links.new(last.outputs["Color"], shader.inputs["Base Color"])
        tree.links.new(last.outputs["Roughness"], shader.inputs["Roughness"])
    shader.inputs["Metallic"].default_value = 1.0 if edge_wear > 0 else 0.0
    return material
