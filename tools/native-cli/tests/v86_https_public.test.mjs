/* eslint-disable test/no-import-node-test -- Native CLI driver; public assertions execute in Guest JS. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import https from 'node:https'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createNativeV86PublicFixture } from './v86_public_fixture.mjs'

const workload = new URL('../../../conformance/capabilities/process-https-native.test.mjs', import.meta.url)
const processLimits = {
  maxConcurrentProcesses: 1,
  maxTotalProcesses: 6,
  maxProcessTreeDepth: 1,
  maxExecutionTimeMs: 30_000,
  maxStdinBytes: 1024,
  maxStdoutBytes: 4096,
  maxStderrBytes: 8192,
  maxOpenPipes: 3,
  maxWritableRootfsBytes: 0
}

const openssl = (cwd, ...args) => {
  const result = spawnSync('openssl', args, { cwd, encoding: 'utf8', timeout: 10_000 })
  assert.equal(result.status, 0, `openssl ${args[0]}: ${result.stderr || result.error}`)
}

const issueCertificates = async (root, address) => {
  const privateRoot = join(root, 'private-tls')
  const publicRoot = join(root, 'public-ca')
  await mkdir(privateRoot)
  await mkdir(publicRoot)
  openssl(
    privateRoot,
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-sha256',
    '-days',
    '1',
    '-subj',
    '/CN=Holonomy HTTPS Fixture CA',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
    '-keyout',
    'ca-key.pem',
    '-out',
    'ca.pem'
  )
  openssl(
    privateRoot,
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-sha256',
    '-subj',
    `/CN=${address}`,
    '-keyout',
    'server-key.pem',
    '-out',
    'server.csr'
  )
  await writeFile(
    join(privateRoot, 'server.ext'),
    [
      `subjectAltName=IP:${address}`,
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      ''
    ].join('\n')
  )
  openssl(
    privateRoot,
    'x509',
    '-req',
    '-in',
    'server.csr',
    '-CA',
    'ca.pem',
    '-CAkey',
    'ca-key.pem',
    '-CAcreateserial',
    '-days',
    '1',
    '-sha256',
    '-extfile',
    'server.ext',
    '-out',
    'server.pem'
  )
  openssl(privateRoot, 'verify', '-CAfile', 'ca.pem', 'server.pem')
  openssl(
    privateRoot,
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-sha256',
    '-days',
    '1',
    '-subj',
    '/CN=Wrong Holonomy Fixture CA',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
    '-keyout',
    'wrong-ca-key.pem',
    '-out',
    'wrong-ca.pem'
  )
  await writeFile(join(publicRoot, 'ca.pem'), await readFile(join(privateRoot, 'ca.pem')))
  await writeFile(join(publicRoot, 'wrong-ca.pem'), await readFile(join(privateRoot, 'wrong-ca.pem')))
  assert.deepEqual((await readdir(publicRoot)).sort(), ['ca.pem', 'wrong-ca.pem'])
  return {
    key: await readFile(join(privateRoot, 'server-key.pem')),
    cert: await readFile(join(privateRoot, 'server.pem'))
  }
}

const startHttps = async (server, address, sockets) => {
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.setTimeout(10_000, () => socket.destroy())
  })
  server.listen(0, address)
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  return server.address().port
}

const reportFrom = result =>
  result.stdout.split('\n').map(line => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  }).find(value => Array.isArray(value?.results))

test('Native Linux curl verifies HTTPS over authorized raw TCP and read-only FUSE CA', {
  timeout: 130_000
}, async t => {
  const address = Object.values(networkInterfaces()).flat().find(value => value?.family === 'IPv4' && !value.internal)
    ?.address
  assert(address, 'A Host IPv4 interface is required for the local VM fixture')
  const effects = { allowedConnections: 0, requests: [], policyDeniedConnections: 0, middlewareDeniedConnections: 0 }
  const sockets = new Set()
  const fixture = await createNativeV86PublicFixture({
    testContext: t,
    prefix: 'holo-v86-https-public-',
    executables: [{ executableId: 'curl', path: '/usr/bin/curl' }],
    requiredKernelCapabilities: ['process', 'fuse'],
    hostConfig: {
      filesystemRoots: [{ rootId: 'workspace', hostPath: './public-ca' }],
      plugins: [{ id: 'https-source-check', use: './plugin.mjs' }],
      sandboxPolicy: {
        schemaVersion: 2,
        filesystem: {
          access: 'sandboxed',
          roots: [{ rootId: 'workspace', virtualUrl: 'holo-fs://workspace/', symlinks: 'deny', rights: ['read'] }],
          limits: {
            maxReadBytes: 1048576,
            maxWriteBytes: 1048576,
            maxOpenHandles: 8,
            maxWatchers: 0,
            maxDirectoryEntries: 32,
            maxQueuedEvents: 0
          }
        },
        process: {
          access: 'sandboxed',
          environment: { allowedNames: [], maxValueBytes: 1024 },
          executables: [{ executableId: 'curl', argumentBytes: 4096 }],
          shell: { access: 'none' },
          mounts: [{ rootId: 'workspace', guestPath: '/workspace', rights: ['read'] }],
          limits: processLimits,
          network: {
            access: 'restricted',
            endpoints: [],
            maxSockets: 1,
            privateNetwork: 'allow'
          }
        }
      }
    }
  })
  let servers = []
  try {
    const identity = await issueCertificates(fixture.root, address)
    const policyDenied = https.createServer(identity, (_request, response) => response.end('MUST_NOT_CONNECT'))
    policyDenied.on('connection', () => effects.policyDeniedConnections++)
    const middlewareDenied = https.createServer(identity, (_request, response) => response.end('MUST_NOT_CONNECT'))
    middlewareDenied.on('connection', () => effects.middlewareDeniedConnections++)
    const allowed = https.createServer(identity, (request, response) => {
      effects.requests.push(request.url)
      if (request.url === '/redirect') {
        response.writeHead(302, { location: `https://${address}:${policyDenied.address().port}/blocked` })
        response.end()
      } else response.end('HTTPS_OK')
    })
    allowed.on('connection', () => effects.allowedConnections++)
    servers = [allowed, policyDenied, middlewareDenied]
    const httpsPort = await startHttps(allowed, address, sockets)
    const policyDeniedPort = await startHttps(policyDenied, address, sockets)
    const middlewareDeniedPort = await startHttps(middlewareDenied, address, sockets)
    const host = JSON.parse(await readFile(join(fixture.root, 'host.json'), 'utf8'))
    host.sandboxPolicy.process.network.endpoints = [{
      hostname: address,
      ports: [httpsPort, middlewareDeniedPort],
      transport: 'tcp'
    }]
    await writeFile(join(fixture.root, 'host.json'), JSON.stringify(host), { mode: 0o600 })
    await fixture.write(
      'plugin.mjs',
      `export default ctx => {
      ctx.holo.intercept({operation:'process.network.connect'},(request,next) => {
        const source=request.source;
        if (!source || source.kind!=='linuxProcess' || source.executableId!=='curl' ||
            ![source.linuxPid,source.parentLinuxPid,source.rootLinuxPid,source.syntheticProcessId,
              source.processStartTimeTicks].every(value=>Number.isSafeInteger(value)&&value>=1) ||
            typeof source.processResourceId!=='string' || source.processResourceId.length===0 ||
            typeof source.environmentId!=='string' || source.environmentId.length===0 ||
            request.arguments.port===${middlewareDeniedPort}) return ctx.holo.deny(request);
        return next();
      },{execution:'sync'});
    };`
    )
    await fixture.write('workload.mjs', await readFile(workload))
    await fixture.write(
      'https.test.mjs',
      `import {registerNativeProcessHttpsTests} from './workload.mjs';
      registerNativeProcessHttpsTests(${
        JSON.stringify({
          address,
          httpsPort,
          policyDeniedPort,
          middlewareDeniedPort
        })
      });`
    )
    const result = await fixture.run('https.test.mjs')
    assert.equal(result.code, 0, result.stdout + result.stderr)
    assert.equal(result.signal, null)
    const report = reportFrom(result)
    assert(report, result.stdout + result.stderr)
    assert.equal(report.total, 6)
    assert.equal(report.passed, 6, result.stdout + result.stderr)
    assert.equal(report.failed, 0)
    assert.equal(report.skipped, 0)
    assert.deepEqual(effects.requests, ['/ok', '/redirect'])
    assert.equal(effects.policyDeniedConnections, 0)
    assert.equal(effects.middlewareDeniedConnections, 0)
    assert(effects.allowedConnections >= 4, 'TLS success and two certificate failures must reach the local server')
    t.diagnostic(JSON.stringify({ runtime: 'holo', guestReport: report, externalEffects: effects }))
  } finally {
    for (const socket of sockets) socket.destroy()
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))))
    await fixture.dispose()
  }
})
