export interface NativeSourceBytes {
  readonly bytes: Uint8Array
  readonly sha256: string
  readonly metadataOnly?: true
}

export type NativeSourceReadPurpose = 'module' | 'packageMetadata'

export interface NativeSourceResource extends NativeSourceBytes {
  readonly canonicalUrl: string
}

export interface NativePrivatePackage extends NativeSourceBytes {
  readonly packageId: string
  readonly rootPath: string
}

export interface NativePrivateSourceRoot {
  readonly sourceRootId: string
  readonly rootPath: string
}

export type NativeSourceStat =
  | Readonly<{ kind: 'file'; size: number; mtimeMs: number }>
  | Readonly<{ kind: 'directory'; size: number; mtimeMs: number }>
  | Readonly<{ kind: 'missing' }>

export interface NativeSourceReader {
  statPrivate(path: string): Promise<NativeSourceStat>
  reservePrivateDirectory(path: string): Promise<void>
  readPrivate(
    path: string,
    kind: 'module' | 'manifest' | 'config' | 'schema'
  ): Promise<NativeSourceBytes | null>
  openPrivatePackage(root: string, requestedPackageJson: string): Promise<NativePrivatePackage | null>
  readPrivatePackage(
    packageId: string,
    relativePath: string,
    kind: 'module' | 'schema'
  ): Promise<NativeSourceBytes | null>
  openPrivateSourceRoot(
    rootPath: string,
    rootUrl: string,
    packageId?: string
  ): Promise<NativePrivateSourceRoot>
  readPrivateSourceResource(
    sourceRootId: string,
    url: string,
    purpose?: NativeSourceReadPurpose
  ): Promise<NativeSourceResource | null>
  capturePrivate(path: string): Promise<Extract<NativeSourceStat, { kind: 'file' }> | null>
  seal(): Promise<void>
  readGuest(url: string, purpose?: NativeSourceReadPurpose): Promise<NativeSourceBytes | null>
  readGuestResource(url: string, purpose?: NativeSourceReadPurpose): Promise<NativeSourceResource | null>
  close(): Promise<void>
}

export function createNativeSourceReader(options: {
  readonly binaryPath: string
  readonly workspaceRoot: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}): Promise<NativeSourceReader>
