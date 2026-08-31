export type HolonomyModuleLoaderErrorCode =
  | 'ERR_HOLONOMY_MODULE_DYNAMIC_REQUIRE_UNSUPPORTED'
  | 'ERR_HOLONOMY_MODULE_FORMAT_UNSUPPORTED'
  | 'ERR_HOLONOMY_MODULE_HOST_READ_FAILED'
  | 'ERR_HOLONOMY_MODULE_INTEGRITY'
  | 'ERR_HOLONOMY_MODULE_INVALID_PACKAGE_CONFIG'
  | 'ERR_HOLONOMY_MODULE_INVALID_URL'
  | 'ERR_HOLONOMY_MODULE_JSON_UNSUPPORTED'
  | 'ERR_HOLONOMY_MODULE_NATIVE_ADDON_UNSUPPORTED'
  | 'ERR_HOLONOMY_MODULE_NOT_FOUND'
  | 'ERR_HOLONOMY_MODULE_PATH_ESCAPE'
  | 'ERR_HOLONOMY_MODULE_PLUGIN_ENTRY_INVALID'
  | 'ERR_HOLONOMY_MODULE_REENTRANT_HOST_CALL'
  | 'ERR_HOLONOMY_MODULE_RESOURCE_EXHAUSTED'
  | 'ERR_HOLONOMY_MODULE_SOURCE_INVALID'
  | 'ERR_HOLONOMY_MODULE_SYNTHETIC_NOT_FOUND'
  | 'ERR_HOLONOMY_MODULE_TRANSACTION_ACTIVE'
  | 'ERR_HOLONOMY_MODULE_UNSUPPORTED_SCHEME'
  | 'ERR_PACKAGE_PATH_NOT_EXPORTED'
  | 'ERR_REQUIRE_ESM'

export interface HolonomyModuleLoaderErrorOptions {
  diagnosticCode?: HolonomyModuleLoaderDiagnosticCode
  specifier?: string
  url?: string
}

export type HolonomyModuleLoaderDiagnosticCode =
  | 'HOST_READ_FAILED'
  | 'INVALID_PACKAGE_JSON'
  | 'INVALID_SOURCE_BYTES'
  | 'INVALID_SOURCE_SYNTAX'
  | 'INVALID_URL'

export class HolonomyModuleLoaderError extends Error {
  readonly code: HolonomyModuleLoaderErrorCode
  readonly diagnosticCode: HolonomyModuleLoaderDiagnosticCode | undefined
  readonly specifier: string | undefined
  readonly url: string | undefined

  constructor(
    code: HolonomyModuleLoaderErrorCode,
    message: string,
    options: HolonomyModuleLoaderErrorOptions = {}
  ) {
    super(message)
    this.code = code
    this.diagnosticCode = options.diagnosticCode
    this.name = 'HolonomyModuleLoaderError'
    this.specifier = options.specifier
    this.url = options.url
  }
}

export class RequireEsmError extends HolonomyModuleLoaderError {
  constructor(url: string) {
    super(
      'ERR_REQUIRE_ESM',
      `Cannot require ES module ${url}; use import() instead`,
      { url }
    )
    this.name = 'RequireEsmError'
  }
}
