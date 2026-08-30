/* eslint-disable max-lines -- AST quota, scope construction and extraction form one parser boundary. */
import { parse } from 'acorn'
import type {
  AnyNode,
  AssignmentExpression,
  CallExpression,
  ExportNamedDeclaration,
  Expression,
  Identifier,
  ImportExpression,
  Literal,
  MemberExpression,
  Node,
  ObjectExpression,
  Options as AcornOptions,
  Pattern,
  Program,
  Property,
  TemplateLiteral,
  VariableDeclaration
} from 'acorn'

import { HolonomyModuleLoaderError } from './errors.js'
import { DEFAULT_HOLONOMY_MODULE_LOADER_LIMITS } from './types.js'
import type { HolonomyModuleLoaderLimits, ModuleDependencyKind, PlannedModuleFormat } from './types.js'

export interface AnalyzedDependency {
  kind: ModuleDependencyKind
  specifier: string | null
  start: number
}

export interface AnalyzedModuleSource {
  dependencies: readonly AnalyzedDependency[]
  exportNames: readonly string[]
  usesDlopen: boolean
}

type AstLimits = Pick<HolonomyModuleLoaderLimits, 'maxAstDepth' | 'maxAstNodes'>

interface LexicalScope {
  readonly bindings: Set<string>
  readonly kind: 'block' | 'function' | 'program' | 'static-block'
  readonly parent: LexicalScope | undefined
}

interface ScopedAst {
  readonly nodes: readonly AnyNode[]
  readonly scopeByNode: WeakMap<AnyNode, LexicalScope>
}

interface AstFrame {
  readonly depth: number
  readonly node: AnyNode
  readonly scope: LexicalScope
}

interface BindingBudget {
  nodes: number
}

type ProgramParser = (source: string, options: AcornOptions) => Program

const parseWithAcorn: ProgramParser = (source, options) => parse(source, options) as Program

let parserForTesting: ProgramParser | undefined

/**
 * Internal test seam for deterministic Acorn capacity failures. This leaf is
 * deliberately not re-exported from either package entry point.
 */
export const setModuleSourceParserForTesting = (parser: ProgramParser | undefined) => {
  const previous = parserForTesting
  parserForTesting = parser
  return () => {
    parserForTesting = previous
  }
}

const isNode = (value: unknown): value is AnyNode => (
  value != null && typeof value === 'object' &&
  typeof (value as { type?: unknown }).type === 'string'
)

const resourceExhausted = (url: string, resource: string) =>
  new HolonomyModuleLoaderError(
    'ERR_HOLONOMY_MODULE_RESOURCE_EXHAUSTED',
    `Holonomy module resource limit exceeded: ${resource}`,
    { url }
  )

const isParserCapacityError = (error: unknown) => (
  error instanceof RangeError ||
  (error instanceof SyntaxError && error.message.startsWith('Not enough stack space to parse input'))
)

const childNodes = (node: AnyNode, maximum: number, url: string) => {
  const children: AnyNode[] = []
  const add = (child: AnyNode) => {
    if (children.length >= maximum) throw resourceExhausted(url, 'AST nodes')
    children.push(child)
  }
  for (const value of Object.values(node)) {
    if (isNode(value)) {
      add(value)
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (isNode(item)) add(item)
      }
    }
  }
  return children
}

const isFunctionNode = (node: AnyNode) => (
  node.type === 'ArrowFunctionExpression' ||
  node.type === 'FunctionDeclaration' ||
  node.type === 'FunctionExpression'
)

const scopeKind = (node: AnyNode): LexicalScope['kind'] | undefined => {
  if (isFunctionNode(node)) return 'function'
  if (node.type === 'StaticBlock') return 'static-block'
  if (
    node.type === 'BlockStatement' ||
    node.type === 'CatchClause' ||
    node.type === 'ClassDeclaration' ||
    node.type === 'ClassExpression' ||
    node.type === 'ForInStatement' ||
    node.type === 'ForOfStatement' ||
    node.type === 'ForStatement' ||
    node.type === 'SwitchStatement'
  ) {
    return 'block'
  }
  return undefined
}

