const asymmetricAlgorithms = new Set([
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
]);
export const CLERK_ISSUER = "https://steady-ladybug-22.clerk.accounts.dev";
export const SUPABASE_PROJECT_REF = "qjsyhvclllikkopjfqtc";
export const SUPABASE_PROJECT_NAME = "subtrack-dev";
const SUPABASE_URL = `https://${SUPABASE_PROJECT_REF}.supabase.co`;
const responseStatusGetter = Object.getOwnPropertyDescriptor(
  Response.prototype,
  "status",
)?.get;
const responseJson = Response.prototype.json;
const statusFailureCodes = new Set([
  "positive_create",
  "positive_read",
  "positive_update",
  "negative_boundary",
  "negative_configuration",
  "cleanup",
]);
const nonStatusFailureCodes = new Set([
  "public_key_discovery",
  "browser_launch",
  "user_cancelled",
  "browser_ui",
  "token_handoff",
  "token_contract",
  "transport_or_configuration",
]);
const failureDetails = new WeakMap();

export class HostedProofError extends Error {
  constructor(code = "transport_or_configuration", status) {
    super("hosted_proof_failed");
    this.name = "Error";
    if (
      statusFailureCodes.has(code) &&
      Number.isSafeInteger(status) &&
      status >= 100 &&
      status <= 599
    ) {
      failureDetails.set(this, Object.freeze({ code, status }));
    } else if (nonStatusFailureCodes.has(code)) {
      failureDetails.set(this, Object.freeze({ code }));
    } else {
      failureDetails.set(
        this,
        Object.freeze({ code: "transport_or_configuration" }),
      );
    }
  }
}

export function formatRedactedFailure(error) {
  const detail =
    (typeof error === "object" && error !== null) || typeof error === "function"
      ? failureDetails.get(error)
      : undefined;
  const failure = Object.create(null);
  failure.code = detail?.code ?? "transport_or_configuration";
  if (detail?.status !== undefined) failure.status = detail.status;
  const output = Object.create(null);
  output.outcome = "failed";
  output.issuer = CLERK_ISSUER;
  output.project = SUPABASE_PROJECT_NAME;
  output.projectRef = SUPABASE_PROJECT_REF;
  output.failure = failure;
  return `${JSON.stringify(output)}\n`;
}

export function normalizeHostedProofError(
  error,
  fallbackCode = "transport_or_configuration",
) {
  if (
    ((typeof error === "object" && error !== null) ||
      typeof error === "function") &&
    failureDetails.has(error)
  ) {
    return error;
  }
  return new HostedProofError(fallbackCode);
}

function fail(reason, status) {
  throw new HostedProofError(reason, status);
}

function trustedResponseStatus(response) {
  if (
    !(response instanceof Response) ||
    typeof responseStatusGetter !== "function"
  ) {
    fail("transport_or_configuration");
  }
  try {
    const status = responseStatusGetter.call(response);
    if (!Number.isSafeInteger(status) || status < 100 || status > 599) {
      fail("transport_or_configuration");
    }
    return status;
  } catch {
    fail("transport_or_configuration");
  }
}

function decodePart(value) {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      fail();
    }
    return parsed;
  } catch {
    fail();
  }
}

export function selectPublicSupabaseKeys(entries) {
  if (!Array.isArray(entries)) fail();
  const publishable = entries.filter(
    (entry) =>
      entry !== null &&
      typeof entry === "object" &&
      entry.type === "publishable",
  );
  const anonymous = entries.filter(
    (entry) =>
      entry !== null &&
      typeof entry === "object" &&
      entry.type === "legacy" &&
      entry.name === "anon",
  );
  if (publishable.length !== 1 || anonymous.length !== 1) fail();
  const publishableKey = publishable[0].api_key;
  const negativeToken = anonymous[0].api_key;
  if (
    typeof publishableKey !== "string" ||
    !/^sb_publishable_[A-Za-z0-9_-]{7,512}$/.test(publishableKey) ||
    typeof negativeToken !== "string" ||
    negativeToken.length > 16_384 ||
    negativeToken.split(".").length !== 3
  ) {
    fail();
  }
  return Object.freeze({ publishableKey, negativeToken });
}

export async function discoverSupabasePublicKeys({ runCli }) {
  if (typeof runCli !== "function") fail("public_key_discovery");
  try {
    const output = await runCli([
      "projects",
      "api-keys",
      "--project-ref",
      SUPABASE_PROJECT_REF,
      "--output",
      "json",
    ]);
    if (typeof output !== "string" || output.length > 1_000_000) fail();
    return selectPublicSupabaseKeys(JSON.parse(output));
  } catch {
    fail("public_key_discovery");
  }
}

function proofHeaders(publishableKey, token, includeBody = false) {
  const headers = {
    accept: "application/json",
    apikey: publishableKey,
    authorization: `Bearer ${token}`,
    prefer: "return=representation",
  };
  if (includeBody) headers["content-type"] = "application/json";
  return headers;
}

