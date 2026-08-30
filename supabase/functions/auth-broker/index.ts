import { AuthBrokerService, type SecurityEvent } from "./broker.ts";
import { ClerkOAuthProvider } from "./clerk-oauth-provider.ts";
import { loadBrokerConfig } from "./config.ts";
import { PostgrestBrokerStore } from "./postgrest-store.ts";

const config = loadBrokerConfig(Deno.env.toObject());
const store = new PostgrestBrokerStore({
  serviceRoleKey: config.supabaseServiceRoleKey,
  supabaseUrl: config.supabaseUrl,
});
const provider = new ClerkOAuthProvider({
  backendApiUrl: config.clerkBackendApiUrl,
  callbackUrl: config.clerkCallbackUrl,
  clientId: config.clerkOAuthClientId,
  clientSecret: config.clerkOAuthClientSecret,
  frontendApiUrl: config.clerkFrontendApiUrl,
  secretKey: config.clerkSecretKey,
});
const service = new AuthBrokerService({
  clock: Date.now,
  events: { record: recordSecurityEvent },
  options: config.options,
  provider,
  store,
});

Deno.serve(async (request) => {
  const url = new URL(request.url);
  const cleanupPath = `${new URL(config.brokerPublicUrl).pathname.replace(/\/$/, "")}/internal/cleanup`;
  if (request.method === "POST" && url.pathname === cleanupPath) {
    const supplied =
      request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    if (!constantTimeEqual(supplied, config.cleanupSecret)) {
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json",
        },
      });
    }
    const result = await service.cleanup();
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json",
      },
    });
  }
  return service.handle(request);
});

function recordSecurityEvent(event: SecurityEvent) {
  // Event is a closed type containing only a bounded name and generic reason.
  console.info(JSON.stringify(event));
}

function constantTimeEqual(left: string, right: string) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}
