/* eslint-disable test/no-import-node-test -- Native CLI journey driver; Guest assertions live in conformance. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import dgram from 'node:dgram'
import { once } from 'node:events'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const binary = process.env.HOLONOMY_NATIVE_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../../../target/debug/holo', import.meta.url))
const workload = new URL('../../../conformance/capabilities/process-network-native.test.mjs', import.meta.url)
const lifecycleWorkload = new URL(
  '../../../conformance/capabilities/process-network-native-lifecycle.test.mjs',
  import.meta.url
)
const pins = Object.freeze({
  'seabios.bin': '73e3f359102e3a9982c35fce98eb7cd08f18303ac7f1ba6ebfbe6cdc1c244d98',
  'kernel.bin': 'ca4d39b3035d6ba733416c82a44c8d636f3f544a13fea775a11583f482d16c78',
  'agent.cpio': '14079ff3d8c1d0dcd6801b60c7acc0cabea0e6572d718877a31e1393e3f80514',
  'v86.wasm': '8a969d64cf8f64b8183fdcc3a2ccdb31ae5ae6db7c9fba49949106f574640a7b'
})

test(
  'standalone Native runs real Linux network and lifecycle JS unit cases through Process authority',
  { timeout: 130_000 },
  async t => {
    assert.equal(process.platform, 'darwin', 'This explicit profile gate currently requires macOS')
    const assets = process.env.HOLO_V86_PRODUCTION_ASSET_ROOT
    assert(assets, 'Set HOLO_V86_PRODUCTION_ASSET_ROOT to the pinned production agent image')
    for (const [name, digest] of Object.entries(pins)) {
      assert.equal(createHash('sha256').update(await readFile(join(assets, name))).digest('hex'), digest, name)
    }
    const engine = spawnSync(binary, ['engine', 'info', '--json'], {
      env: { PATH: '' },
      encoding: 'utf8',
      timeout: 5000
    })
    assert.equal(engine.status, 0, engine.stderr)
    assert.equal(JSON.parse(engine.stdout).v86BackendCompiled, true, 'Build the explicit v86-backend feature first')
    const address = Object.values(networkInterfaces()).flat().find(value => value?.family === 'IPv4' && !value.internal)
      ?.address
    assert(address, 'The self-address fixture needs a Host IPv4 interface; it never uses a public server')
    const root = await realpath(await mkdtemp(join(tmpdir(), 'holo-v86-network-public-')))
    const sockets = new Set()
    const counts = {
      tcp: 0,
      udp: 0,
      http: 0,
      denied: 0,
      tcpAbort: 0,
      tcpQuota: 0,
      tcpAfter: 0,
      tcpQuotaProbe: 0,
      httpAbort: 0,
      httpKill: 0,
      httpAfter: 0,
      oldRuntime: 0,
      newRuntime: 0
    }
    let oldPendingResponse
    let oldPendingClosed
    const track = socket => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    }
    const tcp = net.createServer(socket => {
      counts.tcp++
      track(socket)
      socket.setTimeout(10_000, () => socket.destroy())
      let input = ''
      socket.on('data', bytes => {
        input += bytes
        if (input === 'TCP_REQUEST') socket.end('TCP_RESPONSE')
        else if (input === 'HOLD_ABORT' || input === 'HOLD_QUOTA') {
          if (input === 'HOLD_ABORT') counts.tcpAbort++
          else counts.tcpQuota++
          socket.write('TCP_READY')
        } else if (input === 'AFTER_ABORT' || input === 'AFTER_QUOTA' || input === 'AFTER_PRE_ABORT') {
          counts.tcpAfter++
          socket.end('TCP_AFTER')
        } else if (input === 'QUOTA_PROBE') {
          counts.tcpQuotaProbe++
          socket.end('QUOTA_CONNECTED')
        }
      })
    })
    const denied = http.createServer((_request, response) => response.end('MUST_NOT_CONNECT'))
    denied.on('connection', socket => {
      counts.denied++
      track(socket)
    })
    const web = http.createServer((request, response) => {
      counts.http++
      if (request.url === '/hold-abort' || request.url === '/hold-kill') {
        if (request.url === '/hold-abort') counts.httpAbort++
        else counts.httpKill++
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.write('HTTP_READY')
        return
      }
      if (request.url === '/after-abort' || request.url === '/after-kill') {
        counts.httpAfter++
        response.end('HTTP_AFTER')
        return
      }
      if (request.url === '/hold-old') {
        counts.oldRuntime++
        oldPendingResponse = response
        oldPendingClosed = once(response, 'close')
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.write('OLD_READY')
        return
      }
      if (request.url === '/new-runtime') {
        counts.newRuntime++
        oldPendingResponse?.end('OLD_RESULT')
        response.end('NEW_RUNTIME')
        return
      }
      if (request.url === `/redirect/${denied.address().port}`) {
        response.writeHead(302, { location: `http://${address}:${denied.address().port}/blocked` })
        response.end()
        return
      }
      response.end('HTTP_RESPONSE')
    })
    web.on('connection', track)
    const udp = dgram.createSocket('udp4')
    udp.on('message', (bytes, peer) => {
      counts.udp++
      if (bytes.toString() === 'UDP_REQUEST') udp.send('UDP_RESPONSE', peer.port, peer.address)
    })
    let child
    let udpBound = false
    try {
      for (const server of [tcp, web, denied]) {
        server.listen(0, server === web ? '0.0.0.0' : address)
        await once(server, 'listening')
      }
      udp.bind(0, address)
      await once(udp, 'listening')
      udpBound = true
      const fixture = {
        address,
        tcpPort: tcp.address().port,
        udpPort: udp.address().port,
        httpPort: web.address().port,
        deniedPort: denied.address().port
      }
      const limits = {
        maxConcurrentProcesses: 1,
        maxTotalProcesses: 6,
        maxProcessTreeDepth: 1,
        maxExecutionTimeMs: 30_000,
        maxStdinBytes: 4096,
        maxStdoutBytes: 4096,
        maxStderrBytes: 8192,
        maxOpenPipes: 3,
        maxWritableRootfsBytes: 0
      }
      await writeFile(
        join(root, 'host.json'),
        JSON.stringify({
          schemaVersion: 1,
          processProfileId: 'linux',
          plugins: [{ id: 'source-check', use: './plugin.mjs' }],
          sandboxPolicy: {
            schemaVersion: 2,
            process: {
              access: 'sandboxed',
              environment: { allowedNames: [], maxValueBytes: 1024 },
              executables: [{ executableId: 'nc', argumentBytes: 4096 }, { executableId: 'curl', argumentBytes: 4096 }],
              shell: { access: 'none' },
              mounts: [],
              limits,
              network: {
                access: 'restricted',
                endpoints: [
                  {
                    hostname: address,
                    ports: [fixture.tcpPort, fixture.httpPort, fixture.deniedPort],
                    transport: 'tcp'
                  },
                  { hostname: address, ports: [fixture.udpPort], transport: 'udp' },
                  { hostname: 'localhost', ports: [fixture.httpPort], transport: 'tcp' }
                ],
                maxSockets: 1,
                privateNetwork: 'allow'
              }
            }
          }
        }),
        { mode: 0o600 }
      )
      const lifecycleHost = JSON.parse(await readFile(join(root, 'host.json'), 'utf8'))
      Object.assign(lifecycleHost.sandboxPolicy.process.limits, {
        maxConcurrentProcesses: 2,
        maxTotalProcesses: 12,
        maxOpenPipes: 6
      })
      await writeFile(join(root, 'lifecycle-host.json'), JSON.stringify(lifecycleHost), { mode: 0o600 })
      await writeFile(
        join(root, 'plugin.mjs'),
        `export default ctx=>{
      ctx.holo.intercept({operation:'process.network.connect'},(request,next)=>{
        const s=request.source;
        if(!s||s.kind!=='linuxProcess'||s.linuxPid<1||s.parentLinuxPid<1||s.processStartTimeTicks<1||
           !s.processResourceId||!['nc','curl'].includes(s.executableId))return ctx.holo.deny(request);
        if(request.arguments.port===${fixture.deniedPort})return ctx.holo.deny(request);
        return next();
      },{execution:'sync'});
    }`
      )
      const artifact = name => ({ artifactId: name, sha256: pins[name] })
      await writeFile(
        join(root, 'profiles.json'),
        JSON.stringify({
          schemaVersion: 1,
          profiles: {
            linux: {
              profile: 'process-profile-v1',
              backend: {
                backendId: 'experimental.v86-v1',
                configuration: {
                  artifacts: {
                    bios: artifact('seabios.bin'),
                    kernel: artifact('kernel.bin'),
                    initrd: artifact('agent.cpio'),
                    wasm: artifact('v86.wasm')
                  },
                  memoryBytes: 134217728,
                  requiredKernelCapabilities: ['process'],
                  supervisor: { protocolVersion: 1, execGateTimeoutMs: 30_000 }
                }
              },
              environment: {
                allowedScopes: ['processTree'],
                defaultScope: 'processTree',
                capabilityBridge: { domains: [] }
              },
              executables: [
                {
                  executableId: 'nc',
                  executable: { kind: 'guestPath', path: '/usr/bin/nc' },
                  fixedArgs: [],
                  shell: false
                },
                {
                  executableId: 'curl',
                  executable: { kind: 'guestPath', path: '/usr/bin/curl' },
                  fixedArgs: [],
                  shell: false
                }
              ]
            }
          }
        }),
        { mode: 0o600 }
      )
      await writeFile(
        join(root, 'backends.json'),
        JSON.stringify({
          schemaVersion: 1,
          backends: {
            'experimental.v86-v1': { implementation: 'builtin.v86-v1', artifactRoot: await realpath(assets) }
          }
        }),
        { mode: 0o600 }
      )
      await writeFile(join(root, 'workload.mjs'), await readFile(workload))
      await writeFile(
        join(root, 'network.test.mjs'),
        `import {registerNativeProcessNetworkTests} from './workload.mjs';registerNativeProcessNetworkTests(${
          JSON.stringify(fixture)
        });`
      )
      await writeFile(join(root, 'lifecycle-workload.mjs'), await readFile(lifecycleWorkload))
      await writeFile(
        join(root, 'network-lifecycle.test.mjs'),
        `import {registerNativeProcessNetworkLifecycleTests} from './lifecycle-workload.mjs';` +
          `registerNativeProcessNetworkLifecycleTests(${JSON.stringify(fixture)});`
      )
      const args = (mode, hostConfig) => [
        mode,
        '--timeout',
        '110000',
        '--host-config',
        hostConfig,
        '--process-profiles',
        'profiles.json',
        '--process-backends',
        'backends.json',
        '--experimental-v86-process'
      ]
      const launch = (mode, entries, hostConfig = 'host.json') => {
        child = spawn(binary, [...args(mode, hostConfig), ...entries], {
          cwd: root,
          env: { PATH: '' },
          stdio: ['ignore', 'pipe', 'pipe']
        })
        const active = child
        let stdout = ''
        let stderr = ''
        let closed = false
        const waiters = new Set()
        active.stdout.on('data', bytes => {
          stdout = (stdout + bytes).slice(-200_000)
          for (const waiter of waiters) {
            if (stdout.includes(waiter.marker)) {
              waiters.delete(waiter)
              waiter.resolve()
            }
          }
        })
        active.stderr.on('data', bytes => stderr = (stderr + bytes).slice(-200_000))
        const timer = setTimeout(() => active.kill('SIGKILL'), 120_000)
        const done = new Promise(resolve =>
          active.once('close', (code, signal) => {
            clearTimeout(timer)
            closed = true
            for (const waiter of waiters) waiter.reject(new Error(`Missing ${waiter.marker}: ${stdout}${stderr}`))
            waiters.clear()
            resolve({ code, signal, stdout, stderr })
          })
        )
        const waitFor = marker => {
          if (stdout.includes(marker)) return Promise.resolve()
          if (closed) return Promise.reject(new Error(`Missing ${marker}: ${stdout}${stderr}`))
          return new Promise((resolve, reject) => waiters.add({ marker, resolve, reject }))
        }
        return { child: active, done, waitFor }
      }
      const reports = output =>
        output.stdout.split('\n').map(line => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        }).filter(value => Array.isArray(value?.results))

      const baselineOutput = await launch('test', ['network.test.mjs']).done
      assert.equal(baselineOutput.code, 0, baselineOutput.stdout + baselineOutput.stderr)
      const [baseline] = reports(baselineOutput)
      assert.equal(baseline?.total, 6, baselineOutput.stdout + baselineOutput.stderr)
      assert.equal(baseline.passed, 6, baselineOutput.stdout + baselineOutput.stderr)
      assert.equal(baseline.failed, 0)
      assert.deepEqual({ tcp: counts.tcp, udp: counts.udp, http: counts.http, denied: counts.denied }, {
        tcp: 1,
        udp: 1,
        http: 3,
        denied: 0
      })
      const lifecycleOutput = await launch('test', ['network-lifecycle.test.mjs'], 'lifecycle-host.json').done
      t.diagnostic(JSON.stringify({ stage: 'lifecycle', counts }))
      assert.equal(lifecycleOutput.code, 0, lifecycleOutput.stdout + lifecycleOutput.stderr)
      const [lifecycle] = reports(lifecycleOutput)
      assert.equal(lifecycle?.total, 5, lifecycleOutput.stdout + lifecycleOutput.stderr)
      assert.equal(lifecycle.passed, 5, lifecycleOutput.stdout + lifecycleOutput.stderr)
      assert.equal(lifecycle.failed, 0)
      assert.deepEqual(counts, {
        tcp: 6,
        udp: 1,
        http: 7,
        denied: 0,
        tcpAbort: 1,
        tcpQuota: 1,
        tcpAfter: 3,
        tcpQuotaProbe: 0,
        httpAbort: 1,
        httpKill: 1,
        httpAfter: 2,
        oldRuntime: 0,
        newRuntime: 0
      })

      await writeFile(
        join(root, 'old-runtime.mjs'),
        `
        import {spawn} from 'node:child_process';
        const child=spawn('curl',[
          '--silent','--show-error','--fail','--no-buffer','--max-time','8',
          '--noproxy','','--proxy','http://192.168.86.1:80',
          'http://${fixture.address}:${fixture.httpPort}/hold-old'
        ],{stdio:['ignore','pipe','pipe']});
        let output='';let ready=false;
        child.stdout.on('data',bytes=>{
          output+=new TextDecoder().decode(bytes);
          if(!ready&&output.includes('OLD_READY')){ready=true;console.log('OLD_PENDING')}
          if(output.includes('OLD_RESULT'))console.log('OLD_RESULT_CALLBACK');
        });
        child.stderr.on('data',()=>{});
        child.on('error',()=>{});
      `
      )
      const old = launch('run', ['old-runtime.mjs'], 'lifecycle-host.json')
      await old.waitFor('OLD_PENDING')
      old.child.kill('SIGTERM')
      const oldOutput = await old.done
      assert(oldPendingClosed, 'The prior Runtime must have reached the Host HTTP fixture')
      await oldPendingClosed
      assert.equal(oldOutput.stdout.includes('OLD_RESULT_CALLBACK'), false, oldOutput.stdout + oldOutput.stderr)

      await writeFile(
        join(root, 'new-runtime.test.mjs'),
        `import {registerNativeProcessNetworkNewRuntimeTest} from './lifecycle-workload.mjs';` +
          `registerNativeProcessNetworkNewRuntimeTest(${JSON.stringify(fixture)});`
      )
      const next = await launch('test', ['new-runtime.test.mjs'], 'lifecycle-host.json').done
      assert.equal(next.code, 0, next.stdout + next.stderr)
      const [newRuntime] = reports(next)
      assert.equal(newRuntime?.total, 1, next.stdout + next.stderr)
      assert.equal(newRuntime.passed, 1, next.stdout + next.stderr)
      assert.equal(newRuntime.failed, 0)
      assert.equal(next.stdout.includes('OLD_RESULT_CALLBACK'), false, next.stdout + next.stderr)
      assert.deepEqual(counts, {
        tcp: 6,
        udp: 1,
        http: 9,
        denied: 0,
        tcpAbort: 1,
        tcpQuota: 1,
        tcpAfter: 3,
        tcpQuotaProbe: 0,
        httpAbort: 1,
        httpKill: 1,
        httpAfter: 2,
        oldRuntime: 1,
        newRuntime: 1
      })
      t.diagnostic(
        JSON.stringify({
          runtime: 'holo',
          guestReports: [baseline, lifecycle, newRuntime],
          externalEffects: counts,
          oldRuntimeExit: { code: oldOutput.code, signal: oldOutput.signal }
        })
      )
    } finally {
      if (child?.exitCode == null && child?.signalCode == null) child?.kill('SIGKILL')
      for (const socket of sockets) socket.destroy()
      if (udpBound) udp.close()
      await Promise.all([tcp, web, denied].map(server => new Promise(resolve => server.close(resolve))))
      await rm(root, { recursive: true, force: true })
    }
  }
)
