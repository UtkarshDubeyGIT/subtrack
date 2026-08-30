import { z } from "zod";
import type { PersistedSession, SessionVault } from "./types";

const persistedSessionSchema = z.object({
  refreshCredential: z.string().min(1).max(4_096),
  subject: z.string().min(1).max(512),
});

type Invoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

export class NativeSessionVault implements SessionVault {
  constructor(private readonly invoke: Invoke) {}

  async read(): Promise<PersistedSession | null> {
    const value = await this.invoke("read_session_secret");
    if (value === null) return null;
    const parsed = persistedSessionSchema.safeParse(value);
    if (!parsed.success) throw new Error("Invalid native session response.");
    return parsed.data;
  }

  async write(session: PersistedSession): Promise<void> {
    const validated = persistedSessionSchema.parse(session);
    await this.invoke("write_session_secret", { session: validated });
  }

  async clear(): Promise<void> {
    await this.invoke("clear_session_secret");
  }
}
