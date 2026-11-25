#!/usr/bin/env bash
# 发布流程中 macOS 产物的签名 / 公证策略，供 release.yml 与 preview.yml 共用。
#
# 为什么需要它：Tauri 只有在拿到签名身份时才会重签 app bundle。没有 APPLE_CERTIFICATE /
# APPLE_SIGNING_IDENTITY 时，bundle 里只剩 rustc 链接期写下的 linker-signed ad-hoc 签名，
# `codesign --verify --strict` 会报 “code has no resources but signature indicates they
# must be present”，用户从浏览器下载（带 com.apple.quarantine）后系统直接判定产物损坏，
# 提示“已损坏，无法打开”。因此无论凭据是否齐全，都必须保证发布产物的 bundle 签名自洽。
#
# 子命令：
#   plan      解析凭据组合、导出可用凭据并决定签名模式（结果写入 $GITHUB_ENV），stdout 只输出模式
#   verify    校验 <bundle>/macos/*.app、<bundle>/macos/*.app.tar.gz 与 <bundle>/dmg/*.dmg
#   notes     输出追加到 release notes 的 macOS 说明（已签名时为空）
#
# 模式：
#   signed  Developer ID 证书 + 公证凭据齐全：正常签名 + 公证 + 装订票据
#   adhoc   没有任何 Apple 凭据：退化为 ad-hoc 重签，签名自洽可启动，但不满足 Gatekeeper
#
# 凭据只允许「全无」或「齐全」两种状态；只给一半会直接失败，避免静默产出半残产物。
# 特别注意：CI 里 `secrets.X` 缺失时会展开成空字符串，因此 plan 只把非空凭据写进
# $GITHUB_ENV——否则 tauri 会认为 APPLE_CERTIFICATE="" 是「有证书」而去导入空证书。
set -euo pipefail

die() {
  printf '::error::%s\n' "$*" >&2
  exit 1
}

