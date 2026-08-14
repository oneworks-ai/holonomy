import { createHash } from 'node:crypto'
import ts from 'typescript'

const chapter = '0001-holo-capability-runtime'

const UNION_OWNERS = {
  BuiltInCapabilityNameV1: `${chapter}/capability-definitions.md`,
  DeviceOperationV1: `${chapter}/device-schema-v1.md`,
  EngineGateOperationV1: `${chapter}/engine-gate-and-realms.md`,
  FilesystemOperationV1: `${chapter}/filesystem-operation-registry.md`,
  HoloGuestErrorCodeV1: `${chapter}/error-contract-v1.md`,
  InternalCapabilityCodeV1: `${chapter}/error-contract-v1.md`,
  NetworkOperationV1: `${chapter}/network-operation-registry.md`,
  NodeGuestErrorCodeV1: `${chapter}/error-contract-v1.md`,
  ProcessOperationV1: `${chapter}/process-operation-registry.md`,
  RuntimeAdmissionCodeV1: `${chapter}/error-contract-v1.md`,
  SystemInformationOperationV1: `${chapter}/system-operation-registry.md`
}

const REGISTRY_TABLES = {
  FilesystemOperationV1: {
    owner: `${chapter}/filesystem-operation-registry.md`,
    columns: ['Module/member', 'Mode', 'Args / result', 'Operation/right', 'callback'],
    rows: 36,
    sha256: 'c24add10e06d3986f91201f6a03f53a8d388af48cdec6d1cef815ed7d8e053a5'
  },
  NetworkOperationV1: {
    owner: `${chapter}/network-operation-registry.md`,
    columns: ['Facade/member', 'Mode', 'Operation', 'Interception', 'Capability / authority', 'Args → result'],
    rows: 9,
    sha256: '94c4d2f8bcaf90973b12b578f974286f32d7f6b692c4b21481846b59d0691f2a'
  },
  ProcessOperationV1: {
    owner: `${chapter}/process-operation-registry.md`,
    columns: [
      'Member / branch',
      'Delivery',
      'Kind/layer',
      'Operation',
      'Capability requirement',
      'Args → result / callback schema',
      'Resource canonicalizer',
      'Limits owner'
    ],
    rows: 17,
    sha256: '6dd0480d974f078c94504d48811fdaf8255dd10e02d8dacba2fb53194cb50de7'
  },
  SystemInformationOperationV1: {
    owner: `${chapter}/system-operation-registry.md`,
    columns: ['Module/member', 'Operation', 'Capability', 'unavailable'],
    rows: 21,
    sha256: '0452690155ab196b28012f1c9247b8e85fcba85e70c1c9fb2a10a7551c22592d'
  }
}

const ERROR_TABLES = {
  ChildProcessErrorMapV1: {
    owner: `${chapter}/error-contract-v1.md`,
    marker: '`CAPABILITY_ERROR_MAP_V1.childProcess`',
    columns: ['Internal condition', 'node:child_process code/class'],
    rows: 13,
    sha256: '54c131e0a9cad2501a89f71712bbfb022e0ba146eb824dc589a43054c7d2b808'
  }
}

const REQUIRED_NORMATIVE_SNIPPETS = {
  [`${chapter}/process-and-linux-backend.md`]: [
    "readonly invocation: 'program'",
    'readonly argvDigest: string',
    "readonly invocation: 'shell'",
    'readonly commandDigest: string'
  ],
  [`${chapter}/process-operation-registry.md`]: [
    "extends Omit<ProcessSpawnOptionsV1, 'executableId' | 'args' | 'shell'>",
    "readonly stdio?: readonly [\n    stdin: 'pipe' | 'ignore',\n    stdout: 'pipe' | 'ignore',\n    stderr: 'pipe' | 'ignore'\n  ]",
    "immediateResultSchemaId: 'ChildProcessFacadeV1'",
    "eventSchemaId: 'ChildProcessEventV1'",
    "type ProcessReadableEventDeliveryV1 = Readonly<{\n  kind: 'resourceEvents'\n  eventSchemaId: 'ChildProcessReadableEventV1'\n  terminalEvent: 'close'\n}>",
    "terminalEvent: 'close'"
  ],
  [`${chapter}/process-resource-protocol.md`]: [
    'readonly stdout: ChildProcessReadableFacadeV1 | null',
    'readonly stderr: ChildProcessReadableFacadeV1 | null',
    'pause(): this\n  resume(): this\n  destroy(): this',
    'write(\n    data: FsDataV1,\n    callback?: (error: NodeErrorSnapshotV1 | null) => void\n  ): boolean',
    'end(callback?: (error: NodeErrorSnapshotV1 | null) => void): this'
  ],
  [`${chapter}/resources-and-snapshots.md`]: [
    "['processExecutable','program',executableId,argvDigest",
    "['processExecutable','shell',shellExecutableId,commandDigest"
  ]
}

