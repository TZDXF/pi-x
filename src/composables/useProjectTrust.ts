import { computed, onScopeDispose, ref, watch } from "vue"
import type { TrustStatus } from "@/api/piClient"
import type { SshConnectionRef } from "@/lib/ssh"
import { loadTrustStatus, saveTrustDecision } from "@/lib/sshTrust"

type PiClient = typeof import("@/api/piClient")

interface ProjectTrustContext {
  project(): string
  active(): boolean
  connections(): readonly SshConnectionRef[]
  api: Pick<PiClient, "trustStatus" | "sshTrustStatus" | "trustSave" | "sshTrustSave">
}

/** Trust is saved independently of the project form, for exactly one directory. */
export function useProjectTrust(context: ProjectTrustContext) {
  const status = ref<TrustStatus | null>(null)
  const loading = ref(false)
  const saving = ref(false)
  const saved = ref(false)
  const error = ref<unknown>(null)
  const trusted = computed(
    () => status.value?.decision === true || (status.value?.decision === null && status.value.policy === "always"),
  )
  let revision = 0

  async function refresh() {
    if (!context.active() || !context.project() || saving.value) return
    const current = ++revision
    loading.value = true
    error.value = null
    try {
      const result = await loadTrustStatus(context.project(), context.connections(), context.api)
      if (current === revision) status.value = result
    } catch (e) {
      if (current === revision) error.value = e
    } finally {
      if (current === revision) loading.value = false
    }
  }

  async function trust() {
    if (!context.active() || !status.value || trusted.value || loading.value || saving.value) return
    const current = revision
    const project = context.project()
    const connections = context.connections()
    saving.value = true
    error.value = null
    try {
      await saveTrustDecision(project, status.value.projectPath, true, false, connections, context.api)
      if (current !== revision) return
      saved.value = true
      const result = await loadTrustStatus(project, connections, context.api)
      if (current === revision) status.value = result
    } catch (e) {
      if (current === revision) error.value = e
    } finally {
      if (current === revision) saving.value = false
    }
  }

  watch(
    [context.active, context.project, context.connections],
    () => {
      revision++
      status.value = null
      loading.value = false
      saving.value = false
      saved.value = false
      error.value = null
      void refresh()
    },
    { immediate: true, flush: "sync" },
  )
  onScopeDispose(() => revision++)

  return { status, loading, saving, saved, error, trusted, refresh, trust }
}
