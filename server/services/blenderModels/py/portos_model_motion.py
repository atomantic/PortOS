"""Moving parts of a Blender model: bones, actions, the sweep and the re-import check.

Runs inside Blender for `portos_model_driver.py`. The model is built in its
default position, so every bone's rest pose is the control's `default` and a
pose is a displacement from what build() made. Each control has one bone
(local Y along its axis) and one linear one-second action named `control:<id>`.

Facts only, like the driver: overlaps are reported as found, including those
`allowContact` lists; the server decides what they mean.
"""

import math
import time

import bpy
import numpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

import portos_bake
import portos_model_poses as poses

ARMATURE = "portos_controls"
# One past each end checks that a command outside 0-1 clamps.
PROBES = (-0.3, 0.0, 0.5, 1.0, 1.3)
MAX_OVERLAPS = 200
MAX_REST_PAIRS = 200


def control_matrix(control, value):
    """The world displacement `control` commands at a 0-1 value: identity at its default."""
    delta = poses.joint_value(control, value) - control["default"]
    axis = Vector(control["axis"])
    if control["type"] == "slide":
        return Matrix.Translation(axis * delta)
    origin = Matrix.Translation(Vector(control["origin"]))
    return origin @ Matrix.Rotation(math.radians(delta), 4, axis) @ origin.inverted()


class Rig:
    """The armature, and which control carries each object (None: it does not move)."""

    def __init__(self, armature, controls, carried):
        self.armature = armature
        self.controls = controls
        self.by_id = {control["id"]: control for control in controls}
        self.carried = carried
        bones = armature.data.bones
        # Each control with the controls it rides on, innermost first.
        self.chain = {}
        for control in controls:
            bone, chain = bones[bone_name(control["id"])], []
            while bone:
                chain.append(bone["portos_control"])
                bone = bone.parent
            self.chain[control["id"]] = chain
        self.moved = {
            control["id"]: {name for name, carrier in carried.items() if carrier and control["id"] in self.chain[carrier]}
            for control in controls
        }

    def reset(self):
        for bone in self.armature.pose.bones:
            bone.matrix_basis = Matrix.Identity(4)

    def displacements(self, values):
        """`{control id: world displacement}` of every bone in a pose, as Blender evaluates it."""
        for control in self.controls:
            set_bone(self.armature.pose.bones[bone_name(control["id"])], control, values[control["id"]])
        bpy.context.view_layer.update()
        return {
            control["id"]: numpy.array(self.armature.pose.bones[bone_name(control["id"])].matrix
                                       @ self.armature.data.bones[bone_name(control["id"])].matrix_local.inverted())
            for control in self.controls
        }


def bone_name(control_id):
    return "control:%s" % control_id


def set_bone(bone, control, value):
    delta = poses.joint_value(control, value) - control["default"]
    if control["type"] == "slide":
        bone.location = (0.0, delta, 0.0)
    else:
        bone.rotation_euler = (0.0, math.radians(delta), 0.0)


def carriers(controls, declared):
    """`{object name: control id or None}`: the last control of the nearest part up the declared (else built) parents."""
    last = {control["partId"]: control["id"] for control in controls}
    objects = {obj.name: obj for obj in bpy.context.scene.objects if not portos_bake.is_bake_only(obj)}

    def parent_name(name):
        if declared.get(name) in objects:
            return declared[name]
        parent = objects[name].parent
        return parent.name if parent and parent.name in objects else None

    found = {}
    for name in objects:
        current, seen = name, set()
        while current and current not in last and current not in seen:
            seen.add(current)
            current = parent_name(current)
        found[name] = last.get(current)
    return found, parent_name


