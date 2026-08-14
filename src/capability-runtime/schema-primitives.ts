export type JsonSchema = Readonly<Record<string, unknown>>

export const integerSchema = (minimum: number, maximum: number): JsonSchema =>
  Object.freeze({ maximum, minimum, type: 'integer' })

export const strictObject = (
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[] = Object.keys(properties)
): JsonSchema =>
  Object.freeze({
    additionalProperties: false,
    properties,
    required,
    type: 'object'
  })

export const stringSetSchema = (
  items: JsonSchema,
  minItems: number,
  maxItems: number
): JsonSchema => Object.freeze({ items, maxItems, minItems, type: 'array', uniqueItems: true })

export const noneSchema = strictObject({ access: { const: 'none' } })
