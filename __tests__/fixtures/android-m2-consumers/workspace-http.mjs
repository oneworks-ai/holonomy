import { Buffer } from 'node:buffer'
import process from 'node:process'

export const forwardWorkspaceRequest = async (path, bodyBase64) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30000)
  try {
    const response = await fetch(
      `http://${process.env.__ONEWORKS_PROJECT_SERVER_HOST__}:${process.env.__ONEWORKS_PROJECT_SERVER_PORT__}${path}`,
      {
        body: Buffer.from(bodyBase64, 'base64'),
        method: 'POST',
        signal: controller.signal
      }
    )
    return Buffer.from(await response.arrayBuffer())
  } finally {
    clearTimeout(timeout)
  }
}
