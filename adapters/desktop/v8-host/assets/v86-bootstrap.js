// Private VM transport only. Supervisor frames and Process identity stay in HoloUV.
const vm = new module.exports.V86({
  autostart: false,
  bios: { buffer: globalThis.__holoBios },
  bzimage: { buffer: globalThis.__holoKernel },
  cmdline: 'tsc=reliable mitigations=off random.trust_cpu=on console=ttyS0 audit=0 rdinit=/sbin/holo-uvd',
  disable_keyboard: true,
  disable_mouse: true,
  disable_speaker: true,
  filesystem: {},
  initrd: { buffer: globalThis.__holoInitrd },
  memory_size: globalThis.__holoMemoryBytes,
  ...(globalThis.__holoNetworkEnabled === true ? { net_device: { relay_url: 'fetch', type: 'virtio' } } : {}),
  screen: { container: null },
  uart1: true,
  wasm_fn: async imports => (await WebAssembly.instantiate(globalThis.__holoWasm, imports)).instance.exports
})
let failed = false
let stopped = false
let ready = false
let startRequested = false
let queuedBytes = 0
const serial = []
vm.add_listener('serial1-output-byte', byte => {
  if (!Number.isInteger(byte) || byte < 0 || byte > 255 || queuedBytes >= 262144) {
    failed = true
    return
  }
  serial.push(byte)
  queuedBytes += 1
})
vm.add_listener('download-error', () => { failed = true })
vm.add_listener('emulator-stopped', () => { stopped = true })
const startReadyVm = () => {
  if (!ready || !startRequested) return
  startRequested = false
  void vm.run().catch(() => { failed = true })
}
vm.add_listener('emulator-ready', () => {
  try {
    if (globalThis.__holoNetworkEnabled === true) globalThis.__holoVmNetworkSetup(vm)
    ready = true
    startReadyVm()
  } catch {
    failed = true
  }
})
globalThis.__holoVmStart = () => { startRequested = true; startReadyVm() }
globalThis.__holoVmWrite = () => {
  vm.serial_send_bytes(1, globalThis.__holoPendingWrite)
  delete globalThis.__holoPendingWrite
}
globalThis.__holoVmPoll = maxBytes => {
  globalThis.__holoRunV86Timers()
  if (failed) return { status: 'failed', bytes: new Uint8Array(0) }
  const bytes = Uint8Array.from(serial.splice(0, maxBytes))
  queuedBytes -= bytes.length
  return { status: stopped ? 'stopped' : 'running', bytes }
}
globalThis.__holoVmClose = () => {
  if (globalThis.__holoNetworkEnabled === true) globalThis.__holoVmNetworkClose()
  void vm.destroy().catch(() => {})
}
