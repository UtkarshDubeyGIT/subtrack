import { rmSync, writeFileSync } from "node:fs";
import {
  createReleaseConfig,
  readReleaseInputs,
  releaseConfigPath,
  releaseEnvironment,
} from "./config.mjs";

// A failed preparation must not leave a usable stale configuration behind.
rmSync(releaseConfigPath, { force: true });
try {
  const { base, capability } = readReleaseInputs();
  const config = createReleaseConfig(releaseEnvironment(), base, capability);
  writeFileSync(releaseConfigPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(
    "Installer configuration prepared. Public endpoints and browser permissions are aligned; no credentials were printed.",
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
