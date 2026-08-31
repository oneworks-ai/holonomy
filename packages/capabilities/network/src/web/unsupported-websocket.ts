export const createUnsupportedCapabilityWebSocketV1 = () => {
  const WebSocket = function WebSocket(): never {
    throw new TypeError('Holonomy WebSocket is unsupported by SandboxPolicyV2')
  }
  return Object.freeze(WebSocket)
}
