export type MobileModuleLoaderErrorCode =
  | 'ERR_MOBILE_MODULE_DYNAMIC_REQUIRE_UNSUPPORTED'
  | 'ERR_MOBILE_MODULE_FORMAT_UNSUPPORTED'
  | 'ERR_MOBILE_MODULE_HOST_READ_FAILED'
  | 'ERR_MOBILE_MODULE_INTEGRITY'
  | 'ERR_MOBILE_MODULE_INVALID_PACKAGE_CONFIG'
  | 'ERR_MOBILE_MODULE_INVALID_URL'
  | 'ERR_MOBILE_MODULE_JSON_UNSUPPORTED'
  | 'ERR_MOBILE_MODULE_NATIVE_ADDON_UNSUPPORTED'
  | 'ERR_MOBILE_MODULE_NOT_FOUND'
  | 'ERR_MOBILE_MODULE_PATH_ESCAPE'
  | 'ERR_MOBILE_MODULE_PLUGIN_ENTRY_INVALID'
  | 'ERR_MOBILE_MODULE_REENTRANT_HOST_CALL'
  | 'ERR_MOBILE_MODULE_RESOURCE_EXHAUSTED'
  | 'ERR_MOBILE_MODULE_SOURCE_INVALID'
  | 'ERR_MOBILE_MODULE_SYNTHETIC_NOT_FOUND'
  | 'ERR_MOBILE_MODULE_TRANSACTION_ACTIVE'
  | 'ERR_MOBILE_MODULE_UNSUPPORTED_SCHEME'
  | 'ERR_PACKAGE_PATH_NOT_EXPORTED'
  | 'ERR_REQUIRE_ESM'

export interface MobileModuleLoaderErrorOptions {
  diagnosticCode?: MobileModuleLoaderDiagnosticCode
  specifier?: string
  url?: string
}

export type MobileModuleLoaderDiagnosticCode =
  | 'HOST_READ_FAILED'
  | 'INVALID_PACKAGE_JSON'
  | 'INVALID_SOURCE_BYTES'
  | 'INVALID_SOURCE_SYNTAX'
  | 'INVALID_URL'

export class MobileModuleLoaderError extends Error {
  readonly code: MobileModuleLoaderErrorCode
  readonly diagnosticCode: MobileModuleLoaderDiagnosticCode | undefined
  readonly specifier: string | undefined
  readonly url: string | undefined

  constructor(
    code: MobileModuleLoaderErrorCode,
    message: string,
    options: MobileModuleLoaderErrorOptions = {}
  ) {
    super(message)
    this.code = code
    this.diagnosticCode = options.diagnosticCode
    this.name = 'MobileModuleLoaderError'
    this.specifier = options.specifier
    this.url = options.url
  }
}

export class RequireEsmError extends MobileModuleLoaderError {
  constructor(url: string) {
    super(
      'ERR_REQUIRE_ESM',
      `Cannot require ES module ${url}; use import() instead`,
      { url }
    )
    this.name = 'RequireEsmError'
  }
}
