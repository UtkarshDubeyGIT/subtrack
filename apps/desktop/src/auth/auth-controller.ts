import { authCallbackSchema, redactError } from "@subtrack/schemas";
import type {
  AuthBroker,
  AuthSnapshot,
  BrokerSession,
  PersistedSession,
  SessionVault,
} from "./types";

export class AuthExchangeError extends Error {
  constructor(
    public readonly reason: "expired" | "revoked" | "transient",
    message: string,
  ) {
    super(message);
    this.name = "AuthExchangeError";
  }
}

export type AccessTokenLease = Readonly<{
  token: string;
  isCurrent: () => boolean;
}>;

function safeFailure(
  code: "auth_callback_failed" | "auth_sign_in_failed",
  error: unknown,
) {
  return Object.assign(new Error(redactError(error, code).message), { code });
}

function createGenerationInvalidation() {
  let invalidate!: () => void;
  const promise = new Promise<void>((resolve) => {
    invalidate = resolve;
  });
  return { invalidate, promise };
}

export class AuthController {
  private accessTokenValue: string | null = null;
  private accessTokenExpiresAt = 0;
  private generation = 0;
  private generationInvalidation = createGenerationInvalidation();
  private mutationTail: Promise<void> = Promise.resolve();
  private currentPersisted: PersistedSession | null = null;
  private sessionRefreshOperation: Readonly<{
    generation: number;
    promise: Promise<AuthSnapshot>;
  }> | null = null;
  private expectedCallback: { state: string; codeVerifier: string } | null =
    null;
  private state: AuthSnapshot = { status: "signed_out" };

  constructor(
    private readonly broker: AuthBroker,
    private readonly vault: SessionVault,
    private readonly options: Readonly<{
      clock?: () => number;
      refreshSkewMs?: number;
    }> = {},
  ) {}

  snapshot(): AuthSnapshot {
    return this.state;
  }

  async accessToken(): Promise<string | null> {
    const lease = await this.accessTokenLease();
    return lease?.isCurrent() ? lease.token : null;
  }

  async accessTokenLease(): Promise<AccessTokenLease | null> {
    const requestGeneration = this.generation;
    const invalidated = this.generationInvalidation.promise;
    if (this.accessTokenValue === null) return null;
    if (this.accessTokenExpiresAt > this.clock() + this.refreshSkewMs()) {
      const token = this.accessTokenValue;
      await Promise.resolve();
      return this.createAccessTokenLease(token, requestGeneration);
    }
    const refreshOperation = this.getSessionRefreshOperation(requestGeneration);
    const completed = await Promise.race([
      refreshOperation.promise.then(
        () => true,
        () => false,
      ),
      invalidated.then(() => false),
    ]);
    if (!completed || requestGeneration !== this.generation) return null;
    if (
      this.accessTokenValue !== null &&
      this.accessTokenExpiresAt > this.clock() + this.refreshSkewMs()
    ) {
      return this.createAccessTokenLease(
        this.accessTokenValue,
        requestGeneration,
      );
    }
    return null;
  }

  expectCallback(input: { state: string; codeVerifier: string }): void {
    if (
      input.state.length === 0 ||
      input.state.length > 512 ||
      input.codeVerifier.length < 43 ||
      input.codeVerifier.length > 128 ||
      !/^[A-Za-z0-9._~-]+$/.test(input.codeVerifier)
    ) {
      throw safeFailure(
        "auth_callback_failed",
        new Error("Invalid OAuth callback binding."),
      );
    }
    this.advanceGeneration();
    this.expectedCallback = input;
  }

  abandonCallback(): void {
    this.advanceGeneration();
    this.expectedCallback = null;
  }

  isExpectingCallback(): boolean {
    return this.expectedCallback !== null;
  }

  claimCallback(
    candidate: string,
  ):
    | Readonly<{ claimed: false }>
    | Readonly<{ claimed: true; completion: Promise<AuthSnapshot> }> {
    if (this.expectedCallback === null) return { claimed: false };
    const operationGeneration = this.generation;
    try {
      const { code, state } = authCallbackSchema.parse(candidate);
      const expected = this.expectedCallback;
      if (expected === null || state !== expected.state) {
        return { claimed: false };
      }
      this.expectedCallback = null;
      return {
        claimed: true,
        completion: this.exchangeClaimedCallback(
          code,
          expected.codeVerifier,
          operationGeneration,
        ),
      };
    } catch (error) {
      throw safeFailure("auth_callback_failed", error);
    }
  }

  async completeCallback(candidate: string): Promise<AuthSnapshot> {
    const claim = this.claimCallback(candidate);
    return claim.claimed ? claim.completion : this.state;
  }

  restore(): Promise<AuthSnapshot> {
    const operationGeneration = this.generation;
    return this.getSessionRefreshOperation(operationGeneration).promise;
  }