# 公证凭据状态：absent（一个都没有）/ partial（只给了几个）/ complete（某一组成齐全）。
# 支持两种组合：Apple ID（APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID）与
# App Store Connect API Key（APPLE_API_KEY + APPLE_API_ISSUER + APPLE_API_KEY_PATH
# 或 APPLE_API_KEY_P8_BASE64，后者由本脚本落盘成 APPLE_API_KEY_PATH）。
notarization_state() {
  local any=""
  if [[ -n "${APPLE_ID:-}${APPLE_PASSWORD:-}${APPLE_TEAM_ID:-}${APPLE_API_KEY:-}${APPLE_API_ISSUER:-}${APPLE_API_KEY_PATH:-}${APPLE_API_KEY_P8_BASE64:-}" ]]; then
    any=1
  fi
  if [[ -z "$any" ]]; then
    echo absent
    return 0
  fi
  if [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
    echo complete
    return 0
  fi
  if [[ -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_ISSUER:-}" ]] &&
    [[ -n "${APPLE_API_KEY_PATH:-}" || -n "${APPLE_API_KEY_P8_BASE64:-}" ]]; then
    echo complete
    return 0
  fi
  echo partial
}

certificate_state() {
  if [[ -z "${APPLE_CERTIFICATE:-}" && -z "${APPLE_CERTIFICATE_PASSWORD:-}" ]]; then
    echo absent
  elif [[ -n "${APPLE_CERTIFICATE:-}" && -n "${APPLE_CERTIFICATE_PASSWORD:-}" ]]; then
    echo complete
  else
    echo partial
  fi
}

resolve_mode() {
  local cert notary
  cert=$(certificate_state)
  notary=$(notarization_state)

  if [[ "$cert" == partial ]]; then
    die "APPLE_CERTIFICATE 与 APPLE_CERTIFICATE_PASSWORD 必须同时提供（只给了其中一个）"
  fi

  if [[ "$cert" == absent ]]; then
    if [[ "$notary" == partial ]]; then
      die "公证凭据不完整：APPLE_ID 需配套 APPLE_PASSWORD 与 APPLE_TEAM_ID；API Key 需配套 APPLE_API_ISSUER 与 APPLE_API_KEY_PATH（或 APPLE_API_KEY_P8_BASE64）"
    fi
    if [[ "$notary" == complete ]]; then
      die "提供了公证凭据但缺 APPLE_CERTIFICATE / APPLE_CERTIFICATE_PASSWORD：没有 Developer ID 证书无法公证，请补齐证书或清空公证凭据走 ad-hoc 降级"
    fi
    if [[ -n "${APPLE_SIGNING_IDENTITY:-}" && "${APPLE_SIGNING_IDENTITY}" != "-" ]]; then
      die "只设置 APPLE_SIGNING_IDENTITY 无法签名：CI runner 的 keychain 里没有该身份，必须同时提供 APPLE_CERTIFICATE / APPLE_CERTIFICATE_PASSWORD"
    fi
    echo adhoc
    return 0
  fi

  if [[ "$notary" != complete ]]; then
    die "已提供 Developer ID 证书但缺少公证凭据（APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID 或 APPLE_API_KEY/APPLE_API_ISSUER/APPLE_API_KEY_PATH）：Developer ID 签名的产物必须公证，否则 Gatekeeper 仍会拦截"
  fi
  echo signed
}

# 写 $GITHUB_ENV（本地直接运行时变量为空，忽略即可）；GITHUB_ENV 不支持多行值。
write_env() {
  if [[ -n "${GITHUB_ENV:-}" ]]; then
    printf '%s=%s\n' "$1" "$2" >> "$GITHUB_ENV"
  fi
}

step_summary() {
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '%s\n' "$1" >> "$GITHUB_STEP_SUMMARY"
  fi
}

# 把非空凭据透传给后续步骤（tauri 读的是环境变量，不认 GitHub secrets）。
export_credentials() {
  local name value
  for name in APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID \
    APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH APPLE_PROVIDER_SHORT_NAME; do
    value="${!name:-}"
    if [[ -n "$value" ]]; then write_env "$name" "$value"; fi
  done

  # API Key 只以 base64 形式给出时落盘成文件（p8 私钥下载后只能看到一次）。
  if [[ -n "${APPLE_API_KEY_P8_BASE64:-}" ]]; then
    [[ -n "${RUNNER_TEMP:-}" ]] || die "APPLE_API_KEY_P8_BASE64 需要配合 GITHUB_ACTIONS 的 RUNNER_TEMP 使用"
    local key_path="$RUNNER_TEMP/AuthKey_${APPLE_API_KEY:-key}.p8"
    printf '%s' "$APPLE_API_KEY_P8_BASE64" | openssl base64 -d -A > "$key_path"
    chmod 600 "$key_path"
    write_env APPLE_API_KEY_PATH "$key_path"
  fi
}

cmd_plan() {
  local mode
  mode=$(resolve_mode)
  export_credentials
  write_env MACOS_SIGNING_MODE "$mode"
  echo "$mode"

  if [[ "$mode" == signed ]]; then
    {
      echo "签名模式：Developer ID + 公证（tauri 会导入 APPLE_CERTIFICATE 并自动公证、装订票据）"
    } >&2
    step_summary "- macOS 产物：Developer ID 签名 + 公证（凭据齐全）"
    return 0
  fi

  # tauri 约定的 ad-hoc 伪身份：仍然会深层重签 app bundle，让签名自洽。
  write_env APPLE_SIGNING_IDENTITY "-"
  {
    echo "签名模式：ad-hoc 降级（未配置 Apple Developer ID 证书 / 公证凭据）"
    echo "  - bundle 会被重新签名，签名自洽、可启动，不再出现「code has no resources」坏签名"
    echo "  - 未公证：Gatekeeper 仍会拦截浏览器下载后的首次打开，release notes 会附用户处理说明"
  } >&2
  step_summary "- macOS 产物：**ad-hoc 签名降级**（未配置 Apple Developer ID 证书 / 公证凭据），未公证，release notes 已附用户处理说明"
}

# macOS runner 的 /bin/bash 是 3.2，`set -u` 下展开空数组会报 unbound variable，统一按下标循环。
verify_one_app() {
  local app="$1" strict="$2" failed=0

  echo "== 校验 $app =="
  codesign -dv --verbose=4 "$app" 2>&1 |
    grep -E '^(Identifier|Format|CodeDirectory|Signature|TeamIdentifier|Sealed Resources|Info\.plist|Internal requirements)' || true

  # 针对本次缺陷的回归守卫：没有 CodeResources 说明 bundle 从未被重签，只剩 linker-signed 签名。
  if [[ -f "$app/Contents/_CodeSignature/CodeResources" ]]; then
    echo "seal: 存在 Contents/_CodeSignature/CodeResources"
  else
    echo "::error::$app 缺少 Contents/_CodeSignature/CodeResources，bundle 未被重新签名（只有 linker-signed 签名）"
    failed=1
  fi

  if codesign --verify --deep --strict --verbose=2 "$app"; then
    echo "codesign --verify --deep --strict: 通过（签名自洽）"
  else
    echo "::error::$app 签名校验失败（codesign --verify --deep --strict 未通过）"
    failed=1
  fi

  if [[ "$strict" == signed ]]; then
    if xcrun stapler validate "$app"; then
      echo "stapler validate: 通过（公证票据已装订）"
    else
      echo "::error::$app 未装订公证票据（stapler validate 失败）"
      failed=1
    fi
    if spctl --assess --type execute -vv "$app"; then
      echo "spctl --assess: 通过（Gatekeeper 放行）"
    else
      echo "::error::$app 未通过 Gatekeeper 评估（spctl --assess 拒绝）"
      failed=1
    fi
  else
    # ad-hoc 只能保证签名自洽，Gatekeeper 按设计拒绝；记录结果但不作为失败。
    if xcrun stapler validate "$app"; then
      echo "stapler validate: 通过（公证票据已装订）"
    else
      echo "stapler validate: 无公证票据（ad-hoc 模式预期如此）"
    fi
    if spctl --assess --type execute -vv "$app"; then
      echo "spctl --assess: 通过"
    else
      echo "spctl --assess: 拒绝（ad-hoc 无 Developer ID 时的预期结果；不作为 CI 失败）"
    fi
  fi

  return "$failed"
}

cmd_verify() {
  local bundle_root="${1:-}"
  [[ -n "$bundle_root" ]] || die "用法：macos-signing.sh verify <bundle 目录>，例如 src-tauri/target/release/bundle"
  [[ -d "$bundle_root" ]] || die "找不到产物目录：$bundle_root"

  local mode="${MACOS_SIGNING_MODE:-}"
  if [[ -z "$mode" ]]; then
    mode=$(resolve_mode)
  fi

  local failed=0 app dmg tarball idx app_count dmg_count tar_count
  local apps=() dmgs=() tarballs=()
  shopt -s nullglob
  apps=("$bundle_root"/macos/*.app)
  tarballs=("$bundle_root"/macos/*.app.tar.gz)
  dmgs=("$bundle_root"/dmg/*.dmg)
  shopt -u nullglob
  app_count=${#apps[@]}
  dmg_count=${#dmgs[@]}
  tar_count=${#tarballs[@]}

  [[ "$app_count" -gt 0 ]] || die "在 $bundle_root/macos 下没有找到 .app 产物"

  for ((idx = 0; idx < app_count; idx++)); do
    app="${apps[idx]}"
    verify_one_app "$app" "$mode" || failed=1
  done

  # 自动更新包必须是同一个已签名 app（tauri 先签 app 再打 tar.gz），否则升级安装后照样坏签名。
  local unpack_dir
  for ((idx = 0; idx < tar_count; idx++)); do
    tarball="${tarballs[idx]}"
    echo "== 校验自动更新包 $tarball =="
    unpack_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/pix-macos-update.XXXXXX")"
    if tar xzf "$tarball" -C "$unpack_dir" --strip-components=0 2>/dev/null; then
      local unpacked_app=()
      shopt -s nullglob
      unpacked_app=("$unpack_dir"/*.app)
      shopt -u nullglob
      if [[ ${#unpacked_app[@]} -gt 0 ]]; then
        verify_one_app "${unpacked_app[0]}" "$mode" || failed=1
      else
        echo "::error::$tarball 里没有 .app，自动更新包内容异常"
        failed=1
      fi
    else
      echo "::error::$tarball 无法解包，自动更新包内容异常"
      failed=1
    fi
    rm -rf "$unpack_dir"
  done

  for ((idx = 0; idx < dmg_count; idx++)); do
    dmg="${dmgs[idx]}"
    echo "== 校验 $dmg =="
    if codesign --verify --verbose=2 "$dmg" 2>&1; then
      echo "codesign --verify: 通过（dmg 有签名）"
      if [[ "$mode" == signed ]]; then
        if xcrun stapler validate "$dmg"; then
          echo "stapler validate: 通过（dmg 已装订票据）"
        else
          echo "提示：dmg 未装订公证票据（tauri 只给 .app 装订，取决于 app 自身票据，不影响打开）"
        fi
      fi
    else
      if [[ "$mode" == signed ]]; then
        echo "::error::$dmg 在 Developer ID 模式下没有有效签名"
        failed=1
      else
        echo "codesign --verify: dmg 自身未签名（ad-hoc 模式预期如此；决定能否打开的是 dmg 内 app 的签名）"
      fi
    fi
  done

  [[ "$dmg_count" -gt 0 ]] || echo "提示：$bundle_root/dmg 下没有 .dmg 产物（可能是只构建了 app 的本地验证）"

  if [[ "$failed" != 0 ]]; then
    die "macOS 产物签名校验未通过（模式 $mode），见上方 ::error:: 行"
  fi
  echo "macOS 产物签名校验完成（模式 $mode）"
}

cmd_notes() {
  local mode="${MACOS_SIGNING_MODE:-}"
  if [[ -z "$mode" ]]; then
    mode=$(resolve_mode)
  fi
  [[ "$mode" == adhoc ]] || return 0
  cat <<'EOF'

## macOS 安装包说明（未公证）

本次 macOS 产物未使用 Apple Developer ID 签名、未公证（构建时只做了 ad-hoc 重签，签名自洽）。浏览器下载的 dmg 会带上系统隔离标记（`com.apple.quarantine`），因此首次打开 PiX 时 macOS 可能提示“已损坏，无法打开”或“无法验证开发者”。这不是安装包损坏，而是未公证产物常见的拦截。

安装后可任选一种方式放行：

1. 在 Finder 中右键 PiX.app →「打开」，再在弹窗里选「打开」；
2. 或到「系统设置 → 隐私与安全性」，在“已阻止使用”处点「仍要打开」；
3. 或用命令移除隔离标记后重新打开：

   ```bash
   xattr -dr com.apple.quarantine /Applications/PiX.app
   ```

第 3 种只移除本地隔离标记，不改变签名状态；下次从网络下载的安装包仍会带上该标记。
EOF
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    plan) cmd_plan ;;
    verify)
      shift
      cmd_verify "${1:-}"
      ;;
    notes) cmd_notes ;;
    *)
      die "用法：macos-signing.sh <plan|verify|notes> [参数]"
      ;;
  esac
}

main "$@"
