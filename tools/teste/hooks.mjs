import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, next) {
  if (specifier === "@vercel/kv") {
    return { url: new URL("./kv-memoria.mjs", import.meta.url).href, shortCircuit: true };
  }
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[cm]?[jt]s$/.test(specifier) && context.parentURL) {
    const alvo = new URL(specifier + ".ts", context.parentURL);
    if (existsSync(fileURLToPath(alvo))) return { url: alvo.href, shortCircuit: true };
  }
  return next(specifier, context);
}
