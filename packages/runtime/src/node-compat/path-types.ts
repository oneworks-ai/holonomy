export interface PathParseResult {
  base: string
  dir: string
  ext: string
  name: string
  root: string
}

export interface PathCompatApi {
  readonly basename: (path: string, suffix?: string) => string
  readonly delimiter: ':'
  readonly dirname: (path: string) => string
  readonly extname: (path: string) => string
  readonly isAbsolute: (path: string) => boolean
  readonly join: (...paths: string[]) => string
  readonly normalize: (path: string) => string
  readonly parse: (path: string) => PathParseResult
  readonly relative: (from: string, to: string) => string
  readonly resolve: (...paths: string[]) => string
  readonly sep: '/'
}

export interface PathSyntheticModule extends PathCompatApi {
  readonly default: PathCompatApi & Readonly<{ posix: PathCompatApi }>
  readonly posix: PathCompatApi
}
