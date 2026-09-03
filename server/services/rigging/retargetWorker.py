#!/usr/bin/env python3
"""Blender-side retarget worker for PortOS character rigging.

Sibling of `autoSkinWorker.py` and driven the same way: the Node orchestrator
(`retarget.js`) writes a job JSON, spawns this file with the rigging env's
interpreter, and reads back the report this file writes.

TWO PASSES, AND WHY
-------------------
The skeleton compatibility contract is all-or-nothing and it lives in
`skeletonMapping.js`, not here -- a second copy of the bone tables in Python would be
free to drift from the one the rest of the app uses. So this worker never decides
whether a clip is compatible. It runs as:

    pass "probe"  -- read-only. Reports which bones the clip animates, which clips it
                     carries, which bones the rigged character has, and how many
                     vertices the mesh has. Exports nothing, writes nothing but its
                     report.
    pass "apply"  -- receives the EXPLICIT source->target bone mapping the orchestrator
                     derived from the probe, and does the work.

That is what makes "unsupported or partial skeleton" fail before an exporter is ever
opened, rather than after a partial retarget has been written somewhere.

WHY THE APPLY STEPS ARE IN THIS ORDER
-------------------------------------
1.  Open the RIGGED character. It is the target; the clip is only a source of curves.
2.  Head-zone cleanup FIRST, before any animation exists. Auto-skin's nearest-bone fill
    binds each leftover vertex to whatever bone is closest, which above the neck can
    mean a scalp corner travelling with a shoulder. Re-binding those vertices to the
    head/neck chain is a weight edit, so it is capped and it is opt-in:
      - "diagnostic" MEASURES the proposal and changes nothing (the default);
      - "write" applies it, and refuses the whole pass if the proposal exceeds the cap.
    All-or-nothing on purpose: a partial sweep would leave the mesh in a state neither
    the caller nor the report describes.
3.  Copy the clip's curves onto the target armature under the mapped bone names, then
    delete everything the clip GLB brought in. The clip's own armature and mesh must not
    reach the export -- a file containing two skeletons is not a retargeted character.
4.  MEASURE MOTION, then decide. Sample joint world positions across the clip and take
    the largest displacement from the first frame. A clip that never moves is a pose,
    and exporting it as an animation is the failure this worker exists to catch.
5.  Export, then re-import and confirm the mesh, the armature, the armature modifier AND
    a named non-zero-duration animation all survived the exporter. A file-only export
    passes every check up to here and is still worthless.

The report is written even on failure (that is the user-visible evidence naming the
number that failed the gate); a gate failure exits non-zero with a specific message.
The rigged GLB and the clip GLB are both opened read-only and never written back.
"""

import argparse
import json
import os
import sys
import traceback

REPORT_VERSION = 1

# Blender samples animation on a fixed scene FPS; the report's durations are seconds, so
# every frame<->second conversion goes through this one value.
SCENE_FPS = 24.0

# Curve channels that are safe to copy verbatim between two skeletons sharing a joint.
# Rotation and scale are joint-local and proportion-independent; `location` is NOT (it is
# measured in the source rig's units), so it is copied only for the root and only after
# being rescaled by the height ratio below.
_POSE_CHANNEL = 'pose.bones["%s"].%s'
_ORIENTATION_CHANNELS = ("rotation_quaternion", "rotation_euler", "scale")
_TRANSLATION_CHANNEL = "location"


def _fail(message, code=2):
    """Named, non-zero exit. stderr is what the orchestrator tails."""
    sys.stderr.write("retarget: %s\n" % message)
    return code


def _write_report(path, report):
    """Report first, always -- the orchestrator prefers a measured refusal to an exit code."""
    tmp = "%s.partial" % path
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
    os.replace(tmp, path)


def _bone_name_from_path(data_path):
    """`pose.bones["mixamorig:Hips"].location` -> `mixamorig:Hips`, or None."""
    if not data_path or not data_path.startswith('pose.bones["'):
        return None
    rest = data_path[len('pose.bones["'):]
    end = rest.find('"]')
    return rest[:end] if end > 0 else None


def _action_duration(action):
    """Clip length in seconds, from the action's own frame range."""
    start, end = action.frame_range
    return max(0.0, (float(end) - float(start)) / SCENE_FPS)


def _actions_on(objects):
    """Every action reachable from the given objects, in a stable order."""
    seen = []
    for obj in objects:
        action = getattr(getattr(obj, "animation_data", None), "action", None)
        if action is not None and action not in seen:
            seen.append(action)
    return seen


def _scene_objects(bpy, kind):
    return [o for o in bpy.data.objects if o.type == kind]


def _armature_height(armature):
    """World-space vertical extent of an armature's rest pose, for translation scaling."""
    ys = []
    for bone in armature.data.bones:
        for point in (bone.head_local, bone.tail_local):
            ys.append((armature.matrix_world @ point).z)
    return max(ys) - min(ys) if ys else 0.0


