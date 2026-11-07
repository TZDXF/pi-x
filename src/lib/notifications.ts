/**
 * System notifications, modeled after the Codex desktop settings: turn
 * completion (never / only when unfocused / always),
 * questions awaiting input, and an optional sound.
 *
 * Desktop uses tauri-plugin-notification; the web build falls back to the
 * browser Notification API. Preferences persist to ~/.pix/config.json and
 * synchronize between desktop and remote web clients.
 */
import { i18n } from "@/i18n"
import { invoke, isDesktop, listen } from "@/api/transport"
import { pixLog } from "@/api/piClient"
import { createConfigPreference } from "@/lib/configPreference"

export type TurnCompleteNotification = "never" | "unfocused" | "always"
export type NotificationSound = "default" | "none"

export interface SessionNotificationTarget {
  runtimeId: string
  sessionFile?: string | null
  cwd?: string
}

const activationHandlers = new Set<(target: SessionNotificationTarget) => void>()

/** Desktop events stay local to this webview; web notifications use their own click handler. */
export async function onSessionNotificationActivated(handler: (target: SessionNotificationTarget) => void) {
  if (isDesktop) return listen<SessionNotificationTarget>("notification-activated", event => handler(event.payload))
  activationHandlers.add(handler)
  return () => {
    activationHandlers.delete(handler)
  }
}

const TURN_LEGACY_KEY = "pix.notify.turnComplete"
const QUESTION_LEGACY_KEY = "pix.notify.question"
const SOUND_LEGACY_KEY = "pix.notify.sound"

const isTurnMode = (value: unknown): value is TurnCompleteNotification =>
  value === "never" || value === "unfocused" || value === "always"
const isSound = (value: unknown): value is NotificationSound => value === "default" || value === "none"

const turnPreference = createConfigPreference<TurnCompleteNotification>({
  key: "notifyTurnComplete",
  legacyKey: TURN_LEGACY_KEY,
  defaultValue: "unfocused",
  validate: isTurnMode,
})
const questionPreference = createConfigPreference<boolean>({
  key: "notifyQuestion",
  legacyKey: QUESTION_LEGACY_KEY,
  defaultValue: true,
  read: raw => raw !== "0",
  serialize: value => (value ? "1" : "0"),
})
const soundPreference = createConfigPreference<NotificationSound>({
  key: "notifySound",
  legacyKey: SOUND_LEGACY_KEY,
  defaultValue: "default",
  validate: isSound,
})

export const turnCompleteNotification = turnPreference.value
export const questionNotification = questionPreference.value
export const notificationSound = soundPreference.value

export function setTurnCompleteNotification(value: TurnCompleteNotification) {
  if (!isTurnMode(value)) return
  const saving = turnPreference.set(value)
  if (value !== "never") void ensurePermission()
  return saving
}
export function setQuestionNotification(value: boolean) {
  const saving = questionPreference.set(value)
  if (value) void ensurePermission()
  return saving
}
export function setNotificationSound(value: NotificationSound) {
  if (!isSound(value)) return
  const saving = soundPreference.set(value)
  if (value === "default") playNotificationSound()
  return saving
}

/** True when the window is hidden or unfocused, so "unfocused" mode fires. */
function windowUnfocused(): boolean {
  return document.visibilityState !== "visible" || !document.hasFocus()
}

async function ensurePermission(): Promise<boolean> {
  try {
    if (isDesktop) {
      const plugin = await import("@tauri-apps/plugin-notification")
      if (await plugin.isPermissionGranted()) return true
      return (await plugin.requestPermission()) === "granted"
    }
    if (!("Notification" in window)) return false
    if (Notification.permission === "granted") return true
    if (Notification.permission === "denied") return false
    return (await Notification.requestPermission()) === "granted"
  } catch {
    return false
  }
}

/** Short two-tone chime played through WebAudio; no audio asset needed. */
export function playNotificationSound() {
  try {
    const AudioContextClass =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextClass) return
    const ctx = new AudioContextClass()
    const notes = [880, 1174.66]
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = "sine"
      osc.frequency.value = freq
      const start = ctx.currentTime + i * 0.12
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(0.18, start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.4)
      osc.connect(gain).connect(ctx.destination)
      osc.start(start)
      osc.stop(start + 0.45)
    })
    window.setTimeout(() => void ctx.close(), 900)
  } catch {
    /* Audio is optional. */
  }
}

async function deliver(title: string, body: string, target: SessionNotificationTarget) {
  if (!(await ensurePermission())) return
  if (notificationSound.value === "default") playNotificationSound()
  try {
    if (isDesktop) {
      // Desktop delivery goes through the backend command: the notification
      // plugin skips the Windows AUMID for dev builds and never handles click
      // activation, so the toast showed as PowerShell and clicking it did
      // nothing. The command registers the app identity and focuses the main
      // window on click.
      await invoke("send_notification", { title, body, target })
    } else {
      const notification = new Notification(title, { body })
      notification.onclick = () => {
        window.focus()
        notification.close()
        activationHandlers.forEach(handler => handler(target))
      }
    }
  } catch {
    /* Notification delivery is best-effort. */
  }
}

const t = (key: string) => i18n.global.t(key)

/** Pi finished a turn (or failed); `detail` is "project · session title". */
export function notifyTurnComplete(detail: string, failed: boolean, target: SessionNotificationTarget) {
  const mode = turnCompleteNotification.value
  pixLog(`notify turnComplete failed=${failed} mode=${mode} detail=${detail}`)
  if (mode === "never") return
  if (mode === "unfocused" && !windowUnfocused()) return
  void deliver(t(failed ? "notify.turnFailedTitle" : "notify.turnCompleteTitle"), detail, { ...target })
}

/** An extension dialog (select/confirm/input/editor) awaits user input. */
export function notifyQuestion(detail: string, target: SessionNotificationTarget) {
  if (!questionNotification.value) return
  if (!windowUnfocused()) return
  void deliver(t("notify.questionTitle"), detail, { ...target })
}
