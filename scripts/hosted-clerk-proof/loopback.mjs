import { createServer } from "node:http";

import { HostedProofError } from "./core.mjs";

const MAX_HANDOFF_BYTES = 16_384;
const MAX_DEVELOPMENT_HANDSHAKE_BYTES = 8_192;
const DEVELOPMENT_HANDSHAKE_PREFIX = "/?__clerk_db_jwt=";
const compactDevelopmentHandshakeTarget =
  /^\/\?__clerk_db_jwt=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const CLERK_DOMAIN = "steady-ladybug-22.clerk.accounts.dev";
const CLERK_JS_VERSION = "6.26.0";
const CLERK_UI_VERSION = "1.28.0";
const browserFailureCodes = new Set(["browser_ui", "token_handoff"]);

function fail(code = "token_handoff") {
  return new HostedProofError(code);
}

function initialPageTargetKind(target) {
  if (target === "/") return "bare";
  if (
    typeof target !== "string" ||
    target.length >
      DEVELOPMENT_HANDSHAKE_PREFIX.length + MAX_DEVELOPMENT_HANDSHAKE_BYTES
  ) {
    return "rejected";
  }
  return compactDevelopmentHandshakeTarget.test(target)
    ? "development_handshake"
    : "rejected";
}

function browserPage(state) {
  const publishableKey = `pk_test_${Buffer.from(`${CLERK_DOMAIN}$`).toString("base64")}`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Subtrack hosted identity proof</title>
  </head>
  <body>
    <main>
      <h1>Sign in to run the Subtrack development proof</h1>
      <p id="status">Complete sign-in in this window. It closes no accounts and stores no token.</p>
      <div id="sign-in"></div>
      <button id="cancel" type="button">Cancel proof</button>
    </main>
    <script defer crossorigin="anonymous" src="https://${CLERK_DOMAIN}/npm/@clerk/ui@${CLERK_UI_VERSION}/dist/ui.browser.js"></script>
    <script defer crossorigin="anonymous" data-clerk-publishable-key="${publishableKey}" src="https://${CLERK_DOMAIN}/npm/@clerk/clerk-js@${CLERK_JS_VERSION}/dist/clerk.browser.js"></script>
    <script nonce="${state}">
      window.addEventListener("load", async () => {
        const status = document.getElementById("status");
        let phase = "loading";
        let historyScrubbed = false;
        let historyScrubFailed = false;
        const scrubHistory = () => {
          if (historyScrubbed) return true;
          if (historyScrubFailed) return false;
          try {
            window.history.replaceState(null, "", "/");
            historyScrubbed = true;
            return true;
          } catch {
            historyScrubFailed = true;
            phase = "terminal";
            document.getElementById("cancel").disabled = true;
            status.textContent = "Proof stopped because the browser address could not be cleared. Close this tab and return to the terminal.";
            document.getElementById("sign-in").replaceChildren();
            return false;
          }
        };
        const reportFailure = async (code) => {
          if (!["loading", "ready", "acquiring", "delivering"].includes(phase)) return;
          phase = "terminal";
          document.getElementById("cancel").disabled = true;
          if (!scrubHistory()) return;
          try {
            await fetch("/failure", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ state: ${JSON.stringify(state)}, code }),
            });
          } finally {
            status.textContent = code === "browser_ui"
              ? "Clerk sign-in could not start. Return to the terminal."
              : "The session handoff failed. Return to the terminal.";
            document.getElementById("sign-in").replaceChildren();
          }
        };
        document.getElementById("cancel").addEventListener("click", async () => {
          if (!["loading", "ready", "acquiring"].includes(phase)) return;
          phase = "terminal";
          document.getElementById("cancel").disabled = true;
          if (!scrubHistory()) return;
          try {
            await fetch("/cancel", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ state: ${JSON.stringify(state)} }),
            });
          } finally {
            status.textContent = "Proof cancelled. Return to the terminal.";
            document.getElementById("sign-in").replaceChildren();
          }
        });
        const submit = async (session) => {
          if (phase !== "ready" || !session) return;
          phase = "acquiring";
          let token = "";
          try {
            token = await session.getToken({ skipCache: true });
            if (phase !== "acquiring") return;
            if (typeof token !== "string" || token.length === 0) throw new Error();
            phase = "delivering";
            document.getElementById("cancel").disabled = true;
            const response = await fetch("/token", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ state: ${JSON.stringify(state)}, token }),
            });
            if (!response.ok) throw new Error();
            if (phase !== "delivering") return;
            phase = "terminal";
            status.textContent = "Token received. Return to the terminal for the redacted result.";
            document.getElementById("sign-in").replaceChildren();
          } catch {
            await reportFailure("token_handoff");
          } finally {
            token = "";
          }
        };
        try {
          await Clerk.load({
            ui: { ClerkUI: window.__internal_ClerkUICtor },
            signInForceRedirectUrl: window.location.origin + "/",
            signUpForceRedirectUrl: window.location.origin + "/",
          });
          if (phase !== "loading") return;
          if (!scrubHistory()) return;
          phase = "ready";
          Clerk.addListener(({ session }) => { void submit(session); });
          if (Clerk.session) await submit(Clerk.session);
          else Clerk.mountSignIn(document.getElementById("sign-in"));
        } catch {
          if (phase === "terminal") return;
          await reportFailure("browser_ui");
        }
      });
    </script>
  </body>
