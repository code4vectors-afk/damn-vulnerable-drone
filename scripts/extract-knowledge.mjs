#!/usr/bin/env node
/**
 * Builds:
 *  1. data/scenarios/catalog.json  (42 structured DVD scenarios + Part 1 Field Manual tags)
 *  2. data/knowledge/chunks.json   (Local BM25 RAG index from all 42 YAMLs + Part 1 PDF + Readme)
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const yaml = require("../apps/orchestrator/node_modules/js-yaml");

const ROOT = process.cwd();
const ATTACKS_DIR = path.join(ROOT, "upstream/Damn-Vulnerable-Drone/simulator/mgmt/templates/pages/attacks");
const PDF_PATH = path.join(ROOT, "DVD-Part1-Field-Manual.pdf");
const README_PATH = path.join(ROOT, "upstream/Damn-Vulnerable-Drone/Readme.md");
const CATALOG_OUT = path.join(ROOT, "data/scenarios/catalog.json");
const KNOWLEDGE_OUT = path.join(ROOT, "data/knowledge/chunks.json");

const WIFI_SLUGS = new Set([
  "wifi-analysis-cracking",
  "wireless-deauthentication",
  "wifi-client-data-leak",
]);

const PART1_MAP = {
  "drone-discovery": { track: "PART 1 // RECON", order: 1 },
  "companion-computer-discovery": { track: "PART 1 // RECON", order: 2 },
  "wifi-analysis-cracking": { track: "PART 1 // TRACK A (WI-FI)", order: 3 },
  "camera-feed-ros-topic-flooding": { track: "PART 1 // TRACK B (CAMERA DoS)", order: 4 },
  "companion-computer-web-ui-login-brute-force": { track: "PART 1 // COMPANION", order: 5 },
  "mavlink-command-injection": { track: "PART 1 // MAVLINK", order: 6 },
};

const DEFENSIVE_BY_PHASE = {
  "RECON": "Segment flight-control, companion, and telemetry networks; disable unnecessary service banners and enforce mutual authentication.",
  "LINK-LAYER WI-FI": "Never deploy WEP or weak PSKs on drone APs. Enforce WPA3-SAE or certificate-backed EAP-TLS, 802.11w protected management frames (PMF), and link-loss failsafes.",
  "COMPANION EXPLOIT": "Disable default credentials, enforce strong password policies + MFA/rate-limiting on the companion web UI, and restrict SSH to key-only auth.",
  "CAMERA / ROS DoS": "Enable SROS2 (DDS-Security) with authenticated enclaves, restrict CycloneDDS peer ACLs, and isolate RTSP/camera pipelines from flight-critical buses.",
  "MAVLINK INJECTION": "Enable MAVLink v2 message signing with per-vehicle secret keys, restrict TCP/UDP router endpoints, and monitor for unauthorized source system IDs.",
  "GPS / GEOFENCE": "Use multi-constellation GNSS with EKF innovation checks, sensor fusion (IMU/baro/optical flow), and signed geofence/parameter locking.",
  "EXFILTRATION": "Encrypt telemetry/video links in transit, disable unauthenticated RTSP/FTP endpoints, and sign/protect onboard flight logs.",
  "TAMPERING": "Authenticate GCS-bound telemetry with MAVLink v2 signing and validate telemetry integrity against independent onboard state estimators.",
  "FIRMWARE": "Enable secure boot, signed firmware verification, JTAG/SWD readout protection, and hardware-backed key storage.",
};

function classifyPhase(dirName, slug) {
  if (WIFI_SLUGS.has(slug)) return "LINK-LAYER WI-FI";
  if (slug.includes("ros2") || slug.includes("camera") || slug.includes("gimbal")) return "CAMERA / ROS DoS";
  if (slug.includes("companion-computer-")) return "COMPANION EXPLOIT";
  if (slug.includes("gps") || slug.includes("geofenc") || slug.includes("satellite")) return "GPS / GEOFENCE";
  if (dirName === "recon") return "RECON";
  if (dirName === "injection") return "MAVLINK INJECTION";
  if (dirName === "dos") return "MAVLINK INJECTION";
  if (dirName === "exfiltration") return "EXFILTRATION";
  if (dirName === "tampering") return "TAMPERING";
  if (dirName === "firmware") return "FIRMWARE";
  return "RECON";
}

function difficultyFor(dirName, slug) {
  if (dirName === "recon" || slug.includes("brute-force")) return "INTRO";
  if (dirName === "firmware" || slug.includes("ros2") || slug.includes("hijacking")) return "ADVANCED";
  return "OPERATOR";
}

function extractCommands(text) {
  if (!text) return [];
  const cmds = [];
  // Matches fenced blocks ```...``` (DVD YAMLs often put command right after ``` without a newline)
  const re = /```(?:[a-zA-Z0-9_-]+\n)?([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const block = m[1].trim();
    if (block) cmds.push(block);
  }
  return cmds;
}

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9_/.:-]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

function walkYaml(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkYaml(full));
    else if (entry.name.endsWith(".yaml")) out.push(full);
  }
  return out.sort();
}

const scenarios = [];
const chunks = [];

for (const file of walkYaml(ATTACKS_DIR)) {
  const rel = path.relative(ATTACKS_DIR, file);
  const dirName = path.dirname(rel);
  const slug = path.basename(file, ".yaml");
  const doc = yaml.load(fs.readFileSync(file, "utf8"));
  if (!doc || typeof doc !== "object") continue;

  const phase = classifyPhase(dirName, slug);
  const runtime = WIFI_SLUGS.has(slug) ? "wifi-linux" : "lite";
  const part1 = PART1_MAP[slug] || null;
  const difficulty = difficultyFor(dirName, slug);

  let overview = doc.description || "";
  const steps = [];
  const resources = [];

  for (const sec of doc.sections || []) {
    if (sec.title === "Description" && typeof sec.content === "string") {
      overview = sec.content.trim();
    } else if (sec.title === "Resources" && Array.isArray(sec.content)) {
      for (const r of sec.content) {
        if (r?.text) resources.push({ text: r.text, link: r.link || "" });
      }
    } else if (Array.isArray(sec.steps)) {
      for (const st of sec.steps) {
        const desc = (st.description || "").trim();
        steps.push({
          title: st.title || "Step",
          description: desc,
          commands: extractCommands(desc),
        });
      }
    }
  }

  const scenario = {
    id: `${dirName}/${slug}`,
    slug,
    category: dirName,
    phase,
    title: doc.title || slug,
    description: (doc.description || "").trim(),
    overview,
    runtime,
    difficulty,
    part1Track: part1?.track || null,
    part1Order: part1?.order || 999,
    steps,
    resources,
    defensiveTakeaway: DEFENSIVE_BY_PHASE[phase] || DEFENSIVE_BY_PHASE.RECON,
  };
  scenarios.push(scenario);

  // Add overview + steps to knowledge chunks
  const fullText = [
    `Scenario: ${scenario.title} (${scenario.phase}, runtime: ${scenario.runtime})`,
    scenario.description,
    scenario.overview,
    ...steps.map((s) => `${s.title}\n${s.description}`),
    `Defense: ${scenario.defensiveTakeaway}`,
  ].join("\n\n");

  chunks.push({
    id: `scenario:${scenario.id}`,
    source: `DVD Scenario // ${scenario.title}`,
    category: scenario.phase,
    scenarioId: scenario.id,
    text: fullText.slice(0, 4000),
    tokens: tokenize(fullText.slice(0, 4000)),
  });
}

// Extract Part 1 Field Manual PDF
if (fs.existsSync(PDF_PATH)) {
  const pdfText = execFileSync("pdftotext", [PDF_PATH, "-"], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  const pages = pdfText.split("\f").map((p) => p.trim()).filter(Boolean);
  pages.forEach((pageText, idx) => {
    chunks.push({
      id: `manual:page-${idx + 1}`,
      source: `DVD-Part1-Field-Manual.pdf (Page ${idx + 1})`,
      category: "FIELD MANUAL",
      scenarioId: null,
      text: pageText.slice(0, 3500),
      tokens: tokenize(pageText.slice(0, 3500)),
    });
  });
}

// Extract Readme.md sections
if (fs.existsSync(README_PATH)) {
  const readme = fs.readFileSync(README_PATH, "utf8");
  const sections = readme.split(/\n(?=##\s+)/).filter((s) => s.trim().length > 60);
  sections.forEach((sec, idx) => {
    const firstLine = sec.split("\n")[0].replace(/^#+\s*/, "").trim();
    chunks.push({
      id: `readme:sec-${idx + 1}`,
      source: `Damn-Vulnerable-Drone Readme // ${firstLine.slice(0, 60)}`,
      category: "ARCHITECTURE",
      scenarioId: null,
      text: sec.slice(0, 3000),
      tokens: tokenize(sec.slice(0, 3000)),
    });
  });
}

fs.mkdirSync(path.dirname(CATALOG_OUT), { recursive: true });
fs.mkdirSync(path.dirname(KNOWLEDGE_OUT), { recursive: true });
fs.writeFileSync(CATALOG_OUT, JSON.stringify({ generatedAt: new Date().toISOString(), count: scenarios.length, scenarios }, null, 2));
fs.writeFileSync(KNOWLEDGE_OUT, JSON.stringify({ generatedAt: new Date().toISOString(), count: chunks.length, chunks }));

console.log(`Generated ${scenarios.length} scenarios -> ${path.relative(ROOT, CATALOG_OUT)}`);
console.log(`Generated ${chunks.length} knowledge chunks -> ${path.relative(ROOT, KNOWLEDGE_OUT)}`);