const REQUIRED_PLUGIN_SNIPPETS = {
  [`${chapter}/runtime-plugins-and-watch.md`]: [
    'holo-plugins:///<plugin-instance-id>/<relative-path>',
    'readonly rootUrl: `holo-plugins:///' + '$' + '{string}/`',
    'readonly plugins?: readonly HoloPluginConfigEntryV1[]',
    'last-known-good plugin graph 完全不变',
    '原子发布递增的 `pluginGraphRevision`'
  ]
}

function literalUnion(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (!ts.isTypeAliasDeclaration(statement) || statement.name.text !== name) continue
    const nodes = ts.isUnionTypeNode(statement.type) ? statement.type.types : [statement.type]
    return new Set(
      nodes.filter(ts.isLiteralTypeNode).map(node => node.literal)
        .filter(ts.isStringLiteral).map(node => node.text)
    )
  }
  return new Set()
}

function tableCells(line) {
  return line.slice(1, -1).split('|').map(value => value.trim())
}

function firstTable(source) {
  const lines = source.split('\n')
  const start = lines.findIndex((line, index) =>
    line.startsWith('|') && lines[index + 1]?.startsWith('|') && lines[index + 1].includes('---')
  )
  if (start < 0) return { columns: [], rows: [], signature: '' }
  const table = []
  for (let index = start; index < lines.length && lines[index].startsWith('|'); index += 1) {
    if (index !== start + 1) table.push(tableCells(lines[index]))
  }
  const normalized = table.map(row => row.join('\u001F')).join('\u001E')
  return {
    columns: table[0] ?? [],
    rows: table.slice(1),
    signature: createHash('sha256').update(normalized).digest('hex')
  }
}

function tableAfter(source, marker) {
  const start = source.indexOf(marker)
  return firstTable(start < 0 ? '' : source.slice(start))
}

function checkLiteralFamily(allSource, literals, pattern, label, failures, ignored = new Set()) {
  for (const value of new Set(allSource.match(pattern) ?? [])) {
    if (!ignored.has(value) && !literals.has(value)) failures.push(`${label} outside closed union: ${value}`)
  }
}

function checkClosedLiterals(allSource, sourceFile, failures) {
  const unions = new Map(Object.keys(UNION_OWNERS).map(name => [name, literalUnion(sourceFile, name)]))
  const operations = new Set(
    [...unions].filter(([name]) => name.endsWith('OperationV1'))
      .flatMap(([, values]) => [...values])
  )
  checkLiteralFamily(
    allSource,
    operations,
    /(?<!host\.)\b(?:device|system|filesystem|network|process)(?:\.[a-z0-9-]+){2,}\b/g,
    'operation',
    failures
  )
  checkLiteralFamily(
    allSource,
    unions.get('BuiltInCapabilityNameV1'),
    /\bhost\.[a-z0-9_.-]+\b/g,
    'capability',
    failures
  )
  checkLiteralFamily(
    allSource,
    unions.get('HoloGuestErrorCodeV1'),
    /\bholo\.[a-z0-9_.-]+\b/g,
    'Holo error',
    failures,
    new Set(['holo.config.json'])
  )
  checkLiteralFamily(
    allSource,
    unions.get('NodeGuestErrorCodeV1'),
    /\b(?:E[A-Z][A-Z0-9_]+|ABORT_ERR)\b/g,
    'Node error',
    failures,
    new Set(['E2E', 'ERR_'])
  )
  checkLiteralFamily(
    allSource,
    unions.get('RuntimeAdmissionCodeV1'),
    /\bruntime\.(?:configuration|policy|binding)_[a-z0-9_]+\b/g,
    'admission error',
    failures
  )
  const internalPattern =
    /(?<![\w.-])(?:policy|capability|argument|resource|middleware|provider|result)\.[a-z][a-z0-9_]*\b|(?<![\w.-])runtime\.(?:cancelled|generation_stale|async_required)\b/g
  checkLiteralFamily(
    allSource,
    unions.get('InternalCapabilityCodeV1'),
    internalPattern,
    'internal error',
    failures,
    new Set(['middleware.md', 'resource.close'])
  )
  for (const [name, owner] of Object.entries(UNION_OWNERS)) {
    for (const literal of unions.get(name)) {
      const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if ([...allSource.matchAll(new RegExp(escaped, 'g'))].length < 2) {
        failures.push(`${owner}: ${literal} has no registry/mapping reference`)
      }
    }
  }
  return unions
}

