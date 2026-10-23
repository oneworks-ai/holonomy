import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Real Node adapter scheduling boundary.
import test from 'node:test'
import vm from 'node:vm'

import { createRuntimeContext } from '../src/runtime-context.mjs'
import { NodeRuntimeHostController } from '../src/runtime-host-controller.mjs'
import { normalizeNodeRuntimeSession } from '../src/session-validation.mjs'
import { NodeRuntimeSupervisor } from '../src/supervisor.mjs'

const entryUrl = 'app://fixture/immediate.mjs'
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

test('Node Immediate keeps handle identity, arguments and per-callback tick/Promise boundaries', async t => {
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 5000 })
  t.after(() => supervisor.stop())
  const logs = []
  supervisor.on('log', event => logs.push(event.text))
  await supervisor.start(session(`
    import process from 'node:process';
    import {setImmediate as schedule,clearImmediate as cancel} from 'node:timers';
    if(schedule!==globalThis.setImmediate||cancel!==globalThis.clearImmediate)throw new Error('global identity');
    const events=[]; const argument={identity:true};
    const first=schedule(function(value){
      if(this!==first||value!==argument)throw new Error('callback identity');
      events.push('first');
      process.nextTick(()=>events.push('tick'));
      Promise.resolve().then(()=>events.push('promise'));
      schedule(()=>{events.push('nested');console.log('IMMEDIATE_ORDER:'+events.join('|'))});
    },argument);
    schedule(()=>events.push('second'));
    const cancelled=schedule(()=>{throw new Error('cancelled immediate ran')});
    cancel(cancelled); cancel(cancelled); cancel(null); cancel(undefined);
  `))
  const line = await waitFor(() => logs.find(text => text.startsWith('IMMEDIATE_ORDER:')), 'Immediate ordering')
  assert.equal(line, 'IMMEDIATE_ORDER:first|tick|promise|second|nested')
})

test('Node Immediate exposes reference controls and rejects nonfunctions synchronously', async t => {
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 5000 })
  t.after(() => supervisor.stop())
  const logs = []
  supervisor.on('log', event => logs.push(event.text))
  await supervisor.start(session(`
    import {setImmediate,clearImmediate} from 'node:timers';
    let sideEffects=0;
    try { setImmediate({toString(){sideEffects++;return 'callback'}});throw new Error('accepted object') }
    catch(error){if(error.code!=='ERR_INVALID_ARG_TYPE')throw error}
    const handle=setImmediate(()=>{throw new Error('cleared immediate ran')});
    if(!handle.hasRef()||handle.unref()!==handle||handle.hasRef())throw new Error('unref');
    if(handle.ref()!==handle||!handle.hasRef())throw new Error('ref');
    clearImmediate(handle);
    if(sideEffects!==0)throw new Error('coercion');
    setImmediate(()=>console.log('IMMEDIATE_REFERENCE_OK'));
  `))
  await waitFor(() => logs.includes('IMMEDIATE_REFERENCE_OK'), 'Immediate reference controls')
})

test('Node Immediate callback throw terminates before later ticks, Promises and callbacks', async t => {
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 5000 })
  t.after(() => supervisor.stop())
  const logs = []
  let exit
  supervisor.on('log', event => logs.push(event.text))
  supervisor.on('exit', event => exit = event)
  await supervisor.start(session(`
    import process from 'node:process';
    setImmediate(()=>{
      process.nextTick(()=>console.log('MUST_NOT_RUN_TICK'));
      Promise.resolve().then(()=>console.log('MUST_NOT_RUN_PROMISE'));
      throw new Error('immediate failed');
    });
    setImmediate(()=>console.log('MUST_NOT_RUN_IMMEDIATE'));
  `))
  await waitFor(() => exit, 'fatal Immediate')
  assert.equal(exit.code, 1)
  assert.equal(exit.signal, null)
  assert(!logs.some(line => line.includes('MUST_NOT_RUN')))
})

test('ordinary shared-loop wakeups yield to Host I/O instead of forming a nextTick chain', async () => {
  const runtimeContext = createRuntimeContext('immediate-wakeup-fairness')
  const controller = new NodeRuntimeHostController({
    emitLog() {},
    emitNetwork() {},
    generation: 1,
    graph: {},
    runtimeContext,
    session: normalizeNodeRuntimeSession(session(''))
  })
  try {
    vm.runInContext(
      `globalThis.turns=0;const host=__holonomyNodeHost;
      host.registerTurn(()=>{if(++turns<1000)host.requestWakeup(host.now(),'event-loop')});
      host.requestWakeup(host.now(),'event-loop')`,
      runtimeContext.context
    )
    // No assertion about which top-level timer/Immediate fires first. A due
    // Host timer must get an opportunity before an entire recursive chain.
    const observed = await new Promise(resolve => setTimeout(() => resolve(runtimeContext.context.turns), 0))
    assert(observed < 1000, 'ordinary wakeups starved the Host timer through all 1000 turns')
    await waitFor(() => runtimeContext.context.turns === 1000, 'bounded ordinary wakeup chain')
  } finally {
    await controller.dispose()
  }
})
