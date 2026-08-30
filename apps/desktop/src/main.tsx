import { invoke } from "@tauri-apps/api/core";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import { createRoot } from "react-dom/client";
import { AuthApp } from "./App";
import { createDesktopPreferencesRuntime } from "./account/preferences-composition";
import { createDesktopAuthRuntime } from "./auth/desktop-auth";
import { deliverAuthCallbacks } from "./auth/deep-link-ingress";
import { createDesktopSubscriptionsRuntime } from "./subscriptions/subscriptions-composition";
import "./styles.css";

const runtime = createDesktopAuthRuntime(import.meta.env, { invoke, openUrl });
const preferencesRuntime = createDesktopPreferencesRuntime(import.meta.env, {
  accessToken: () => runtime.accessTokenLease(),
});
const subscriptionsRuntime = createDesktopSubscriptionsRuntime(
  import.meta.env,
  {
    accessToken: () => runtime.accessTokenLease(),
  },
);
void configureDeepLinkIngress();

async function configureDeepLinkIngress() {
  try {
    await onOpenUrl((candidates) => {
      void deliverAuthCallbacks(runtime, candidates);
    });
    await deliverAuthCallbacks(runtime, await getCurrent());
  } catch {
    // The signed-out route remains safe when native deep-link setup is absent.
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("application_root_missing");
createRoot(root).render(
  <AuthApp
    runtime={runtime}
    preferencesRuntime={preferencesRuntime}
    subscriptionsRuntime={subscriptionsRuntime}
  />,
);
