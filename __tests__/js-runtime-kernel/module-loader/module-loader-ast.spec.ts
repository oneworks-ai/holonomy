import { describe, expect, it } from 'vitest'

import { analyzeModuleSource } from '../../../src/module-loader/source-analysis.js'

describe('mobileModuleLoader Acorn dependency analysis', () => {
  it('finds ESM declarations, re-exports and literal/runtime import expressions in nested AST nodes', () => {
    const analysis = analyzeModuleSource(
      `
      import value from './imported.mjs'
      export * from './all.mjs'
      export { named as renamed } from './named.mjs'
      export * as namespace from './namespace.mjs'
      export const load = () => ({
        literal: import(('./literal.mjs')),
        template: import(\`./template.mjs\`),
        runtime: import(getSpecifier())
      })
    `,
      'module',
      'app:///bundle/ast.mjs'
    )

    expect(analysis.dependencies.map(({ kind, specifier }) => ({ kind, specifier }))).toEqual([
      { kind: 'import', specifier: './imported.mjs' },
      { kind: 'import', specifier: './all.mjs' },
      { kind: 'import', specifier: './named.mjs' },
      { kind: 'import', specifier: './namespace.mjs' },
      { kind: 'dynamic-import', specifier: './literal.mjs' },
      { kind: 'dynamic-import', specifier: './template.mjs' },
      { kind: 'dynamic-import', specifier: null }
    ])
    expect(analysis.exportNames).toEqual(expect.arrayContaining(['load', 'namespace', 'renamed']))
  })

  it('finds parenthesized require and require.resolve with static template arguments', () => {
    const analysis = analyzeModuleSource(
      `
      const loaded = ((require))(\`./loaded.cjs\`)
      const resolved = (((require).resolve))((\`./resolved.cjs\`))
    `,
      'commonjs',
      'app:///bundle/ast.cjs'
    )

    expect(analysis.dependencies.map(({ kind, specifier }) => ({ kind, specifier }))).toEqual([
      { kind: 'require', specifier: './loaded.cjs' },
      { kind: 'require-resolve', specifier: './resolved.cjs' }
    ])
  })

  it('ignores member object.import calls and dependency-like raw text', () => {
    const analysis = analyzeModuleSource(
      `
      const matcher = /require\\(['"]\\.\\/regex\\.cjs/
      const text = "require('./string.cjs') and import('./string.mjs')"
      const raw = \`require('./template.cjs') import('./template.mjs')\`
      // require('./comment.cjs')
      object.import('./member.mjs')
      void matcher
      void text
      void raw
    `,
      'commonjs',
      'app:///bundle/ignored.cjs'
    )

    expect(analysis.dependencies).toEqual([])
  })

  it('rejects a non-literal require nested inside a template expression', () => {
    const source = 'const nested = `' + '$' + '{() => ((require))(`./' + '$' + '{name}.cjs`)}`'
    expect(() =>
      analyzeModuleSource(
        source,
        'commonjs',
        'app:///bundle/nested.cjs'
      )
    ).toThrowError(expect.objectContaining({
      code: 'ERR_HOLONOMY_MODULE_DYNAMIC_REQUIRE_UNSUPPORTED'
    }))
  })

  it('ignores function, block, catch, class, var and destructuring shadows', () => {
    const analysis = analyzeModuleSource(
      `
        function invoke(require, { process }) {
          require(runtimeName)
          process.dlopen(handle)
        }
        function hoisted() {
          require(runtimeName)
          var require
        }
        {
          const { require, nested: { process } } = localCapabilities
          require(runtimeName)
          process.dlopen(handle)
        }
        try {
          throw localCapabilities
        } catch ({ require, process }) {
          require(runtimeName)
          process.dlopen(handle)
        }
        {
          class process {}
          void process.dlopen
        }
        void invoke
        void hoisted
      `,
      'commonjs',
      'app:///bundle/shadowed.cjs'
    )

    expect(analysis.dependencies).toEqual([])
    expect(analysis.usesDlopen).toBe(false)
  })

  it('respects imported require/process bindings', () => {
    const analysis = analyzeModuleSource(
      `
        import require, { process } from './capabilities.mjs'
        require(runtimeName)
        process.dlopen(handle)
      `,
      'module',
      'app:///bundle/import-shadow.mjs'
    )

    expect(analysis.dependencies.map(({ kind, specifier }) => ({ kind, specifier }))).toEqual([
      { kind: 'import', specifier: './capabilities.mjs' }
    ])
    expect(analysis.usesDlopen).toBe(false)
  })

  it('still rejects a free dynamic require outside a nested shadow', () => {
    expect(() =>
      analyzeModuleSource(
        `
          function local(require) {
            require(runtimeName)
          }
          require(runtimeName)
        `,
        'commonjs',
        'app:///bundle/free-require.cjs'
      )
    ).toThrowError(expect.objectContaining({
      code: 'ERR_HOLONOMY_MODULE_DYNAMIC_REQUIRE_UNSUPPORTED'
    }))
  })

  it('still detects free process.dlopen outside a block shadow', () => {
    const analysis = analyzeModuleSource(
      `
        {
          const process = localProcess
          process.dlopen(handle)
        }
        process.dlopen(handle)
      `,
      'commonjs',
      'app:///bundle/free-process.cjs'
    )

    expect(analysis.usesDlopen).toBe(true)
  })

  it('keeps var require/process inside a static-block var boundary', () => {
    const analysis = analyzeModuleSource(
      `
        class RuntimeCapabilities {
          static {
            require(runtimeName)
            process.dlopen(handle)
            var require
            var process
          }
        }
      `,
      'commonjs',
      'app:///bundle/static-block-shadow.cjs'
    )

    expect(analysis.dependencies).toEqual([])
    expect(analysis.usesDlopen).toBe(false)
  })

  it('does not let static-block var bindings shadow an outer free require', () => {
    expect(() =>
      analyzeModuleSource(
        `
          class RuntimeCapabilities {
            static {
              require(runtimeName)
              var require
            }
          }
          require(runtimeName)
        `,
        'commonjs',
        'app:///bundle/static-block-free-require.cjs'
      )
    ).toThrowError(expect.objectContaining({
      code: 'ERR_HOLONOMY_MODULE_DYNAMIC_REQUIRE_UNSUPPORTED'
    }))
  })

  it('does not let static-block var bindings shadow an outer free process.dlopen', () => {
    const analysis = analyzeModuleSource(
      `
        class RuntimeCapabilities {
          static {
            process.dlopen(handle)
            var process
          }
        }
        process.dlopen(handle)
      `,
      'commonjs',
      'app:///bundle/static-block-free-process.cjs'
    )

    expect(analysis.usesDlopen).toBe(true)
  })

  it('recognizes literal-template computed require.resolve and process.dlopen', () => {
    const analysis = analyzeModuleSource(
      `
        const resolved = require[\`resolve\`](\`./peer.cjs\`)
        process[\`dlopen\`](handle)
      `,
      'commonjs',
      'app:///bundle/computed-static.cjs'
    )

    expect(analysis.dependencies.map(({ kind, specifier }) => ({ kind, specifier }))).toEqual([
      { kind: 'require-resolve', specifier: './peer.cjs' }
    ])
    expect(analysis.usesDlopen).toBe(true)
  })

  it('rejects expression-bearing computed global capabilities without treating them as static', () => {
    expect(() =>
      analyzeModuleSource(
        'require[`res$' + '{capability}`](runtimeName)',
        'commonjs',
        'app:///bundle/computed-runtime-require.cjs'
      )
    ).toThrowError(expect.objectContaining({
      code: 'ERR_HOLONOMY_MODULE_DYNAMIC_REQUIRE_UNSUPPORTED'
    }))
    expect(() =>
      analyzeModuleSource(
        'process[`dlo$' + '{capability}`](handle)',
        'commonjs',
        'app:///bundle/computed-runtime-process.cjs'
      )
    ).toThrowError(expect.objectContaining({
      code: 'ERR_HOLONOMY_MODULE_NATIVE_ADDON_UNSUPPORTED'
    }))

    const local = analyzeModuleSource(
      `
        function useLocal(require, process) {
          require[\`res\${capability}\`](runtimeName)
          process[\`dlo\${capability}\`](handle)
        }
      `,
      'commonjs',
      'app:///bundle/computed-runtime-local.cjs'
    )
    expect(local.dependencies).toEqual([])
    expect(local.usesDlopen).toBe(false)
  })

  it('rejects a dynamic argument passed to computed static require.resolve', () => {
    expect(() =>
      analyzeModuleSource(
        'require[`resolve`](runtimeName)',
        'commonjs',
        'app:///bundle/computed-dynamic-argument.cjs'
      )
    ).toThrowError(expect.objectContaining({
      code: 'ERR_HOLONOMY_MODULE_DYNAMIC_REQUIRE_UNSUPPORTED'
    }))
  })
})
