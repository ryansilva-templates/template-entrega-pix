// Hooks de módulo SÓ para os testes: troca @vercel/kv por um banco em memória
// e resolve imports relativos sem extensão (como o Vite faz no build).
import { register } from "node:module";
register(new URL("./hooks.mjs", import.meta.url));
