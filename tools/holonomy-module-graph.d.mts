export interface HolonomySourceModule {
  readonly source: string
  readonly url: string
}

export function expandHolonomyEntries(patterns: readonly string[], options?: { native?: boolean }): string[]
export function collectHolonomyGraph(
  entries: readonly string[],
  rootUrl: URL
): {
  readonly entryUrls: string[]
  readonly modules: Map<string, HolonomySourceModule>
}
