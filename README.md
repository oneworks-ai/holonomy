<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/holonomy-icon-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="./assets/holonomy-icon-light.png">
    <img alt="Holonomy icon" src="./assets/holonomy-icon-light.png" width="220">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/oneworks-ai/holonomy/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/oneworks-ai/holonomy?style=flat-square"></a>
</p>

<p align="center">
  English | <a href="./README.zh-Hans.md">简体中文</a>
</p>

<h1 align="center">Holonomy</h1>

<p align="center"><strong>One runtime, every surface.</strong></p>

## Introduction

Holonomy is a platform-neutral, Node-like JavaScript runtime for native hosts. It preserves reviewed scheduling, authority, resource-identity, and lifecycle semantics across host engines, with explicit and observable capability boundaries.

## Quick Start

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test
```

## Documentation

- [CLI and JavaScript usage](./tools/README.md)
- [Service operations and managed processes](./tools/service/README.md)
- [Android host documentation](./adapters/android/network-host/README.md) · [Session host](./adapters/android/session-host/README.md)
- [Runtime execution and conformance](./docs/execution-and-conformance.md) · [Testing strategy](./docs/testing-strategy.md)
- [Managed V8 DevTools](./tools/README.md)

## License

[MIT](./LICENSE)
