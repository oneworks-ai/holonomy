import { createArtifactArchive } from '../artifact-archive/archive.mjs'

export {
  artifactArchiveMembers as nativeArchiveMembers,
  verifyArtifactArchiveMembers as verifyNativeArchiveMembers,
  verifyArtifactBundleInventory as verifyNativeBundleInventory
} from '../artifact-archive/archive.mjs'

export const createNativeArchive = options =>
  createArtifactArchive({
    ...options,
    privateRoots: ['private'],
    executablePaths: ['bin/holo', 'configure-v86.sh']
  })
