import type { JsonSchema } from './schema-primitives.js'

const SUPPORTED = new Set([
  '$defs',
  '$ref',
  'additionalProperties',
  'allOf',
  'anyOf',
  'const',
  'else',
  'enum',
  'if',
  'items',
  'maxItems',
  'maxLength',
  'maxProperties',
  'maximum',
  'minItems',
  'minLength',
  'minimum',
  'not',
  'oneOf',
  'pattern',
  'prefixItems',
  'properties',
  'propertyNames',
  'required',
  'then',
  'type',
  'uniqueItems'
])

const equal = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)

const numberConstraint = (value: unknown, schema: JsonSchema): boolean => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false
  if (typeof schema.minimum === 'number' && value < schema.minimum) return false
  if (typeof schema.maximum === 'number' && value > schema.maximum) return false
  return schema.type !== 'integer' || Number.isInteger(value)
}

const arrayConstraint = (value: unknown, schema: JsonSchema, root: JsonSchema): boolean => {
  if (!Array.isArray(value)) return false
  if (typeof schema.minItems === 'number' && value.length < schema.minItems) return false
  if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return false
  if (schema.uniqueItems === true && new Set(value.map(item => JSON.stringify(item))).size !== value.length) {
    return false
  }
  const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems as JsonSchema[] : []
  for (let index = 0; index < prefix.length && index < value.length; index += 1) {
    if (!validate(prefix[index]!, value[index], root)) return false
  }
  if (schema.items === false && value.length > prefix.length) return false
  if (schema.items != null && schema.items !== false) {
    for (let index = prefix.length; index < value.length; index += 1) {
      if (!validate(schema.items as JsonSchema, value[index], root)) return false
    }
  }
  return true
}

const objectConstraint = (value: unknown, schema: JsonSchema, root: JsonSchema): boolean => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>
  const required = Array.isArray(schema.required) ? schema.required as string[] : []
  if (typeof schema.maxProperties === 'number' && Object.keys(input).length > schema.maxProperties) return false
  if (required.some(key => !Object.hasOwn(input, key))) return false
  if (schema.additionalProperties === false && Object.keys(input).some(key => !Object.hasOwn(properties, key))) {
    return false
  }
  if (
    schema.propertyNames != null &&
    Object.keys(input).some(key => !validate(schema.propertyNames as JsonSchema, key, root))
  ) return false
  for (const [key, child] of Object.entries(properties)) {
    if (Object.hasOwn(input, key) && !validate(child, input[key], root)) return false
  }
  if (schema.additionalProperties != null && schema.additionalProperties !== false) {
    const additional = schema.additionalProperties as JsonSchema
    for (const [key, child] of Object.entries(input)) {
      if (!Object.hasOwn(properties, key) && !validate(additional, child, root)) return false
    }
  }
  return true
}

const validate = (schema: JsonSchema, value: unknown, root: JsonSchema): boolean => {
  if (Object.keys(schema).some(key => !SUPPORTED.has(key))) return false
  if (typeof schema.$ref === 'string') {
    const match = /^#\/\$defs\/([\w.-]+)$/u.exec(schema.$ref)
    const definition = match == null
      ? undefined
      : (root.$defs as Record<string, JsonSchema> | undefined)?.[match[1]!]
    return definition != null && validate(definition, value, root)
  }
  if (Object.hasOwn(schema, 'const') && !equal(value, schema.const)) return false
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).some(item => equal(value, item))) return false
  if (Array.isArray(schema.allOf) && !(schema.allOf as JsonSchema[]).every(item => validate(item, value, root))) {
    return false
  }
  if (Array.isArray(schema.anyOf) && !(schema.anyOf as JsonSchema[]).some(item => validate(item, value, root))) {
    return false
  }
  if (schema.if != null) {
    const branch = validate(schema.if as JsonSchema, value, root) ? schema.then : schema.else
    if (branch != null && !validate(branch as JsonSchema, value, root)) return false
  }
  if (schema.not != null && validate(schema.not as JsonSchema, value, root)) return false
  if (
    Array.isArray(schema.oneOf) &&
    (schema.oneOf as JsonSchema[]).filter(item => validate(item, value, root)).length !== 1
  ) return false
  if (schema.type === 'null' && value !== null) return false
  if (schema.type === 'boolean' && typeof value !== 'boolean') return false
  if (schema.type === 'number' || schema.type === 'integer') return numberConstraint(value, schema)
  if (schema.type === 'string') {
    if (typeof value !== 'string') return false
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) return false
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) return false
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) return false
  }
  if (schema.type === 'array' && !arrayConstraint(value, schema, root)) return false
  const isObject = value !== null && typeof value === 'object' && !Array.isArray(value)
  const hasObjectKeyword = schema.additionalProperties !== undefined ||
    schema.maxProperties !== undefined ||
    schema.properties !== undefined ||
    schema.propertyNames !== undefined ||
    schema.required !== undefined
  if (schema.type === 'object' && !isObject) return false
  if (isObject && hasObjectKeyword && !objectConstraint(value, schema, root)) return false
  return true
}

export const validateFiniteJsonSchemaV1 = (schema: JsonSchema, value: unknown): boolean =>
  validate(schema, value, schema)
