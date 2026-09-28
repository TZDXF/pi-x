// Apply before first paint; storage can be unavailable in restricted webviews.
;(() => {
  let preference = "dark"
  try {
    preference = localStorage.getItem("pix.theme") || "dark"
  } catch {}
  const dark =
    preference === "system" ? window.matchMedia("(prefers-color-scheme: dark)").matches : preference !== "light"
  document.documentElement.classList.toggle("dark", dark)
})()
