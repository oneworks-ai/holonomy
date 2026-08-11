# Project identity and public README

## Meaning

- Holonomy refers to the transformation accumulated while something is transported around a closed path. The brand is not limited to a Möbius strip; the durable idea is that local motion preserves a reviewed global contract while context can still change.
- For this runtime, the transported object is a JavaScript application. Native hosts and engines may change, while scheduling, authority, resource identity, and lifecycle semantics remain owned by Holonomy.
- The public line is **One runtime, every surface.** Keep it short and do not introduce competing taglines without a product-level decision.
- The primary positioning is a platform-neutral Node-like runtime across native hosts. Explicit, observable, and constrainable capability boundaries are a secondary benefit that makes Agent workloads safer; mention this briefly without turning security into the headline or sole product goal.

## Visual identity

- The canonical concept is a transparent wireframe sphere above a gravity-warped plane. A closed triangular path connects one pole to two equatorial points separated by 90 degrees.
- Use a 30-degree elevated view and a full-opacity spectral path. Dark mode uses a pure-black field, translucent white front geometry, and darker dashed rear geometry; light mode uses a pure-white field, black front geometry, and lighter dashed rear geometry.
- The sphere occupies about 72% of the square export. The Gaussian gravity well sits slightly above the sphere's mathematical bottom and remains visible without an opaque ground-shadow ellipse. Depth comes from projection, line opacity, dashes, and grid deformation—not glow, material fill, or an extra shadow patch.
- Light and dark path gradients are authored separately. The light loop uses higher-luminance blue, cyan, violet, pink, and orange stops instead of an inverted dark asset.
- The source preview lives in the `oneworks-ai/icon` repository. `assets/holonomy-icon-light.png` and `assets/holonomy-icon-dark.png` are repository-facing 1024-by-1024 static exports; regenerate both from that preview instead of filtering or hand-editing either bitmap.
- README exports isolate the transparent sphere and closed path, omitting both the flat field and gravity plane so GitHub supplies the surrounding light or dark surface. The two assets still carry appearance-specific geometry and path colors; do not collapse them into one image or bake a white/black square into either PNG. The full icon preview retains the gravity plane as part of the broader visual concept.

## Documentation boundary

- `README.md` and `README.zh-Hans.md` are concise public entry points: a theme-aware `<picture>`, language switch, project name, one-line positioning, short introduction, quick start, and license.
- Runtime contracts, adapter ownership, module maps, security invariants, and verification details belong in `AGENTS.md` or the nearest `.oo/rules/` document.
- Longer public usage guides belong in `docs/` when they exist. Do not turn either root README into an architecture specification or platform bring-up log.
- Keep the English and Simplified Chinese README structures equivalent, and keep their language links at the top.
