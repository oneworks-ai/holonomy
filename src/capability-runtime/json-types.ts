export type JsonScalarV1 = boolean | null | number | string
export type JsonValueV1 =
  | JsonScalarV1
  | readonly JsonValueV1[]
  | Readonly<{ [key: string]: JsonValueV1 }>
