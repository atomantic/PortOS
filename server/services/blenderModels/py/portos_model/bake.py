"""Marking objects for the texture bake."""

BAKE_ONLY = "portos_bake_only"
BAKE_SETS = "portos_bake_sets"


def mark_bake_only(obj, sets=None):
    """Make `obj` shape the normal map only: it is left out of the GLB, the triangle count and the checks.

    `sets` (a bake set id or a list of ids) limits the sets it shapes; by default it shapes them all.
    Returns `obj`.
    """
    obj[BAKE_ONLY] = True
    if sets is not None:
        obj[BAKE_SETS] = ",".join([sets] if isinstance(sets, str) else list(sets))
    return obj
