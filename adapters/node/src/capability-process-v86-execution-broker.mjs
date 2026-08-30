// Built runtime contract: adapter production code consumes the compiled package payload.
import { LinuxProcessExecutionCapabilityBridgeV1 } from '../../../dist/capability-runtime/index.js'

const failure = code => {
  const error = new Error('v86 descendant process authorization failed')
  Object.defineProperty(error, 'code', { enumerable: true, value: code })
  throw error
}

export class NodeV86ProcessExecutionBrokerV1 {
  #authorize = new LinuxProcessExecutionCapabilityBridgeV1()

  bind(invoke) {
    this.#authorize.bind(invoke)
    return this
  }

  authorize(input) {
    const executable = input.executables.find(item =>
      item.executable?.kind === 'guestPath' && item.executable.path === input.path
    )
    if (executable == null || executable.shell === true) {
      return failure('process.executable_unavailable')
    }
    return this.#authorize.authorize(Object.freeze({
      argv: input.argv,
      cwd: input.cwd,
      environmentId: input.environmentId,
      executableId: executable.executableId,
      linuxPid: input.linuxPid,
      parentLinuxPid: input.parentLinuxPid,
      path: input.path,
      policy: input.policy,
      processId: input.processId,
      processResourceId: input.processResourceId,
      rootLinuxPid: input.rootLinuxPid,
      scope: input.scope
    }))
  }
}
