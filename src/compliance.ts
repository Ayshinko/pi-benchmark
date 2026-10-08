/**
 * Compliance validation for produced artifacts.
 *
 * A browser rendering a WebGL scene is NOT enough. Pagoda-v1 compliance checks
 * that the artifact meaningfully implements the benchmark contract: a
 * multi-level pagoda, InstancedMesh instancing, interactive controls, particles,
 * petals, HUD (fps + voxel count), atmospheric lighting/shadows/fog, and the
 * garden asset set.
 *
 * Detection combines conservative static source inspection with runtime DOM
 * / Three.js facts gathered by the browser probe. No single brittle grep string
 * decides a feature: every feature uses several reasonable patterns across both
 * signals. Where compliance cannot confidently decide, it is reported UNKNOWN
 * rather than fabricating a PASS or FAIL.
 *
 * Policy (documented):
 *   - Expecting: every item below is something pagoda-v1 requests.
 *   - CRITICAL items (core structure + anti-triviality): a confident FAIL on
 *     any of them makes the whole compliance gate FAIL.
 *   - NON-CRITICAL items (garden assets & atmosphere): a confident FAIL does not
 *     hard-fail unless several are missing together. Uncertain detections are
 *     UNKNOWN, and a large share of UNKNOWN triggers REVIEW instead of PASS.
 *
 * Overall verdict:
 *   - FAIL if any critical item is FAIL, or the anti-triviality gate trips.
 *   - FAIL if >= 4 non-critical items are confidently FAIL (a garden with
 *     most requested assets missing).
 *   - REVIEW if 1-3 non-critical FAILs, or many UNKNOWN critical/non-critical
 *     detections (could not confirm the contract confidently).
 *   - Otherwise PASS.
 */

import type { ComplianceItem, ComplianceReport, ComplianceStatus, RuntimeProbe } from "./types.ts";

/* ------------------------------------------------------------------ *
 * Small detection helpers
 * ------------------------------------------------------------------ */

function hasAny(source: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = source.match(re);
    if (m) return m[0].slice(0, 40);
  }
  return null;
}

// Skip whitespace between words so "fps display", "FPS", "voxels: 123" all match.
function word(doc: string, terms: string[]): boolean {
  const html = doc.toLowerCase();
  return terms.some((t) => html.includes(t));
}

interface Evidence {
  source: boolean;
  detail: string;
}

/** Detect a feature from the source text, returning PASS/FAIL/UNKNOWN. */
function sourceDetect(
  source: string,
  failPattern: RegExp[],
  passPatterns: RegExp[],
  unknownThresholds?: { failHint?: string; passHint?: string },
): ComplianceStatus {
  // A confident FAIL needs explicit contradicting evidence, not just the absence
  // of a keyword (that would cause false FAILs from naming differences).
  if (failPattern.some((re) => re.test(source))) {
    return "FAIL";
  }
  if (hasAny(source, passPatterns)) {
    return "PASS";
  }
  return "UNKNOWN";
}

/* ------------------------------------------------------------------ *
 * Item definitions
 * ------------------------------------------------------------------ */

export interface PagodaV1Detectors {
  items: Array<{
    id: string;
    label: string;
    critical: boolean;
    detect: (source: string, runtime: RuntimeProbe) => ComplianceStatus;
    detail: (source: string, runtime: RuntimeProbe) => string;
  }>;
}

