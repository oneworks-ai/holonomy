const RuntimeArray = Array
const RuntimeFunction = Function
const RuntimeObject = Object
const RuntimeReflect = Reflect
const RuntimeSet = Set
const RuntimeString = String
const RuntimeWeakMap = WeakMap

const arrayFromIntrinsic = RuntimeArray.from
const arrayPushIntrinsic = RuntimeArray.prototype.push
const arraySpliceIntrinsic = RuntimeArray.prototype.splice
const functionBindIntrinsic = RuntimeFunction.prototype.bind
const objectCreateIntrinsic = RuntimeObject.create
const objectFreezeIntrinsic = RuntimeObject.freeze
const objectKeysIntrinsic = RuntimeObject.keys
const reflectApplyIntrinsic = RuntimeReflect.apply
const setAddIntrinsic = RuntimeSet.prototype.add
const setDeleteIntrinsic = RuntimeSet.prototype.delete
const setSizeGetter = RuntimeObject.getOwnPropertyDescriptor(RuntimeSet.prototype, 'size')?.get
const setValuesIntrinsic = RuntimeSet.prototype.values
const stringCharCodeAtIntrinsic = RuntimeString.prototype.charCodeAt
const stringToLowerCaseIntrinsic = RuntimeString.prototype.toLowerCase
const weakMapDeleteIntrinsic = RuntimeWeakMap.prototype.delete
const weakMapGetIntrinsic = RuntimeWeakMap.prototype.get
const weakMapHasIntrinsic = RuntimeWeakMap.prototype.has
const weakMapSetIntrinsic = RuntimeWeakMap.prototype.set

if (setSizeGetter === undefined) {
  throw new Error('Required mobile runtime intrinsics are unavailable')
}

export const callIntrinsic = <Result>(
  callback: (...args: never[]) => Result,
  receiver: unknown,
  args: readonly unknown[] = []
): Result => reflectApplyIntrinsic(callback, receiver, args) as Result

export const freeze = <Value>(value: Value): Readonly<Value> =>
  reflectApplyIntrinsic(objectFreezeIntrinsic, RuntimeObject, [value]) as Readonly<Value>

export const createNullRecord = (): Record<string, unknown> =>
  reflectApplyIntrinsic(objectCreateIntrinsic, RuntimeObject, [null]) as Record<string, unknown>

export const objectKeys = (value: object): string[] =>
  reflectApplyIntrinsic(objectKeysIntrinsic, RuntimeObject, [value]) as string[]

export const bindFunction = <Callback extends (...args: never[]) => unknown>(
  callback: Callback,
  receiver: unknown
): Callback => reflectApplyIntrinsic(functionBindIntrinsic, callback, [receiver]) as Callback

export const lowercaseString = (value: string): string =>
  reflectApplyIntrinsic(stringToLowerCaseIntrinsic, value, []) as string

export const stringCodeUnitAt = (value: string, index: number): number =>
  reflectApplyIntrinsic(stringCharCodeAtIntrinsic, value, [index]) as number

export const createRuntimeSet = <Value>(): Set<Value> => new RuntimeSet<Value>()

export const createRuntimeWeakMap = <Key extends object, Value>(): WeakMap<Key, Value> =>
  new RuntimeWeakMap<Key, Value>()

export const runtimeSetAdd = <Value>(set: Set<Value>, value: Value): void => {
  reflectApplyIntrinsic(setAddIntrinsic, set, [value])
}

export const runtimeSetDelete = <Value>(set: Set<Value>, value: Value): void => {
  reflectApplyIntrinsic(setDeleteIntrinsic, set, [value])
}

export const runtimeSetSize = (set: Set<unknown>): number => reflectApplyIntrinsic(setSizeGetter, set, []) as number

export const runtimeSetValues = <Value>(set: Set<Value>): Value[] => {
  const iterator = reflectApplyIntrinsic(setValuesIntrinsic, set, [])
  return reflectApplyIntrinsic(arrayFromIntrinsic, RuntimeArray, [iterator]) as Value[]
}

export const runtimeArrayPush = <Value>(array: Value[], value: Value): void => {
  reflectApplyIntrinsic(arrayPushIntrinsic, array, [value])
}

export const runtimeArrayClear = (array: unknown[]): void => {
  if (array.length === 0) return
  reflectApplyIntrinsic(arraySpliceIntrinsic, array, [0, array.length])
}

export const weakMapGet = <Key extends object, Value>(
  map: WeakMap<Key, Value>,
  key: Key
): Value | undefined => reflectApplyIntrinsic(weakMapGetIntrinsic, map, [key]) as Value | undefined

export const weakMapHas = <Key extends object>(map: WeakMap<Key, unknown>, key: Key): boolean =>
  reflectApplyIntrinsic(weakMapHasIntrinsic, map, [key]) as boolean

export const weakMapSet = <Key extends object, Value>(
  map: WeakMap<Key, Value>,
  key: Key,
  value: Value
): void => {
  reflectApplyIntrinsic(weakMapSetIntrinsic, map, [key, value])
}

export const weakMapDelete = <Key extends object>(map: WeakMap<Key, unknown>, key: Key): void => {
  reflectApplyIntrinsic(weakMapDeleteIntrinsic, map, [key])
}
