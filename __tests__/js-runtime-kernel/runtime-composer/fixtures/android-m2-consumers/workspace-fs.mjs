import { createReadStream } from 'node:fs'

export const readWorkspaceResource = path => createReadStream(path)