def build_rig(controls, declared):
    """One bone per control, and every part rigidly on the bone that carries it."""
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    bpy.context.view_layer.update()
    carried, parent_name = carriers(controls, declared)
    placed = {obj.name: obj.matrix_world.copy() for obj in bpy.context.scene.objects}
    low, high = scene_bounds()
    length = max((high - low).length * 0.05, 1e-3)

    armature = bpy.data.objects.new(ARMATURE, bpy.data.armatures.new(ARMATURE))
    bpy.context.scene.collection.objects.link(armature)
    bpy.context.view_layer.objects.active = armature
    bpy.ops.object.mode_set(mode="EDIT")
    previous = {}
    edit = armature.data.edit_bones
    for control in controls:
        bone = edit.new(bone_name(control["id"]))
        bone.head = Vector(control["origin"])
        bone.tail = bone.head + Vector(control["axis"]) * length
        bone["portos_control"] = control["id"]
    for control in controls:
        # Controls of one part stack in declared order; the first rides on whatever carries the part's parent.
        outer = previous.get(control["partId"])
        if outer is None:
            above = parent_name(control["partId"])
            outer = carried.get(above) if above else None
        previous[control["partId"]] = control["id"]
        if outer and outer != control["id"]:
            edit[bone_name(control["id"])].parent = edit[bone_name(outer)]
    bpy.ops.object.mode_set(mode="OBJECT")
    for bone in armature.pose.bones:
        bone.rotation_mode = "XYZ"
    bpy.context.view_layer.update()

    rigged = {control["partId"] for control in controls}
    for name, carrier in carried.items():
        obj = bpy.data.objects[name]
        rides_parent = name not in rigged and obj.parent is not None and carried.get(obj.parent.name) == carrier
        if carrier is None or rides_parent:
            continue
        bone = armature.data.bones[bone_name(carrier)]
        obj.parent = armature
        obj.parent_type = "BONE"
        obj.parent_bone = bone.name
        tip = armature.matrix_world @ bone.matrix_local @ Matrix.Translation((0.0, bone.length, 0.0))
        # The basis stays as the model set it, so its scale is still what was measured.
        obj.matrix_parent_inverse = tip.inverted() @ placed[name] @ obj.matrix_basis.inverted()
    bpy.context.view_layer.update()
    return Rig(armature, controls, carried)


def curves_of(action):
    if hasattr(action, "fcurves"):
        return list(action.fcurves)
    return [curve for layer in action.layers for strip in layer.strips for bag in strip.channelbags for curve in bag.fcurves]


def new_action(rig, name, keys):
    """An action keying `(frame, values)` for the named controls, linear, kept on its own muted track."""
    armature = rig.armature
    data = armature.animation_data or armature.animation_data_create()
    action = bpy.data.actions.new(name)
    data.action = action
    rig.reset()
    for frame, values in keys:
        for control_id, value in values.items():
            control = rig.by_id[control_id]
            bone = armature.pose.bones[bone_name(control_id)]
            set_bone(bone, control, value)
            bone.keyframe_insert("location" if control["type"] == "slide" else "rotation_euler", index=1, frame=frame)
    for curve in curves_of(action):
        for point in curve.keyframe_points:
            point.interpolation = "LINEAR"
    track = data.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, 0, action)
    if hasattr(data, "action_slot"):
        strip.action_slot = data.action_slot
    track.mute = True
    data.action = None
    rig.reset()
    return action


def play(target, action, slot, frame):
    data = target.animation_data
    data.action = action
    if hasattr(data, "action_slot") and slot is not None:
        data.action_slot = slot
    whole = math.floor(frame)
    bpy.context.scene.frame_set(whole, subframe=frame - whole)


def measured_joint(control, displacement):
    """The joint value and the off-axis drift (meters) of a part's world displacement."""
    axis, origin = Vector(control["axis"]), Vector(control["origin"])
    if control["type"] == "slide":
        travel = displacement.translation
        along = travel.dot(axis)
        return control["default"] + along, (travel - axis * along).length
    side = axis.orthogonal().normalized()
    turned = displacement.to_3x3() @ side
    angle = math.degrees(math.atan2(axis.dot(side.cross(turned)), side.dot(turned)))
    return control["default"] + angle, ((displacement @ origin) - origin).length


def nearest_turn(value, expected):
    return value + 360.0 * round((expected - value) / 360.0)


