import type {
  AuthorizationTransaction,
  BrokerStore,
  CredentialFamily,
  RefreshCredentialRecord,
  RefreshInspection,
  RotationResult,
} from "../contracts.ts";

export class InMemoryBrokerStore implements BrokerStore {
  private readonly authorizations = new Map<string, AuthorizationTransaction>();
  private readonly families = new Map<string, CredentialFamily>();
  private readonly credentials = new Map<string, RefreshCredentialRecord>();
  private readonly rateLimits = new Map<
    string,
    { count: number; windowEndsAt: number }
  >();

  createAuthorization(transaction: AuthorizationTransaction): Promise<void> {
    this.authorizations.set(transaction.id, structuredClone(transaction));
    return Promise.resolve();
  }

  getAuthorization(id: string): Promise<AuthorizationTransaction | null> {
    const transaction = this.authorizations.get(id);
    return Promise.resolve(transaction ? structuredClone(transaction) : null);
  }

  completeAuthorization(
    id: string,
    completion: Pick<
      AuthorizationTransaction,
      | "authorizationCodeExpiresAt"
      | "authorizationCodeHash"
      | "providerSessionId"
      | "subject"
    >,
    now: number,
  ): Promise<boolean> {
    const transaction = this.authorizations.get(id);
    if (
      !transaction ||
      transaction.status !== "pending" ||
      transaction.expiresAt <= now
    ) {
      return Promise.resolve(false);
    }
    Object.assign(transaction, completion, {
      status: "callback_complete" as const,
    });
    return Promise.resolve(true);
  }

  consumeAuthorizationCode(
    hash: string,
    now: number,
  ): Promise<AuthorizationTransaction | null> {
    const transaction = [...this.authorizations.values()].find(
      (candidate) => candidate.authorizationCodeHash === hash,
    );
    if (
      !transaction ||
      transaction.status !== "callback_complete" ||
      !transaction.authorizationCodeExpiresAt ||
      transaction.authorizationCodeExpiresAt <= now
    ) {
      return Promise.resolve(null);
    }
    transaction.status = "exchanged";
    return Promise.resolve(structuredClone(transaction));
  }

  createCredentialFamily(
    family: CredentialFamily,
    credential: RefreshCredentialRecord,
  ): Promise<void> {
    this.families.set(family.id, structuredClone(family));
    this.credentials.set(credential.hash, structuredClone(credential));
    return Promise.resolve();
  }

  inspectRefresh(hash: string, now: number): Promise<RefreshInspection> {
    const credential = this.credentials.get(hash);
    if (!credential) return Promise.resolve({ status: "missing" });
    if (credential.expiresAt <= now)
      return Promise.resolve({ status: "expired" });
    const family = this.families.get(credential.familyId);
    if (!family) return Promise.resolve({ status: "missing" });
    if (family.revokedAt) {
      return Promise.resolve({
        status: "family_revoked",
        credential: structuredClone(credential),
        family: structuredClone(family),
      });
    }
    return Promise.resolve({
      status: credential.usedAt ? "used" : "active",
      credential: structuredClone(credential),
      family: structuredClone(family),
    });
  }

  async rotateRefresh(
    oldHash: string,
    replacement: RefreshCredentialRecord,
    now: number,
  ): Promise<RotationResult> {
    const inspection = await this.inspectRefresh(oldHash, now);
    if (!("family" in inspection)) return inspection;
    if (inspection.status === "family_revoked") {
      return { status: "family_revoked", family: inspection.family };
    }
    if (inspection.status === "used")
      return { status: "reused", family: inspection.family };
    const current = this.credentials.get(oldHash)!;
    current.usedAt = now;
    this.credentials.set(replacement.hash, structuredClone(replacement));
    const family: CredentialFamily = inspection.family;
    return { status: "rotated", family };
  }

  revokeFamily(familyId: string, now: number): Promise<void> {
    const family = this.families.get(familyId);
    if (family && !family.revokedAt) family.revokedAt = now;
    return Promise.resolve();
  }

  takeRateLimit(
    keyHash: string,
    limit: number,
    windowMs: number,
    now: number,
  ): Promise<boolean> {
    const current = this.rateLimits.get(keyHash);
    if (!current || current.windowEndsAt <= now) {
      this.rateLimits.set(keyHash, { count: 1, windowEndsAt: now + windowMs });
      return Promise.resolve(true);
    }
    current.count += 1;
    return Promise.resolve(current.count <= limit);
  }

  cleanup(now: number) {
    let transactions = 0;
    let credentials = 0;
    let rateLimits = 0;
    for (const [id, transaction] of this.authorizations) {
      const codeExpired =
        transaction.authorizationCodeExpiresAt !== undefined &&
        transaction.authorizationCodeExpiresAt <= now;
      if (transaction.expiresAt <= now || codeExpired) {
        this.authorizations.delete(id);
        transactions += 1;
      }
    }
    for (const [hash, credential] of this.credentials) {
      if (credential.expiresAt <= now) {
        this.credentials.delete(hash);
        credentials += 1;
      }
    }
    for (const [key, rate] of this.rateLimits) {
      if (rate.windowEndsAt <= now) {
        this.rateLimits.delete(key);
        rateLimits += 1;
      }
    }
    return Promise.resolve({ credentials, transactions, rateLimits });
  }

  containsRawSecret(secret: string): Promise<boolean> {
    return Promise.resolve(
      JSON.stringify({
        authorizations: [...this.authorizations.values()],
        credentials: [...this.credentials.values()],
      }).includes(secret),
    );
  }
}
