#!/usr/bin/env python3
"""Blender-side auto-skin worker for PortOS character rigging.

Sited alongside the other Python workers in `server/services/imageTo3d/`
(`trellis2NormalBake.py`, `trellis2RestoreFillHoles.py`): the Node orchestrator
(`autoSkin.js`) writes a job JSON, spawns this file with the rigging env's
interpreter, and reads back the report this file writes.

WHY THE STEPS ARE IN THIS ORDER
-------------------------------
A neural image-to-3D decoder emits a triangle soup: every triangle carries its own
copy of each corner vertex, at bit-identical positions. That mesh *looks* watertight
and is topologically dust, which is exactly the input on which Blender's automatic
(bone-heat) weighting quietly gives up over whole regions. So:

1.  Weld coincident vertices at a tight distance. This is what makes heat weighting
    converge at all -- it is not a cleanup nicety, it is the precondition.
2.  Drop any weights that arrived with the mesh. A re-derived rig must have ONE
    provenance; blending a decoder's guess with a fresh solve produces a result
    nobody can reason about later.
3.  Delete tiny disconnected components -- but only specks, and only while the
    combined removal stays under a hard fraction of the mesh. Stray specks defeat
    heat weighting; a threshold loose enough to eat a hand is worse than the problem
    it solves, so this pass is arithmetically incapable of removing a body part.
4.  Bone-heat weight against the humanoid armature the orchestrator specified.
5.  MEASURE, then decide. Count vertices carrying a positive deform weight. If the
    unweighted fraction exceeds the configured ceiling, FAIL -- do not export. Below
    it, complete the remainder with a nearest-bone fill and assert zero unweighted.
6.  Round-trip validate: re-import the exported GLB and confirm the armature, the
    armature modifier, and the mesh all survived the exporter.

The report is written even on failure (that is the user-visible evidence naming the
number that failed the gate); a gate failure exits non-zero with a specific message.
The input GLB is opened read-only and never written back.
"""

import argparse
import json
import os
import sys
import traceback

REPORT_VERSION = 1


def _fail(message, code=2):
    """Named, non-zero exit. stderr is what the orchestrator tails."""
    sys.stderr.write("auto-skin: %s\n" % message)
    return code


def _write_report(path, report):
    """Report first, always -- the orchestrator prefers a measured refusal to an exit code."""
    tmp = "%s.partial" % path
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
    os.replace(tmp, path)


def _bounds(mesh_objects):
    """Axis-aligned world-space bounds over every mesh object."""
    import mathutils  # noqa: PLC0415 -- Blender-only import, deferred to the runtime path

    lo = [float("inf")] * 3
    hi = [float("-inf")] * 3
    for obj in mesh_objects:
        for corner in obj.bound_box:
            world = obj.matrix_world @ mathutils.Vector(corner)
            for axis in range(3):
                lo[axis] = min(lo[axis], world[axis])
                hi[axis] = max(hi[axis], world[axis])
    return lo, hi


def _weld(bmesh, mesh_object, distance):
    """Merge coincident vertices; returns (before, after)."""
    mesh = mesh_object.data
    before = len(mesh.vertices)
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=distance)
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    return before, len(mesh.vertices)


def _linked_components(bmesh, mesh_object):
    """Vertex-index sets for each edge-connected component."""
    bm = bmesh.new()
    bm.from_mesh(mesh_object.data)
    bm.verts.ensure_lookup_table()
    seen = set()
    components = []
    for vert in bm.verts:
        if vert.index in seen:
            continue
        stack = [vert]
        component = set()
        while stack:
            current = stack.pop()
            if current.index in component:
                continue
            component.add(current.index)
            for edge in current.link_edges:
                other = edge.other_vert(current)
                if other.index not in component:
                    stack.append(other)
        seen |= component
        components.append(component)
    bm.free()
    return components


def _remove_specks(bmesh, mesh_object, max_component_vertices, max_fraction):
    """Delete tiny islands, refusing the whole pass if it would exceed `max_fraction`.

    All-or-nothing on purpose: a partial sweep would leave the mesh in a state neither
    the caller nor the report describes.
    """
    total = len(mesh_object.data.vertices)
    components = _linked_components(bmesh, mesh_object)
    specks = [c for c in components if len(c) <= max_component_vertices]
    # Never delete the whole mesh: if every component is speck-sized the mesh IS specks,
    # and the coverage gate below is the right place for that to fail.
    if len(specks) == len(components):
        return 0, 0, 0.0
    doomed = set().union(*specks) if specks else set()
    fraction = (len(doomed) / total) if total else 0.0
    if not doomed or fraction > max_fraction:
        return 0, 0, fraction

    bm = bmesh.new()
    bm.from_mesh(mesh_object.data)
    bm.verts.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[bm.verts[i] for i in sorted(doomed)], context="VERTS")
    bm.to_mesh(mesh_object.data)
    bm.free()
    mesh_object.data.update()
    return len(specks), len(doomed), fraction


