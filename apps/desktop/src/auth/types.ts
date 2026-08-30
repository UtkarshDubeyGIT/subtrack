export interface PersistedSession {
  refreshCredential: string;
  subject: string;
}

export interface BrokerSession extends PersistedSession {
  accessToken: string;
  expiresAt: number;
}

export interface AuthBroker {
  exchange(input: {
    code: string;
    codeVerifier: string;
  }): Promise<BrokerSession>;
  refresh(refreshCredential: string): Promise<BrokerSession>;
  revoke(refreshCredential: string): Promise<void>;
}

export interface SessionVault {
  read(): Promise<PersistedSession | null>;
  write(session: PersistedSession): Promise<void>;
  clear(): Promise<void>;
}

export type AuthSnapshot =
  | { status: "signed_out"; reason?: "session_expired" }
  | { status: "signed_in"; subject: string };
