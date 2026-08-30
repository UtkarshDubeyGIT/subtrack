import { z } from "zod";

const callbackValue = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9._~-]+$/);

export const authCallbackSchema = z.string().transform((candidate, context) => {
  try {
    const url = new URL(candidate);
    const keys = [...url.searchParams.keys()];
    if (
      url.protocol !== "subtrack:" ||
      url.hostname !== "auth" ||
      url.pathname !== "/callback" ||
      keys.length !== 2 ||
      !keys.includes("code") ||
      !keys.includes("state")
    ) {
      throw new Error("Untrusted callback target");
    }
    return {
      code: callbackValue.parse(url.searchParams.get("code")),
      state: callbackValue.parse(url.searchParams.get("state")),
    };
  } catch {
    context.addIssue({
      code: "custom",
      message: "Invalid authentication callback",
    });
    return z.NEVER;
  }
});

export type SafeError = Readonly<{ code: string; message: string }>;

const safeMessages: Readonly<Record<string, string>> = {
  auth_callback_failed: "Authentication failed.",
  auth_code_failed: "The verification code was not accepted.",
  auth_restore_failed: "Your session could not be restored.",
};

export function redactError(_error: unknown, code: string): SafeError {
  return { code, message: safeMessages[code] ?? "Something went wrong." };
}