def probe(rig, control, action):
    """Seek the control's action and measure where its part went, one command per probe."""
    part = bpy.data.objects[control["partId"]]
    bpy.context.view_layer.update()
    rest = part.matrix_world.copy()
    slot = action.slots[0] if hasattr(action, "slots") and len(action.slots) else None
    found = []
    for value in PROBES:
        play(rig.armature, action, slot, value * poses.FPS)
        joint, drift = measured_joint(control, part.matrix_world @ rest.inverted())
        expected = poses.joint_value(control, value)
        if control["type"] != "slide":
            joint = nearest_turn(joint, expected)
        found.append({"command": value, "expected": round(expected, 6), "measured": round(joint, 6), "drift": round(drift, 6)})
    rig.armature.animation_data.action = None
    rig.reset()
    bpy.context.scene.frame_set(0)
    bpy.context.view_layer.update()
    return found


def scene_bounds():
    low, high = Vector((math.inf,) * 3), Vector((-math.inf,) * 3)
    for obj in bpy.context.scene.objects:
        if obj.type == "MESH" and not portos_bake.is_bake_only(obj):
            for corner in obj.bound_box:
                point = obj.matrix_world @ Vector(corner)
                low, high = Vector(map(min, low, point)), Vector(map(max, high, point))
    return (low, high) if low.x <= high.x else (Vector(), Vector())


class Part:
    """One mesh as built, in world space."""

    def __init__(self, obj, depsgraph):
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        try:
            mesh.calc_loop_triangles()
            flat = numpy.empty(len(mesh.vertices) * 3, dtype=numpy.float32)
            mesh.vertices.foreach_get("co", flat)
            faces = numpy.empty(len(mesh.loop_triangles) * 3, dtype=numpy.int32)
            mesh.loop_triangles.foreach_get("vertices", faces)
        finally:
            evaluated.to_mesh_clear()
        self.name = obj.name
        self.points = transform(numpy.array(obj.matrix_world), flat.reshape(-1, 3).astype(numpy.float64))
        self.faces = faces.reshape(-1, 3)
        self.tree = None
        if len(self.faces):
            self.low, self.high = self.points.min(axis=0), self.points.max(axis=0)

    def bvh(self):
        if self.tree is None:
            self.tree = BVHTree.FromPolygons(self.points.tolist(), self.faces.tolist())
        return self.tree


def transform(matrix, points):
    return points @ matrix[:3, :3].T + matrix[:3, 3]


def near_faces(part, points, low, high):
    """The faces of `part` (moved to `points`) whose boxes reach the box `low`-`high`."""
    corners = points[part.faces]
    keep = ((corners.max(axis=1) >= low) & (corners.min(axis=1) <= high)).all(axis=1)
    return part.faces[keep]


def parts_overlap(first, second, relative):
    """Whether any triangles of the two parts meet, with `second` displaced by `relative` against `first`."""
    if len(second.faces) > len(first.faces):
        first, second, relative = second, first, numpy.linalg.inv(relative)
    points = transform(relative, second.points)
    faces = near_faces(second, points, first.low, first.high)
    if not len(faces):
        return False
    return bool(first.bvh().overlap(BVHTree.FromPolygons(points.tolist(), faces.tolist())))


class Group:
    """The parts one bone carries, with their boxes stacked for a quick look."""

    def __init__(self, control_id, parts):
        self.id = control_id
        self.parts = parts
        low, high = numpy.array([part.low for part in parts]), numpy.array([part.high for part in parts])
        self.center, self.half = (low + high) / 2, (high - low) / 2

    def near(self, other, relative):
        """Index pairs whose boxes meet, with `other` displaced by `relative` against this group."""
        center = transform(relative, other.center)
        half = other.half @ numpy.abs(relative[:3, :3]).T
        gap = numpy.abs(self.center[:, None, :] - center[None, :, :]) - (self.half[:, None, :] + half[None, :, :])
        return numpy.argwhere((gap <= 1e-9).all(axis=2))


