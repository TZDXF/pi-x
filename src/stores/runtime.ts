import { ref } from "vue"

// Selection is a UI concern; every request captures its owning runtime explicitly.
export const activeRuntimeId = ref("default")
