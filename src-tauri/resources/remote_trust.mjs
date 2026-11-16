// Run against the remote installation's SDK, including the self-contained bundle.
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
const dist = process.argv[1];
const bundled = process.argv[2] === "bundle";
const load = name => import(pathToFileURL(join(dist, name)).href);
const sdk = bundled ? await load("index.js") : null;
const { getAgentDir } = sdk ?? await load("config.js");
const { ProjectTrustStore, hasTrustRequiringProjectResources } = sdk ?? await load("core/trust-manager.js");
const { SettingsManager } = sdk ?? await load("core/settings-manager.js");
const request = JSON.parse(readFileSync(0, "utf8"));
if (!["trust_status", "trust_save"].includes(request.op)) throw new Error("Unsupported remote trust operation");
const project = realpathSync(request.project);
const parent = dirname(project) === project ? null : dirname(project);
const store = new ProjectTrustStore(getAgentDir());
if (request.op === "trust_save") {
  if (typeof request.trusted !== "boolean") throw new Error("Invalid trust decision");
  // Use Pi's store for locking, canonicalization and persistence. Trusting the
  // parent also clears a previous child decision so inheritance takes effect.
  if (request.trustParent && request.trusted) {
    if (!parent) throw new Error("Project has no parent");
    store.setMany([{ path: parent, decision: true }, { path: project, decision: null }]);
  } else {
    store.setMany([{ path: project, decision: request.trusted }]);
  }
}
const settings = SettingsManager.create(project, getAgentDir());
const errors = settings.drainErrors();
if (errors.length) throw new Error(errors.map(e => String(e.error ?? e)).join("; "));
const decision = store.get(project);
const resources = hasTrustRequiringProjectResources(project);
const policy = settings.getDefaultProjectTrust();
console.log(JSON.stringify({ projectPath: project, parentPath: parent,
  hasTrustRequiringResources: resources, decision, policy,
  needsDecision: resources && decision === null && policy === "ask" }));
