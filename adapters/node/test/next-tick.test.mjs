import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Real adapter lifecycle and engine boundary test.
import test from 'node:test'
import vm from 'node:vm'

import { createRuntimeContext } from '../src/runtime-context.mjs'
import { NodeRuntimeHostController } from '../src/runtime-host-controller.mjs'
import { normalizeNodeRuntimeSession } from '../src/session-validation.mjs'
import { NodeRuntimeSupervisor } from '../src/supervisor.mjs'

const entryUrl = 'app://fixture/main.mjs'
const session = source => ({
  entryUrl,
  runtimeModules: [],
  syntheticModules: {},
  userModules: [{ source, url: entryUrl }]
})
const waitFor = async (read, label) => {
  for (let turn = 0; turn < 500; turn++) {
    const value = read()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail(`${label} did not settle`)
}

test('Node nextTick keeps ESM entry and timer callback Promise priorities', async t => {
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 5000 })
  t.after(() => supervisor.stop())
  const logs = []
  supervisor.on('log', event => logs.push(event.text))
  await supervisor.start(session(`
    import process, {nextTick} from 'node:process';
    const events=['sync']; const argument={identity:true};
    const returned=nextTick(function(value){
      if(this!==undefined||value!==argument)throw new Error('identity'); events.push('tick');
    },argument);
    if(returned!==undefined||nextTick!==process.nextTick)throw new Error('shape');
    Promise.resolve().then(()=>events.push('promise'));
    setTimeout(()=>{
      events.push('timer:first');
      process.nextTick(()=>events.push('timer:tick'));
      Promise.resolve().then(()=>{
        events.push('timer:promise');
        process.nextTick(()=>events.push('promise:tick'));
      });
    },5);
    setTimeout(()=>{
      events.push('timer:second'); console.log('NEXT_TICK_ORDER:'+events.join('|'));
    },20);
  `))
  const line = await waitFor(() => logs.find(text => text.startsWith('NEXT_TICK_ORDER:')), 'nextTick ordering')
  assert.equal(line, 'NEXT_TICK_ORDER:sync|promise|tick|timer:first|timer:tick|timer:promise|promise:tick|timer:second')
})

test('Node loop callback throw selects a fatal terminal before later Guest jobs', async t => {
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 5000 })
  t.after(() => supervisor.stop())
  const logs = []
  supervisor.on('log', event => logs.push(event.text))
  await supervisor.start(session(`
    import process from 'node:process';
    setTimeout(()=>{
      process.nextTick(()=>{throw new Error('tick failed')});
      process.nextTick(()=>console.log('MUST_NOT_RUN_TICK'));
      Promise.resolve().then(()=>console.log('MUST_NOT_RUN_PROMISE'));
    },10);
  `))
  await waitFor(() => supervisor.state === 'failed', 'fatal nextTick')
  assert(!logs.some(line => line.includes('MUST_NOT_RUN')))
})

test('Node explicit exit in a tick preserves its OS status and preempts queued Promise jobs', async t => {
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 5000 })
  t.after(() => supervisor.stop())
  const logs = []
  let exit
  supervisor.on('log', event => logs.push(event.text))
  supervisor.on('exit', event => exit = event)
  await supervisor.start(session(`
    import process from 'node:process';
    setTimeout(()=>{
      process.nextTick(()=>process.exit(4));
      process.nextTick(()=>console.log('MUST_NOT_RUN_TICK'));
      Promise.resolve().then(()=>console.log('MUST_NOT_RUN_PROMISE'));
    },10);
  `))
  await waitFor(() => exit, 'explicit nextTick exit')
  assert.equal(exit.code, 4)
  assert.equal(exit.signal, null)
  assert(!logs.some(line => line.includes('MUST_NOT_RUN')))
})

test('Node Host cancels null wakeups and coalesces immediate tick wakeups', async () => {
  const runtimeContext = createRuntimeContext('next-tick-wakeup')
  const normalized = normalizeNodeRuntimeSession(session(''))
  const controller = new NodeRuntimeHostController({
    emitLog() {},
    emitNetwork() {},
    generation: 1,
    graph: {},
    runtimeContext,
    session: normalized
  })
  try {
    vm.runInContext(
      `globalThis.turns=0;const h=__holonomyNodeHost;
      h.registerTurn(()=>{turns++});h.requestWakeup(h.now());h.requestWakeup(null)`,
      runtimeContext.context
    )
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(runtimeContext.context.turns, 0)
    vm.runInContext(
      `h.requestWakeup(h.now());h.requestWakeup(h.now());h.requestWakeup(h.now())`,
      runtimeContext.context
    )
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(runtimeContext.context.turns, 1)
  } finally {
    await controller.dispose()
  }
})