class Sweep:
    def __init__(self, rig, emit, seconds):
        self.rig, self.emit, self.seconds = rig, emit, seconds
        self.started = time.monotonic()
        depsgraph = bpy.context.evaluated_depsgraph_get()
        parts = [Part(obj, depsgraph) for obj in bpy.context.scene.objects if obj.type == "MESH" and not portos_bake.is_bake_only(obj)]
        self.empty = [part.name for part in parts if not len(part.faces)]
        carried = {}
        for part in parts:
            if len(part.faces):
                carried.setdefault(rig.carried.get(part.name), []).append(part)
        groups = [Group(control_id, members) for control_id, members in carried.items()]
        self.pairs = [(a, b) for index, a in enumerate(groups) for b in groups[index + 1:]]
        self.part_count = sum(len(group.parts) for group in groups)
        self.rest = set()
        self.rest_known = False
        self.memo = {}
        self.found = {}
        self.poses = 0

    def overlapping(self, displaced):
        """Every pair of part names that meets in a pose, rest pairs left out."""
        still = numpy.identity(4)
        for a, b in self.pairs:
            first = displaced.get(a.id, still)
            relative = numpy.linalg.inv(first) @ displaced.get(b.id, still)
            # The same relative position as built: the answer is the rest one.
            if self.rest_known and numpy.allclose(relative, still, rtol=0, atol=1e-7):
                continue
            key = (a.id, b.id, numpy.round(relative, 6).tobytes())
            if key not in self.memo:
                self.memo[key] = [
                    (a.parts[i].name, b.parts[j].name) for i, j in a.near(b, relative)
                    if (a.parts[i].name, b.parts[j].name) not in self.rest and parts_overlap(a.parts[i], b.parts[j], relative)
                ]
            yield from self.memo[key]

    def out_of_budget(self):
        return time.monotonic() - self.started >= self.seconds

    def measure_rest(self):
        self.rest = set(self.overlapping({}))
        self.rest_known = True
        self.memo.clear()
        for a, b in sorted(self.rest)[:MAX_REST_PAIRS]:
            self.emit("sweep-rest", a=a, b=b)

    def scope(self, kind, ids, planned, blocked, samples):
        """Measure `samples` (`(t, values)`) until the time runs out; what is left is reported as unmeasured."""
        measured = 0
        for t, values in samples:
            if self.out_of_budget():
                break
            for pair in self.overlapping(self.rig.displacements(values)):
                entry = self.found.setdefault((pair, kind, tuple(ids)), {"t": t, "values": values, "count": 0})
                entry["count"] += 1
            measured += 1
        self.poses += measured
        self.emit("sweep-scope", kind=kind, ids=list(ids), planned=planned, measured=measured, blocked=blocked)

    def finish(self):
        self.rig.reset()
        bpy.context.view_layer.update()
        for (pair, kind, ids), entry in list(self.found.items())[:MAX_OVERLAPS]:
            self.emit(
                "sweep-overlap", a=pair[0], b=pair[1], kind=kind, ids=list(ids), count=entry["count"],
                t=entry["t"], values={key: round(value, 4) for key, value in entry["values"].items()},
            )
        self.emit(
            "sweep", poses=self.poses, parts=self.part_count, empty=self.empty[:50], restPairs=len(self.rest), overlaps=len(self.found),
            budgetSec=self.seconds, sec=round(time.monotonic() - self.started, 3),
        )


def choreography(model, ctx, rig, action):
    """Every frame of a choreographed action: `[(t, values)]`."""
    if not callable(getattr(model, "pose", None)):
        raise RuntimeError("src/model.py must define pose(ctx, action, t) for describe().actions")
    frames = action["frames"]
    return [(frame / frames, poses.action_pose(rig.controls, model.pose(ctx, action["id"], frame / frames))) for frame in range(frames + 1)]


