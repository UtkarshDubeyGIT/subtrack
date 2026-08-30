import {
  formatRedactedResult,
  HostedProofError,
  normalizeHostedProofError,
} from "./core.mjs";

function fail() {
  throw new HostedProofError();
}

export async function runHostedProofHarness({
  discoverKeys,
  now,
  openBrowser,
  persist,
  print,
  prove,
  randomBytes,
  startReceiver,
}) {
  if (
    [
      discoverKeys,
      now,
      openBrowser,
      persist,
      print,
      prove,
      randomBytes,
      startReceiver,
    ].some((dependency) => typeof dependency !== "function")
  ) {
    fail();
  }

  let keys;
  try {
    keys = await discoverKeys();
  } catch (error) {
    throw normalizeHostedProofError(error, "public_key_discovery");
  }
  const stateBytes = randomBytes(32);
  const fixtureBytes = randomBytes(16);
  if (
    !Buffer.isBuffer(stateBytes) ||
    stateBytes.length !== 32 ||
    !Buffer.isBuffer(fixtureBytes) ||
    fixtureBytes.length !== 16
  ) {
    fail();
  }
  const receiver = await startReceiver({
    state: stateBytes.toString("base64url"),
    timeoutMs: 300_000,
  });
  const tokenPromise = receiver.token;
  void tokenPromise.catch(() => undefined);
  try {
    try {
      await openBrowser(receiver.url);
    } catch (error) {
      throw normalizeHostedProofError(error, "browser_launch");
    }
    let sessionToken;
    try {
      sessionToken = await tokenPromise;
    } catch (error) {
      throw normalizeHostedProofError(error, "token_handoff");
    }
    const instant = now();
    if (!(instant instanceof Date) || Number.isNaN(instant.valueOf())) fail();
    const timestamp = instant.toISOString();
    const result = await prove({
      fetcher: fetch,
      fixtureId: `sub_proof_${fixtureBytes.toString("hex")}`,
      negativeToken: keys.negativeToken,
      nowSeconds: Math.floor(instant.valueOf() / 1_000),
      publishableKey: keys.publishableKey,
      sessionToken,
      timestamp,
      today: timestamp.slice(0, 10),
    });
    await persist(result);
    print(formatRedactedResult(result));
    return result;
  } catch (error) {
    throw normalizeHostedProofError(error);
  } finally {
    await receiver.close();
  }
}
