export const GIT_NATIVE_MODULE = 'host.git'
export const GIT_OPERATION_VERSION = 1
export const GIT_REQUIRED_CAPABILITY = 'host.git.v1'

export const GIT_OPERATIONS = Object.freeze({
  clone: 'v1.clone',
  configGet: 'v1.config.get',
  fetch: 'v1.fetch',
  open: 'v1.repository.open',
  push: 'v1.push',
  remoteList: 'v1.remote.list',
  status: 'v1.status'
})

export const GIT_REPOSITORY_RESOURCE = 'git.repository'

export type GitProviderOperation = typeof GIT_OPERATIONS[keyof typeof GIT_OPERATIONS]
