/**
 * System notifications, modeled after the Codex desktop settings: turn
 * completion (never / only when unfocused / always),
 * questions awaiting input, and an optional sound.
 *
 * Desktop uses tauri-plugin-notification; the web build falls back to the
 * browser Notification API. Preferences persist to localStorage and sync
 * across windows via the storage event.
 */
import { i18n } from "@/i18n"
import { invoke, isDesktop } from "@/api/transport"
import { pixLog } from "@/api/piClient"
import { createLocalPreference } from "@/lib/localPreference"

export type TurnCompleteNotification = "never" | "unfocused" | "always"
export type NotificationSound = "default" | "none"

const TURN_KEY = "pix.notify.turnComplete"
const QUESTION_KEY = "pix.notify.question"
const SOUND_KEY = "pix.notify.sound"

const isTurnMode = (value: unknown): value is TurnCompleteNotification =>
  value === "never" || value === "unfocused" || value === "always"
const isSound = (value: unknown): value is NotificationSound => value === "default" || value === "none"

const turnPreference = createLocalPreference<TurnCompleteNotification>({
  key: TURN_KEY,
  defaultValue: "unfocused",
  validate: isTurnMode,
})
const questionPreference = createLocalPreference<boolean>({
  key: QUESTION_KEY,
  defaultValue: true,
  read: raw => raw !== "0",
  serialize: value => (value ? "1" : "0"),
})
const soundPreference = createLocalPreference<NotificationSound>({
  key: SOUND_KEY,
  defaultValue: "default",
  validate: isSound,
})

export const turnCompleteNotification = turnPreference.value
export const questionNotification = questionPreference.value
export const notificationSound = soundPreference.value

export function setTurnCompleteNotification(value: TurnCompleteNotification) {
  if (!isTurnMode(value)) return
  turnPreference.set(value)
  if (value !== "never") void ensurePermission()
}
export function setQuestionNotification(value: boolean) {
  questionPreference.set(value)
  if (value) void ensurePermission()
}
export function setNotificationSound(value: NotificationSound) {
  if (!isSound(value)) return
  soundPreference.set(value)
  if (value === "default") playNotificationSound()
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

async function deliver(title: string, body: string) {
  if (!(await ensurePermission())) return
  if (notificationSound.value === "default") playNotificationSound()
  try {
    if (isDesktop) {
      // Desktop delivery goes through the backend command: the notification
      // plugin skips the Windows AUMID for dev builds and never handles click
      // activation, so the toast showed as PowerShell and clicking it did
      // nothing. The command registers the app identity and focuses the main
      // window on click.
      await invoke("send_notification", { title, body })
    } else {
      new Notification(title, { body })
    }
  } catch {
    /* Notification delivery is best-effort. */
  }
}

const t = (key: string) => i18n.global.t(key)

/** Pi finished a turn (or failed); `detail` is "project · session title". */
export function notifyTurnComplete(detail: string, failed = false) {
  const mode = turnCompleteNotification.value
  pixLog(`notify turnComplete failed=${failed} mode=${mode} detail=${detail}`)
  if (mode === "never") return
  if (mode === "unfocused" && !windowUnfocused()) return
  void deliver(t(failed ? "notify.turnFailedTitle" : "notify.turnCompleteTitle"), detail)
}

/** An extension dialog (select/confirm/input/editor) awaits user input. */
export function notifyQuestion(detail: string) {
  if (!questionNotification.value) return
  if (!windowUnfocused()) return
  void deliver(t("notify.questionTitle"), detail)
}