const addPatternBindings = (
  pattern: unknown,
  scope: LexicalScope,
  budget: BindingBudget,
  limits: AstLimits,
  url: string
) => {
  const pending: AnyNode[] = []
  const schedule = (value: unknown) => {
    if (!isNode(value)) return
    budget.nodes += 1
    if (budget.nodes > limits.maxAstNodes) throw resourceExhausted(url, 'binding nodes')
    pending.push(value)
  }
  schedule(pattern)
  while (pending.length > 0) {
    const current = pending.pop()!
    if (current.type === 'Identifier') {
      scope.bindings.add((current as Identifier).name)
      continue
    }
    if (current.type === 'RestElement') {
      schedule(current.argument)
      continue
    }
    if (current.type === 'AssignmentPattern') {
      schedule(current.left)
      continue
    }
    if (current.type === 'ArrayPattern') {
      for (const element of current.elements) schedule(element)
      continue
    }
    if (current.type !== 'ObjectPattern') continue
    for (const property of current.properties) {
      schedule(property.type === 'RestElement' ? property.argument : property.value)
    }
  }
}

const nearestVarScope = (scope: LexicalScope) => {
  let current = scope
  while (current.kind === 'block' && current.parent != null) current = current.parent
  return current
}

const registerBindings = (
  node: AnyNode,
  incomingScope: LexicalScope,
  nodeScope: LexicalScope,
  bindingBudget: BindingBudget,
  limits: AstLimits,
  url: string
) => {
  if (node.type === 'ImportDeclaration') {
    for (const specifier of node.specifiers) nodeScope.bindings.add(specifier.local.name)
  }
  if (node.type === 'VariableDeclaration') {
    const declaration = node as VariableDeclaration
    const target = declaration.kind === 'var' ? nearestVarScope(nodeScope) : nodeScope
    for (const item of declaration.declarations) {
      addPatternBindings(item.id, target, bindingBudget, limits, url)
    }
  }
  if (isFunctionNode(node)) {
    const functionNode = node as AnyNode & { id?: Identifier | null; params: readonly Pattern[] }
    if (node.type === 'FunctionDeclaration' && functionNode.id != null) {
      incomingScope.bindings.add(functionNode.id.name)
      nodeScope.bindings.add(functionNode.id.name)
    } else if (node.type === 'FunctionExpression' && functionNode.id != null) {
      nodeScope.bindings.add(functionNode.id.name)
    }
    for (const parameter of functionNode.params) {
      addPatternBindings(parameter, nodeScope, bindingBudget, limits, url)
    }
  }
  if (node.type === 'ClassDeclaration' && node.id != null) {
    incomingScope.bindings.add(node.id.name)
    nodeScope.bindings.add(node.id.name)
  } else if (node.type === 'ClassExpression' && node.id != null) {
    nodeScope.bindings.add(node.id.name)
  }
  if (node.type === 'CatchClause' && node.param != null) {
    addPatternBindings(node.param, nodeScope, bindingBudget, limits, url)
  }
}

