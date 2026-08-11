export interface HolonomyDocumentationOptions {
  cwd?: string
}

export declare const readHolonomyDocumentation: (
  input: readonly string[],
  options?: HolonomyDocumentationOptions
) => string | undefined
