export const jsonContent = schema => ({ 'application/json': { schema } })
export const response = (description, schema = { type: 'object' }) => ({ content: jsonContent(schema), description })
export const reference = name => ({ $ref: `#/components/schemas/${name}` })
export const idParameter = (name, description) => ({
  description,
  in: 'path',
  name,
  required: true,
  schema: { maxLength: 160, pattern: '^[A-Za-z0-9:._-]+$', type: 'string' }
})
export const mutationHeaders = [{
  description: 'Idempotently identifies this mutation for 24 hours.',
  in: 'header',
  name: 'Idempotency-Key',
  required: true,
  schema: { maxLength: 200, minLength: 1, type: 'string' }
}]
export const revisionHeader = {
  description: 'Expected network rule revision.',
  in: 'header',
  name: 'If-Match',
  required: true,
  schema: { maxLength: 64, minLength: 1, type: 'string' }
}
export const secured = operation => ({ ...operation, security: [{ bearerAuth: [] }] })
export const actionBody = properties => ({
  content: jsonContent({
    additionalProperties: false,
    properties,
    required: Object.keys(properties),
    type: 'object'
  }),
  required: true
})
export const actionBodyReference = name => ({
  content: jsonContent(reference(name)),
  required: true
})
export const resourceListOperation = (tag, schema) =>
  secured({
    responses: { 200: response(`${tag} inventory`, { items: reference(schema), type: 'array' }) },
    tags: [tag]
  })