const buildScopedAst = (
  program: Program,
  limits: AstLimits,
  url: string
): ScopedAst => {
  const rootScope: LexicalScope = {
    bindings: new Set(),
    kind: 'program',
    parent: undefined
  }
  const nodes: AnyNode[] = []
  const scopeByNode = new WeakMap<AnyNode, LexicalScope>()
  const bindingBudget: BindingBudget = { nodes: 0 }
  const pending: AstFrame[] = [{ depth: 1, node: program, scope: rootScope }]

  while (pending.length > 0) {
    const frame = pending.pop()!
    if (frame.depth > limits.maxAstDepth) throw resourceExhausted(url, 'AST depth')
    nodes.push(frame.node)
    if (nodes.length > limits.maxAstNodes) throw resourceExhausted(url, 'AST nodes')

    const kind = frame.node.type === 'Program' ? undefined : scopeKind(frame.node)
    const nodeScope = kind == null
      ? frame.scope
      : { bindings: new Set<string>(), kind, parent: frame.scope }
    scopeByNode.set(frame.node, nodeScope)
    registerBindings(frame.node, frame.scope, nodeScope, bindingBudget, limits, url)

    const children = childNodes(
      frame.node,
      limits.maxAstNodes - nodes.length - pending.length,
      url
    )
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]
      if (child != null) pending.push({ depth: frame.depth + 1, node: child, scope: nodeScope })
    }
  }

  return { nodes, scopeByNode }
}

const isUnbound = (scope: LexicalScope, name: string) => {
  let current: LexicalScope | undefined = scope
  while (current != null) {
    if (current.bindings.has(name)) return false
    current = current.parent
  }
  return true
}

const unwrapExpression = (expression: Expression): Expression => {
  let current = expression
  while (current.type === 'ParenthesizedExpression' || current.type === 'ChainExpression') {
    current = current.expression
  }
  return current
}

const identifierName = (node: Node | null | undefined) => (
  node?.type === 'Identifier' ? (node as Identifier).name : undefined
)

const literalString = (node: Node | null | undefined) => (
  node?.type === 'Literal' && typeof (node as Literal).value === 'string'
    ? (node as Literal).value as string
    : undefined
)

const templateString = (node: Node | null | undefined) => {
  if (node?.type !== 'TemplateLiteral') return undefined
  const template = node as TemplateLiteral
  if (template.expressions.length !== 0 || template.quasis.length !== 1) return undefined
  return template.quasis[0]?.value.cooked ?? undefined
}

const staticSpecifier = (node: Node | null | undefined) => {
  if (node == null || !isNode(node)) return undefined
  const unwrapped = node.type === 'ParenthesizedExpression' || node.type === 'ChainExpression'
    ? unwrapExpression(node as Expression)
    : node
  return literalString(unwrapped) ?? templateString(unwrapped)
}

const staticMemberProperty = (member: MemberExpression) => {
  if (!member.computed) return identifierName(member.property)
  return staticSpecifier(member.property)
}

const isDirectRequire = (callee: Expression) => (
  identifierName(unwrapExpression(callee)) === 'require'
)

const isRequireResolve = (callee: Expression) => {
  const unwrapped = unwrapExpression(callee)
  if (unwrapped.type !== 'MemberExpression') return false
  const member = unwrapped as MemberExpression
  const object = member.object.type === 'Super'
    ? undefined
    : unwrapExpression(member.object as Expression)
  return identifierName(object) === 'require' && staticMemberProperty(member) === 'resolve'
}

const isProcessDlopen = (node: AnyNode) => {
  if (node.type !== 'MemberExpression') return false
  const member = node as MemberExpression
  if (member.object.type === 'Super') return false
  return identifierName(unwrapExpression(member.object as Expression)) === 'process' &&
    staticMemberProperty(member) === 'dlopen'
}

const dynamicComputedCapability = (node: AnyNode) => {
  if (node.type !== 'MemberExpression' || !node.computed || staticMemberProperty(node) != null) {
    return undefined
  }
  if (node.object.type === 'Super') return undefined
  const name = identifierName(unwrapExpression(node.object as Expression))
  return name === 'process' || name === 'require' ? name : undefined
}

const collectPatternNames = (pattern: Pattern, names: Set<string>) => {
  const pending: unknown[] = [pattern]
  while (pending.length > 0) {
    const current = pending.pop()
    if (!isNode(current)) continue
    if (current.type === 'Identifier') {
      names.add(current.name)
    } else if (current.type === 'RestElement') {
      pending.push(current.argument)
    } else if (current.type === 'AssignmentPattern') {
      pending.push(current.left)
    } else if (current.type === 'ArrayPattern') {
      for (const element of current.elements) pending.push(element)
    } else if (current.type === 'ObjectPattern') {
      for (const property of current.properties) {
        pending.push(property.type === 'RestElement' ? property.argument : property.value)
      }
    }
  }
}

