import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnv } from "vite";

export const root = resolve(import.meta.dirname, "../..");
export const releaseConfigPath = resolve(
  root,
  "apps/desktop/src-tauri/tauri.release.conf.json",
);

export function releaseEnvironment() {
  // Match Vite's production precedence, including .env.production.local.
  // Only read public values. Never serialize the server-side environment.
  return loadEnv("production", root, "VITE_");
}

function httpsUrl(value, name, allowPath) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an HTTPS URL.`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(url.hostname) ||
    /(?:replace[-_]?me|example|localhost|\.test$|\.invalid$|\.local$)/i.test(
      url.hostname,
    ) ||
    (!allowPath && url.pathname !== "/") ||
    (allowPath && !/^\/(?:[a-zA-Z0-9_-]+\/?)*$/.test(url.pathname))
  )
    throw new Error(
      `${name} must use an exact public HTTPS host and a safe fixed path, without placeholders or URL credentials.`,
    );
  return url;
}

export function createReleaseConfig(environment, base, capability) {
  const data = httpsUrl(
    environment.VITE_SUPABASE_URL,
    "VITE_SUPABASE_URL",
    false,
  );
  const broker = httpsUrl(
    environment.VITE_AUTH_BROKER_URL,
    "VITE_AUTH_BROKER_URL",
    true,
  );
  const key = environment.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";
  if (
    !/^sb_publishable_[A-Za-z0-9_-]{20,}$/.test(key) ||
    /replace[-_]?me|placeholder/i.test(key)
  ) {
    throw new Error(
      "VITE_SUPABASE_PUBLISHABLE_KEY must be a publishable key, never a secret or service-role key.",
    );
  }
  if (!/^\d+\.\d+\.\d+$/.test(base.version) || base.version === "0.0.0") {
    throw new Error("Set a nonzero desktop release version before packaging.");
  }
  const origins = [...new Set([data.origin, broker.origin])];
  const csp = base.app.security.csp.replace(
    /connect-src[^;]*/,
    `connect-src 'self' ipc: http://ipc.localhost ${origins.join(" ")}`,
  );
  const authorizeUrl = `${broker.origin}${broker.pathname.replace(/\/$/, "")}/v1/desktop/authorize?*`;
  const configuredCapability = structuredClone(capability);
  delete configuredCapability.$schema;
  configuredCapability.identifier = "release-main-window";
  const opener = configuredCapability.permissions.find(
    (permission) =>
      typeof permission === "object" &&
      permission.identifier === "opener:allow-open-url",
  );
  if (!opener) throw new Error("Missing restricted browser opener capability.");
  opener.allow = [{ url: authorizeUrl }];
  return { app: { security: { csp, capabilities: [configuredCapability] } } };
}

export function readReleaseInputs() {
  return {
    base: JSON.parse(
      readFileSync(
        resolve(root, "apps/desktop/src-tauri/tauri.conf.json"),
        "utf8",
      ),
    ),
    capability: JSON.parse(
      readFileSync(
        resolve(root, "apps/desktop/src-tauri/capabilities/main.json"),
        "utf8",
      ),
    ),
  };
}
