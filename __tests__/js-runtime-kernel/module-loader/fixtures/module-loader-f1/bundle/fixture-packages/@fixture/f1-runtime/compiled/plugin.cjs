const peer = require('./peer.cjs')
const resolvedPeer = require.resolve('./peer.cjs')

exports.activatePlugin = context => ({ context, selected: 'commonjs' })
exports.peer = peer
exports.resolvedPeer = resolvedPeer
