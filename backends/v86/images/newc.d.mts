export interface NewcEntryV1 {
  readonly bytes: Uint8Array
  readonly mode: number
  readonly name: string
}

export declare const createNewcArchiveFromEntriesV1: (
  values: readonly NewcEntryV1[]
) => Uint8Array

export declare const createNewcArchiveV1: (root: string) => Promise<Uint8Array>

export declare const parseNewcArchiveV1: (
  bytes: Uint8Array
) => readonly Readonly<NewcEntryV1>[]
