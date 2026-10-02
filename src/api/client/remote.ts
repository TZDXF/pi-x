import { invoke } from "../transport"

export interface RemoteStatus {
  enabled: boolean
  port: number
  urls: string[]
  passwordEnabled: boolean
}
export const remoteStatus = () => invoke<RemoteStatus>("remote_status")
export const remoteSet = (enabled: boolean, port: number) => invoke<RemoteStatus>("remote_set", { enabled, port })
export const remotePasswordSet = (password: string | null) => invoke<RemoteStatus>("remote_password_set", { password })
