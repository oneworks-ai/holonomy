# Conformance maintenance

`conformance/` owns developer-visible CLI end-to-end verification. Read [the testing strategy](../.oo/rules/testing-strategy.md) before adding or moving a case. Public usage and evidence categories live in [the Conformance guide](../.oo/docs/testing/conformance.md).

- Every case must run through the public `holonomy run` or `holonomy test` workflow and prove the complete CLI → Adapter → JavaScript API → Runtime path.
- Assert only developer-visible stdout/stderr, exit status, reports, public values or external fixture effects. Do not inspect private Runtime or Adapter state.
- Keep one representative success path and only critical public failure paths per capability. Exhaustive semantic, protocol, quota and race matrices stay in their owning JS, Runtime or Adapter suites.
- Write portable Node/Web behavior once with plain `describe` / `it` and run the same file unchanged on every host.
- Use `.holonomy.<platform>` only for an intentional platform promise. Platform cases never enter the common coverage denominator.
- Missing common capability fails; do not add `requires` helpers or automatic capability skips.
- Keep cases deterministic and bounded. `tools/holonomy*.mjs` owns fixture lifecycle, ADB, environment injection, CDP and process collection.
- A platform receives a generic runtime session. Test discovery, TAP/JSON reporting and coverage calculation stay out of Kotlin and other native adapters.