const collectDeclarationNames = (
  declaration: ExportNamedDeclaration['declaration'],
  names: Set<string>
) => {
  if (declaration == null) return
  if (declaration.type === 'VariableDeclaration') {
    for (const item of (declaration as VariableDeclaration).declarations) {
      collectPatternNames(item.id, names)
    }
    return
  }
  const name = identifierName(declaration.id)
  if (name != null) names.add(name)
}

const memberPath = (expression: Expression): readonly string[] | undefined => {
  const path: string[] = []
  let current = unwrapExpression(expression)
  while (current.type === 'MemberExpression') {
    const member = current as MemberExpression
    if (member.object.type === 'Super') return undefined
    const property = staticMemberProperty(member)
    if (property == null) return undefined
    path.push(property)
    current = unwrapExpression(member.object as Expression)
  }
  if (current.type !== 'Identifier') return undefined
  path.push((current as Identifier).name)
  return path.reverse()
}

const objectPropertyName = (property: Property) => (
  property.computed ? literalString(property.key) : identifierName(property.key) ?? literalString(property.key)
)

const collectCommonJsAssignmentExports = (
  assignment: AssignmentExpression,
  names: Set<string>
) => {
  if (assignment.left.type !== 'MemberExpression') return
  const path = memberPath(assignment.left as MemberExpression)
  if (path == null) return
  if (path.length === 2 && path[0] === 'exports') names.add(path[1] ?? '')
  if (path.length === 3 && path[0] === 'module' && path[1] === 'exports') {
    names.add(path[2] ?? '')
  }
  if (
    path.length !== 2 || path[0] !== 'module' || path[1] !== 'exports' ||
    assignment.right.type !== 'ObjectExpression'
  ) {
    return
  }
  for (const property of (assignment.right as ObjectExpression).properties) {
    if (property.type !== 'Property') continue
    const name = objectPropertyName(property as Property)
    if (name != null) names.add(name)
  }
}

const dependencyFromImportExpression = (node: ImportExpression): AnalyzedDependency => ({
  kind: 'dynamic-import',
  specifier: staticSpecifier(node.source) ?? null,
  start: node.start
})

const dependencyFromRequire = (
  node: CallExpression,
  kind: 'require' | 'require-resolve',
  url: string
): AnalyzedDependency => {
  const firstArgument = node.arguments[0]
  const specifier = firstArgument?.type === 'SpreadElement'
    ? undefined
    : staticSpecifier(firstArgument)
  if (specifier == null) {
    throw new HolonomyModuleLoaderError(
      'ERR_HOLONOMY_MODULE_DYNAMIC_REQUIRE_UNSUPPORTED',
      `Non-literal ${kind === 'require' ? 'require()' : 'require.resolve()'} is not supported`,
      { url }
    )
  }
  return { kind, specifier, start: node.start }
}

const parseProgram = (
  source: string,
  format: PlannedModuleFormat,
  url: string
) => {
  try {
    return (parserForTesting ?? parseWithAcorn)(source, {
      allowHashBang: true,
      allowReturnOutsideFunction: format === 'commonjs',
      ecmaVersion: 'latest',
      preserveParens: true,
      sourceType: format === 'module' ? 'module' : 'script'
    })
  } catch (error) {
    if (isParserCapacityError(error)) throw resourceExhausted(url, 'parser capacity')
    throw new HolonomyModuleLoaderError(
      'ERR_HOLONOMY_MODULE_SOURCE_INVALID',
      `Module source contains invalid ${format === 'commonjs' ? 'CommonJS' : 'ES module'} syntax`,
      { diagnosticCode: 'INVALID_SOURCE_SYNTAX', url }
    )
  }
}

