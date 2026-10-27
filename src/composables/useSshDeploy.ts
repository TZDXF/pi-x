import { ref } from "vue"
import { sshDeployPi, sshDeployStatus, type DeployStatus, type SshConnection } from "@/api/piClient"
import { useSshDeployProgress } from "@/composables/useSshDeployProgress"

interface SshDeployCallbacks {
  onSuccess?: () => void
  onError?: (error: unknown) => void
}

/** Shared deployment state and actions for settings and project creation. */
export function useSshDeploy(callbacks: SshDeployCallbacks = {}) {
  const statuses = ref<Record<string, DeployStatus>>({})
  const deployingIds = ref(new Set<string>())
  const progress = useSshDeployProgress()

  async function loadStatus(connection: Pick<SshConnection, "id">) {
    try {
      const status = await sshDeployStatus(connection.id)
      statuses.value = { ...statuses.value, [connection.id]: status }
    } catch {
      // Deployment details are optional and must not hide probe results.
    }
  }

  async function deploy(connection: Pick<SshConnection, "id">) {
    if (deployingIds.value.has(connection.id)) return
    deployingIds.value.add(connection.id)
    try {
      const result = await sshDeployPi(connection.id)
      statuses.value = {
        ...statuses.value,
        [connection.id]: {
          piFound: true,
          piBin: result.piBin,
          deployed: result.deployed,
          version: result.version,
          contentHash: result.contentHash,
        },
      }
      callbacks.onSuccess?.()
    } catch (error) {
      callbacks.onError?.(error)
    } finally {
      progress.value = null
      deployingIds.value.delete(connection.id)
    }
  }

  return { statuses, deployingIds, progress, loadStatus, deploy }
}
