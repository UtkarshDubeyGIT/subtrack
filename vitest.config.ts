import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: { reporter: ["text", "json", "html"] },
    include: [
      "apps/**/*.test.{ts,tsx}",
      "packages/**/*.test.{ts,tsx}",
      "supabase/**/*.test.{ts,tsx}",
      "tests/**/*.test.{ts,tsx}",
      "scripts/**/*.test.mjs",
    ],
  },
});
