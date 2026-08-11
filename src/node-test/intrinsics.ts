const ARRAY_IS_ARRAY = Array.isArray
const DATE_NOW = Date.now
const MATH_MAX = Math.max
const OBJECT_ASSIGN = Object.assign
const OBJECT_CREATE = Object.create
const OBJECT_DEFINE_PROPERTIES = Object.defineProperties
const OBJECT_DEFINE_PROPERTY = Object.defineProperty
const OBJECT_FREEZE = Object.freeze
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf
const OBJECT_IS = Object.is
const REFLECT_OWN_KEYS = Reflect.ownKeys
const STRING = String

export const appendTestValue = <Value>(target: Value[], value: Value) => {
  OBJECT_DEFINE_PROPERTY(target, target.length, {
    configurable: true,
    enumerable: true,
    value,
    writable: true
  })
}

export const assignTestProperties: typeof Object.assign = OBJECT_ASSIGN
export const createTestRecord = () => OBJECT_CREATE(null) as Record<string, unknown>
export const defineTestProperties: typeof Object.defineProperties = OBJECT_DEFINE_PROPERTIES
export const defineTestProperty: typeof Object.defineProperty = OBJECT_DEFINE_PROPERTY
export const freezeTestValue: typeof Object.freeze = OBJECT_FREEZE
export const getTestOwnDescriptor: typeof Object.getOwnPropertyDescriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR
export const getTestPrototype: typeof Object.getPrototypeOf = OBJECT_GET_PROTOTYPE_OF
export const isTestArray: typeof Array.isArray = ARRAY_IS_ARRAY
export const isTestValue: typeof Object.is = OBJECT_IS
export const nowForTest = DATE_NOW
export const maxTestNumber = MATH_MAX
export const ownTestKeys: typeof Reflect.ownKeys = REFLECT_OWN_KEYS
export const testString = STRING
