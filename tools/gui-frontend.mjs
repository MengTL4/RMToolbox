import { build } from "vite";
import path from "node:path";

export async function buildFrontend(projectRoot, write = true, entry = null) {
  const result = await build({
    root: projectRoot,
    configFile: path.join(projectRoot, "vite.config.mjs"),
    logLevel: "warn",
    build: { write, ...(entry ? { lib: { entry } } : {}) }
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(
    (item) => item.output || []
  );
  const chunk = outputs.find(
    (item) => item.type === "chunk" && item.fileName === "modern.js"
  );
  if (!chunk) throw new Error("Frontend build did not produce modern.js");
  return chunk.code;
}
