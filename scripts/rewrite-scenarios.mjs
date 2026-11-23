#!/usr/bin/env node
/**
 * Rewrites all 42 upstream DVD attack scenario YAML files for the multi-slot
 * Web Range AttackBox:
 *  - Replaces hardcoded 10.13.0.x / localhost:3000 with slot env vars ($DRONE_*_IP)
 *  - Removes `sudo ` from commands (AttackBox has NET_RAW/NET_ADMIN caps, no sudo)
 *  - Points wordlists/scripts to pre-baked /opt/dvd-tools/
 *  - Updates ROS 2 scenarios to use the pre-configured ROS 2 Humble + CycloneDDS shell
 *  - Annotates Wi-Fi-only scenarios with Linux mac80211_hwsim runtime requirement
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const yaml = require("../apps/orchestrator/node_modules/js-yaml");

const ATTACKS_DIR = path.resolve(
  "upstream/Damn-Vulnerable-Drone/simulator/mgmt/templates/pages/attacks"
);

const WIFI_ONLY = new Set([
  "wifi-analysis-cracking.yaml",
  "wireless-deauthentication.yaml",
  "wifi-client-data-leak.yaml",
]);

function walkYaml(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkYaml(full));
    else if (entry.name.endsWith(".yaml")) out.push(full);
  }
  return out.sort();
}

function rewriteText(text, filename) {
  if (typeof text !== "string") return text;
  let s = text;

  // Replace hardcoded subnet & static IPs with slot-aware env vars
  s = s.replace(/10\.13\.0\.0\/24/g, "$DRONE_SUBNET");
  s = s.replace(/10\.13\.0\.2\b/g, "$DRONE_FC_IP");
  s = s.replace(/10\.13\.0\.3\b/g, "$DRONE_COMPANION_IP");
  s = s.replace(/10\.13\.0\.4\b/g, "$DRONE_GCS_IP");
  s = s.replace(/10\.13\.0\.5\b/g, "$DRONE_SIM_IP");
  s = s.replace(/10\.13\.0\.6\b/g, "$DRONE_GCS_IP");
  s = s.replace(/10\.13\.0\.1,/g, ""); // simplify nmap --exclude when using env vars
  s = s.replace(/http:\/\/localhost:3000/g, "http://$DRONE_COMPANION_IP:3000");

  // Hydra brute force target fix: add $DRONE_COMPANION_IP target and bundled wordlist
  s = s.replace(
    /hydra -l admin -P passwords\.txt http-post-form "\/login:username=\^USER\^&password=\^PASS\^:Invalid" -s 3000/g,
    'hydra -l admin -P /opt/dvd-tools/passwords.txt $DRONE_COMPANION_IP http-post-form "/login:username=^USER^&password=^PASS^:Invalid" -s 3000'
  );
  s = s.replace(/\bpasswords\.txt\b/g, "/opt/dvd-tools/passwords.txt");
  s = s.replace(/\bros2_rogue_publisher\.py\b/g, "/opt/dvd-tools/ros2_rogue_publisher.py");

  // Remove sudo prefix in command lines (AttackBox runs as lab with NET_RAW/NET_ADMIN caps)
  s = s.replace(/(^|[`(\s])sudo\s+/gm, "$1");

  // Replace apt-get install one-liners with pre-installed note
  s = s.replace(
    /apt-get (?:update && )?apt-get install -y[^\n`]*/g,
    "# Already pre-installed in the Web Range AttackBox (zero-egress lab)"
  );
  s = s.replace(
    /apt-get install [^\n`]*/g,
    "# Already pre-installed in the Web Range AttackBox (zero-egress lab)"
  );

  // Replace nested docker run for ROS 2 Humble with native AttackBox verification
  s = s.replace(
    /docker pull osrf\/ros:humble-desktop[\s\S]*?osrf\/ros:humble-desktop bash/g,
    "# ROS 2 Humble + CycloneDDS are already pre-configured in your AttackBox terminal!\n# Verify your active slot peers:\ncat /tmp/cyclonedds.xml\necho \"ROS_DOMAIN_ID=$ROS_DOMAIN_ID\""
  );

  // Clean up duplicate CycloneDDS setup blocks inside ROS 2 scenarios
  if (s.includes("CYCLONEDDS_URI=file:///etc/cyclonedds.xml")) {
    s = s.replace(/CYCLONEDDS_URI=file:\/\/\/etc\/cyclonedds\.xml/g, "CYCLONEDDS_URI=file:///tmp/cyclonedds.xml");
  }

  return s;
}

const files = walkYaml(ATTACKS_DIR);
let updated = 0;

for (const file of files) {
  const raw = fs.readFileSync(file, "utf8");
  const doc = yaml.load(raw);
  if (!doc || typeof doc !== "object") continue;

  const base = path.basename(file);
  doc.description = rewriteText(doc.description, base);

  if (Array.isArray(doc.sections)) {
    for (const sec of doc.sections) {
      if (typeof sec.content === "string") {
        sec.content = rewriteText(sec.content, base);
        if (sec.title === "Description" && WIFI_ONLY.has(base) && !sec.content.includes("mac80211_hwsim")) {
          sec.content +=
            "\n\n> **Web Range Runtime Note:** This Wi-Fi link-layer scenario requires virtual wireless radios (`mac80211_hwsim` / `wlan0mon`), available on the **Linux VM Runtime**. In macOS Lite mode, your AttackBox is already bridged onto `$DRONE_SUBNET` so you can skip directly to network, MAVLink, companion, and ROS 2 scenarios.";
        }
      }
      if (Array.isArray(sec.steps)) {
        for (const step of sec.steps) {
          if (typeof step.title === "string") step.title = rewriteText(step.title, base);
          if (typeof step.description === "string") step.description = rewriteText(step.description, base);
        }
      }
    }
  }

  const out = yaml.dump(doc, { lineWidth: 120, noRefs: true });
  // Validate round-trip parse
  yaml.load(out);
  fs.writeFileSync(file, out, "utf8");
  updated++;
}

console.log(`Rewrote and validated ${updated} scenario YAML files.`);