def _build_armature(bpy, spec, lo, hi):
    """Create the humanoid armature from the orchestrator's unit-space spec.

    Head/tail arrive as fractions of the mesh's own bounding box, so one spec fits any
    character proportion and the bone NAMES stay owned by `skeletonMapping.js` rather
    than being duplicated here.
    """
    import mathutils  # noqa: PLC0415 -- Blender-only import, deferred to the runtime path

    size = [max(hi[axis] - lo[axis], 1e-6) for axis in range(3)]

    def place(unit):
        return tuple(lo[axis] + unit[axis] * size[axis] for axis in range(3))

    armature_data = bpy.data.armatures.new("PortOSHumanoid")
    armature = bpy.data.objects.new("PortOSHumanoid", armature_data)
    bpy.context.collection.objects.link(armature)
    bpy.context.view_layer.objects.active = armature
    bpy.ops.object.mode_set(mode="EDIT")
    created = {}
    for bone_spec in spec["bones"]:
        bone = armature_data.edit_bones.new(bone_spec["name"])
        bone.head = place(bone_spec["head"])
        bone.tail = place(bone_spec["tail"])
        # A zero-length bone is silently discarded by Blender, which would turn a
        # placement bug into a mysteriously short bone list.
        if (bone.tail - bone.head).length < 1e-6:
            bone.tail = bone.head + mathutils.Vector((0.0, size[1] * 0.02, 0.0))
        created[bone_spec["name"]] = bone
    for bone_spec in spec["bones"]:
        parent = bone_spec.get("parent")
        if parent and parent in created:
            created[bone_spec["name"]].parent = created[parent]
    bpy.ops.object.mode_set(mode="OBJECT")
    return armature


def _count_weighted(mesh_object, deform_group_indices):
    """Vertices carrying a positive weight in at least one DEFORM group."""
    weighted = 0
    for vert in mesh_object.data.vertices:
        for group in vert.groups:
            if group.group in deform_group_indices and group.weight > 0.0:
                weighted += 1
                break
    return weighted


def _nearest_bone_fill(mesh_object, armature, deform_group_indices):
    """Bind each still-unweighted vertex to the nearest bone at full weight."""
    import mathutils  # noqa: PLC0415 -- only importable inside the Blender runtime

    bones = [b for b in armature.pose.bones if b.name in mesh_object.vertex_groups]
    if not bones:
        return 0
    segments = [
        (b.name, armature.matrix_world @ b.head, armature.matrix_world @ b.tail)
        for b in bones
    ]
    completed = 0
    for vert in mesh_object.data.vertices:
        if any(g.group in deform_group_indices and g.weight > 0.0 for g in vert.groups):
            continue
        point = mesh_object.matrix_world @ vert.co
        best_name = None
        best_distance = None
        for name, head, tail in segments:
            axis = tail - head
            length_sq = axis.dot(axis)
            t = 0.0 if length_sq <= 0.0 else max(0.0, min(1.0, (point - head).dot(axis) / length_sq))
            distance = (point - (head + axis * t)).length
            if best_distance is None or distance < best_distance:
                best_distance = distance
                best_name = name
        mesh_object.vertex_groups[best_name].add([vert.index], 1.0, "REPLACE")
        completed += 1
    return completed