function subscriptionUrl(query) {
  const url = new URL("/rest/v1/subscriptions", SUPABASE_URL);
  url.search = query.toString();
  return url;
}

export function classifyNegativeStatus(status) {
  if (!Number.isSafeInteger(status) || status < 100 || status > 599) fail();
  if (status === 401 || status === 403) return "denied";
  if (status >= 200 && status < 300) return "boundary_failed";
  return "network_or_configuration";
}

export function formatRedactedResult(result) {
  try {
    if (
      result === null ||
      typeof result !== "object" ||
      result.outcome !== "passed" ||
      result.issuer !== CLERK_ISSUER ||
      result.project !== SUPABASE_PROJECT_NAME ||
      result.projectRef !== SUPABASE_PROJECT_REF ||
      typeof result.timestamp !== "string" ||
      new Date(result.timestamp).toISOString() !== result.timestamp ||
      typeof result.fixtureId !== "string" ||
      !/^sub_proof_[a-z0-9_-]{1,96}$/.test(result.fixtureId) ||
      result.positive?.create !== 201 ||
      result.positive?.read !== 200 ||
      result.positive?.update !== 200 ||
      result.positive?.delete !== 200 ||
      ![401, 403].includes(result.negative?.status) ||
      result.negative?.classification !== "denied" ||
      result.cleanup?.status !== 200 ||
      result.cleanup?.outcome !== "removed"
    ) {
      fail();
    }
    return `${JSON.stringify(
      {
        outcome: "passed",
        timestamp: result.timestamp,
        issuer: CLERK_ISSUER,
        project: SUPABASE_PROJECT_NAME,
        projectRef: SUPABASE_PROJECT_REF,
        fixtureId: result.fixtureId,
        positive: {
          create: 201,
          read: 200,
          update: 200,
          delete: 200,
        },
        negative: {
          status: result.negative.status,
          classification: "denied",
        },
        cleanup: { status: 200, outcome: "removed" },
      },
      null,
      2,
    )}\n`;
  } catch {
    fail();
  }
}

