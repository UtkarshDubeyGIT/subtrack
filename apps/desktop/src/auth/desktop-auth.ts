import { AuthController, type AccessTokenLease } from "./auth-controller";
import { HttpAuthBroker } from "./broker-client";
import { NativeSessionVault } from "./native-session-vault";
import type { AuthSnapshot } from "./types";
import { joinAuthBrokerPath, parseAuthBrokerBaseUrl } from "./broker-url";

type Invoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;
type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
type OpenUrl = (url: string) => Promise<void>;

export type PkceBinding = Readonly<{
  state: string;
  verifier: string;
  challenge: string;
}>;

export type DesktopAuthSnapshot =
  | AuthSnapshot
  | Readonly<{ status: "starting" }>
  | Readonly<{ status: "verification_pending" }>
  | Readonly<{ status: "setup_required"; message: string }>
  | Readonly<{ status: "error"; message: string }>;

export interface DesktopAuthRuntime {
  snapshot(): DesktopAuthSnapshot;
  subscribe(listener: (snapshot: DesktopAuthSnapshot) => void): () => void;
  boot(): Promise<DesktopAuthSnapshot>;
  beginSignIn(): Promise<DesktopAuthSnapshot>;
  handleCallback(candidate: string): Promise<DesktopAuthSnapshot>;
  signOut(): Promise<DesktopAuthSnapshot>;
  accessToken(): Promise<string | null>;
  accessTokenLease(): Promise<AccessTokenLease | null>;
}

type Dependencies = Readonly<{
  fetcher?: Fetcher;
  invoke?: Invoke;
  openUrl?: OpenUrl;
  createPkce?: () => Promise<PkceBinding>;
}>;

class SetupRequiredRuntime implements DesktopAuthRuntime {
  private readonly state: DesktopAuthSnapshot;

  constructor(message: string) {
    this.state = { status: "setup_required", message };
  }

  snapshot() {
    return this.state;
  }

  subscribe(listener: (snapshot: DesktopAuthSnapshot) => void) {
    listener(this.state);
    return () => undefined;
  }

  boot() {
    return Promise.resolve(this.state);
  }

  beginSignIn() {
    return Promise.resolve(this.state);
  }

  handleCallback() {
    return Promise.resolve(this.state);
  }

  signOut() {
    return Promise.resolve(this.state);
  }

  accessToken() {
    return Promise.resolve(null);
  }

  accessTokenLease() {
    return Promise.resolve(null);
  }
}

class BrokerDesktopAuthRuntime implements DesktopAuthRuntime {
  private state: DesktopAuthSnapshot = { status: "starting" };
  private generation = 0;
  private signInOperation: Readonly<{
    generation: number;
    promise: Promise<DesktopAuthSnapshot>;
  }> | null = null;
  private bootOperation: Readonly<{
    generation: number;
    promise: Promise<DesktopAuthSnapshot>;
  }> | null = null;
  private readonly listeners = new Set<
    (snapshot: DesktopAuthSnapshot) => void
  >();

  constructor(
    private readonly brokerUrl: string,
    private readonly controller: AuthController,
    private readonly openUrl: OpenUrl,
    private readonly createPkce: () => Promise<PkceBinding>,
  ) {}

  snapshot() {
    return this.state;
  }