</html>`;
}

export async function startLoopbackTokenReceiver({ state, timeoutMs }) {
  if (typeof state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(state)) {
    throw fail();
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw fail();

  let resolveToken;
  let rejectToken;
  let settled = false;
  let developmentHandshakeAccepted = false;
  const token = new Promise((resolve, reject) => {
    resolveToken = resolve;
    rejectToken = reject;
  });
  const server = createServer((request, response) => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      response.writeHead(503).end();
      return;
    }
    const origin = `http://127.0.0.1:${address.port}`;
    const expectedHost = `127.0.0.1:${address.port}`;
    const pageTargetKind = initialPageTargetKind(request.url);
    if (
      request.method === "GET" &&
      pageTargetKind !== "rejected" &&
      !(
        pageTargetKind === "development_handshake" &&
        developmentHandshakeAccepted
      ) &&
      request.headers.host === expectedHost &&
      !settled
    ) {
      if (pageTargetKind === "development_handshake") {
        developmentHandshakeAccepted = true;
      }
      const page = browserPage(state);
      response
        .writeHead(200, {
          "cache-control": "no-store, max-age=0",
          "content-security-policy": [
            "default-src 'none'",
            `script-src 'nonce-${state}' https://${CLERK_DOMAIN}`,
            `connect-src 'self' https://${CLERK_DOMAIN}`,
            `style-src 'unsafe-inline' https://${CLERK_DOMAIN}`,
            `img-src data: blob: https://${CLERK_DOMAIN} https://img.clerk.com`,
            `font-src data: https://${CLERK_DOMAIN}`,
            `frame-src https://${CLERK_DOMAIN} https://challenges.cloudflare.com`,
            `form-action 'self' https://${CLERK_DOMAIN}`,
            "base-uri 'none'",
            "frame-ancestors 'none'",
          ].join("; "),
          "content-type": "text/html; charset=utf-8",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
        })
        .end(page);
      return;
    }
    if (
      request.method !== "POST" ||
      !["/token", "/cancel", "/failure"].includes(request.url ?? "") ||
      request.headers.host !== expectedHost ||
      request.headers.origin !== origin ||
      request.headers["content-type"] !== "application/json" ||
      settled
    ) {
      response.writeHead(403).end();
      return;
    }

    const declaredLength = request.headers["content-length"];
    if (
      declaredLength !== undefined &&
      (!/^\d+$/.test(declaredLength) ||
        Number(declaredLength) > MAX_HANDOFF_BYTES)
    ) {
      request.resume();
      response.writeHead(413).end();
      return;
    }

    let body = "";
    let receivedBytes = 0;
    let tooLarge = false;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      receivedBytes += Buffer.byteLength(chunk);
      if (receivedBytes > MAX_HANDOFF_BYTES) {
        tooLarge = true;
        body = "";
      } else if (!tooLarge) {
        body += chunk;
      }
    });
    request.on("end", () => {
      if (tooLarge) {
        response.writeHead(413).end();
        return;
      }
      try {
        const parsed = JSON.parse(body);
        if (request.url === "/failure") {
          if (
            parsed === null ||
            typeof parsed !== "object" ||
            Array.isArray(parsed) ||
            Object.keys(parsed).length !== 2 ||
            !Object.hasOwn(parsed, "state") ||
            !Object.hasOwn(parsed, "code") ||
            parsed.state !== state ||
            !browserFailureCodes.has(parsed.code)
          ) {
            throw fail();
          }
          if (settled) {
            response.writeHead(409).end();
            return;
          }
          settled = true;
          response.writeHead(204).end();
          rejectToken(fail(parsed.code));
          setImmediate(() => server.close());
          return;
        }
        if (request.url === "/cancel") {
          if (
            parsed === null ||
            typeof parsed !== "object" ||
            Array.isArray(parsed) ||
            Object.keys(parsed).length !== 1 ||
            !Object.hasOwn(parsed, "state") ||
            parsed.state !== state
          ) {
            throw fail();
          }
          if (settled) {
            response.writeHead(409).end();
            return;
          }
          settled = true;
          response.writeHead(204).end();
          rejectToken(fail("user_cancelled"));
          setImmediate(() => server.close());
          return;
        }
        if (
          parsed === null ||
          typeof parsed !== "object" ||
          Array.isArray(parsed) ||
          Object.keys(parsed).length !== 2 ||
          !Object.hasOwn(parsed, "state") ||
          !Object.hasOwn(parsed, "token") ||
          parsed.state !== state ||
          typeof parsed.token !== "string" ||
          parsed.token.length === 0
        ) {
          throw fail();
        }
        if (settled) {
          response.writeHead(409).end();
          return;
        }
        settled = true;
        response.writeHead(204).end();
        resolveToken(parsed.token);
        setImmediate(() => server.close());
      } catch {
        response.writeHead(400).end();
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw fail();
  }
  const url = `http://127.0.0.1:${address.port}/`;
  const timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectToken(fail());
      server.close();
    }
  }, timeoutMs);
  timeout.unref();

  return {
    url,
    token: token.finally(() => clearTimeout(timeout)),
    close: async () => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        rejectToken(fail());
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
