# Standalone documentation site contract

This rule defines how a future Holonomy documentation site consumes the public content in `.oo/docs/`. It follows the One Works app repository split: the product repository owns content, while a standalone VitePress app owns presentation and deployment.

## Content source

- `.oo/docs/` is the only public content source.
- Simplified Chinese is the root locale. `.oo/docs/index.md` maps to `/`, and root topic paths map directly below it.
- English mirrors the same relative paths under `.oo/docs/en/`. `.oo/docs/en/index.md` maps to `/en/`.
- A paired page keeps the same locale-relative slug. For example:

```text
.oo/docs/guides/manage-processes.md     -> /guides/manage-processes
.oo/docs/en/guides/manage-processes.md  -> /en/guides/manage-processes
```

- Content uses relative Markdown links and base-independent media paths. Do not hard-code the final domain or deployment base into internal navigation.
- Shared page media belongs in `.oo/docs/images/` and optional web-optimized video in `.oo/docs/videos/`. Only the inert raster and video formats admitted by `pnpm docs:check` may be staged; SVG, HTML, symlinks, hidden paths, and executable assets are rejected. Language-specific labels use separate localized assets.
- `.oo/docs/AGENTS.md` is internal maintenance guidance and must be excluded from publication.

## Site shell

The standalone docs app owns:

- VitePress, `.vitepress/`, package metadata, theme, components, navigation, sidebars, search, analytics, build, and deployment;
- `locales.root` for `zh-CN` and `locales.en` for `en-US`, including localized UI strings, navigation, outline labels, footer, and edit links;
- a staging step that copies `.oo/docs/` to a generated `src/`, excluding `AGENTS.md`, README files, build output, and hidden implementation files;
- clean URLs, a configurable deployment base, local search, last-updated metadata, and source edit links that map staged paths back to this repository's `.oo/docs/` tree;
- Mermaid rendering for architecture diagrams and a build-time diagram validation gate;
- generated `/llms.txt`, `/llms-full.txt`, and per-page Markdown access for machine readers.

Do not place this shell inside `.oo/docs/`. Generated `src/` is disposable and must never become an authored content source.

## Locale behavior

- The site language menu maps a page to the same locale-relative slug in the other locale when that pair exists; it falls back to the target locale index only for an intentionally absent translation.
- Until the standalone site is published, pages keep a small explicit counterpart-language link for GitHub and raw Markdown readers. The site shell may remove this fallback in one coordinated migration after its locale menu is live.
- Search indexes are locale-scoped. Chinese UI labels and search prompts must not appear on English routes, and vice versa.
- Navigation order and section grouping are independently localized but must expose equivalent content coverage.

## Build and publication gates

Before deploying the site:

1. Run `pnpm docs:check` in this repository.
2. Stage only the allowlisted, realpath-confined authored files from `.oo/docs/` into a clean generated source directory; never follow symlinks.
3. Build both locales with no broken internal link or Mermaid error.
4. Confirm `AGENTS.md`, `.oo/rules/`, tokens, host paths, and private runtime state are absent from output.
5. Confirm local search, language switching, edit links, clean URLs, and `llms.txt` outputs.
6. Smoke-test one Chinese and one English page in every top-level documentation section.
