export function openHolonomyDevTools(
  devtoolsUrl: string,
  options?: {
    readonly executable?: string
    readonly spawn?: (...arguments_: unknown[]) => { unref(): void }
  }
): void
