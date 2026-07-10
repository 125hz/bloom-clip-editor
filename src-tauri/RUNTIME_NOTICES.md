# Bundled motion-blur runtime notices

Bloom bundles the following Windows runtime components for the optional GPU
motion-blur backend. Their source code and license terms are available from
their respective projects:

- VapourSynth R70: https://github.com/vapoursynth/vapoursynth
- VapourSynth-RIFE-ncnn-Vulkan r9_mod_v33: https://github.com/styler00dollar/VapourSynth-RIFE-ncnn-Vulkan
- L-SMASH Works: https://github.com/HomeOfAviSynthPlusEvolution/L-SMASH-Works
- vapoursynth-mvtools v24: https://github.com/dubhater/vapoursynth-mvtools

Bloom's `rife_blur.vpy` is an independent integration script that uses the
public APIs of these components; it does not include source code from f0e/blur.