# --------------------------------------------------------------------------- probe pass


def probe(job):
    import bpy  # noqa: PLC0415 -- Blender-only import, deferred to the runtime path

    report = {"clips": [], "clip_bones": [], "rig_bones": [], "vertices": 0}

    # The clip file first, in its own scene: a clip GLB commonly carries a whole rig of
    # its own, and mixing it with the target here would make the bone lists ambiguous.
    # The fps is pinned after the reset for the same reason the apply pass pins it -- the
    # reported clip durations are frames divided by it.
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = int(SCENE_FPS)
    bpy.ops.import_scene.gltf(filepath=job["clip_glb"])
    animated = []
    for action in bpy.data.actions:
        report["clips"].append({"name": action.name, "duration": _action_duration(action)})
        for curve in action.fcurves:
            name = _bone_name_from_path(curve.data_path)
            if name and name not in animated:
                animated.append(name)
    report["clip_bones"] = animated

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=job["rig_glb"])
    armatures = _scene_objects(bpy, "ARMATURE")
    report["rig_bones"] = [b.name for b in armatures[0].data.bones] if armatures else []
    report["vertices"] = sum(len(o.data.vertices) for o in _scene_objects(bpy, "MESH"))

    _write_report(job["report_path"], report)
    if not report["clip_bones"]:
        return _fail("the clip file animates no bones")
    if not report["rig_bones"]:
        return _fail("the rigged character has no armature")
    return 0


# --------------------------------------------------------------- apply pass: the cleanup


def _head_zone_candidates(mesh_object, armature, zone_bones):
    """Vertices above the neck whose dominant deform group is OUTSIDE the head zone.

    Geometric, not name-based: the zone is everything at or above the first zone bone's
    head, so a vertex only qualifies when it BOTH sits in the head and is driven from
    outside it. Returns `(candidate_vertex_indices, zone_bone_names_present)`.
    """
    present = [name for name in zone_bones if name in mesh_object.vertex_groups]
    if not present:
        return [], present
    zone_indices = {mesh_object.vertex_groups[name].index for name in present}
    heads = [armature.matrix_world @ armature.data.bones[name].head_local
             for name in present if name in armature.data.bones]
    if not heads:
        return [], present
    floor = min(head.z for head in heads)

    candidates = []
    for vert in mesh_object.data.vertices:
        if (mesh_object.matrix_world @ vert.co).z < floor:
            continue
        dominant = None
        best = 0.0
        for group in vert.groups:
            if group.weight > best:
                best = group.weight
                dominant = group.group
        if dominant is not None and dominant not in zone_indices:
            candidates.append(vert.index)
    return candidates, present


def _rebind_to_nearest_zone_bone(mesh_object, armature, zone_bones, vertex_indices):
    """Bind each named vertex to the nearest head-zone bone at full weight, exclusively."""
    segments = [
        (name,
         armature.matrix_world @ armature.data.bones[name].head_local,
         armature.matrix_world @ armature.data.bones[name].tail_local)
        for name in zone_bones if name in armature.data.bones
    ]
    if not segments:
        return 0
    other_groups = [g for g in mesh_object.vertex_groups if g.name not in zone_bones]
    changed = 0
    for index in vertex_indices:
        point = mesh_object.matrix_world @ mesh_object.data.vertices[index].co
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
        # Exclusive: the old weights are removed, not blended with. A vertex driven half
        # by a shoulder is exactly the artifact this cleanup exists to remove.
        for group in other_groups:
            group.remove([index])
        mesh_object.vertex_groups[best_name].add([index], 1.0, "REPLACE")
        changed += 1
    return changed


# ------------------------------------------------------------ apply pass: the retarget


def _copy_curves(source_action, target_action, name_by_source, translation_scale, root_targets):
    """Copy the source clip's curves onto the target armature's bone names.

    Orientation channels transfer verbatim. `location` is copied ONLY for a root bone,
    and scaled by the height ratio: a translation authored against a source rig means a
    different distance on a character of another size, and every non-root joint gets its
    position from its parent anyway.
    """
    copied = 0
    for curve in source_action.fcurves:
        source_bone = _bone_name_from_path(curve.data_path)
        target_bone = name_by_source.get(source_bone) if source_bone else None
        if not target_bone:
            continue
        channel = curve.data_path.rsplit(".", 1)[-1]
        if channel == _TRANSLATION_CHANNEL:
            if target_bone not in root_targets:
                continue
            scale = translation_scale
        elif channel in _ORIENTATION_CHANNELS:
            scale = 1.0
        else:
            continue
        target_curve = target_action.fcurves.new(
            _POSE_CHANNEL % (target_bone, channel), index=curve.array_index, action_group=target_bone,
        )
        target_curve.keyframe_points.add(count=len(curve.keyframe_points))
        for slot, key in zip(target_curve.keyframe_points, curve.keyframe_points):
            slot.co = (key.co[0], key.co[1] * scale)
            slot.interpolation = key.interpolation
        target_curve.update()
        copied += 1
    return copied


