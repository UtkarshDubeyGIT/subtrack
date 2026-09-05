import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createReleaseConfig,
  readReleaseInputs,
  releaseEnvironment,
  root,
} from "./config.mjs";

const failures = [];
try {
  const { base, capability } = readReleaseInputs();
  createReleaseConfig(releaseEnvironment(), base, capability);
} catch (error) {
  failures.push(error.message);
}

const gate = readFileSync(
  resolve(root, "docs/security/auth-risk-gate.md"),
  "utf8",
);
if (!/\*\*Status: PASS\b/.test(gate))
  failures.push(
    "Packaged macOS and Windows authentication evidence has not passed docs/security/auth-risk-gate.md.",
  );
const evidence = JSON.parse(
  readFileSync(resolve(root, "docs/release-evidence.json"), "utf8"),
);
const manifest = JSON.parse(
  readFileSync(resolve(root, "apps/desktop/package.json"), "utf8"),
);
if (evidence.version !== manifest.version)
  failures.push("Release evidence does not match the desktop version.");
for (const name of [
  "macosArm64",
  "macosIntel",
  "windowsX64",
  "hostedAuth",
  "reminderScheduler",
  "distributionTerms",
]) {
  if (evidence[name]?.status !== "passed" || !evidence[name]?.evidence)
    failures.push(`Missing reviewed release evidence: ${name}.`);
}
if (failures.length) {
  console.error(
    `Public release is blocked:\n${failures.map((message) => `- ${message}`).join("\n")}`,
  );
  process.exitCode = 1;
} else
  console.log(
    "Release configuration and recorded review gates pass. Verify installer checksums and signatures before publishing.",
  );
