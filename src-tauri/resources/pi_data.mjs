// Executed with the user's Pi modules, not a bundled copy of Pi.
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const load = name => import(pathToFileURL(join(process.argv[1], name)).href);
const { getAgentDir } = await load("config.js");
const request = JSON.parse(readFileSync(0, "utf8"));
const { op } = request;
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
      if (!["defaultProvider", "defaultModel", "skills", "retry", "followUpMode"].includes(key))
        throw new Error(`Unsupported setting: ${key}`);
    }
    if ("skills" in patch && (!Array.isArray(patch.skills) || !patch.skills.every(p => typeof p === "string"))) throw new Error("Invalid skill paths");
    if ("followUpMode" in patch) {
      if (!["one-at-a-time", "all"].includes(patch.followUpMode)) throw new Error("Invalid followUpMode");
      settings.setFollowUpMode(patch.followUpMode);
    }
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
    skills: global.skills ?? [], retry: readRetrySettings(settings),
    followUpMode: settings.getFollowUpMode() };
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

function readRetrySettings(settings) {
  return { maxRetries: settings.getRetrySettings().maxRetries };
}

/**
 * Pi exposes no setter for the retry attempt count, so write it the way Pi's own
 * setters do — mutate the global settings object, mark the key as modified, then
 * save — which rewrites only that key inside the existing `retry` block.
 */
function applyRetrySettings(settings, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Invalid retry settings");
  for (const key of Object.keys(patch)) {
    if (key !== "maxRetries") throw new Error(`Unsupported retry setting: ${key}`);
  }
  if (!Number.isSafeInteger(patch.maxRetries) || patch.maxRetries < 0) throw new Error("Invalid retry maxRetries");
  if (!settings.globalSettings || typeof settings.markModified !== "function" || typeof settings.save !== "function") {
    throw new Error("Installed Pi does not support retry settings");
  }
  if (!settings.globalSettings.retry) settings.globalSettings.retry = {};
  settings.globalSettings.retry.maxRetries = patch.maxRetries;
  settings.markModified("retry", "maxRetries");
  settings.save();
}
