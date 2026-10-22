import { afterEach, describe, expect, test, vi } from "vitest"
import {
  copySshProjectConnection,
  rememberSshProjectConnection,
  resolveSshConnectionId,
  buildDockerUri,
  buildSshUri,
  buildWslUri,
  dockerIdentityKey,
  isRemoteUri,
  isSshUri,
  normalizeSshPath,
  parseDockerIdentityKey,
  parseDockerUri,
  parseRemoteUri,
  parseSshIdentityKey,
  parseSshUri,
  parseWslIdentityKey,
  parseWslUri,
  sshIdentityKey,
  wslIdentityKey,
  type DockerTarget,
  type SshTarget,
  type WslTarget,
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

/**
 * 多后端契约（docs/plans/remote-backends-contract.md）§2.4 用例表：
 * WSL / Docker 身份与伞型解析；与 Rust identity.rs 单测保持一一对应。
 */
describe("wsl identity（契约 §2.4 用例 1-4）", () => {
  test("case 1: user + distro round-trip 与身份键", () => {
    const uri = "wsl://tzdxf@Ubuntu-22.04/home/dev/proj"
    const target = parseWslUri(uri)
    expect(target).toEqual({ distro: "Ubuntu-22.04", user: "tzdxf", path: "/home/dev/proj" })
    expect(buildWslUri(target!)).toBe(uri)
    expect(wslIdentityKey(target!)).toBe("remote:wsl:Ubuntu-22.04:tzdxf:/home/dev/proj")
  })

  test("case 2: 缺省 user、path 大小写保留、身份键空 user 段", () => {
    const target = parseWslUri("wsl://Ubuntu/Proj")
    expect(target).toEqual({ distro: "Ubuntu", user: null, path: "/Proj" })
    expect(wslIdentityKey(target!)).toBe("remote:wsl:Ubuntu::/Proj")
    expect(buildWslUri(target!)).toBe("wsl://Ubuntu/Proj")
  })

  test("case 3: 路径归一化复用 normalizeSshPath", () => {
    expect(parseWslUri("wsl://Ubuntu/a/b///")).toMatchObject({ path: "/a/b" })
    expect(parseWslUri("wsl://Ubuntu/./a")).toMatchObject({ path: "/a" })
    expect(parseWslUri("wsl://Ubuntu/../etc")).toBeNull()
    // 契约 §2.2：不单独存在 normalizeWslPath，复用 normalizeSshPath。
    expect(normalizeSshPath("\\home\\dev")).toBe("/home/dev")
  })

  test("case 4: 非法输入全部返回 null", () => {
    for (const uri of [
      "wsl://default/x",
      "wsl://Default/x",
      "wsl://Ubuntu",
      "wsl:///x",
      "wsl://@U/x",
      "wsl://U a/x",
      "wsl://U:b/x",
      "C:/code",
      "/home/u",
    ]) {
      expect(parseWslUri(uri), uri).toBeNull()
    }
  })

  test("buildWslUri / wslIdentityKey 对非法字段抛错", () => {
    expect(() => buildWslUri({ distro: "default", user: null, path: "/a" })).toThrow()
    expect(() => buildWslUri({ distro: "Ubuntu", user: "in valid", path: "/a" })).toThrow()
    expect(() => buildWslUri({ distro: "Ubuntu", user: null, path: "relative" })).toThrow()
    expect(() => wslIdentityKey({ distro: "-bad", user: null, path: "/a" })).toThrow()
    expect(() => wslIdentityKey({ distro: "Ubuntu", user: null, path: "/a:b" })).toThrow()
  })

  test("身份键互逆与缺失 path 段", () => {
    const targets: WslTarget[] = [
      { distro: "Ubuntu-22.04", user: "tzdxf", path: "/home/dev/proj" },
      { distro: "Ubuntu", user: null, path: "/" },
      { distro: "Debian", user: "Dev.Name", path: "/a b/c" },
    ]
    for (const target of targets) {
      expect(parseWslIdentityKey(wslIdentityKey(target))).toEqual(target)
    }
    expect(parseWslIdentityKey("remote:wsl:Ubuntu:tzdxf")).toBeNull()
    expect(parseWslIdentityKey("remote:wsl:Ubuntu:tzdxf:/a")).toEqual({
      distro: "Ubuntu",
      user: "tzdxf",
      path: "/a",
    })
    // 未归一化 path 拒绝
    expect(parseWslIdentityKey("remote:wsl:Ubuntu::/a/")).toBeNull()
    expect(parseWslIdentityKey("remote:wsl:Ubuntu::a")).toBeNull()
    // distro 为 default（任何大小写）拒绝
    expect(parseWslIdentityKey("remote:wsl:default::/a")).toBeNull()
  })
})

describe("docker identity（契约 §2.4 用例 5-7）", () => {
  test("case 5: 容器名 round-trip 与身份键", () => {
    const uri = "docker://pix-docker-test/root/pix-docker-demo"
    const target = parseDockerUri(uri)
    expect(target).toEqual({ container: "pix-docker-test", path: "/root/pix-docker-demo" })
    expect(dockerIdentityKey(target!)).toBe("remote:docker:pix-docker-test:/root/pix-docker-demo")
    expect(buildDockerUri(target!)).toBe(uri)
  })

  test("case 6: 短 ID 合法，非法输入返回 null", () => {
    expect(parseDockerUri("docker://fdc995e5a8fc/root/demo")).toEqual({
      container: "fdc995e5a8fc",
      path: "/root/demo",
    })
    for (const uri of ["docker://-x/y", "docker://x", "docker://x:1/y", "docker:///y"]) {
      expect(parseDockerUri(uri), uri).toBeNull()
    }
  })

  test("case 7: 身份键互逆、缺失段与未归一化 path", () => {
    const targets: DockerTarget[] = [
      { container: "pix-docker-test", path: "/root/pix-docker-demo" },
      { container: "fdc995e5a8fc", path: "/" },
    ]
    for (const target of targets) {
      expect(parseDockerIdentityKey(dockerIdentityKey(target))).toEqual(target)
    }
    expect(parseDockerIdentityKey("remote:docker:c:/a")).toBeNull()
    expect(parseDockerIdentityKey("remote:docker:c")).toBeNull()
    expect(parseDockerIdentityKey("remote:docker:pix-docker-test:/a/")).toBeNull()
    expect(parseDockerIdentityKey("remote:docker:pix-docker-test:a")).toBeNull()
  })

  test("buildDockerUri / dockerIdentityKey 对非法字段抛错", () => {
    expect(() => buildDockerUri({ container: "-x", path: "/a" })).toThrow()
    expect(() => buildDockerUri({ container: "x:1", path: "/a" })).toThrow()
    expect(() => buildDockerUri({ container: "pix", path: "relative" })).toThrow()
    expect(() => dockerIdentityKey({ container: "", path: "/a" })).toThrow()
  })
})

describe("伞型 parseRemoteUri / isRemoteUri（契约 §2.4 用例 8）", () => {
  test("三后端分别命中对应分支", () => {
    expect(parseRemoteUri("ssh://dev@h:22/a")).toMatchObject({ kind: "ssh" })
    expect(parseRemoteUri("wsl://U/a")).toMatchObject({ kind: "wsl" })
    // 契约 §2.4 用例 8 经发起人修订：容器名至少 2 字符（对齐 moby 规则）。
    expect(parseRemoteUri("docker://ci/a")).toMatchObject({ kind: "docker" })
    expect(parseRemoteUri("docker://c/a")).toBeNull()
  })

  test("本地路径与未知前缀返回 null，本地项目零影响", () => {
    for (const value of ["C:/code", "/home/u", "", "wslx://a/b", "https://host/x"]) {
      expect(parseRemoteUri(value), value).toBeNull()
      expect(isRemoteUri(value), value).toBe(false)
      expect(isSshUri(value), value).toBe(false)
    }
  })

  test("isRemoteUri 对三后端前缀为 true", () => {
    expect(isRemoteUri("ssh://host/a")).toBe(true)
    expect(isRemoteUri("wsl://Ubuntu/a")).toBe(true)
    expect(isRemoteUri("docker://c/a")).toBe(true)
  })
})

describe("回绑项目连接选择", () => {
  afterEach(() => vi.unstubAllGlobals())

  const previous = "ssh://dev@host:2222/alias"
  const rebound = "ssh://dev@host:2222/real"
  const connections = [
    { id: "first", host: "host", port: 2222, user: "dev", keyPath: "/keys/first" },
    { id: "selected", host: "host", port: 2222, user: "dev", keyPath: "/keys/selected" },
    { id: "other", host: "other", port: 2222, user: "dev" },
  ]

  function storage() {
    const values = new Map<string, string>()
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    })
    return values
  }

  test("复制当前来源选择并覆盖目标旧选择，保留来源与无关项目", () => {
    storage()
    rememberSshProjectConnection(previous, "selected")
    rememberSshProjectConnection(rebound, "first")
    const unrelated = "ssh://dev@host:2222/unrelated"
    rememberSshProjectConnection(unrelated, "first")
    copySshProjectConnection(previous, rebound, connections)
    expect(resolveSshConnectionId(previous, connections)).toBe("selected")
    expect(resolveSshConnectionId(rebound, connections)).toBe("selected")
    expect(resolveSshConnectionId(unrelated, connections)).toBe("first")
    // 同一目标再次回绑时，以这次来源为准。
    copySshProjectConnection(unrelated, rebound, connections)
    expect(resolveSshConnectionId(rebound, connections)).toBe("first")
    expect(resolveSshConnectionId(previous, connections)).toBe("selected")
  })

  test.each([undefined, "deleted", "other"])("来源绑定 %s 时复制有效回退而非目标旧选择", remembered => {
    storage()
    if (remembered) rememberSshProjectConnection(previous, remembered)
    rememberSshProjectConnection(rebound, "selected")
    copySshProjectConnection(previous, rebound, connections)
    expect(resolveSshConnectionId(rebound, connections)).toBe("first")
  })

  test.each([
    "ssh://dev@other:2222/real",
    "ssh://dev@host:22/real",
    "ssh://another@host:2222/real",
    "wsl://Ubuntu/real",
    "ssh://host",
    "/local",
  ])("不向不同目标或非法 URI %s 复制连接", target => {
    const values = storage()
    rememberSshProjectConnection(previous, "selected")
    const before = values.get("pix.sshProjectConnections")
    copySshProjectConnection(previous, target, connections)
    expect(values.get("pix.sshProjectConnections")).toBe(before)
  })

  test("来源无有效连接时不修改已有绑定", () => {
    const values = storage()
    rememberSshProjectConnection(previous, "deleted")
    rememberSshProjectConnection(rebound, "selected")
    const before = values.get("pix.sshProjectConnections")
    copySshProjectConnection(previous, rebound, [])
    copySshProjectConnection("/local", rebound, connections)
    copySshProjectConnection(previous, previous, connections)
    expect(values.get("pix.sshProjectConnections")).toBe(before)
  })

  test("存储不可用不会阻断回绑", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("unavailable")
      },
      setItem: () => {
        throw new Error("unavailable")
      },
    })
    expect(() => copySshProjectConnection(previous, rebound, connections)).not.toThrow()
  })
})
