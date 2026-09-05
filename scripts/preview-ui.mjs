import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "vite";
import react from "@vitejs/plugin-react";

// Bundle only the isolated sample-data entry. No app environment is loaded.
const result = await build({
  configFile: false,
  root: resolve("apps/desktop"),
  envFile: false,
  plugins: [react()],
  build: {
    write: false,
    minify: true,
    rollupOptions: {
      input: resolve("apps/desktop/preview.html"),
      output: { inlineDynamicImports: true },
    },
  },
});
if (Array.isArray(result) || !("output" in result))
  throw new Error("Unexpected preview build output.");
const html = result.output.find(
  (file) => file.type === "asset" && file.fileName === "preview.html",
);
const script = result.output.find(
  (file) => file.type === "chunk" && file.isEntry,
);
const styles = result.output.filter(
  (file) => file.type === "asset" && file.fileName.endsWith(".css"),
);
if (!html || !script || styles.length === 0)
  throw new Error("Incomplete preview output.");
const standalone = String(html.source)
  .replace(/<script type="module"[^>]*><\/script>/u, "")
  .replace(/<link rel="stylesheet"[^>]*>/gu, "")
  .replace(
    "</head>",
    () =>
      `<style>${styles.map((file) => String(file.source)).join("\n")}</style></head>`,
  )
  .replace(
    "</body>",
    () =>
      `<script>${script.code.replaceAll("</script", "<\\/script")}</script></body>`,
  );
const destination = resolve(process.argv[2] ?? "dist/subtrack-ui-preview.html");
await mkdir(resolve(destination, ".."), { recursive: true });
await writeFile(destination, standalone);
console.log(`Interactive UI preview: ${destination}`);