def _round_trip(bpy, path, armature_name):
    """Re-import the export and confirm the rig survived it."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    armatures = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    has_modifier = any(
        any(m.type == "ARMATURE" and m.object is not None for m in o.modifiers) for o in meshes
    )
    return {
        "mesh": bool(meshes),
        "armature": bool(armatures),
        "armature_modifier": bool(has_modifier),
        "imported_armature": armatures[0].name if armatures else None,
        "expected_armature": armature_name,
    }


def run(job):
    import bmesh  # noqa: PLC0415 -- Blender-only imports stay inside the runtime path
    import bpy  # noqa: PLC0415

    thresholds = job["thresholds"]
    report = {
        "report_version": REPORT_VERSION,
        "thresholds": thresholds,
        "vertices": {"before_weld": 0, "after_weld": 0, "welded": 0},
        "removed_components": {"count": 0, "vertices": 0, "fraction": 0.0},
        "weighting": {
            "after_heat": {"weighted": 0, "unweighted": 0, "unweighted_fraction": 0.0},
            "nearest_bone_completed": 0,
            "after_fill": {"weighted": 0, "unweighted": 0, "unweighted_fraction": 0.0},
        },
        "armature": {"name": None, "bone_count": 0, "bones": []},
        "round_trip": {"mesh": False, "armature": False, "armature_modifier": False},
    }

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=job["input_glb"])
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    if not meshes:
        _write_report(job["report_path"], report)
        return _fail("the source GLB contains no mesh")

    # One mesh object to rig. A decoder emits a single surface; joining any extras keeps
    # the weight measurement over the whole thing rather than an arbitrary first object.
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    mesh_object = bpy.context.view_layer.objects.active

    # (1) Weld, (2) discard inherited weights -- one provenance, not a blend.
    before, after = _weld(bmesh, mesh_object, thresholds["weld_distance"])
    report["vertices"] = {"before_weld": before, "after_weld": after, "welded": before - after}
    for group in list(mesh_object.vertex_groups):
        mesh_object.vertex_groups.remove(group)

    if after == 0:
        _write_report(job["report_path"], report)
        return _fail("the mesh had no vertices left after welding")

    # (3) Conservative speck removal.
    removed_count, removed_vertices, removed_fraction = _remove_specks(
        bmesh, mesh_object,
        thresholds["max_component_vertices"], thresholds["max_removed_component_fraction"],
    )
    report["removed_components"] = {
        "count": removed_count, "vertices": removed_vertices, "fraction": removed_fraction,
    }

    # (4) Bone-heat weighting against the humanoid armature.
    lo, hi = _bounds([mesh_object])
    armature = _build_armature(bpy, job["armature"], lo, hi)
    report["armature"] = {
        "name": armature.name,
        "bone_count": len(armature.data.bones),
        "bones": [b.name for b in armature.data.bones],
    }
    bpy.ops.object.select_all(action="DESELECT")
    mesh_object.select_set(True)
    armature.select_set(True)
    bpy.context.view_layer.objects.active = armature
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")

    deform_group_indices = {
        mesh_object.vertex_groups[b.name].index
        for b in armature.data.bones
        if b.name in mesh_object.vertex_groups
    }
    total = len(mesh_object.data.vertices)

    # (5) Measure, then decide.
    weighted = _count_weighted(mesh_object, deform_group_indices)
    unweighted = total - weighted
    fraction = (unweighted / total) if total else 0.0
    report["weighting"]["after_heat"] = {
        "weighted": weighted, "unweighted": unweighted, "unweighted_fraction": fraction,
    }
    if fraction > thresholds["unweighted_ceiling"]:
        _write_report(job["report_path"], report)
        return _fail(
            "automatic weighting left %.1f%% of vertices unweighted, ceiling is %.1f%%"
            % (fraction * 100.0, thresholds["unweighted_ceiling"] * 100.0)
        )

    completed = _nearest_bone_fill(mesh_object, armature, deform_group_indices)
    weighted_after = _count_weighted(mesh_object, deform_group_indices)
    unweighted_after = total - weighted_after
    report["weighting"]["nearest_bone_completed"] = completed
    report["weighting"]["after_fill"] = {
        "weighted": weighted_after,
        "unweighted": unweighted_after,
        "unweighted_fraction": (unweighted_after / total) if total else 0.0,
    }
    if unweighted_after != 0:
        _write_report(job["report_path"], report)
        return _fail(
            "the nearest-bone pass left %d of %d vertices unweighted, which must be zero"
            % (unweighted_after, total)
        )

    os.makedirs(os.path.dirname(job["output_glb"]), exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    mesh_object.select_set(True)
    armature.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=job["output_glb"], export_format="GLB",
        use_selection=True, export_skins=True, export_yup=True,
    )

    # (6) Round-trip validate before calling it done.
    report["round_trip"] = _round_trip(bpy, job["output_glb"], report["armature"]["name"])
    _write_report(job["report_path"], report)
    if not all(report["round_trip"][k] for k in ("mesh", "armature", "armature_modifier")):
        return _fail("the exported GLB did not survive a re-import check")
    return 0


def main(argv):
    parser = argparse.ArgumentParser(description="PortOS auto-skin worker (Blender)")
    parser.add_argument("--job", required=True, help="Path to the job JSON written by autoSkin.js")
    args = parser.parse_args(argv)
    with open(args.job, "r", encoding="utf-8") as handle:
        job = json.load(handle)
    # Top-level guard: this is a subprocess boundary, so an unexpected Blender error
    # must become a named non-zero exit rather than an opaque traceback the
    # orchestrator cannot classify.
    try:
        return run(job)
    except Exception:  # noqa: BLE001 -- see above
        sys.stderr.write(traceback.format_exc())
        return _fail("the rigging worker raised an unexpected error", code=3)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