export const analyzeModuleSource = (
  source: string,
  format: PlannedModuleFormat,
  url: string,
  limits: AstLimits = DEFAULT_HOLONOMY_MODULE_LOADER_LIMITS
): AnalyzedModuleSource => {
  if (format === 'json') {
    return { dependencies: [], exportNames: ['default'], usesDlopen: false }
  }
  if (format === 'synthetic') {
    return { dependencies: [], exportNames: [], usesDlopen: false }
  }

  const program = parseProgram(source, format, url)
  const { nodes, scopeByNode } = buildScopedAst(program, limits, url)
  const dependencies: AnalyzedDependency[] = []
  const exportNames = new Set<string>(format === 'commonjs' ? ['default'] : [])
  let usesDlopen = false

  for (const node of nodes) {
    const scope = scopeByNode.get(node)!
    const dynamicCapability = dynamicComputedCapability(node)
    if (dynamicCapability != null && isUnbound(scope, dynamicCapability)) {
      if (dynamicCapability === 'require') {
        throw new HolonomyModuleLoaderError(
          'ERR_HOLONOMY_MODULE_DYNAMIC_REQUIRE_UNSUPPORTED',
          'Dynamic computed access on global require is not supported',
          { url }
        )
      }
      throw new HolonomyModuleLoaderError(
        'ERR_HOLONOMY_MODULE_NATIVE_ADDON_UNSUPPORTED',
        'Dynamic computed access on global process is not supported',
        { url }
      )
    }
    if (isProcessDlopen(node) && isUnbound(scope, 'process')) usesDlopen = true
    if (node.type === 'ImportDeclaration') {
      const specifier = literalString(node.source)
      if (specifier != null) dependencies.push({ kind: 'import', specifier, start: node.start })
      continue
    }
    if (node.type === 'ExportAllDeclaration') {
      const specifier = literalString(node.source)
      if (specifier != null) dependencies.push({ kind: 'import', specifier, start: node.start })
      if (node.exported != null) {
        const name = identifierName(node.exported) ?? literalString(node.exported)
        if (name != null) exportNames.add(name)
      }
      continue
    }
    if (node.type === 'ExportDefaultDeclaration') {
      exportNames.add('default')
      continue
    }
    if (node.type === 'ExportNamedDeclaration') {
      const declaration = node as ExportNamedDeclaration
      collectDeclarationNames(declaration.declaration, exportNames)
      for (const specifier of declaration.specifiers) {
        const name = identifierName(specifier.exported) ?? literalString(specifier.exported)
        if (name != null) exportNames.add(name)
      }
      const sourceSpecifier = literalString(declaration.source)
      if (sourceSpecifier != null) {
        dependencies.push({ kind: 'import', specifier: sourceSpecifier, start: node.start })
      }
      continue
    }
    if (node.type === 'ImportExpression') {
      dependencies.push(dependencyFromImportExpression(node as ImportExpression))
      continue
    }
    if (format === 'commonjs' && node.type === 'AssignmentExpression') {
      collectCommonJsAssignmentExports(node as AssignmentExpression, exportNames)
      continue
    }
    if (format !== 'commonjs' || node.type !== 'CallExpression') continue
    const call = node as CallExpression
    if (call.callee.type === 'Super') continue
    if (isDirectRequire(call.callee as Expression) && isUnbound(scope, 'require')) {
      dependencies.push(dependencyFromRequire(call, 'require', url))
    } else if (isRequireResolve(call.callee as Expression) && isUnbound(scope, 'require')) {
      dependencies.push(dependencyFromRequire(call, 'require-resolve', url))
    }
  }

  dependencies.sort((left, right) => left.start - right.start)
  return {
    dependencies,
    exportNames: [...exportNames].filter(Boolean).sort(),
    usesDlopen
  }
}
