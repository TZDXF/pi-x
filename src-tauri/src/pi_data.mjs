// Executed with the user's Pi modules, not a bundled copy of Pi.
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const load = name => import(pathToFileURL(join(process.argv[1], name)).href);
const { getAgentDir } = await load("config.js");
const request = JSON.parse(readFileSync(0, "utf8"));
const { op } = request;
// Declared before the dispatch chain below, which runs before the helpers at the
// end of this file are reached.
const RETRY_BUDGET_KEYS = ["maxRetries", "baseDelayMs", "maxAgentDelayMs"];
let result = null;
if (op.startsWith("trust_")) {
  const { ProjectTrustStore, getProjectTrustOptions, getProjectTrustParentPath,
    hasTrustRequiringProjectResources } = await load("core/trust-manager.js");
  const project = realpathSync(request.project);
  const store = new ProjectTrustStore(getAgentDir());
  if (op === "trust_save") {
    const options = getProjectTrustOptions(project);
    const option = request.trustParent && request.trusted
      ? options.find(o => o.savedPath === getProjectTrustParentPath(project))
      : options.find(o => o.trusted === request.trusted && o.savedPath === project);
    if (!option) throw new Error("Unsupported project trust decision");
    store.setMany(option.updates);
  }
  const decision = store.get(project);
  const resources = hasTrustRequiringProjectResources(project);
  const { SettingsManager } = await load("core/settings-manager.js");
  const settings = SettingsManager.create(project, getAgentDir());
  checkErrors(settings);
  const policy = settings.getDefaultProjectTrust();
  result = { projectPath: project, parentPath: getProjectTrustParentPath(project) ?? null,
    hasTrustRequiringResources: resources, decision, policy,
    needsDecision: resources && decision === null && policy === "ask" };
} else if (op.startsWith("settings_")) {
  const { SettingsManager } = await load("core/settings-manager.js");
  // Only global preferences; do not load or overwrite project settings here.
  const settings = SettingsManager.create(getAgentDir(), getAgentDir());
  checkErrors(settings);
  if (op === "settings_save") {
    const patch = request.settings;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Invalid settings");
    for (const key of Object.keys(patch)) {
      if (!["defaultProvider", "defaultModel", "skills", "retry"].includes(key)) throw new Error(`Unsupported setting: ${key}`);
    }
    if ("skills" in patch && (!Array.isArray(patch.skills) || !patch.skills.every(p => typeof p === "string"))) throw new Error("Invalid skill paths");
    if ("defaultProvider" in patch || "defaultModel" in patch) {
      if (![patch.defaultProvider, patch.defaultModel].every(v => v === null || typeof v === "string")) throw new Error("Invalid default model");
      settings.setDefaultModelAndProvider(patch.defaultProvider ?? undefined, patch.defaultModel ?? undefined);
    }
    if ("skills" in patch) {
      settings.setSkillPaths(patch.skills);
    }
    if ("retry" in patch) applyRetrySettings(settings, patch.retry);
    await settings.flush();
    checkErrors(settings);
  }
  const global = settings.getGlobalSettings();
  result = { defaultProvider: global.defaultProvider, defaultModel: global.defaultModel,
    defaultThinkingLevel: global.defaultThinkingLevel, modelThinkingLevels: global.modelThinkingLevels,
    skills: global.skills ?? [], retry: readRetrySettings(settings) };
} else if (op === "session_export_html") {
  const { exportFromFile } = await load("core/export-html/index.js");
  result = await exportFromFile(request.file, { outputPath: request.outputPath });
} else if (op === "session_name") {
  const { SessionManager } = await load("core/session-manager.js");
  const session = SessionManager.open(request.file);
  if (typeof request.title === "string" && request.title.trim() && (!request.onlyIfEmpty || !session.getSessionName())) {
    session.appendSessionInfo(request.title.trim());
  }
  result = session.getSessionName() ?? null;
} else {
  throw new Error(`Unsupported operation: ${op}`);
}
process.stdout.write(JSON.stringify(result));

function checkErrors(settings) {
  const errors = settings.drainErrors();
  if (errors.length) throw new Error(errors.map(e => e.error?.message ?? String(e)).join("; "));
}

/** Resolved retry policy, or null when the installed Pi predates the `retry` block. */
function readRetrySettings(settings) {
  if (typeof settings.getRetrySettings !== "function" || typeof settings.getRetryEnabled !== "function") return null;
  const { maxRetries, baseDelayMs, maxAgentDelayMs } = settings.getRetrySettings();
  return { enabled: settings.getRetryEnabled(), maxRetries, baseDelayMs, maxAgentDelayMs };
}

/**
 * Pi only exposes a setter for `retry.enabled`; the budget keys have none. Write
 * them the way Pi's own setters do — mutate the global settings object, mark the
 * touched key as modified, then save — so a patch rewrites just those keys.
 */
function applyRetrySettings(settings, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Invalid retry settings");
  for (const key of Object.keys(patch)) {
    if (key !== "enabled" && !RETRY_BUDGET_KEYS.includes(key)) throw new Error(`Unsupported retry setting: ${key}`);
  }
  if ("enabled" in patch && typeof patch.enabled !== "boolean") throw new Error("Invalid retry enabled");
  for (const key of RETRY_BUDGET_KEYS) {
    if (key in patch && (!Number.isSafeInteger(patch[key]) || patch[key] < 0)) throw new Error(`Invalid retry ${key}`);
  }
  if (typeof settings.setRetryEnabled !== "function" || !settings.globalSettings || typeof settings.markModified !== "function") {
    throw new Error("Installed Pi does not support retry settings");
  }
  if ("enabled" in patch) settings.setRetryEnabled(patch.enabled);
  const budget = RETRY_BUDGET_KEYS.filter(key => key in patch);
  if (!budget.length) return;
  if (!settings.globalSettings.retry) settings.globalSettings.retry = {};
  for (const key of budget) {
    settings.globalSettings.retry[key] = patch[key];
    settings.markModified("retry", key);
  }
  settings.save();
}
