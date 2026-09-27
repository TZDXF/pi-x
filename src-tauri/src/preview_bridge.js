/*!
 * PiX preview bridge — injected by the preview proxy into every HTML page.
 * Talks to the BrowserPanel iframe host via postMessage: navigation
 * reporting, history control, console forwarding, element inspect
 * selection (pin / area) and numbered annotation markers.
 */
;(function () {
  "use strict"
  if (window.__pixPreviewBridge) return
  window.__pixPreviewBridge = true

  var parent = window.parent
  if (!parent || parent === window) return

  var SOURCE = "pix-preview"
  var INCOMING = "pix-preview-page"

  // Injected by the proxy: the proxied base for this document
  // ("{prefix}/{scheme}/{host}"). Root-relative URLs must be re-based or they
  // escape the proxy prefix and 404 against the proxy origin.
  var BASE = window.__pixPreviewBase || ""

  function prefixUrl(url) {
    if (!BASE || typeof url !== "string") return url
    if (url.charAt(0) === "/" && url.charAt(1) !== "/" && url.indexOf(BASE + "/") !== 0 && url !== BASE) {
      return BASE + url
    }
    return url
  }

  function send(message) {
    try {
      message.source = SOURCE
      parent.postMessage(message, "*")
    } catch (_) { /* parent may be gone during teardown */ }
  }

  function safeText(value, limit) {
    var text = String(value == null ? "" : value).replace(/\s+/g, " ").trim()
    return text.length > limit ? text.slice(0, limit) + "…" : text
  }

  // ---- navigation reporting -------------------------------------------------

  function fixStateUrl(url) {
    if (url == null) return url
    if (typeof url === "string") return prefixUrl(url)
    return String(url)
  }

  function reportNavigation() {
    send({ type: "navigated", url: location.href, title: safeText(document.title, 200) })
  }

  var nativePushState = history.pushState
  var nativeReplaceState = history.replaceState
  history.pushState = function () {
    var args = Array.prototype.slice.call(arguments)
    if (args.length >= 3) args[2] = fixStateUrl(args[2])
    var result = nativePushState.apply(this, args)
    setTimeout(reportNavigation, 0)
    return result
  }
  history.replaceState = function () {
    var args = Array.prototype.slice.call(arguments)
    if (args.length >= 3) args[2] = fixStateUrl(args[2])
    var result = nativeReplaceState.apply(this, args)
    setTimeout(reportNavigation, 0)
    return result
  }
  window.addEventListener("popstate", function () { setTimeout(reportNavigation, 0) })
  window.addEventListener("hashchange", reportNavigation)
  window.addEventListener("DOMContentLoaded", reportNavigation)
  window.addEventListener("load", reportNavigation)
  if (document.readyState !== "loading") reportNavigation()

  // ---- console forwarding ---------------------------------------------------

  function forwardConsole(level, args) {
    var parts = []
    for (var i = 0; i < args.length; i++) {
      var value = args[i]
      try {
        parts.push(typeof value === "string" ? value : JSON.stringify(value))
      } catch (_) {
        parts.push(String(value))
      }
    }
    send({ type: "console", level: level, text: safeText(parts.join(" "), 500) })
  }

  ;["log", "info", "warn", "error", "debug"].forEach(function (level) {
    var native = console[level]
    console[level] = function () {
      try { forwardConsole(level, Array.prototype.slice.call(arguments)) } catch (_) { /* ignore */ }
      return native.apply(console, arguments)
    }
  })
  window.addEventListener("error", function (event) {
    forwardConsole("error", [safeText(event.message, 400) + " (" + (event.filename || "") + ":" + (event.lineno || 0) + ")"])
  })
  window.addEventListener("unhandledrejection", function (event) {
    var reason = event.reason
    forwardConsole("error", ["Unhandled rejection: " + safeText(reason && reason.message ? reason.message : reason, 400)])
  })

  // ---- runtime request patching ----------------------------------------------
  // Static HTML/CSS are rewritten server-side; requests issued from
  // JavaScript need the same re-basing at runtime.

  if (BASE) {
    var nativeFetch = window.fetch
    if (nativeFetch) {
      window.fetch = function (input, init) {
        try {
          if (typeof input === "string") input = prefixUrl(input)
        } catch (_) { /* fall through with the original input */ }
        return nativeFetch.call(this, input, init)
      }
    }

    var nativeOpen = XMLHttpRequest.prototype.open
    XMLHttpRequest.prototype.open = function () {
      var args = Array.prototype.slice.call(arguments)
      if (args.length >= 2) args[1] = prefixUrl(args[1])
      return nativeOpen.apply(this, args)
    }

    var NativeEventSource = window.EventSource
    if (NativeEventSource) {
      window.EventSource = function (url, config) {
        return new NativeEventSource(prefixUrl(url), config)
      }
      window.EventSource.prototype = NativeEventSource.prototype
      Object.assign(window.EventSource, { CONNECTING: 0, OPEN: 1, CLOSED: 2 })
    }

    var NativeWebSocket = window.WebSocket
    if (NativeWebSocket) {
      window.WebSocket = function (url, protocols) {
        var patched = url
        try {
          if (typeof url === "string") {
            if (url.charAt(0) === "/" && url.charAt(1) !== "/") {
              var scheme = location.protocol === "https:" ? "wss:" : "ws:"
              patched = scheme + "//" + location.host + prefixUrl(url)
            } else if (/^wss?:\/\//i.test(url)) {
              // Absolute socket URLs aimed at the proxy host need the base
              // inserted; other hosts go out directly.
              var parsed = new URL(url)
              if (parsed.host === location.host) {
                var path = parsed.pathname + parsed.search
                if (path.charAt(0) === "/" && path.indexOf(BASE + "/") !== 0) {
                  patched = parsed.protocol + "//" + parsed.host + BASE + path
                }
              }
            }
          }
        } catch (_) { /* keep the original url */ }
        return protocols === undefined ? new NativeWebSocket(patched) : new NativeWebSocket(patched, protocols)
      }
      window.WebSocket.prototype = NativeWebSocket.prototype
      Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })
    }
  }

  // ---- document-coordinate helpers -------------------------------------------

  function toDocumentRect(rect) {
    return {
      x: rect.left + window.scrollX,
      y: rect.top + window.scrollY,
      width: rect.width,
      height: rect.height,
    }
  }

  function cssPath(element) {
    var parts = []
    var node = element
    while (node && node.nodeType === 1 && node !== document.body && parts.length < 5) {
      var segment = node.nodeName.toLowerCase()
      if (node.id) {
        try { parts.unshift("#" + CSS.escape(node.id)) } catch (_) { parts.unshift("#" + node.id) }
        break
      }
      var index = 1
      var sibling = node
      while ((sibling = sibling.previousElementSibling)) index++
      parts.unshift(segment + ":nth-of-type(" + index + ")")
      node = node.parentElement
    }
    return parts.join(" > ") || element.nodeName.toLowerCase()
  }

  function elementText(element) {
    return safeText(element.innerText || element.textContent, 120)
  }

  // ---- inspect mode -----------------------------------------------------------

  var inspecting = false
  var hoverBox = null
  var hoverLabel = null
  var areaBox = null
  var dragStart = null
  var dragging = false

  function ensureInspectLayer() {
    if (hoverBox) return
    hoverBox = document.createElement("div")
    hoverBox.style.cssText = "position:absolute;display:none;pointer-events:none;z-index:2147483645;outline:2px solid #3b82f6;outline-offset:-2px;background:rgba(59,130,246,.12)"
    hoverLabel = document.createElement("div")
    hoverLabel.style.cssText = "position:absolute;display:none;pointer-events:none;z-index:2147483646;max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:#3b82f6;color:#fff;font:11px/1.4 system-ui,sans-serif;padding:2px 6px;border-radius:4px"
    areaBox = document.createElement("div")
    areaBox.style.cssText = "position:absolute;display:none;pointer-events:none;z-index:2147483645;outline:2px dashed #f59e0b;background:rgba(245,158,11,.12)"
    var style = document.createElement("style")
    style.textContent = "html.pix-preview-inspect, html.pix-preview-inspect * { cursor: crosshair !important; user-select: none !important }"
    document.documentElement.appendChild(style)
    document.documentElement.appendChild(hoverBox)
    document.documentElement.appendChild(hoverLabel)
    document.documentElement.appendChild(areaBox)
  }

  function positionBox(box, rect, labelNode, label) {
    box.style.display = "block"
    box.style.left = rect.x + "px"
    box.style.top = rect.y + "px"
    box.style.width = Math.max(rect.width, 2) + "px"
    box.style.height = Math.max(rect.height, 2) + "px"
    if (labelNode) {
      labelNode.style.display = "block"
      labelNode.style.left = rect.x + "px"
      labelNode.style.top = Math.max(rect.y - 20, 0) + "px"
      labelNode.textContent = label
    }
  }

  function hideHover() {
    if (hoverBox) hoverBox.style.display = "none"
    if (hoverLabel) hoverLabel.style.display = "none"
  }

  function setInspect(enabled) {
    inspecting = enabled
    ensureInspectLayer()
    document.documentElement.classList.toggle("pix-preview-inspect", enabled)
    // Capture phase so inspect clicks are consumed here and never reach the
    // page's own handlers.
    if (enabled) {
      document.addEventListener("mousemove", onInspectMove, true)
      document.addEventListener("mousedown", onInspectDown, true)
      document.addEventListener("mouseup", onInspectUp, true)
    } else {
      document.removeEventListener("mousemove", onInspectMove, true)
      document.removeEventListener("mousedown", onInspectDown, true)
      document.removeEventListener("mouseup", onInspectUp, true)
      hideHover()
      areaBox.style.display = "none"
      dragStart = null
      dragging = false
    }
  }

  function onInspectMove(event) {
    if (!inspecting) return
    var target = event.target
    if (!target || target === hoverBox || target === hoverLabel || target === areaBox || target === document.documentElement) return
    if (dragStart) {
      var moved = Math.abs(event.pageX - dragStart.x) + Math.abs(event.pageY - dragStart.y)
      if (moved >= 6) dragging = true
    }
    if (dragging) {
      positionBox(areaBox, {
        x: Math.min(dragStart.x, event.pageX),
        y: Math.min(dragStart.y, event.pageY),
        width: Math.abs(event.pageX - dragStart.x),
        height: Math.abs(event.pageY - dragStart.y),
      })
      hideHover()
      return
    }
    var rect = toDocumentRect(target.getBoundingClientRect())
    positionBox(hoverBox, rect, hoverLabel, target.tagName.toLowerCase() + (elementText(target) ? " · " + elementText(target) : ""))
  }

  function onInspectDown(event) {
    if (!inspecting || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    dragStart = { x: event.pageX, y: event.pageY }
    dragging = false
  }

  function onInspectUp(event) {
    if (!inspecting || !dragStart) return
    event.preventDefault()
    event.stopPropagation()
    var moved = Math.abs(event.pageX - dragStart.x) + Math.abs(event.pageY - dragStart.y)
    if (moved >= 6) {
      var rect = {
        x: Math.min(dragStart.x, event.pageX),
        y: Math.min(dragStart.y, event.pageY),
        width: Math.abs(event.pageX - dragStart.x),
        height: Math.abs(event.pageY - dragStart.y),
      }
      areaBox.style.display = "none"
      send({ type: "selected", area: { rect: rect } })
    } else {
      var target = event.target
      if (target && target !== document.documentElement) {
        send({
          type: "selected",
          pin: {
            selector: cssPath(target),
            text: elementText(target),
            rect: toDocumentRect(target.getBoundingClientRect()),
          },
        })
      }
    }
    dragStart = null
    dragging = false
  }

  // ---- annotation markers -------------------------------------------------------

  var markerLayer = null

  function ensureMarkerLayer() {
    if (markerLayer) return
    markerLayer = document.createElement("div")
    markerLayer.id = "__pix-preview-markers"
    document.documentElement.appendChild(markerLayer)
  }

  function markerBadge(number, x, y) {
    var badge = document.createElement("div")
    badge.style.cssText = "position:absolute;display:flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:#ef4444;color:#fff;font:bold 12px/1 system-ui,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.4);border:2px solid #fff"
    badge.textContent = String(number)
    badge.style.left = x - 10 + "px"
    badge.style.top = y - 10 + "px"
    return badge
  }

  function renderMarker(annotation) {
    ensureMarkerLayer()
    var node = document.createElement("div")
    node.dataset.annotationId = annotation.id
    node.style.cssText = "position:absolute;pointer-events:none;z-index:2147483644"
    var rect = annotation.rect
    if (annotation.kind === "pin") {
      node.appendChild(markerBadge(annotation.number, rect.x, rect.y))
    } else {
      var frame = document.createElement("div")
      frame.style.cssText = "position:absolute;outline:2px dashed #ef4444;background:rgba(239,68,68,.08)"
      frame.style.left = rect.x + "px"
      frame.style.top = rect.y + "px"
      frame.style.width = Math.max(rect.width, 4) + "px"
      frame.style.height = Math.max(rect.height, 4) + "px"
      node.appendChild(frame)
      node.appendChild(markerBadge(annotation.number, rect.x, rect.y))
    }
    markerLayer.appendChild(node)
    trackMarker(annotation)
  }

  // Pin markers follow their element across scrolls and layout shifts; if the
  // element disappears the last document position is kept.
  function trackMarker(annotation) {
    if (annotation.kind !== "pin" || !annotation.pin || !annotation.pin.selector) return
    var node = markerLayer && markerLayer.querySelector('[data-annotation-id="' + annotation.id + '"]')
    if (!node) return
    var update = function () {
      var element = null
      try { element = document.querySelector(annotation.pin.selector) } catch (_) { return }
      if (!element) return
      var rect = toDocumentRect(element.getBoundingClientRect())
      var badge = node.firstChild
      badge.style.left = rect.x - 10 + "px"
      badge.style.top = rect.y - 10 + "px"
    }
    window.addEventListener("scroll", update, { passive: true })
    window.addEventListener("resize", update)
  }

  function clearMarkers() {
    if (markerLayer) markerLayer.textContent = ""
  }

  // ---- control messages ---------------------------------------------------------

  window.addEventListener("message", function (event) {
    var data = event.data
    if (!data || data.target !== INCOMING) return
    switch (data.type) {
      case "back":
        history.back()
        break
      case "forward":
        history.forward()
        break
      case "reload":
        location.reload()
        break
      case "inspect":
        setInspect(!!data.enabled)
        break
      case "add-marker":
        if (data.annotation) renderMarker(data.annotation)
        break
      case "clear-markers":
        clearMarkers()
        break
    }
  })

  send({ type: "ready" })
})()
