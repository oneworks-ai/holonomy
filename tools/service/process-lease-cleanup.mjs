export const closeProcessLeases = async options => {
  const inspectors = options.registry.list('inspectors').filter(inspector => (
    inspector.processId === options.process.id && inspector.generation === options.process.generation &&
    !['closed', 'failed', 'lost'].includes(inspector.state)
  ))
  for (const inspector of inspectors) {
    await options.adapters.target(options.process.target).closeInspector({ inspector, process: options.process })
      .catch(() => undefined)
    options.inspectorProxy?.closeLease(inspector.id)
    await options.registry.updateInspector(inspector.id, 'closed').catch(() => undefined)
  }
  options.inspectorProxy?.closeProcess(options.process.id, options.process.generation)
  if (options.releaseFixture === true) {
    if (options.fixtures.release != null) await options.fixtures.release(options.process.id)
    else await options.fixtures.stop(options.process.id, options.process.generation)
  }
}
