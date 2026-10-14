/**
 * Leitura de variável de ambiente em tempo de execução.
 * `process.env` é a fonte na Vercel; `import.meta.env` cobre o `astro dev`
 * lendo o `.env` local. Valor vazio conta como ausente.
 */
export function env(nome: string): string | undefined {
  const v = (typeof process !== "undefined" ? process.env?.[nome] : undefined) ?? (import.meta as any).env?.[nome];
  const s = typeof v === "string" ? v.trim() : v;
  return s ? String(s) : undefined;
}
