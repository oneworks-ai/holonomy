import config from '@antfu/eslint-config'

const maxLinesRule = [
  'error',
  {
    max: 200,
    skipBlankLines: false,
    skipComments: false
  }
]

const maxLinesTestRule = [
  'error',
  {
    max: 500,
    skipBlankLines: false,
    skipComments: false
  }
]

export default config(
  {
    ignores: [
      '**/*.d.ts',
      'dist/**',
      'coverage/**',
      'backends/v86/images/*-lock-v1.json',
      'packages/runtime/src/kernel/machine/*.json'
    ],
    stylistic: false,
    rules: {
      'max-lines': maxLinesRule,
      'perfectionist/sort-named-exports': 'off',
      'perfectionist/sort-named-imports': 'off'
    },
    typescript: {
      overrides: {
        'import/no-mutable-exports': 'off',
        'perfectionist/sort-imports': 'off',
        'perfectionist/sort-named-imports': 'off',
        'ts/ban-ts-comment': 'off',
        'ts/method-signature-style': 'off',
        'ts/no-empty-object-type': 'off',
        'ts/no-namespace': 'off',
        'ts/no-redeclare': 'off',
        'ts/no-unsafe-function-type': 'off',
        'ts/no-use-before-define': 'off',
        'ts/no-wrapper-object-types': 'off'
      }
    },
    javascript: {
      overrides: {
        'unused-imports/no-unused-vars': 'off'
      }
    },
    test: {
      overrides: {
        'test/consistent-test-it': 'off'
      }
    }
  },
  {
    files: ['backends/v86/images/*.mjs'],
    rules: {
      'antfu/no-top-level-await': 'off',
      'no-console': 'off'
    }
  },
  {
    files: [
      'adapters/android/process-backend-v86/src/main/backend/*.mjs',
      'adapters/node/src/capability-process-v86-environment.mjs',
      'adapters/node/src/capability-process-v86-fuse.mjs',
      'packages/holouv/src/supervisor-payload.ts'
    ],
    rules: {
      'max-lines': maxLinesTestRule
    }
  },
  {
    files: [
      '**/__tests__/**/*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}',
      '**/*.{spec,test}.{cjs,cts,js,jsx,mjs,mts,ts,tsx}',
      'adapters/android/e2e/src/backendProbe/**/*.mjs',
      'adapters/android/e2e/tools/generate-*.mjs',
      'tests/**/*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}'
    ],
    rules: {
      'max-lines': maxLinesTestRule
    }
  },
  {
    files: ['eslint.config.mjs', 'vitest.config.ts'],
    rules: {
      'no-console': 'off',
      'ts/strict-boolean-expressions': 'off'
    }
  },
  {
    files: [
      'adapters/node/src/capability-*.mjs',
      'tools/generate-capability-contracts.mjs',
      'tools/service/capability-runtime-*.mjs'
    ],
    rules: {
      'antfu/no-import-dist': 'off'
    }
  },
  {
    files: ['conformance/**/*.mjs'],
    rules: {
      'no-console': 'off',
      'test/no-import-node-test': 'off'
    }
  },
  {
    files: ['examples/**/*.mjs'],
    rules: {
      'antfu/no-top-level-await': 'off',
      'no-console': 'off'
    }
  },
  {
    files: ['.oo/skills/*/agents/openai.yaml'],
    rules: {
      'yaml/plain-scalar': 'off'
    }
  }
)
