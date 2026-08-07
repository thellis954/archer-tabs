# Renders web/assets/arc-{light,dark}.png: three passes of the bowstring curve
# in brass, the front one drawn and sharp, the two behind it flattening as the
# string releases.
#
# Abstract on purpose. docs/BRAND.md forbids re-rendering the mark itself in 3D
# (no rotation, no gradient, no outline, no fill in the counter), so this takes
# only the bow geometry and leaves the mark alone. It is an ambient asset, not a
# logo treatment.
#
# Needs Blender on PATH. Ubuntu's package ships without OpenImageDenoise, hence
# the high sample count and the absent denoise pass.
#
#   blender -b -P tools/render-arc.py -- light web/assets/arc-light.png
#   blender -b -P tools/render-arc.py -- dark  web/assets/arc-dark.png
#
import bpy, sys, math, mathutils

argv = sys.argv[sys.argv.index("--") + 1:]
THEME = argv[0] if argv else "light"
OUT = argv[1] if len(argv) > 1 else "web/assets/arc-light.png"

DARK = THEME == "dark"
# Straight from docs/BRAND.md. Blender wants linear, the tokens are sRGB.
ACCENT = (0.961, 0.620, 0.043) if DARK else (0.706, 0.325, 0.035)   # amber / brass
GROUND = (0.078, 0.078, 0.086) if DARK else (0.984, 0.969, 0.941)


def srgb_to_linear(c):
    return tuple(
        (v / 12.92) if v <= 0.04045 else (((v + 0.055) / 1.055) ** 2.4) for v in c
    )


ACCENT_L = srgb_to_linear(ACCENT)
GROUND_L = srgb_to_linear(GROUND)

# --- empty the default scene ------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
# Ubuntu's blender package is built without OpenImageDenoise, so there is no
# denoiser to lean on. Brute-force it instead: the scene is three curves and a
# plane, so a high sample count is still cheap.
scene.cycles.samples = 220
scene.cycles.use_denoising = False
scene.cycles.use_adaptive_sampling = True
scene.cycles.adaptive_threshold = 0.012
scene.render.resolution_x = 1200
scene.render.resolution_y = 900
scene.render.film_transparent = True
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
# AgX is 4.x's default view transform and it desaturates bright metal hard.
# "Punchy" pulls the brass back toward the token value.
scene.view_settings.look = "AgX - Punchy"


def arc_curve(name, span, sag, depth, z):
    """The bowstring: M9.8 18.5 Q16 24.5 22.2 18.5, drawn as a bevelled curve.

    Blender has no quadratic bezier, so the single quadratic control point is
    raised to the two cubic handles at 2/3 of the way toward it.
    """
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    cu.resolution_u = 64
    cu.bevel_depth = depth
    cu.bevel_resolution = 12
    cu.use_fill_caps = True

    p0 = mathutils.Vector((-span, 0.0, 0.0))
    p2 = mathutils.Vector((span, 0.0, 0.0))
    ctrl = mathutils.Vector((0.0, 0.0, -sag))
    c1 = p0 + (ctrl - p0) * (2 / 3)
    c2 = p2 + (ctrl - p2) * (2 / 3)

    spline = cu.splines.new("BEZIER")
    spline.bezier_points.add(1)
    a, b = spline.bezier_points
    a.co, a.handle_right, a.handle_left = p0, c1, p0 * 2 - c1
    b.co, b.handle_left, b.handle_right = p2, c2, p2 * 2 - c2
    for pt in (a, b):
        pt.handle_left_type = pt.handle_right_type = "FREE"

    obj = bpy.data.objects.new(name, cu)
    obj.location.z = z
    scene.collection.objects.link(obj)
    return obj


def brass(name, roughness, alpha):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*ACCENT_L, 1.0)
    bsdf.inputs["Metallic"].default_value = 1.0
    bsdf.inputs["Roughness"].default_value = roughness
    if alpha < 1.0:
        bsdf.inputs["Alpha"].default_value = alpha
        mat.blend_method = "BLEND"
    return mat


# Three passes of the same string, receding. The front one is the sharp,
# fully-drawn arc; the two behind it are the frames it left behind.
LAYERS = [
    # y-offset,  span, sag,  depth,  roughness, alpha
    (0.00, 3.10, 1.62, 0.082, 0.16, 1.00),
    (-0.40, 3.05, 1.06, 0.064, 0.30, 0.50),
    (-0.80, 3.00, 0.52, 0.050, 0.42, 0.24),
]

for i, (y, span, sag, depth, rough, alpha) in enumerate(LAYERS):
    obj = arc_curve(f"arc{i}", span, sag, depth, z=0.30 + i * 0.72)
    obj.location.y = y
    obj.data.materials.append(brass(f"brass{i}", rough, alpha))

# --- shadow catcher ---------------------------------------------------------
bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, -1.15))
ground = bpy.context.object
ground.is_shadow_catcher = True
gmat = bpy.data.materials.new("ground")
gmat.use_nodes = True
gmat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (*GROUND_L, 1.0)
gmat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.85
ground.data.materials.append(gmat)

# --- light ------------------------------------------------------------------
# Big soft key from upper left, a cooler rim from behind right to separate the
# brass from whatever background the page puts behind the PNG.
def area(name, loc, rot, size, energy, color):
    lamp = bpy.data.lights.new(name, "AREA")
    lamp.size = size
    lamp.energy = energy
    lamp.color = color
    o = bpy.data.objects.new(name, lamp)
    o.location, o.rotation_euler = loc, rot
    scene.collection.objects.link(o)


area("key", (-4.2, -4.0, 6.0), (math.radians(38), 0, math.radians(-38)), 9.0, 1400, (1.0, 0.96, 0.90))
area("fill", (5.0, -3.0, 2.2), (math.radians(74), 0, math.radians(58)), 7.0, 280, (0.95, 0.95, 1.0))
area("rim", (2.0, 5.4, 3.4), (math.radians(-64), 0, math.radians(18)), 6.0, 700, (1.0, 0.88, 0.72))

world = bpy.data.worlds.new("w")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (
    (0.02, 0.02, 0.024, 1) if DARK else (0.16, 0.15, 0.14, 1)
)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.0
scene.world = world

# --- camera -----------------------------------------------------------------
cam_data = bpy.data.cameras.new("cam")
cam_data.lens = 56
cam_data.dof.use_dof = True
cam_data.dof.aperture_fstop = 2.0

cam = bpy.data.objects.new("cam", cam_data)
cam.location = (4.3, -11.4, 2.6)
scene.collection.objects.link(cam)
scene.camera = cam

# Aim at the middle of the trail. A Track To constraint beats hand-written
# eulers: the first pass guessed them and put the arcs half out of frame.
target = bpy.data.objects.new("target", None)
target.location = (0.0, -0.40, 0.95)
scene.collection.objects.link(target)

track = cam.constraints.new("TRACK_TO")
track.target = target
track.track_axis = "TRACK_NEGATIVE_Z"
track.up_axis = "UP_Y"

# Focus the front arc so the two behind it fall away.
focus = bpy.data.objects.new("focus", None)
focus.location = (0, 0.0, 0.30)
scene.collection.objects.link(focus)
cam_data.dof.focus_object = focus

scene.render.filepath = OUT
bpy.ops.render.render(write_still=True)
print(f"WROTE {OUT}")
