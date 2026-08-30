export type AuthorizationTransaction = {
  id: string;
  state: string;
  codeChallenge: string;
  redirectUri: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "callback_complete" | "exchanged";
  authorizationCodeHash?: string;
  authorizationCodeExpiresAt?: number;
  providerSessionId?: string;
  subject?: string;
};

export type CredentialFamily = {
  id: string;
  providerSessionId: string;
  subject: string;
  createdAt: number;
  revokedAt?: number;
};

export type RefreshCredentialRecord = {
  hash: string;
  familyId: string;
  generation: number;
  createdAt: number;
  expiresAt: number;
  usedAt?: number;
};

export type RefreshInspection =
  | { status: "missing" | "expired" }
  | {
      status: "active" | "used" | "family_revoked";
      credential: RefreshCredentialRecord;
      family: CredentialFamily;
    };

export type RotationResult =
  | { status: "rotated"; family: CredentialFamily }
  | {
      status: "missing" | "expired" | "reused" | "family_revoked";
      family?: CredentialFamily;
    };

export interface BrokerStore {
  createAuthorization(transaction: AuthorizationTransaction): Promise<void>;
  getAuthorization(id: string): Promise<AuthorizationTransaction | null>;
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
  ): Promise<boolean>;
  consumeAuthorizationCode(
    hash: string,
    now: number,
  ): Promise<AuthorizationTransaction | null>;
  createCredentialFamily(
    family: CredentialFamily,
    credential: RefreshCredentialRecord,
  ): Promise<void>;
  inspectRefresh(hash: string, now: number): Promise<RefreshInspection>;
  rotateRefresh(
    oldHash: string,
    replacement: RefreshCredentialRecord,
    now: number,
  ): Promise<RotationResult>;
  revokeFamily(familyId: string, now: number): Promise<void>;
  takeRateLimit(
    keyHash: string,
    limit: number,
    windowMs: number,
    now: number,
  ): Promise<boolean>;
  cleanup(
    now: number,
  ): Promise<{ credentials: number; transactions: number; rateLimits: number }>;
}

export type ProviderIdentity = Readonly<{
  providerSessionId: string;
  subject: string;
}>;

export type ProviderSessionToken = Readonly<{
  token: string;
  expiresAt: number;
}>;

export interface IdentityProvider {
  authorizationUrl(input: {
    callbackUrl: string;
    transactionId: string;
  }): Promise<string>;
  completeAuthorization(input: {
    providerCode: string;
    transactionId: string;
  }): Promise<ProviderIdentity>;
  issueSessionToken(
    providerSessionId: string,
    subject: string,
  ): Promise<ProviderSessionToken>;
  revokeSession(providerSessionId: string): Promise<void>;
}

export class IdentityProviderError extends Error {
  constructor(public readonly reason: "revoked" | "invalid" | "unavailable") {
    super("identity_provider_failure");
  }
}
