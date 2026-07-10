# Bloom's bundled motion-blur script: interpolate to a high framerate, blend
# a weighted window, decimate to the output fps. Two interpolators:
#   method=rife    - RIFE ncnn Vulkan (GPU, best quality)
#   method=mvtools - block motion compensation (CPU, much faster; blending
#                    hides the block artifacts, so blurred output looks close)
# It deliberately uses only public VapourSynth interfaces so Bloom does not
# embed f0e/blur code.
import json
from pathlib import Path

import vapoursynth as vs

core = vs.core
input_path = Path(vars()["input_path"])
model_path = Path(vars()["model_path"])
interpolated_fps = int(vars()["interpolated_fps"])
output_fps = int(vars()["output_fps"])
method = str(vars().get("method", "rife"))
# gpu_id deliberately unset by default: ncnn's auto-selection prefers a
# discrete GPU over an iGPU on dual-GPU laptops
gpu_id = vars().get("gpu_id")
gpu_thread = int(vars().get("gpu_thread", 1))
uhd = int(vars().get("uhd", 0))
weights = json.loads(vars()["weights"])

if not weights:
    raise vs.Error("motion blur needs at least one frame weight")
if len(weights) > 31:
    raise vs.Error("motion blur supports a maximum of 31 blend frames")

video = core.lsmas.LWLibavSource(source=str(input_path), cache=0)
source_format = video.format.id
source_is_yuv = video.format.color_family == vs.YUV

# The host snaps interpolated_fps to a whole multiple of output_fps; recompute
# the step here so an off-by-one from rounding can never break decimation.
step = max(2, round(interpolated_fps / output_fps))
interpolated_fps = step * output_fps

if method == "mvtools":
    # Block-based motion compensation straight in the source YUV format — no
    # RGB round-trip and no GPU inference, so it runs several times faster
    # than RIFE. mask=2 falls back to blending where vectors are unreliable.
    if not source_is_yuv:
        video = core.resize.Bicubic(video, format=vs.YUV420P8, matrix_s="709")
    sup = core.mv.Super(video)
    bv = core.mv.Analyse(sup, isb=True, blksize=16, overlap=8)
    fv = core.mv.Analyse(sup, isb=False, blksize=16, overlap=8)
    video = core.mv.FlowFPS(video, sup, bv, fv, num=interpolated_fps, den=1, mask=2)
else:
    if not model_path.is_dir():
        raise vs.Error(f"RIFE model not found: {model_path}")
    # RIFE ncnn Vulkan operates on RGB float. Converted back before the Y4M
    # pipe so FFmpeg receives a conventional YUV stream for the final encode.
    if source_is_yuv:
        video = core.resize.Point(video, format=vs.RGBS, matrix_in_s="709")
    elif video.format.id != vs.RGBS:
        video = core.resize.Point(video, format=vs.RGBS)

    # gpu_thread is chosen by the host from dedicated VRAM: a second
    # in-flight inference doubles VRAM use, and on iGPUs that overcommits and
    # collapses throughput by orders of magnitude.
    # sc=True returns the nearest source frame across scene changes instead
    # of hallucinating a blend between two unrelated shots — keeps hard cuts
    # clean when several clips are joined on the timeline.
    rife_args = dict(
        fps_num=interpolated_fps,
        fps_den=1,
        model_path=str(model_path),
        gpu_thread=gpu_thread,
        tta=0,
        uhd=uhd,
        sc=1,
    )
    if gpu_id is not None:
        rife_args["gpu_id"] = int(gpu_id)
    video = core.rife.RIFE(video, **rife_args)

interpolated = core.std.AverageFrames(video, weights=weights)

# Decimate with a plain integer stride (interpolate-then-blend, as dedicated
# motion-blur tools do). SelectEvery keeps VapourSynth's prefetch pipeline
# parallel, unlike building a per-frame FrameEval graph.
video = core.std.SelectEvery(interpolated, cycle=step, offsets=[0])
video = core.std.AssumeFPS(video, fpsnum=output_fps, fpsden=1)

# Bicubic so 4:2:0 chroma is properly filtered instead of aliased when the
# RIFE branch converts back down from RGB. No-op when formats already match.
if video.format.id != source_format:
    if source_is_yuv:
        video = core.resize.Bicubic(video, format=source_format, matrix_s="709")
    else:
        video = core.resize.Bicubic(video, format=source_format)

video.set_output()