function checkRegistryTables(sources, unions, failures) {
  for (const [unionName, descriptor] of Object.entries(REGISTRY_TABLES)) {
    const table = firstTable(sources.get(descriptor.owner) ?? '')
    if (table.columns.join('\n') !== descriptor.columns.join('\n')) {
      failures.push(`${descriptor.owner}: Registry columns differ from machine descriptor`)
    }
    if (table.rows.length !== descriptor.rows) {
      failures.push(`${descriptor.owner}: Registry row count differs from machine descriptor`)
    }
    if (table.signature !== descriptor.sha256) {
      failures.push(`${descriptor.owner}: Registry semantic signature differs from machine descriptor`)
    }
    for (const operation of unions.get(unionName)) {
      if (!table.rows.some(row => row.some(cell => cell === operation || cell.startsWith(`${operation} /`)))) {
        failures.push(`${descriptor.owner}: missing Registry row for ${operation}`)
      }
    }
    if (unionName === 'ProcessOperationV1') {
      const declarations = new Set()
      for (const statement of unions.sourceFile?.statements ?? []) {
        if ('name' in statement && statement.name && ts.isIdentifier(statement.name)) {
          declarations.add(statement.name.text)
        }
      }
      const identifiers = table.rows.flat().flatMap(cell => cell.match(/\b[A-Z][A-Za-z0-9]*(?:V1|V2)\b/g) ?? [])
      for (const identifier of new Set(identifiers)) {
        if (!declarations.has(identifier)) {
          failures.push(`${descriptor.owner}: Registry schema has no normative owner: ${identifier}`)
        }
      }
    }
  }
  for (const descriptor of Object.values(ERROR_TABLES)) {
    const table = tableAfter(sources.get(descriptor.owner) ?? '', descriptor.marker)
    if (
      table.columns.join('\n') !== descriptor.columns.join('\n') || table.rows.length !== descriptor.rows ||
      table.signature !== descriptor.sha256
    ) {
      failures.push(`${descriptor.owner}: error mapping semantic signature differs from machine descriptor`)
    }
  }
  for (const [owner, snippets] of Object.entries(REQUIRED_NORMATIVE_SNIPPETS)) {
    const source = sources.get(owner) ?? ''
    for (const snippet of snippets) {
      if (!source.includes(snippet)) failures.push(`${owner}: missing required normative Process contract: ${snippet}`)
    }
  }
  for (const [owner, snippets] of Object.entries(REQUIRED_PLUGIN_SNIPPETS)) {
    const source = sources.get(owner) ?? ''
    for (const snippet of snippets) {
      if (!source.includes(snippet)) failures.push(`${owner}: missing required Runtime Plugin contract: ${snippet}`)
    }
  }
}

export function verifyRfcSemantics(sources, allSource, sourceFile, failures) {
  const unions = checkClosedLiterals(allSource, sourceFile, failures)
  unions.sourceFile = sourceFile
  checkRegistryTables(sources, unions, failures)
}

export function currentRegistrySignatures(sources) {
  return {
    ...Object.fromEntries(
      Object.entries(REGISTRY_TABLES).map((
        [name, descriptor]
      ) => [name, firstTable(sources.get(descriptor.owner) ?? '').signature])
    ),
    ...Object.fromEntries(
      Object.entries(ERROR_TABLES).map((
        [name, descriptor]
      ) => [name, tableAfter(sources.get(descriptor.owner) ?? '', descriptor.marker).signature])
    )
  }
}
