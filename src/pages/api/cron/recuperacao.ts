import type { APIRoute } from "astro";
import { SITE } from "../../../config/site.config";
import { env } from "../../../lib/env";
import { processarFila, resumoFila } from "../../../lib/recuperacao";

export const prerender = false;

/**
 * Gatilho da recuperação de venda (lib/recuperacao.ts) — chamar A CADA 5 MIN.
 *
 * O plano Hobby da Vercel só agenda cron 1x por dia, então quem chama esta
 * rota é um agendador externo (cron-job.org ou Upstash QStash), com o header
 * `Authorization: Bearer <CRON_SECRET>`. Idempotente: chamar duas vezes no
 * mesmo minuto não envia nada a mais.
 */
export const GET: APIRoute = async ({ request }) => {
  const segredo = env("CRON_SECRET");
  if (!segredo || request.headers.get("authorization") !== `Bearer ${segredo}`) {
    return new Response(JSON.stringify({ error: "Não autorizado." }), { status: 401 });
  }
  const host = SITE.productionHost;
  const rodada = await processarFila(host);
  const fila = await resumoFila();
  return new Response(JSON.stringify({ ok: true, rodada, fila }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
};

export const POST = GET;
