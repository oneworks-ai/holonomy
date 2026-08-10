import type { NativeChunk, NativeResult, NativeStream } from './types.js'

export type NativeStreamNext = () => Promise<
  IteratorResult<NativeChunk, NativeResult | undefined>
>
export type NativeStreamClose = (reason?: string) => boolean

export class NativeStreamHandle implements NativeStream {
  constructor(
    readonly id: string,
    private readonly readNext: NativeStreamNext,
    private readonly closeStream: NativeStreamClose
  ) {}

  [Symbol.asyncIterator]() {
    return this
  }

  next() {
    return this.readNext()
  }

  async return(): Promise<IteratorResult<NativeChunk, NativeResult | undefined>> {
    this.closeStream('stream_closed')
    return { done: true, value: undefined }
  }

  close(reason?: string) {
    return this.closeStream(reason)
  }
}
