import { cycleValue } from './package-cycle-a.mjs'

const activatePlugin = context => ({ context, cycleValue, selected: '__oneworks__/source' })

export default { activatePlugin }
