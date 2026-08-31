export interface V86ImageExecutableV1 {
  readonly executableId: string
  readonly path: string
  readonly shell: boolean
}

export interface V86ImageProfileV1 {
  readonly executables: readonly V86ImageExecutableV1[]
  readonly id: string
  readonly packages: readonly string[]
  readonly rootfs: 'alpine' | 'empty'
  readonly schemaVersion: 1
}

export declare const canonicalJson: (value: unknown) => string

export declare const normalizeImageProfileV1: (value: unknown) => Readonly<V86ImageProfileV1>

export declare const readImageProfileV1: (selector: string) => Promise<Readonly<V86ImageProfileV1>>

export declare const sha256: (value: ArrayBufferView | string) => string
