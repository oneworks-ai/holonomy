import Ajv2020 from 'ajv/dist/2020.js'

// Single semantic owner for Node preparation and the generated native
// validator asset. Defaults remain annotations because useDefaults is absent;
// formats and remote/custom loaders are intentionally not installed.
export const validateRuntimePluginConfig = (schema, value) => {
  if (schema == null) return
  const validator = new Ajv2020({ allErrors: false, strict: true, validateFormats: false }).compile(schema)
  if (!validator(value)) throw new Error('Holo plugin config does not match its Schema')
}
