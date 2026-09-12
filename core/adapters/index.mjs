// Engine-adapter registry. An engine adapter owns one game family's
// integration end to end (CONTEXT.md 「引擎适配器」):
//
//   detect(facts)      — fingerprint contribution for the scanner, or null
//   plan(scan, opts)   — a launch-route decision, or null when the scan is
//                        not this family's
//   payload            — descriptor of the bridge payload evaluated inside
//                        the game's scripting VM ({ kind, dir, entry })
//   capabilities       — the family's trainer capability ids, as data
//   capabilitiesFor?   — optional per-scan refinement (version differences
//                        inside the family, e.g. RGSS1 has no self-switches)
//
// The scanner and the launch planner are orchestrators: they ask the
// registered adapters instead of hardcoding per-family knowledge. Families
// without an adapter yet (tauri, RM2K) keep their legacy detectors and
// planners until their own adapters land.

import { rgssAdapter } from "./rgss.mjs";
import { nwjsAdapter } from "./nwjs.mjs";

// Registration order is probe order: rgss answers only for its own family,
// while nwjs is the fall-through that always answers — so nwjs stays last.
const REGISTRY = Object.freeze([rgssAdapter, nwjsAdapter]);

export function adapters() {
  return REGISTRY;
}

export function adapterById(id) {
  return REGISTRY.find((adapter) => adapter.id === id) || null;
}

// First adapter to answer wins. The nwjs adapter is the scanner's
// fall-through (it always answers), so adapter order only starts to matter
// when more families register.
export function detectWithAdapters(facts) {
  for (const adapter of REGISTRY) {
    if (typeof adapter.detect !== "function") continue;
    const contribution = adapter.detect(facts);
    if (contribution) return contribution;
  }
  return null;
}

// The bridge payload for a scan, resolved through the adapters' plans (plan
// is pure, so asking costs nothing). Null when no adapter claims the scan —
// callers keep their historical default in that case.
export function payloadForScan(scan) {
  for (const adapter of REGISTRY) {
    if (typeof adapter.plan !== "function" || !adapter.payload) continue;
    if (adapter.plan(scan, { requested: "auto" })) return adapter.payload;
  }
  return null;
}

// The capability set for a scan: adapters with version-sensitive families
// refine their static `capabilities` via capabilitiesFor(scan). Empty when no
// adapter claims the scan.
export function capabilitiesForScan(scan) {
  for (const adapter of REGISTRY) {
    if (typeof adapter.plan !== "function") continue;
    if (!adapter.plan(scan, { requested: "auto" })) continue;
    if (typeof adapter.capabilitiesFor === "function") {
      return adapter.capabilitiesFor(scan);
    }
    return adapter.capabilities || [];
  }
  return [];
}
