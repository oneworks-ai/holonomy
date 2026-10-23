import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { test } from 'node:test'

const input = 'holo-fs://workspace/input.txt'

for (const missing of [false, true]) {
  test(`I/O ${missing ? 'error' : 'success'} callback reaches check before a newly due timer`, async () => {
    const events = []
    await new Promise((resolve, reject) => {
      fs.readFile(missing ? 'holo-fs://workspace/missing.txt' : input, 'utf8', error => {
        try {
          if (missing) assert.equal(error.code, 'ENOENT')
          else assert.equal(error, null)
          const done = () => {
            if (events.length === 4) resolve()
          }
          setTimeout(() => {
            events.push('timer')
            done()
          }, 0)
          setImmediate(() => {
            events.push('immediate')
            done()
          })
          process.nextTick(() =>
            setImmediate(() => {
              events.push('tick-immediate')
              done()
            })
          )
          Promise.resolve().then(() =>
            setImmediate(() => {
              events.push('promise-immediate')
              done()
            })
          )
          const until = Date.now() + 25
          while (Date.now() < until) {
            // Make the timer due without leaving the current I/O callback.
          }
        } catch (failure) {
          reject(failure)
        }
      })
    })
    assert.deepEqual(events, ['immediate', 'tick-immediate', 'promise-immediate', 'timer'])
  })
}

test('file callback drains nextTick before Promise jobs', async () => {
  const events = []
  await new Promise((resolve, reject) => {
    fs.readFile(input, 'utf8', (...args) => {
      try {
        assert.equal(args.length, 2)
        assert.equal(args[0], null)
        assert.equal(args[1], 'IO\n')
        events.push('callback')
        process.nextTick(() => events.push('tick'))
        Promise.resolve().then(() => events.push('promise'))
        setImmediate(resolve)
      } catch (error) {
        reject(error)
      }
    })
  })
  assert.deepEqual(events, ['callback', 'tick', 'promise'])
})

test('failure callback retains exact arity and the same tick boundary', async () => {
  const events = []
  await new Promise((resolve, reject) => {
    fs.readFile('holo-fs://workspace/missing.txt', (...args) => {
      try {
        assert.equal(args.length, 1)
        assert.equal(args[0].code, 'ENOENT')
        events.push('callback')
        process.nextTick(() => events.push('tick'))
        Promise.resolve().then(() => events.push('promise'))
        setImmediate(resolve)
      } catch (error) {
        reject(error)
      }
    })
  })
  assert.deepEqual(events, ['callback', 'tick', 'promise'])
})

test('void callback remains asynchronous and has one null argument', async () => {
  let returned = false
  await new Promise((resolve, reject) => {
    fs.writeFile('holo-fs://workspace/output.txt', 'CALLBACK_WRITE', (...args) => {
      try {
        assert.equal(returned, true)
        assert.deepEqual(args, [null])
        resolve()
      } catch (error) {
        reject(error)
      }
    })
    returned = true
  })
  assert.equal(await fsp.readFile('holo-fs://workspace/output.txt', 'utf8'), 'CALLBACK_WRITE')
})

test('Promise API keeps Promise-job ordering rather than callback ordering', async () => {
  const events = []
  await new Promise((resolve, reject) => {
    fsp.readFile(input, 'utf8').then(value => {
      assert.equal(value, 'IO\n')
      events.push('promise-result')
      process.nextTick(() => events.push('tick'))
      Promise.resolve().then(() => events.push('promise'))
      setImmediate(resolve)
    }, reject)
  })
  assert.deepEqual(events, ['promise-result', 'promise', 'tick'])
})