  subscribe(listener: (snapshot: DesktopAuthSnapshot) => void) {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  boot() {
    if (this.bootOperation?.generation === this.generation) {
      return this.bootOperation.promise;
    }
    const operationGeneration = this.generation;
    const operation = (async () => {
      try {
        const restored = await this.controller.restore();
        if (operationGeneration !== this.generation) return this.state;
        this.state = restored;
      } catch {
        if (operationGeneration !== this.generation) return this.state;
        this.state = {
          status: "error",
          message: "Authentication could not be restored.",
        };
      }
      return this.emit();
    })();
    const bootOperation = {
      generation: operationGeneration,
      promise: operation,
    } as const;
    this.bootOperation = bootOperation;
    const release = () => {
      if (this.bootOperation === bootOperation) this.bootOperation = null;
    };
    void operation.then(release, release);
    return operation;
  }

  beginSignIn() {
    if (this.signInOperation?.generation === this.generation) {
      return this.signInOperation.promise;
    }
    this.generation += 1;
    const operationGeneration = this.generation;
    this.controller.abandonCallback();
    this.state = { status: "verification_pending" };
    this.emit();
    const operation = (async () => {
      try {
        const binding = await this.createPkce();
        if (operationGeneration !== this.generation) return this.state;
        this.controller.expectCallback({
          state: binding.state,
          codeVerifier: binding.verifier,
        });
        const authorize = new URL(
          joinAuthBrokerPath(this.brokerUrl, "/v1/desktop/authorize"),
        );
        authorize.search = new URLSearchParams({
          state: binding.state,
          code_challenge: binding.challenge,
          code_challenge_method: "S256",
          redirect_uri: "subtrack://auth/callback",
        }).toString();
        await this.openUrl(authorize.toString());
        if (operationGeneration !== this.generation) return this.state;
      } catch {
        if (operationGeneration !== this.generation) return this.state;
        this.controller.abandonCallback();
        this.state = {
          status: "error",
          message: "Sign-in could not be started.",
        };
      }
      return this.emit();
    })();
    const signInOperation = {
      generation: operationGeneration,
      promise: operation,
    } as const;
    this.signInOperation = signInOperation;
    const release = () => {
      if (this.signInOperation === signInOperation) {
        this.signInOperation = null;
      }
    };
    void operation.then(release, release);
    return operation;
  }

  async handleCallback(candidate: string) {
    if (!this.controller.isExpectingCallback()) return this.state;
    let claim: ReturnType<AuthController["claimCallback"]>;
    try {
      claim = this.controller.claimCallback(candidate);
    } catch {
      this.state = { status: "error", message: "Authentication failed." };
      return this.emit();
    }
    if (!claim.claimed) return this.state;
    this.generation += 1;
    const operationGeneration = this.generation;
    this.signInOperation = null;
    try {
      const completed = await claim.completion;
      if (operationGeneration !== this.generation) return this.state;
      if (
        this.state.status === "verification_pending" &&
        completed.status === "signed_out"
      ) {
        return this.state;
      }
      this.state = completed;
    } catch {
      if (operationGeneration !== this.generation) return this.state;
      this.state = { status: "error", message: "Authentication failed." };
    }
    return this.emit();
  }

  async signOut() {
    this.generation += 1;
    this.signInOperation = null;
    const operationGeneration = this.generation;
    this.state = { status: "signed_out" };
    this.emit();
    try {
      const signedOut = await this.controller.signOut();
      if (operationGeneration !== this.generation) return this.state;
      this.state = signedOut;
    } catch {
      if (operationGeneration !== this.generation) return this.state;
      this.state = {
        status: "error",
        message: "Local session cleanup failed.",
      };
    }
    return this.emit();
  }

  async accessToken() {
    const operationGeneration = this.generation;
    this.publishControllerExpiry(operationGeneration);
    if (!this.isCurrentSignedInRoute(operationGeneration)) return null;
    const token = await this.controller.accessToken();
    this.publishControllerExpiry(operationGeneration);
    return this.isCurrentSignedInRoute(operationGeneration) ? token : null;
  }

  async accessTokenLease() {
    const operationGeneration = this.generation;
    this.publishControllerExpiry(operationGeneration);
    if (!this.isCurrentSignedInRoute(operationGeneration)) return null;
    const lease = await this.controller.accessTokenLease();
    this.publishControllerExpiry(operationGeneration);
    return this.isCurrentSignedInRoute(operationGeneration) ? lease : null;
  }

  private publishControllerExpiry(operationGeneration: number) {
    if (
      operationGeneration !== this.generation ||
      this.state.status !== "signed_in"
    ) {
      return;
    }
    const controllerState = this.controller.snapshot();
    if (controllerState.status === "signed_out") {
      this.state = controllerState;
      this.emit();
    }
  }

  private isCurrentSignedInRoute(operationGeneration: number) {
    if (
      operationGeneration !== this.generation ||
      this.state.status !== "signed_in"
    ) {
      return false;
    }
    const controllerState = this.controller.snapshot();
    return (
      controllerState.status === "signed_in" &&
      controllerState.subject === this.state.subject
    );
  }

  private emit() {
    for (const listener of this.listeners) listener(this.state);
    return this.state;
  }
}

export function createDesktopAuthRuntime(
  environment: Readonly<Record<string, string | undefined>>,
  dependencies: Dependencies = {},
): DesktopAuthRuntime {
  const configured = environment.VITE_AUTH_BROKER_URL;
  if (!configured) {
    return new SetupRequiredRuntime("Authentication broker is not configured.");
  }
  let brokerUrl: string;
  try {
    brokerUrl = parseAuthBrokerBaseUrl(configured);
  } catch {
    return new SetupRequiredRuntime(
      "Authentication broker configuration is invalid.",
    );
  }
  if (!dependencies.invoke || !dependencies.openUrl) {
    return new SetupRequiredRuntime(
      "Native authentication services are unavailable.",
    );
  }

  const broker = new HttpAuthBroker(brokerUrl, dependencies.fetcher);
  const vault = new NativeSessionVault(dependencies.invoke);
  return new BrokerDesktopAuthRuntime(
    brokerUrl,
    new AuthController(broker, vault),
    dependencies.openUrl,
    dependencies.createPkce ?? createPkceBinding,
  );
}

export async function createPkceBinding(): Promise<PkceBinding> {
  const state = randomBase64Url(32);
  const verifier = randomBase64Url(64);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return {
    state,
    verifier,
    challenge: bytesToBase64Url(new Uint8Array(digest)),
  };
}

function randomBase64Url(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
