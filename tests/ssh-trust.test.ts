import { expect, test } from "vitest"
import {
  loadTrustStatus,
  loadTrustStatusLenient,
  requireSshConnectionId,
  saveTrustDecision,
  terminalConnectionId,
} from "@/lib/sshTrust"
import { parseCodedError } from "@/lib/backendError"
import type { TrustStatus } from "@/api/client/config"

/**
 * 信任与终端连接分流纯逻辑（契约 §3.4/§4.3）：
 * - 本地项目走既有 trust_status/trust_save / 终端不带连接 id
 * - 远程项目走 ssh_trust_status/ssh_trust_save / term_create 带 sshConnectionId
 * - 连接缺失：require 路径抛 coded sshConnectionMissing；lenient 路径降级 null 并回调
 */

const URI = "ssh://dev@host:2222/home/dev/proj"
const LOCAL = "C:/code/local"
const CONNECTIONS = [{ id: "ssh-1", host: "host", port: 2222, user: "dev" }]

const status = (needsDecision: boolean): TrustStatus => ({
  projectPath: "/home/dev/proj",
  parentPath: null,
  hasTrustRequiringResources: needsDecision,
  decision: null,
  needsDecision,
})

function readApi(rec: string[]) {
  return {
    trustStatus: async (project: string) => {
      rec.push(`trustStatus:${project}`)
      return status(false)
    },
    sshTrustStatus: async (project: string, sshConnectionId: string) => {
      rec.push(`sshTrustStatus:${project}:${sshConnectionId}`)
      return status(true)
    },
  }
}

function writeApi(rec: string[]) {
  return {
    trustSave: async (project: string, trusted: boolean, trustParent: boolean) => {
      rec.push(`trustSave:${project}:${trusted}:${trustParent}`)
    },
    sshTrustSave: async (project: string, sshConnectionId: string, trusted: boolean, trustParent: boolean) => {
      rec.push(`sshTrustSave:${project}:${sshConnectionId}:${trusted}:${trustParent}`)
    },
  }
}

test("requireSshConnectionId：本地不适用、远程解析成功、缺失抛 coded", async () => {
  expect(requireSshConnectionId(URI, CONNECTIONS)).toBe("ssh-1")
  // 连接 host/port/user 不匹配 URI 时不采纳
  expect(() => requireSshConnectionId(URI, [{ id: "ssh-9", host: "other" }])).toThrowError(/sshConnectionMissing/)
  const coded = parseCodedError(
    (() => {
      try {
        requireSshConnectionId(URI, [])
      } catch (e) {
        return (e as Error).message
      }
      return ""
    })(),
  )
  expect(coded?.code).toBe("sshConnectionMissing")
})

test("loadTrustStatus：本地走 trustStatus，远程走 sshTrustStatus 并携带连接 id", async () => {
  const rec: string[] = []
  const api = readApi(rec)
  await loadTrustStatus(LOCAL, CONNECTIONS, api)
  await loadTrustStatus(URI, CONNECTIONS, api)
  expect(rec).toEqual([`trustStatus:${LOCAL}`, `sshTrustStatus:${URI}:ssh-1`])
  await expect(loadTrustStatus(URI, [], api)).rejects.toThrow("sshConnectionMissing")
  expect(rec).toEqual([`trustStatus:${LOCAL}`, `sshTrustStatus:${URI}:ssh-1`])
})

test("loadTrustStatusLenient：连接缺失降级为 null 并回调 coded error", async () => {
  const rec: string[] = []
  const api = readApi(rec)
  const missing: unknown[] = []
  expect(await loadTrustStatusLenient(URI, [], api, error => missing.push(error))).toBeNull()
  expect(parseCodedError((missing[0] as Error).message)?.code).toBe("sshConnectionMissing")
  expect(rec).toEqual([])
  // 本地与正常远程不受影响
  expect(await loadTrustStatusLenient(LOCAL, CONNECTIONS, api)).toEqual(status(false))
  expect(await loadTrustStatusLenient(URI, CONNECTIONS, api)).toEqual(status(true))
  expect(rec).toEqual([`trustStatus:${LOCAL}`, `sshTrustStatus:${URI}:ssh-1`])
})

test("saveTrustDecision：本地经 trustSave，远程经 sshTrustSave；缺失连接失败", async () => {
  const rec: string[] = []
  const api = writeApi(rec)
  // 本地：即使 project 与本地落盘路径不同，也按 localProjectPath 保存
  await saveTrustDecision(LOCAL, "/real/local", true, false, CONNECTIONS, api)
  await saveTrustDecision(URI, "/ignored", true, true, CONNECTIONS, api)
  expect(rec).toEqual([`trustSave:/real/local:true:false`, `sshTrustSave:${URI}:ssh-1:true:true`])
  await expect(saveTrustDecision(URI, "/ignored", false, false, [], api)).rejects.toThrow("sshConnectionMissing")
  expect(rec).toHaveLength(2)
})

test("terminalConnectionId：本地恒 undefined（不查询连接），远程解析或抛错", async () => {
  let listed = 0
  const listConnections = () => {
    listed++
    return Promise.resolve(CONNECTIONS)
  }
  expect(await terminalConnectionId(LOCAL, listConnections)).toBeUndefined()
  expect(listed).toBe(0)
  expect(await terminalConnectionId(URI, listConnections)).toBe("ssh-1")
  expect(listed).toBe(1)
  await expect(terminalConnectionId(URI, async () => [])).rejects.toThrow("sshConnectionMissing")
})
