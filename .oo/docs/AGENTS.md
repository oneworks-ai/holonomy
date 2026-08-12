# Holonomy public documentation guide

This directory is the source for public Holonomy product and usage documentation. It explains what users can do, how to do it, and which capabilities are currently supported. Internal ownership, implementation invariants, and agent-only maintenance instructions belong in the nearest `AGENTS.md` or `.oo/rules/` document instead.

## Locale layout

- Simplified Chinese is the root locale: `.oo/docs/index.md` and the root topic directories.
- English mirrors the same information architecture under `.oo/docs/en/`.
- Every public page must link to its counterpart locale near the title.
- Add, rename, and remove equivalent Chinese and English pages in the same change. A page may be temporarily marked as a translation follow-up only when the user explicitly requests a single-locale draft.
- Paired pages keep the same locale-relative file path. Root `guides/x.md` maps to `/guides/x`; English `en/guides/x.md` maps to `/en/guides/x`.
- Use lowercase ASCII kebab-case paths without locale suffixes such as `.en.md` or `.zh-Hans.md`.
- Until the standalone site locale menu is published, retain the small counterpart-language link near each title for GitHub and raw Markdown readers.

The future site assembly boundary is defined in [`.oo/rules/docs-site.md`](../rules/docs-site.md). This directory remains content-only: do not add `package.json`, `.vitepress/`, Vue components, theme code, staging scripts, generated site source, or deployment configuration here.

## Progressive disclosure

Readers should move from outcomes to details:

1. `index.md` answers what Holonomy is, what is supported, and where to start.
2. `getting-started/` provides the shortest verified Node and Android journeys.
3. `guides/` completes a user goal such as process management, sandboxing, mocking, or debugging.
4. `concepts/` explains durable mental models without becoming an implementation specification.
5. `capabilities/` is the human-readable support contract and known-limitations index.
6. `platforms/` describes public Node and Android differences.
7. `service/` and `openapi/` document the managed control plane and HTTP contract.
8. `reference/` contains precise schemas, limits, states, errors, and environment variables.
9. `testing/` explains public conformance usage and evidence classification.
10. `troubleshooting/` diagnoses public workflows using stable symptoms and errors.

Do not force a new reader through architecture or schema pages before showing a working command. Each index page should contain a short summary, the recommended reading order, and links to deeper pages.

## Module boundaries

- Root `README.md` and `README.zh-Hans.md`: brand, short introduction, quick start, and documentation entry points only.
- `.oo/docs/`: cross-module public guides, concepts, capability status, platform comparisons, and references.
- Module `README.md`: external integration instructions owned by that module. Cross-module pages link to these rather than copy their full setup.
- `AGENTS.md` and `.oo/rules/`: internal ownership, design constraints, code routing, and maintenance rules.
- `.oo/skills/`: complete OpenAPI scenarios for agents. Skills link to public references and never become a second general documentation tree.
- `/openapi.json`: authoritative request and response schema. OpenAPI pages explain lifecycle and safe usage without hand-maintaining a divergent schema copy.

## Topic structure

Use these stable top-level modules:

```text
.oo/docs/
  index.md
  getting-started/
  guides/
  concepts/
  capabilities/
  platforms/node/
  platforms/android/
  service/
  openapi/resources/
  reference/
  testing/
  troubleshooting/
  images/diagrams/         # inert raster assets only
  videos/
  en/                     # mirrored locale tree
```

Create a leaf only when it has an independent user question. Keep closely related details on one page until the page becomes difficult to scan. Use an `index.md` at every directory that contains multiple user-facing pages.

## Capability claims

- `capabilities/support-matrix.md` is the primary human-readable status summary.
- Classify behavior as supported, partial, unsupported, or evidence-limited. Do not infer support from a facade, type, schema admission, test provider, or planned API.
- Distinguish product implementation from verification evidence. Emulator results are not physical-device evidence.
- A schema-accepted value that returns a stable unsupported error remains unsupported.
- Test-only providers, memory providers, and contract fixtures must be labeled as such.
- Link detailed Node, Stream, Sandbox, Network, and OpenAPI claims to their owning source or module README when useful.

## Page style

- Lead with the outcome and prerequisites, then show the smallest working command.
- Prefer short tables for support comparisons and exact mappings.
- Use `✅`, `🟡`, `⛔`, and `🧪` only in status tables, with a text legend for accessibility.
- Examples must be bounded, deterministic, and use repository files or loopback fixtures; never require a public internet endpoint.
- State cleanup steps for commands that create a process, lease, emulator, or service resource.
- Use stable public errors and resource names. Do not expose private paths, tokens, provider references, or internal ADB/CDP transport details.
- Avoid copying generated JSON Schema. Show a minimal valid example and link to `/openapi.json` or the owning reference page.

## Architecture diagrams

- Use Mermaid flowcharts, sequence diagrams, and state diagrams for stable product relationships that are materially easier to understand visually. Keep them inline with the owning Markdown page so labels and links evolve with the explanation.
- Draw public responsibilities and data flow, not source-file or class inventories. A reader should be able to identify the control-plane owner, execution boundary, capability gate, lifecycle transition, or diagnostic path without knowing the implementation.
- Keep one primary question per diagram. Split a dense system map into an overview plus focused lifecycle, security, or debugging diagrams.
- Chinese and English counterparts must use equivalent topology and independently readable localized labels.
- Follow every diagram with a concise text summary so the essential relationship remains accessible when Mermaid rendering is unavailable.
- Never include real tokens, host paths, device serials, dynamic ports, provider references, or internal identifiers in a diagram.
- Put inert raster assets under `.oo/docs/images/diagrams/` and provide meaningful alt text. Keep active or editable source formats outside the published content tree. Prefer Mermaid for labeled architecture unless fixed visual composition is necessary.

## Link and migration rules

- Use relative Markdown links inside `.oo/docs/`.
- Root and module READMEs should point to the nearest `.oo/docs` entry rather than a deep implementation page.
- When replacing an existing public `docs/` page, keep a short compatibility page at the old path unless all consumers are updated in the same release.
- Do not move internal review checklists into public documentation. Route them to the nearest `AGENTS.md` instead.
- Images and diagrams belong under `.oo/docs/images/`; provide meaningful alt text and avoid embedding secrets, host paths, or live identifiers.

## Verification

Before delivery:

1. Check that Chinese and English trees are structurally equivalent.
2. Validate every relative link, anchor, image target, authored file type, and real path. Symlinks, hidden files, SVG, HTML, and executable site assets are not publishable content.
3. Search for claims that conflict with `capabilities/support-matrix.md` or `known-limitations.md`.
4. Confirm commands match current CLI help and OpenAPI resource paths.
5. Run `pnpm docs:check`, `pnpm format:check`, and `git diff --check`.
6. When commands or schemas changed, run the owning CLI, Service, or conformance tests; documentation-only wording changes do not require unrelated platform tests.