  private getSessionRefreshOperation(operationGeneration: number) {
    if (this.sessionRefreshOperation?.generation === operationGeneration) {
      return this.sessionRefreshOperation;
    }
    const operation = this.refreshPersistedSession(operationGeneration);
    const sessionRefreshOperation = {
      generation: operationGeneration,
      promise: operation,
    } as const;
    this.sessionRefreshOperation = sessionRefreshOperation;
    const release = () => {
      if (this.sessionRefreshOperation === sessionRefreshOperation) {
        this.sessionRefreshOperation = null;
      }
    };
    void operation.then(release, release);
    return sessionRefreshOperation;
  }

  private async refreshPersistedSession(
    operationGeneration: number,
  ): Promise<AuthSnapshot> {
    try {
      const persisted = await this.enqueueMutation(() => this.vault.read());
      if (operationGeneration !== this.generation) return this.state;
      if (persisted === null) {
        return this.accessTokenValue === null
          ? this.signOutLocally()
          : this.expireSession(operationGeneration);
      }
      this.currentPersisted = persisted;
      return await this.accept(
        await this.broker.refresh(persisted.refreshCredential),
        operationGeneration,
      );
    } catch (error) {
      if (operationGeneration !== this.generation) return this.state;
      if (error instanceof AuthExchangeError && error.reason !== "transient") {
        return this.clearExpiredSession(operationGeneration);
      }
      throw safeFailure("auth_sign_in_failed", error);
    }
  }

  async signOut(): Promise<AuthSnapshot> {
    this.advanceGeneration();
    const operationGeneration = this.generation;
    const persisted = this.currentPersisted;
    this.currentPersisted = null;
    this.signOutLocally();
    try {
      await this.enqueueMutation(async () => {
        await this.vault.clear();
        if (operationGeneration === this.generation) this.signOutLocally();
      });
    } catch {
      // The in-memory route remains signed out even if native cleanup fails.
    }
    try {
      if (persisted !== null)
        await this.broker.revoke(persisted.refreshCredential);
    } catch {
      // Local removal is already complete when remote revocation fails.
    }
    return this.state;
  }

  private async accept(
    session: BrokerSession,
    operationGeneration = this.generation,
  ): Promise<AuthSnapshot> {
    const persisted: PersistedSession = {
      refreshCredential: session.refreshCredential,
      subject: session.subject,
    };
    return this.enqueueMutation(async () => {
      if (operationGeneration !== this.generation) return this.state;
      await this.vault.write(persisted);
      if (operationGeneration !== this.generation) return this.state;
      this.currentPersisted = persisted;
      this.accessTokenValue = session.accessToken;
      this.accessTokenExpiresAt = session.expiresAt;
      this.state = { status: "signed_in", subject: session.subject };
      return this.state;
    });
  }

  private async exchangeClaimedCallback(
    code: string,
    codeVerifier: string,
    operationGeneration: number,
  ): Promise<AuthSnapshot> {
    try {
      const session = await this.broker.exchange({ code, codeVerifier });
      return await this.accept(session, operationGeneration);
    } catch (error) {
      if (operationGeneration !== this.generation) return this.state;
      throw safeFailure("auth_callback_failed", error);
    }
  }

  private signOutLocally(reason?: "session_expired"): AuthSnapshot {
    this.accessTokenValue = null;
    this.accessTokenExpiresAt = 0;
    this.expectedCallback = null;
    this.state = reason
      ? { status: "signed_out", reason }
      : { status: "signed_out" };
    return this.state;
  }

  private clearExpiredSession(
    operationGeneration: number,
  ): Promise<AuthSnapshot> {
    if (operationGeneration !== this.generation) {
      return Promise.resolve(this.state);
    }
    this.currentPersisted = null;
    const expired = this.expireSession(operationGeneration);
    const cleanup = this.enqueueMutation(async () => {
      try {
        await this.vault.clear();
      } catch {
        // The in-memory session remains expired even when native cleanup fails.
      }
    });
    void cleanup.then(
      () => undefined,
      () => undefined,
    );
    return Promise.resolve(expired);
  }

  private advanceGeneration() {
    this.generationInvalidation.invalidate();
    this.generation += 1;
    this.generationInvalidation = createGenerationInvalidation();
  }

  private createAccessTokenLease(
    token: string,
    generation: number,
  ): AccessTokenLease {
    return Object.freeze({
      token,
      isCurrent: () =>
        generation === this.generation && token === this.accessTokenValue,
    });
  }

  private expireSession(operationGeneration: number): AuthSnapshot {
    if (operationGeneration !== this.generation) return this.state;
    this.advanceGeneration();
    return this.signOutLocally("session_expired");
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private clock() {
    return (this.options.clock ?? Date.now)();
  }

  private refreshSkewMs() {
    return this.options.refreshSkewMs ?? 30_000;
  }
}
