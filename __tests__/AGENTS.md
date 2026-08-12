# JavaScript test maintenance

Read [`.oo/rules/testing-strategy.md`](../.oo/rules/testing-strategy.md) before adding or moving a test.

- `js-runtime-kernel/<component>/` tests the TypeScript/JavaScript Event Loop, Module Loader, Native Bridge and Runtime Composer. It is not the V8/Javet/native-host layer.
- `js-api/<component>/` tests only public Node/Web semantics against declared ports. Fetch and FS tests do not inspect native DNS, sockets, filesystem handles, JSB or Android implementation state.
- `cli/` tests command parsing, discovery, session packaging, ADB/CDP orchestration, fixture ownership and report rendering. It does not retest Runtime or public API semantics.
- `support/` is only for fixtures genuinely shared across JS components. Other fixtures stay beside their owner.
- A `*.spec.ts` must have exactly one of the three layer roots above. Run `pnpm test:topology` after moving or adding one.
- Do not copy assertions between layers. Protect the exhaustive defect in its lowest owning layer; add one upper-layer case only when that public boundary was also unprotected.
- The JavaScript `node:test` implementation returns `TestRunSummary`. TAP/JSON rendering belongs to the CLI, and Kotlin/native code has no test-report semantics.