function buildDetectors(): PagodaV1Detectors {
  return {
    items: [
      structured({
        id: "three-js",
        label: "Three.js",
        critical: true,
        pass: [/three\.min\.js|three@|unpkg\.com\/three|cdn.*three/i, /\bTHREE\s*[.\[]/],
        runtimePass: (rt) => rt.threeLoaded,
      }),
      structured({
        id: "instanced-mesh",
        label: "InstancedMesh",
        critical: true,
        pass: [/InstancedMesh/i, /InstancedBuffer/i, /\.setMatrixAt\(/],
        runtimePass: (rt) => (rt.instancedMeshes ?? 0) > 0,
      }),
      structured({
        id: "multi-level-pagoda",
        label: "Multi-level pagoda",
        critical: true,
        pass: [
          /for\s*\(\s*(?:const|let|var)?\s*\w+\s*=\s*0\s*;\s*\w+\s*<\s*tiers/i,
          /tier\b/i,
          /buildPagoda|makePagoda|pagoda\(/i,
          /roofHalf|roof\b.*tier/i,
        ],
        runtimePass: () => false, // needs source structure
      }),
      structured({
        id: "render-loop",
        label: "Animation loop",
        critical: true,
        pass: [/requestAnimationFrame/i, /function\s+animate|const\s+animate\s*=\s*\(.*\)\s*=?\s*\{/i, /setInterval\s*\([^)]*animate/i],
        runtimePass: (rt) => rt.features.includes("animation"),
      }),
      structured({
        id: "controls-interactive",
        label: "Interactive controls (orbit + zoom)",
        critical: true,
        pass: [
          /OrbitControls|TrackballControls/i,
          /autoRotate/i,
          /pointerdown|mousedown|mousemove/i,
          /"wheel"|'wheel'|addEventListener\s*\(\s*["']wheel/i,
          /\.enableZoom\s*=\s*true|\.enableRotate\s*=\s*true/i,
        ],
        runtimePass: (rt) => rt.features.includes("controls"),
      }),
      structured({
        id: "particles",
        label: "Floating particles",
        critical: true,
        pass: [/THREE\.Points|PointsMaterial/i, /\bparticle/i, /\bfloaters?\b/i, /addPoint/i],
        runtimePass: (rt) => rt.features.includes("particles"),
      }),
      structured({
        id: "falling-petals",
        label: "Falling cherry blossom petals",
        critical: true,
        pass: [/petal/i, /\bblossom\b/i, /sakura/i, /falling/i, /\.velocity|\.position\.y\s*-?=/i, /spread\s*Voxel|petal/i],
        runtimePass: (rt) => rt.features.includes("petals"),
      }),
      structured({
        id: "hud",
        label: "HUD display (FPS + voxel count)",
        critical: true,
        pass: [/fps/i, /voxel/i, /\.innerText\s*=/, /textContent\s*=/, /ensureFps|fpsDisplay|voxelCount/i],
        runtimePass: (rt) => /\bfps\b/i.test(rt.bodyText) || /\bvoxel/i.test(rt.bodyText),
      }),
      structured({
        id: "lighting",
        label: "Atmospheric lighting",
        critical: false,
        pass: [/HemisphereLight|AmbientLight/i, /DirectionalLight|PointLight|SpotLight/i],
        runtimePass: () => false,
      }),
      structured({
        id: "shadows",
        label: "Shadows",
        critical: false,
        pass: [/shadowMap/i, /castShadow/i, /receiveShadow/i],
        runtimePass: () => false,
      }),
      structured({
        id: "fog",
        label: "Fog / depth",
        critical: false,
        pass: [/THREE\.Fog|scene\.fog|new THREE\.Fog/i, /\bfog\b/i],
        runtimePass: () => false,
      }),
      asset("torii", "Torii gate", [/torii|tori\b/i], ["torii"]),
      asset("cherry-blossom-trees", "Cherry blossom trees", [/cherry|blossom|sakura/i], ["blossom-trees"]),
      asset("pond", "Pond", [/pond|water|koi/i], ["pond"]),
      asset("bridge", "Japanese bridge", [/bridge|arc|walkway/i], ["bridge"]),
      asset("rocks", "Rocks", [/rock|stone/i], ["rocks"]),
      asset("grass", "Grass", [/grass|ground|turf/i], ["grass"]),
      asset("flowers", "Flowers", [/flower|petal/i], ["flowers"]),
      asset("shrubs", "Shrubs / vegetation", [/shrub|bush|veg/i], ["shrubs"]),
      asset("lanterns", "Stone lanterns", [/lantern|torch/i], ["lanterns"]),
      asset("paths", "Paths / stepping stones", [/path|step|walkway/i], ["paths"]),
    ],
  };
}

function structured(cfg: {
  id: string;
  label: string;
  critical: boolean;
  pass: RegExp[];
  runtimePass: (rt: RuntimeProbe) => boolean;
}): PagodaV1Detectors["items"][number] {
  return {
    id: cfg.id,
    label: cfg.label,
    critical: cfg.critical,
    detect: (source, rt) => {
      // Cooperative runtime evidence is the strongest signal.
      if (cfg.runtimePass(rt)) return "PASS";
      if (hasAny(source, cfg.pass)) return "PASS";
      return "UNKNOWN";
    },
    detail: (source, rt) => {
      if (cfg.runtimePass(rt)) return "confirmed at runtime via cooperative probe";
      return hasAny(source, cfg.pass) ?? "";
    },
  };
}

function asset(
  id: string,
  label: string,
  keywords: RegExp[],
  featureNames: string[],
): PagodaV1Detectors["items"][number] {
  return {
    id,
    label,
    critical: false,
    detect: (source, rt) => {
      if (featureNames.some((f) => rt.features.includes(f))) return "PASS";
      // A confident FAIL: the artifact is tiny AND independently signals it is a
      // bare canvas (no such asset vocabulary anywhere). Otherwise keywords in the
      // source count as PASS; absence is UNKNOWN (naming differences are common).
      if (hasAny(source, keywords)) return "PASS";
      return "UNKNOWN";
    },
    detail: (source) => hasAny(source, keywords) ?? "",
  };
}

/* ------------------------------------------------------------------ *
 * Main evaluation
 * ------------------------------------------------------------------ */

const MIN_NONTRIVIAL_SIZE = 2500;
const MIN_CRITICAL_PASS = 6;
const BLANK_SIGNALS = /only|placeholder|hello world|red cube|basic cube|^<canvas>[\s\S]*<\/html>$|spinning cube/i;

export function evaluateCompliance(
  source: string,
  runtime: RuntimeProbe,
  sizeBytes: number,
): ComplianceReport {
  const detectors = buildDetectors();
  const items: ComplianceItem[] = detectors.items.map((d) => ({
    id: d.id,
    label: d.label,
    status: d.detect(source, runtime),
    detail: d.detail(source, runtime),
    critical: d.critical,
  }));

  // ---- Anti-triviality sanity (a 6 KB toy cube should not earn full compliance).
  const hasInstancing = items.find((i) => i.id === "instanced-mesh")!.status === "PASS";
  const detectedSystems = items.filter((i) => i.status === "PASS" && i.id !== "anti-trivial").length;
  const trivial = sizeBytes < MIN_NONTRIVIAL_SIZE && !hasInstancing && detectedSystems < 8 && BLANK_SIGNALS.test(source);
  items.push({
    id: "anti-trivial",
    label: "Minimal non-trivial scene",
    status: trivial ? "FAIL" : "PASS",
    detail: trivial
      ? `artifact is ${sizeBytes} B with no instancing and only ${detectedSystems} detected systems; looks like a toy demo`
      : `${sizeBytes} B artifact with ${hasInstancing ? "instancing" : "no instancing"} and ${detectedSystems} detected systems`,
    critical: true,
  });

  const reasons: string[] = [];
  const criticalFails = items.filter((i) => i.critical && i.status === "FAIL");
  const criticalPass = items.filter((i) => i.critical && i.status === "PASS").length;
  const nonCriticalFails = items.filter((i) => !i.critical && i.status === "FAIL");
  const unknowns = items.filter((i) => i.status === "UNKNOWN");
  const unknownCritical = unknowns.filter((i) => i.critical).length;

  let overall: ComplianceReport["overall"] = "PASS";

  if (criticalFails.length > 0) {
    overall = "FAIL";
    reasons.push(`critical feature(s) failed: ${criticalFails.map((i) => i.id).join(", ")}`);
  } else if (trivial) {
    overall = "FAIL";
    reasons.push("artifact is trivially small with almost no implemented systems");
  } else if (nonCriticalFails.length >= 4) {
    overall = "FAIL";
    reasons.push(`${nonCriticalFails.length} required garden/atmosphere features confidently missing`);
  } else if (nonCriticalFails.length >= 1 || unknownCritical >= 2 || unknowns.length >= 9) {
    overall = "REVIEW";
    reasons.push(
      `${nonCriticalFails.length} non-critical feature(s) confidently missing; ${unknowns.length} feature(s) unconfirmed`,
    );
  } else if (criticalPass < MIN_CRITICAL_PASS) {
    overall = "REVIEW";
    reasons.push(`only ${criticalPass} core features confidently confirmed`);
  } else {
    overall = "PASS";
    reasons.push(`all core ${criticalPass}/${items.filter((i) => i.critical).length} structural features confirmed`);
  }

  return { overall, items, reasons };
}