;(() => {
  const { ascii, bytes } = globalThis.__holoV86ProbeSupport

  const u16 = value => Uint8Array.of(value >>> 8, value)
  const u32 = value => Uint8Array.of(value >>> 24, value >>> 16, value >>> 8, value)
  const readU32 = (value, offset) =>
    new DataView(value.buffer, value.byteOffset, value.byteLength)
      .getUint32(offset)
  const join = parts => {
    const length = parts.reduce((total, part) => total + part.length, 0)
    const output = new Uint8Array(length)
    let offset = 0
    for (const part of parts) {
      output.set(part, offset)
      offset += part.length
    }
    return output
  }
  const string = value => {
    const encoded = bytes(value)
    return join([u32(encoded.length), encoded])
  }
  const frame = (operation, requestId, processId, sequence, payload = new Uint8Array()) =>
    join([
      u32(20 + payload.length),
      bytes('HOLO'),
      Uint8Array.of(1, operation, 0, 0),
      u32(requestId),
      u32(processId),
      u32(sequence),
      payload
    ])
  const spawnPayload = ({ args, executable, executableId, resourceId }) =>
    join([
      Uint8Array.of(1, 7, 0, 0),
      string(executable),
      string('/'),
      string(executableId),
      string(resourceId),
      u16(args.length),
      u16(1),
      ...args.map(string),
      string('LANG'),
      string('C')
    ])

  globalThis.__holoStartV86Probe = V86 => {
    let vm
    const state = {
      buffer: new Uint8Array(),
      environmentStartedAt: Date.now(),
      fuse: globalThis.__holoCreateV86FuseBridge(),
      fusePid: 0,
      fuseStdout: '',
      pid: 0,
      stderr: '',
      stdout: ''
    }
    const send = (operation, requestId, processId, payload) => {
      vm.serial_send_bytes(1, frame(operation, requestId, processId, 0, payload))
    }
    const receive = byte => {
      state.buffer = join([state.buffer, Uint8Array.of(byte)])
      while (state.buffer.length >= 4) {
        const bodyLength = readU32(state.buffer, 0)
        if (state.buffer.length < bodyLength + 4) return
        const item = state.buffer.slice(0, bodyLength + 4)
        state.buffer = state.buffer.slice(bodyLength + 4)
        if (ascii(item.slice(4, 8)) !== 'HOLO' || item[8] !== 1) throw new Error('Invalid v86 frame')
        const operation = item[9]
        const requestId = readU32(item, 12)
        const processId = readU32(item, 16)
        const payload = item.slice(24)
        if (operation === 5) {
          state.readyFlags = readU32(payload, 0)
          state.bootDurationMs = Date.now() - state.environmentStartedAt
          state.workloadStartedAt = Date.now()
          send(
            8,
            1,
            0,
            spawnPayload({
              args: ['stdio-exit'],
              executable: '/usr/bin/holo-v86-selftest',
              executableId: 'android-v86-probe',
              resourceId: 'android-v86-process'
            })
          )
        } else if (operation === 9 && requestId === 1) {
          state.pid = processId
          setTimeout(() => send(11, 2, state.pid, bytes('android-input\n')), 0)
        } else if (operation === 14) {
          Promise.resolve(state.fuse.handle(payload, { processId }))
            .then(response => send(15, requestId, processId, response))
        } else if (operation === 13 && processId === state.fusePid) state.fuseStdout += ascii(payload)
        else if (operation === 13) state.stdout += ascii(payload)
        else if (operation === 10) state.stderr += ascii(payload)
        else if (operation === 4 && processId === state.fusePid) state.fuseCode = readU32(payload, 0)
        else if (operation === 4) state.code = readU32(payload, 0)
        else if (operation === 2 && processId === state.pid) {
          setTimeout(() =>
            send(
              8,
              10,
              0,
              spawnPayload({
                args: ['fuse'],
                executable: '/usr/bin/holo-v86-selftest',
                executableId: 'android-v86-fuse',
                resourceId: 'android-v86-fuse-process'
              })
            ), 0)
        } else if (operation === 9 && requestId === 10) state.fusePid = processId
        else if (operation === 2 && processId === state.fusePid) {
          const source = state.fuse.events.find(event => event.operation === 'read')
          globalThis.__holoV86ProbeResult = JSON.stringify({
            bootDurationMs: state.bootDurationMs,
            code: state.code,
            fuseCode: state.fuseCode,
            fuseEvents: state.fuse.events.length,
            fuseLinuxPid: source?.linuxPid ?? 0,
            fuseOutput: ascii(state.fuse.readFile('/workspace/output.txt')),
            fuseProcessId: source?.processId ?? 0,
            fuseStdout: state.fuseStdout,
            readyFlags: state.readyFlags,
            stderr: state.stderr,
            stdout: state.stdout,
            workloadDurationMs: Date.now() - state.workloadStartedAt
          })
        } else if (operation === 3) {
          const length = readU32(payload, 0)
          throw new Error(
            `v86 supervisor rejected request ${requestId} for process ${processId}: ${
              ascii(payload.slice(4, 4 + length))
            }`
          )
        }
      }
    }
    vm = new V86({
      autostart: true,
      bios: { buffer: globalThis.__holoV86Bios },
      bzimage: { buffer: globalThis.__holoV86Kernel },
      cmdline: 'tsc=reliable mitigations=off random.trust_cpu=on console=ttyS0 audit=0 rdinit=/sbin/holo-uvd',
      disable_keyboard: true,
      disable_jit: true,
      disable_mouse: true,
      disable_speaker: true,
      filesystem: {},
      initrd: { buffer: globalThis.__holoV86Initrd },
      memory_size: 128 * 1024 * 1024,
      screen: { container: null },
      uart1: true,
      wasm_fn: imports =>
        WebAssembly.instantiate(globalThis.__holoV86Wasm, imports)
          .then(result => result.instance.exports)
    })
    vm.add_listener('serial1-output-byte', receive)
    globalThis.__holoV86ProbeVm = vm
  }
})()