export async function persistRedactedResult(
  result,
  { evidencePath, randomBytes, renameFile, writeFile },
) {
  try {
    if (
      typeof evidencePath !== "string" ||
      evidencePath.length < 1 ||
      typeof randomBytes !== "function" ||
      typeof renameFile !== "function" ||
      typeof writeFile !== "function"
    ) {
      fail();
    }
    const random = randomBytes(8);
    if (!Buffer.isBuffer(random) || random.length !== 8) fail();
    const temporaryPath = `${evidencePath}.${random.toString("hex")}.tmp`;
    await writeFile(temporaryPath, formatRedactedResult(result), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await renameFile(temporaryPath, evidencePath);
  } catch {
    fail();
  }
}

async function expectRows(response, status, fixtureId, version, failureCode) {
  const receivedStatus = trustedResponseStatus(response);
  if (receivedStatus !== status) fail(failureCode, receivedStatus);
  let value;
  try {
    value = await responseJson.call(response);
  } catch {
    fail(failureCode, receivedStatus);
  }
  if (
    !Array.isArray(value) ||
    value.length !== 1 ||
    value[0] === null ||
    typeof value[0] !== "object" ||
    value[0].id !== fixtureId ||
    (version !== undefined && value[0].version !== version)
  ) {
    fail(failureCode, receivedStatus);
  }
}

export async function runHostedDataPlaneProof({
  fetcher,
  fixtureId,
  negativeToken,
  nowSeconds,
  publishableKey,
  sessionToken,
  timestamp,
  today,
}) {
  validateClerkSessionToken(sessionToken, { nowSeconds });
  if (
    typeof fetcher !== "function" ||
    typeof publishableKey !== "string" ||
    !/^sb_publishable_[A-Za-z0-9_-]{7,512}$/.test(publishableKey) ||
    typeof negativeToken !== "string" ||
    negativeToken.length > 16_384 ||
    negativeToken.split(".").length !== 3 ||
    typeof fixtureId !== "string" ||
    !/^sub_proof_[a-z0-9_-]{1,96}$/.test(fixtureId) ||
    typeof timestamp !== "string" ||
    Number.isNaN(Date.parse(timestamp)) ||
    typeof today !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(today)
  ) {
    fail();
  }

  const identityQuery = new URLSearchParams({
    id: `eq.${fixtureId}`,
    select: "id,version",
  });
  const positiveHeaders = proofHeaders(publishableKey, sessionToken, true);
  let create;
  let read;
  let update;
  let negative;
  let proofFailure;
  let createAttempted = false;
  try {
    createAttempted = true;
    create = await fetcher(
      subscriptionUrl(new URLSearchParams({ select: "id,version" })),
      {
        method: "POST",
        headers: positiveHeaders,
        body: JSON.stringify({
          id: fixtureId,
          kind: "one_time",
          service_name: "Subtrack hosted proof fixture",
          plan_name: null,
          amount_minor: 100,
          currency_code: "USD",
          timezone: "UTC",
          lifecycle_status: "active",
          lifecycle_since: today,
          trial_ends_on: null,
          lifecycle_access_ends_on: null,
          start_date: null,
          purchased_on: today,
          access_ends_on: today,
          next_renewal_date: null,
          recurrence_unit: null,
          recurrence_interval: null,
          account_email: null,
          payment_label: null,
          management_url: null,
          notes: null,
        }),
        cache: "no-store",
        redirect: "error",
      },
    );
    await expectRows(create, 201, fixtureId, 1, "positive_create");

    read = await fetcher(subscriptionUrl(identityQuery), {
      method: "GET",
      headers: proofHeaders(publishableKey, sessionToken),
      cache: "no-store",
      redirect: "error",
    });
    await expectRows(read, 200, fixtureId, 1, "positive_read");

    update = await fetcher(
      subscriptionUrl(
        new URLSearchParams({
          id: `eq.${fixtureId}`,
          version: "eq.1",
          select: "id,version",
        }),
      ),
      {
        method: "PATCH",
        headers: positiveHeaders,
        body: JSON.stringify({ plan_name: "Updated hosted proof fixture" }),
        cache: "no-store",
        redirect: "error",
      },
    );
    await expectRows(update, 200, fixtureId, 2, "positive_update");

    negative = await fetcher(subscriptionUrl(identityQuery), {
      method: "GET",
      headers: proofHeaders(publishableKey, negativeToken),
      cache: "no-store",
      redirect: "error",
    });
    const negativeStatus = trustedResponseStatus(negative);
    const negativeClassification = classifyNegativeStatus(negativeStatus);
    if (negativeClassification !== "denied") {
      fail(
        negativeClassification === "boundary_failed"
          ? "negative_boundary"
          : "negative_configuration",
        negativeStatus,
      );
    }
  } catch (error) {
    proofFailure = normalizeHostedProofError(error);
  }

  let cleanup;
  if (createAttempted) {
    try {
      cleanup = await fetcher(
        subscriptionUrl(
          new URLSearchParams({ id: `eq.${fixtureId}`, select: "id" }),
        ),
        {
          method: "DELETE",
          headers: proofHeaders(publishableKey, sessionToken),
          cache: "no-store",
          redirect: "error",
        },
      );
      await expectRows(cleanup, 200, fixtureId, undefined, "cleanup");
    } catch (error) {
      throw normalizeHostedProofError(error);
    }
  }
  if (
    proofFailure !== undefined ||
    !(create instanceof Response) ||
    !(read instanceof Response) ||
    !(update instanceof Response) ||
    !(negative instanceof Response) ||
    !(cleanup instanceof Response)
  ) {
    if (proofFailure !== undefined) throw proofFailure;
    fail("transport_or_configuration");
  }

  return Object.freeze({
    outcome: "passed",
    timestamp,
    issuer: CLERK_ISSUER,
    project: SUPABASE_PROJECT_NAME,
    projectRef: SUPABASE_PROJECT_REF,
    fixtureId,
    positive: Object.freeze({
      create: trustedResponseStatus(create),
      read: trustedResponseStatus(read),
      update: trustedResponseStatus(update),
      delete: trustedResponseStatus(cleanup),
    }),
    negative: Object.freeze({
      status: trustedResponseStatus(negative),
      classification: "denied",
    }),
    cleanup: Object.freeze({
      status: trustedResponseStatus(cleanup),
      outcome: "removed",
    }),
  });
}

function validateClerkSessionTokenStructure(token, options) {
  if (typeof token !== "string" || token.length > 16_384) fail();
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) fail();
  const header = decodePart(parts[0]);
  if (!asymmetricAlgorithms.has(header.alg)) fail();
  if (
    typeof header.kid !== "string" ||
    header.kid.length < 1 ||
    header.kid.length > 256
  ) {
    fail();
  }
  const payload = decodePart(parts[1]);
  if (payload.iss !== CLERK_ISSUER) fail();
  if (payload.role !== "authenticated") fail();
  if (
    typeof payload.sub !== "string" ||
    payload.sub.length < 1 ||
    payload.sub.length > 512 ||
    payload.sub.trim() !== payload.sub
  ) {
    fail();
  }
  const nowSeconds = options?.nowSeconds;
  if (!Number.isSafeInteger(nowSeconds)) fail();
  if (!Number.isSafeInteger(payload.exp) || payload.exp <= nowSeconds) fail();
  if (
    !Number.isSafeInteger(payload.iat) ||
    payload.iat > nowSeconds + 30 ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > 300
  ) {
    fail();
  }
}

export function validateClerkSessionToken(token, options) {
  try {
    validateClerkSessionTokenStructure(token, options);
  } catch {
    fail("token_contract");
  }
}
