import { execFile } from 'node:child_process'

export const readRemoteUrls = (workspaceFolder, callback) =>
  execFile(
    'git',
    ['-C', workspaceFolder, 'config', '--get-regexp', '^remote\\..*\\.url$'],
    { encoding: 'utf8', maxBuffer: 262144 },
    callback
  )
