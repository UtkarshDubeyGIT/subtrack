#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runHostedProofHarness } from "./command.mjs";
import {
  discoverSupabasePublicKeys,
  formatRedactedFailure,
  persistRedactedResult,
  runHostedDataPlaneProof,
} from "./core.mjs";
import { startLoopbackTokenReceiver } from "./loopback.mjs";

const PROJECT_REF = "qjsyhvclllikkopjfqtc";
const CLERK_DOMAIN = "steady-ladybug-22.clerk.accounts.dev";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const supabaseBinary = resolve(root, "node_modules/.bin/supabase");
const evidenceDirectory = resolve(root, ".proof");
const evidencePath = resolve(
  evidenceDirectory,
  "hosted-clerk-proof-result.json",
);

function runSupabaseCli(args) {
  return new Promise((resolveOutput, rejectOutput) => {
    execFile(
      supabaseBinary,
      args,
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          CLERK_FRONTEND_API_DOMAIN: CLERK_DOMAIN,
        },
        maxBuffer: 1_000_000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) rejectOutput(new Error("hosted_proof_failed"));
        else resolveOutput(stdout);
      },
    );
  });
}

function openSystemBrowser(url) {
  const command =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  return new Promise((resolveOpen, rejectOpen) => {
    const child = spawn(command[0], command[1], {
      detached: false,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => rejectOpen(new Error("hosted_proof_failed")));
    child.once("exit", (code) => {
      if (code === 0) resolveOpen();
      else rejectOpen(new Error("hosted_proof_failed"));
    });
  });
}

async function main() {
  if (process.argv.length !== 2) throw new Error("hosted_proof_failed");
  if (PROJECT_REF !== "qjsyhvclllikkopjfqtc") {
    throw new Error("hosted_proof_failed");
  }
  await runHostedProofHarness({
    discoverKeys: () => discoverSupabasePublicKeys({ runCli: runSupabaseCli }),
    now: () => new Date(),
    openBrowser: openSystemBrowser,
    persist: async (result) => {
      await mkdir(evidenceDirectory, { mode: 0o700, recursive: true });
      await persistRedactedResult(result, {
        evidencePath,
        randomBytes,
        renameFile: rename,
        writeFile,
      });
    },
    print: (result) => process.stdout.write(result),
    prove: runHostedDataPlaneProof,
    randomBytes,
    startReceiver: startLoopbackTokenReceiver,
  });
}

main().catch((error) => {
  process.stderr.write(formatRedactedFailure(error));
  process.exitCode = 1;
});
