import { describe, expect, test } from "vitest"
import {
  buildSshUri,
  isSshUri,
  normalizeSshPath,
  parseSshIdentityKey,
  parseSshUri,
  sshIdentityKey,
  type SshTarget,
} from "@/lib/ssh"

/** 契约 §1.5 的 8 组用例；与 Rust identity.rs 单测保持一一对应。 */
describe("ssh identity", () => {
  test("case 1: user + 非默认端口 round-trip 与身份键", () => {
    const uri = "ssh://dev@host.example.com:2222/home/dev/proj"
    const target = parseSshUri(uri)
    expect(target).toEqual({ host: "host.example.com", port: 2222, user: "dev", path: "/home/dev/proj" })
    expect(buildSshUri(target!)).toBe(uri)
    expect(sshIdentityKey(target!)).toBe("remote:ssh:host.example.com:2222:dev:/home/dev/proj")
  })

  test("case 2: host 归一化小写、path 大小写保留、缺省 user/port", () => {
    const target = parseSshUri("ssh://Host.Example.COM/Proj")
    expect(target).toEqual({ host: "host.example.com", port: 22, user: null, path: "/Proj" })
    expect(sshIdentityKey(target!)).toBe("remote:ssh:host.example.com:22::/Proj")
    expect(buildSshUri(target!)).toBe("ssh://host.example.com/Proj")
  })

  test("case 3: 折叠连续斜杠、根路径与反斜杠归一化", () => {
    expect(parseSshUri("ssh://dev@host/a/b///")).toMatchObject({ path: "/a/b" })
    expect(parseSshUri("ssh://dev@host/")).toMatchObject({ path: "/" })
    expect(normalizeSshPath("\\home\\dev")).toBe("/home/dev")
  })

  test("case 4: 删除 . 段、拒绝 .. 段", () => {
    expect(parseSshUri("ssh://dev@host/./a/./b")).toMatchObject({ path: "/a/b" })
    expect(parseSshUri("ssh://dev@host/../etc")).toBeNull()
  })

  test("case 5: 非法输入全部返回 null", () => {
    for (const uri of [
      "ssh://host",
      "ssh:///path",
      "https://host/x",
      "C:/code",
      "/home/u",
      "ssh://host:70000/x",
      "ssh://@host/x",
      "ssh://host:99999/x",
    ]) {
      expect(parseSshUri(uri), uri).toBeNull()
    }
  })

  test("case 6: 端口去前导零、path 与 user 的字符规则", () => {
    expect(parseSshUri("ssh://host:022/x")).toMatchObject({ port: 22 })
    expect(parseSshUri("ssh://Dev.Name@host/a:x")).toBeNull()
    expect(parseSshUri("ssh://Dev.Name@host/x")).toMatchObject({ user: "Dev.Name", host: "host" })
  })

  test("case 7: 身份键互逆", () => {
    const targets: SshTarget[] = [
      { host: "host.example.com", port: 2222, user: "dev", path: "/home/dev/proj" },
      { host: "host", port: 22, user: null, path: "/" },
      { host: "host", port: 2200, user: "Dev.Name", path: "/a b/c" },
      { host: "10.0.0.1", port: 22, user: "root", path: "/srv/app" },
    ]
    for (const target of targets) {
      expect(parseSshIdentityKey(sshIdentityKey(target))).toEqual(target)
    }
    expect(parseSshIdentityKey("remote:ssh:host:22:dev:/a")).toEqual({
      host: "host",
      port: 22,
      user: "dev",
      path: "/a",
    })
    expect(parseSshIdentityKey("remote:ssh:host:22:dev:relative")).toBeNull()
  })

  test("case 8: 非远程判定对本地项目零影响", () => {
    expect(isSshUri("C:/code")).toBe(false)
    expect(isSshUri("/home/u")).toBe(false)
    expect(isSshUri("")).toBe(false)
  })

  test("buildSshUri 对非法字段抛错", () => {
    expect(() => buildSshUri({ host: "", port: 22, user: null, path: "/a" })).toThrow()
    expect(() => buildSshUri({ host: "host", port: 0, user: null, path: "/a" })).toThrow()
    expect(() => buildSshUri({ host: "host", port: 22, user: null, path: "relative" })).toThrow()
    expect(() => buildSshUri({ host: "host", port: 22, user: null, path: "/a/../b" })).toThrow()
    expect(() => buildSshUri({ host: "host", port: 22, user: "in valid", path: "/a" })).toThrow()
    expect(() => sshIdentityKey({ host: "host", port: 22, user: null, path: "/a:b" })).toThrow()
  })

  test("normalizeSshPath 拒绝相对路径与控制字符", () => {
    expect(normalizeSshPath("relative")).toBeNull()
    expect(normalizeSshPath("")).toBeNull()
    expect(normalizeSshPath("/a\nb")).toBeNull()
    expect(normalizeSshPath("/a\tb")).toBeNull()
    expect(normalizeSshPath("/a b")).toBe("/a b")
  })
})