def _sample_motion(bpy, armature, action, sample_count):
    """Largest world-space joint displacement from the first sampled frame.

    Sampled rather than compared end-to-end because a looping clip returns to its start:
    first-vs-last would report a perfectly good walk cycle as motionless.
    """
    start, end = action.frame_range
    frames = max(2, int(sample_count))
    step = (float(end) - float(start)) / (frames - 1) if end > start else 0.0
    if step <= 0.0:
        return 0, 0.0

    reference = None
    worst = 0.0
    for index in range(frames):
        bpy.context.scene.frame_set(int(round(float(start) + step * index)))
        bpy.context.view_layer.update()
        pose = [armature.matrix_world @ bone.head for bone in armature.pose.bones]
        if reference is None:
            reference = pose
            continue
        for current, origin in zip(pose, reference):
            worst = max(worst, (current - origin).length)
    return frames, worst


def _round_trip(bpy, path):
    """Re-import the export and confirm the animated rig survived it."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    meshes = _scene_objects(bpy, "MESH")
    armatures = _scene_objects(bpy, "ARMATURE")
    has_modifier = any(
        any(m.type == "ARMATURE" and m.object is not None for m in o.modifiers) for o in meshes
    )
    actions = _actions_on(armatures) or list(bpy.data.actions)
    return {
        "mesh": bool(meshes),
        "armature": bool(armatures),
        "armature_modifier": bool(has_modifier),
        "animation_count": len(actions),
        "clip_name": actions[0].name if actions else None,
        "clip_duration": _action_duration(actions[0]) if actions else 0.0,
    }


def apply_clip(job):  # noqa: PLR0911, PLR0915 -- one linear pipeline; each return is a named gate
    import bpy  # noqa: PLC0415 -- Blender-only import, deferred to the runtime path

    thresholds = job["thresholds"]
    mapping = job["bone_mapping"]
    zone_bones = job.get("head_zone_bones") or []
    mode = job["mode"]
    report = {
        "report_version": REPORT_VERSION,
        "kind": "retarget",
        "thresholds": thresholds,
        "skeleton": {"hint": job["skeleton_hint"], "mapped_bones": 0, "unmapped_bones": []},
        "vertices": {"total": 0},
        "head_cleanup": {
            "mode": mode, "zone_bones": zone_bones,
            "proposed_vertices": 0, "changed_vertices": 0, "cap_vertices": 0,
        },
        "clip": {"name": job["clip_name"], "duration": 0.0},
        "motion": {"sampled_frames": 0, "max_joint_translation": 0.0},
        "armature": {"name": None, "bone_count": 0, "bones": []},
        "round_trip": {
            "mesh": False, "armature": False, "armature_modifier": False,
            "animation_count": 0, "clip_name": None, "clip_duration": 0.0,
        },
    }

    # (1) The rigged character is the target. The fps is pinned AFTER the factory reset
    #     (which would restore the default) because every frame<->second conversion in
    #     this file -- the durations in the report included -- reads through it.
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = int(SCENE_FPS)
    bpy.ops.import_scene.gltf(filepath=job["rig_glb"])
    armatures = _scene_objects(bpy, "ARMATURE")
    meshes = _scene_objects(bpy, "MESH")
    if not armatures or not meshes:
        _write_report(job["report_path"], report)
        return _fail("the rigged character has no armature or no mesh")
    armature = armatures[0]
    mesh_object = meshes[0]
    total = len(mesh_object.data.vertices)
    report["vertices"]["total"] = total
    report["armature"] = {
        "name": armature.name,
        "bone_count": len(armature.data.bones),
        "bones": [b.name for b in armature.data.bones],
    }

    # The mapping was decided by the orchestrator against the PROBE's bone list; re-check
    # it against the armature actually loaded here, so a target that changed underneath
    # the probe cannot produce a silently partial retarget.
    target_bones = {b.name for b in armature.data.bones}
    missing = [pair["target"] for pair in mapping if pair["target"] not in target_bones]
    report["skeleton"] = {
        "hint": job["skeleton_hint"],
        "mapped_bones": len(mapping) - len(missing),
        "unmapped_bones": missing,
    }
    if missing:
        _write_report(job["report_path"], report)
        return _fail("the rigged character is missing %d mapped bones" % len(missing))

    # (2) Head-zone cleanup, before anything is animated.
    cap = int(total * float(thresholds["head_cleanup_fraction"]))
    candidates, present_zone = _head_zone_candidates(mesh_object, armature, zone_bones)
    report["head_cleanup"].update({
        "zone_bones": present_zone, "proposed_vertices": len(candidates), "cap_vertices": cap,
    })
    if mode == "write":
        if len(candidates) > cap:
            _write_report(job["report_path"], report)
            return _fail(
                "the head-zone cleanup would re-bind %d of %d vertices, cap is %d"
                % (len(candidates), total, cap)
            )
        report["head_cleanup"]["changed_vertices"] = _rebind_to_nearest_zone_bone(
            mesh_object, armature, present_zone, candidates,
        )

    # (3) Bring in the clip, copy its curves onto the target, then remove every object it
    #     brought with it -- a file carrying two skeletons is not a retargeted character.
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=job["clip_glb"])
    imported = [o for o in bpy.data.objects if o not in before]
    source_action = next((a for a in bpy.data.actions if a.name == job["clip_name"]), None)
    if source_action is None:
        _write_report(job["report_path"], report)
        return _fail('the clip file no longer carries an animation named "%s"' % job["clip_name"])
    report["clip"]["duration"] = _action_duration(source_action)

    source_armatures = [o for o in imported if o.type == "ARMATURE"]
    source_height = _armature_height(source_armatures[0]) if source_armatures else 0.0
    target_height = _armature_height(armature)
    translation_scale = (target_height / source_height) if source_height > 0.0 else 1.0

    name_by_source = {pair["source"]: pair["target"] for pair in mapping}
    # The root is whichever mapped bone has no mapped parent -- the only joint whose
    # translation is meaningful to carry across.
    mapped_targets = set(name_by_source.values())
    root_targets = {
        name for name in mapped_targets
        if armature.data.bones[name].parent is None or armature.data.bones[name].parent.name not in mapped_targets
    }

    target_action = bpy.data.actions.new(name=job["clip_name"])
    if armature.animation_data is None:
        armature.animation_data_create()
    armature.animation_data.action = target_action
    copied = _copy_curves(source_action, target_action, name_by_source, translation_scale, root_targets)

    for obj in imported:
        bpy.data.objects.remove(obj, do_unlink=True)
    if source_action.users == 0:
        bpy.data.actions.remove(source_action)
    if not copied:
        _write_report(job["report_path"], report)
        return _fail("no animation curve could be transferred onto the rigged character")

    # (4) Measure motion, then decide.
    start, end = target_action.frame_range
    bpy.context.scene.frame_start = int(start)
    bpy.context.scene.frame_end = int(end)
    frames, worst = _sample_motion(bpy, armature, target_action, thresholds["motion_sample_count"])
    report["motion"] = {"sampled_frames": frames, "max_joint_translation": worst}
    if worst < float(thresholds["min_motion_distance"]):
        _write_report(job["report_path"], report)
        return _fail("the retargeted clip never moves (largest joint displacement %.3e)" % worst)

    # (5) Export, then re-import and confirm the animation survived.
    os.makedirs(os.path.dirname(job["output_glb"]), exist_ok=True)
    bpy.context.scene.frame_set(int(start))
    bpy.ops.object.select_all(action="DESELECT")
    mesh_object.select_set(True)
    armature.select_set(True)
    bpy.context.view_layer.objects.active = armature
    bpy.ops.export_scene.gltf(
        filepath=job["output_glb"], export_format="GLB",
        use_selection=True, export_skins=True, export_yup=True,
        export_animations=True, export_animation_mode="ACTIONS",
    )

    report["round_trip"] = _round_trip(bpy, job["output_glb"])
    _write_report(job["report_path"], report)
    if not all(report["round_trip"][k] for k in ("mesh", "armature", "armature_modifier")):
        return _fail("the exported GLB did not survive a re-import check")
    if not report["round_trip"]["clip_name"]:
        return _fail("the exported GLB carries no named animation")
    if report["round_trip"]["clip_duration"] < float(thresholds["min_clip_duration"]):
        return _fail(
            "the exported animation lasts %.3fs, minimum is %.3fs"
            % (report["round_trip"]["clip_duration"], float(thresholds["min_clip_duration"]))
        )
    return 0


def run(job):
    return probe(job) if job.get("pass") == "probe" else apply_clip(job)


def main(argv):
    parser = argparse.ArgumentParser(description="PortOS retarget worker (Blender)")
    parser.add_argument("--job", required=True, help="Path to the job JSON written by retarget.js")
    args = parser.parse_args(argv)
    with open(args.job, "r", encoding="utf-8") as handle:
        job = json.load(handle)
    # Top-level guard: this is a subprocess boundary, so an unexpected Blender error must
    # become a named non-zero exit rather than an opaque traceback the orchestrator
    # cannot classify.
    try:
        return run(job)
    except Exception:  # noqa: BLE001 -- see above
        sys.stderr.write(traceback.format_exc())
        return _fail("the retarget worker raised an unexpected error", code=3)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
