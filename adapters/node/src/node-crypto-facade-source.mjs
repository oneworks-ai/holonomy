// Compiled in the fresh Guest realm before entry. cryptoCall is a lexical Host
// intrinsic, never a property of any Guest object. Fixed arguments avoid foreign
// iterators on the Host path. Every returned object is created in this realm.
export const NODE_CRYPTO_FACADE_SOURCE = `(() => {
  const Bytes = Uint8Array
  const parse = JSON.parse
  const apply = Reflect.apply
  const create = Object.create
  const freeze = Object.freeze
  const ErrorType = Error
  const parseIntIntrinsic = Number.parseInt
  const slice = String.prototype.slice
  const owners = new WeakMap()
  const get = WeakMap.prototype.get
  const set = WeakMap.prototype.set
  const remove = WeakMap.prototype.delete
  const call = (op, token, first, second, third, fourth) => {
    const result = cryptoCall(op, token, first, second, third, fourth)
    if (result === null) throw new ErrorType('Crypto operation failed')
    return result
  }
  const decode = hex => {
    const length = hex.length / 2
    const output = new Bytes(length)
    for (let i = 0; i < length; i++) {
      output[i] = parseIntIntrinsic(apply(slice, hex, [i * 2, i * 2 + 2]), 16)
    }
    return output
  }
  const token = context => {
    const id = apply(get, owners, [context])
    if (id === undefined) throw new ErrorType('Crypto operation failed')
    return id
  }
  return freeze({
    createContext(request) {
      const kind = request.kind
      const id = call('create', undefined, kind, request.algorithm,
        kind === 'hash' ? undefined : request.key,
        kind === 'cipher' || kind === 'decipher' ? request.iv : undefined)
      const context = freeze(create(null))
      apply(set, owners, [context, id])
      return context
    },
    digest(context) { return decode(call('digest', token(context))) },
    dispose() { call('dispose') },
    disposeContext(context) {
      const id = apply(get, owners, [context])
      if (id !== undefined) {
        apply(remove, owners, [context])
        call('release', id)
      }
    },
    final(context) {
      const packet = parse(call('final', token(context)))
      const result = create(null)
      result.output = decode(packet.output)
      if (packet.authTag !== null) result.authTag = decode(packet.authTag)
      if (packet.authenticated !== null) result.authenticated = packet.authenticated
      return freeze(result)
    },
    randomBytes(size) { return decode(call('random', undefined, size)) },
    setAAD(context, aad) { call('aad', token(context), aad) },
    setAuthTag(context, tag) { call('tag', token(context), tag) },
    timingSafeEqual(left, right) { return call('equal', undefined, left, right) },
    update(context, data) { return decode(call('update', token(context), data)) }
  })
})()`
