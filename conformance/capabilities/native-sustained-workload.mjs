/* eslint-disable antfu/no-top-level-await -- The CLI entry must keep one Runtime busy for the full soak. */
// Executed as ./index.js by the standalone Rust/V8 CLI. The external fixture
// supplies only a loopback origin and a wall-clock soak duration.
import assert from 'node:assert/strict'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import process from 'node:process'

const origin = process.argv[2]
const durationMs = Number(process.argv[3])
assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/u)
assert.ok(Number.isInteger(durationMs) && durationMs >= 185_000 && durationMs <= 1_800_000)

const callback = invoke =>
  new Promise((resolve, reject) => {
    invoke((error, value) => error == null ? resolve(value) : reject(error))
  })
const callbackPath = 'holo-fs://workspace/callback.txt'
const promisePath = 'holo-fs://workspace/promise.txt'
const started = Date.now()
let rounds = 0

while (Date.now() - started < durationMs) {
  const payload = `native-soak-${rounds}`

  await callback(done => fs.writeFile(callbackPath, payload, done))
  const callbackFd = await callback(done => fs.open(callbackPath, 'r', done))
  try {
    assert.equal(await callback(done => fs.readFile(callbackFd, 'utf8', done)), payload)
  } finally {
    await callback(done => fs.close(callbackFd, done))
  }

  const writer = await fsp.open(promisePath, 'w+')
  try {
    await writer.writeFile(payload)
  } finally {
    await writer.close()
  }
  const reader = await fsp.open(promisePath, 'r')
  try {
    assert.equal(await reader.readFile('utf8'), payload)
  } finally {
    await reader.close()
  }

  const digest = createHash('sha256').update(payload).digest('hex')
  assert.match(digest, /^[0-9a-f]{64}$/u)
  assert.match(createHmac('sha256', 'soak-key').update(payload).digest('hex'), /^[0-9a-f]{64}$/u)
  assert.equal(randomBytes(16).length, 16)

  const response = await fetch(`${origin}/echo`, { method: 'POST', body: payload })
  assert.equal(response.status, 200)
  assert.equal(await response.text(), payload)

  rounds += 1
  console.log(
    `NATIVE_SOAK_PROGRESS:${
      JSON.stringify({ rounds, fsCallback: rounds, fsPromise: rounds, crypto: rounds, http: rounds })
    }`
  )
  // Pacing is the intentional lifetime requirement; every turn above completes
  // actual capability work before the next one is scheduled.
  await new Promise(resolve => setTimeout(resolve, 1_000))
}

assert.ok(rounds >= 100, `too few real capability rounds: ${rounds}`)
console.log(`NATIVE_SOAK_PASS:${JSON.stringify({ rounds, elapsedMs: Date.now() - started })}`)
process.exit(0)