def rig_model(description, emit):
    """Rig what describe() declares. None when the model has nothing to move."""
    declared = {
        part["id"]: part.get("parent") for part in poses.items(description.get("parts"))
        if isinstance(part, dict) and isinstance(part.get("id"), str)
    }
    built = {obj.name for obj in bpy.context.scene.objects if obj.type == "MESH" and not portos_bake.is_bake_only(obj)}
    controls, skipped = poses.clean_controls(description.get("controls"), {name for name in declared if name in built})
    for control_id, reason in skipped:
        emit("control-skipped", id=control_id, reason=reason)
    if not controls:
        return None
    scene = bpy.context.scene
    scene.render.fps, scene.render.fps_base = poses.FPS, 1.0
    scene.frame_set(0)
    rig = build_rig(controls, declared)
    for control in controls:
        action = new_action(rig, bone_name(control["id"]), [(0, {control["id"]: 0.0}), (poses.FPS, {control["id"]: 1.0})])
        emit("control", id=control["id"], parts=sorted(rig.moved[control["id"]])[:50], probes=probe(rig, control, action))
    return rig


def sweep_model(model, ctx, rig, description, emit, seconds):
    sweep = Sweep(rig, emit, seconds)
    sweep.measure_rest()
    for scope in poses.control_scopes(rig.controls, rig.moved):
        sweep.scope(scope["kind"], scope["ids"], len(scope["poses"]), scope["blocked"], [(None, values) for values in scope["poses"]])
    actions, skipped = poses.clean_actions(description.get("actions"))
    for action_id, reason in skipped:
        emit("action", id=action_id, frames=0, error=reason)
    for action in actions:
        try:
            frames = choreography(model, ctx, rig, action)
        except Exception as error:  # noqa: B902 - the model's own code; the build goes on without this action
            emit("action", id=action["id"], frames=0, error="%s: %s" % (type(error).__name__, error))
            continue
        unmet_at, unmet = next(((t, names) for t, names in ((t, poses.unmet(rig.controls, values)) for t, values in frames) if names), (None, []))
        emit("action", id=action["id"], frames=len(frames), error=None, unmetAt=unmet_at, unmet=unmet)
        sweep.scope("action", [action["id"]], len(frames), 0, frames)
        used = [control["id"] for control in rig.controls if any(poses.off_default(control, values) for _, values in frames)]
        keys = [(index, {control_id: values[control_id] for control_id in used}) for index, (_, values) in enumerate(frames)]
        if used:
            new_action(rig, "action:%s" % action["id"], keys)
    sweep.finish()


def expected_ends(rig):
    """What the re-import check needs once the built scene is gone: `[(control, box corners of its part)]`."""
    ends = []
    for control in rig.controls:
        part = bpy.data.objects[control["partId"]]
        ends.append((control, [part.matrix_world @ Vector(corner) for corner in part.bound_box]))
    return ends


def imported_track(name):
    """`(object, action, slot)` of every imported animation channel set named `name`."""
    found = []
    for obj in bpy.data.objects:
        for track in obj.animation_data.nla_tracks if obj.animation_data else []:
            if track.name == name and track.strips:
                found.append((obj, track.strips[0].action, getattr(track.strips[0], "action_slot", None)))
    return found


def seek_imported(control, value):
    channels = imported_track(bone_name(control["id"]))
    for obj, action, slot in channels:
        play(obj, action, slot, value * bpy.context.scene.render.fps / bpy.context.scene.render.fps_base)
        # Keep the pose, drop the action: the next control's must not bring this one back.
        obj.animation_data.action = None
    bpy.context.view_layer.update()
    return bool(channels)


def verify_imported(ends, emit):
    """Seek each `control:<id>` of the imported GLB; what is measured next stands at every control's default."""
    for obj in bpy.data.objects:
        if obj.animation_data:
            obj.animation_data.action = None
    missing = {control["id"] for control, _ in ends if not seek_imported(control, control["default01"])}
    for control, corners in ends:
        part = bpy.data.objects.get(control["partId"])
        if control["id"] in missing or part is None:
            emit("reimport-control", id=control["id"], found=False, error=None)
            continue
        rest = part.matrix_world.copy()
        worst = 0.0
        for value in (0.0, 1.0):
            seek_imported(control, value)
            moved, expected = part.matrix_world @ rest.inverted(), control_matrix(control, value)
            worst = max([worst] + [((moved @ point) - (expected @ point)).length for point in corners])
        seek_imported(control, control["default01"])
        emit("reimport-control", id=control["id"], found=True, error=round(worst, 6))
