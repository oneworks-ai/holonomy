import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const main = async () => {
  const [modulePath, wasmPath, biosPath, kernelPath, initrdPath] = process.argv.slice(2)
  if (kernelPath == null) throw new TypeError('Missing v86 boot probe paths')

  const { V86 } = await import(pathToFileURL(modulePath).href)
  const [wasm, bios, kernel, initrd] = await Promise.all([
    readFile(wasmPath),
    readFile(biosPath),
    readFile(kernelPath),
    initrdPath == null ? undefined : readFile(initrdPath)
  ])
  const vm = new V86({
    autostart: true,
    bios: { buffer: Uint8Array.from(bios).buffer },
    bzimage: { buffer: Uint8Array.from(kernel).buffer },
    cmdline: initrd == null
      ? 'tsc=reliable mitigations=off random.trust_cpu=on console=ttyS0 audit=0'
      : 'tsc=reliable mitigations=off random.trust_cpu=on console=ttyS0 audit=0 rdinit=/holo-supervisor',
    disable_keyboard: true,
    disable_mouse: true,
    disable_speaker: true,
    filesystem: {},
    ...(initrd == null ? {} : { initrd: { buffer: Uint8Array.from(initrd).buffer } }),
    memory_size: 128 * 1024 * 1024,
    screen: { container: null },
    uart1: true,
    wasm_fn: async imports => (await WebAssembly.instantiate(wasm, imports)).instance.exports
  })

  let output = ''
  vm.add_listener('serial0-output-byte', byte => {
    const value = String.fromCharCode(byte)
    output += value
    process.stdout.write(value)
  })
  vm.add_listener('serial1-output-byte', byte => {
    process.stderr.write(`[serial1:${byte.toString(16).padStart(2, '0')}]`)
  })
  for (const event of ['emulator-ready', 'emulator-started', 'download-error']) {
    vm.add_listener(event, () => process.stderr.write(`[v86:${event}]\n`))
  }

  await new Promise(resolve => setTimeout(resolve, 15_000))
  await vm.destroy()
  if (output.length === 0) throw new Error('v86 boot probe produced no serial output')
}

void main()
