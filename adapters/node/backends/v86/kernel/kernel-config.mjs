import { readFile } from 'node:fs/promises'

export const V86_KERNEL_CONFIG_REQUIREMENTS_V1 = Object.freeze({
  boot: Object.freeze([
    'CONFIG_BINFMT_ELF',
    'CONFIG_BLK_DEV_INITRD',
    'CONFIG_DEVTMPFS',
    'CONFIG_DEVTMPFS_MOUNT',
    'CONFIG_EXPERT',
    'CONFIG_PROC_FS',
    'CONFIG_SERIAL_8250',
    'CONFIG_SERIAL_8250_CONSOLE',
    'CONFIG_SYSFS',
    'CONFIG_TMPFS',
    'CONFIG_TTY'
  ]),
  filesystemBridge: Object.freeze([
    'CONFIG_9P_FS',
    'CONFIG_FANOTIFY',
    'CONFIG_FANOTIFY_ACCESS_PERMISSIONS',
    'CONFIG_FUSE_FS',
    'CONFIG_NET_9P',
    'CONFIG_NET_9P_VIRTIO',
    'CONFIG_PCI',
    'CONFIG_SECURITY',
    'CONFIG_VIRTIO',
    'CONFIG_VIRTIO_MENU',
    'CONFIG_VIRTIO_PCI'
  ]),
  networkBridge: Object.freeze([
    'CONFIG_CGROUPS',
    'CONFIG_INET',
    'CONFIG_NAMESPACES',
    'CONFIG_NET',
    'CONFIG_NETDEVICES',
    'CONFIG_NET_NS',
    'CONFIG_PACKET',
    'CONFIG_PID_NS',
    'CONFIG_SECCOMP',
    'CONFIG_SECCOMP_FILTER',
    'CONFIG_TUN',
    'CONFIG_VIRTIO_NET'
  ])
})

export const V86_KERNEL_CONFIG_DISABLED_REQUIREMENTS_V1 = Object.freeze([
  'CONFIG_MTRR',
  'CONFIG_X86_PAT'
])

const invalid = message => {
  throw new TypeError(message)
}

export const parseLinuxKernelConfigV1 = source => {
  if (typeof source !== 'string') return invalid('Invalid Linux kernel configuration')
  const values = new Map()
  for (const line of source.split(/\r?\n/u)) {
    if (line === '' || line.startsWith('#') && !line.startsWith('# CONFIG_')) continue
    const disabled = /^# (CONFIG_\w+) is not set$/u.exec(line)
    const enabled = /^(CONFIG_\w+)=(.+)$/u.exec(line)
    const name = disabled?.[1] ?? enabled?.[1]
    if (name == null) return invalid(`Invalid Linux kernel configuration line: ${line}`)
    if (values.has(name)) return invalid(`Duplicate Linux kernel configuration: ${name}`)
    values.set(name, disabled == null ? enabled[2] : 'n')
  }
  return values
}

export const verifyV86KernelConfigV1 = source => {
  const values = parseLinuxKernelConfigV1(source)
  const groups = Object.entries(V86_KERNEL_CONFIG_REQUIREMENTS_V1).map(([group, symbols]) => {
    const missing = symbols.filter(symbol => values.get(symbol) !== 'y')
    if (missing.length > 0) return invalid(`Missing built-in ${group} kernel symbols: ${missing.join(', ')}`)
    return Object.freeze({ group, symbols })
  })
  const enabled = groups.flatMap(item => item.symbols)
  const incorrectlyEnabled = V86_KERNEL_CONFIG_DISABLED_REQUIREMENTS_V1.filter(
    symbol => values.has(symbol) && values.get(symbol) !== 'n'
  )
  if (incorrectlyEnabled.length > 0) {
    return invalid(`Enabled incompatible v86 kernel symbols: ${incorrectlyEnabled.join(', ')}`)
  }
  return Object.freeze({
    disabledSymbols: V86_KERNEL_CONFIG_DISABLED_REQUIREMENTS_V1,
    groups: Object.freeze(groups),
    requiredSymbolCount: enabled.length + V86_KERNEL_CONFIG_DISABLED_REQUIREMENTS_V1.length
  })
}

export const verifyV86KernelConfigFileV1 = async path => verifyV86KernelConfigV1(await readFile(path, 'utf8'))
