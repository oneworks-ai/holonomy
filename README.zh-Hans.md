<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/holonomy-icon-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="./assets/holonomy-icon-light.png">
    <img alt="Holonomy 图标" src="./assets/holonomy-icon-light.png" width="220">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/oneworks-ai/holonomy/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/oneworks-ai/holonomy?style=flat-square"></a>
</p>

<p align="center">
  <a href="./README.md">English</a> | 简体中文
</p>

<h1 align="center">Holonomy</h1>

<p align="center"><strong>一个运行时，跨越每一种载体。</strong></p>

## 介绍

Holonomy 是面向原生宿主的平台中立 Node-like JavaScript 运行时。它在不同宿主引擎之间保持经过审阅的调度、权限、资源身份和生命周期语义，并提供明确、可观测的能力边界。

## 快速开始

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test
```

## 文档

- [CLI 与 JavaScript 用法](./tools/README.zh-Hans.md)
- [Service 操作与受管进程](./tools/service/README.zh-Hans.md)
- [Android 宿主文档](./adapters/android/network-host/README.zh-Hans.md) · [Session 宿主](./adapters/android/session-host/README.zh-Hans.md)
- [Runtime 执行与 conformance](./docs/execution-and-conformance.md) · [测试策略](./docs/testing-strategy.zh-Hans.md)
- [受管 V8 DevTools](./tools/README.zh-Hans.md)

## 许可证

[MIT](./LICENSE)
