export const controlStatus = snapshot => ({
  cursor: snapshot.cursor,
  resources: Object.fromEntries(
    Object.entries(snapshot.resources).map(([name, values]) => [name, Object.keys(values).length])
  ),
  status: 'ready'
})
