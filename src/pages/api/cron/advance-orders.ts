import type { APIRoute } from "astro";
import { advanceAllDueOrders } from "../../../lib/auto-advance";
import { SITE } from "../../../config/site.config";
import { env } from "../../../lib/env";
import { reenviarFalhas } from "../../../lib/emails-falhos";
import { lembretesAutomaticos } from "../../../lib/lembrete-auto";
import { processarFila } from "../../../lib/recuperacao";

export const prerender = false;

/**
 * Chamado pelo Vercel Cron (vercel.json). Consulta o provedor de rastreio para
 * os pedidos com código e aplica o que ele informar — até "saiu para entrega".
 * Nunca finaliza pedido.
 *
 * Exige `Authorization: Bearer <CRON_SECRET>` — a Vercel manda esse header
 * sozinha quando CRON_SECRET existe no projeto. Sem CRON_SECRET, recusa
 * (o template aceitava qualquer chamada anônima).
 */
export const GET: APIRoute = async ({ request }) => {
  const segredo = env("CRON_SECRET");
  if (!segredo || request.headers.get("authorization") !== `Bearer ${segredo}`) {
    return new Response(JSON.stringify({ error: "Não autorizado." }), { status: 401 });
  }
  const host = request.headers.get("host") || SITE.productionHost;
  const resultado = await advanceAllDueOrders(host);
  /* Rede de segurança dos e-mails: o que falhou (429, Resend fora, cota) e o
     pedido continua na mesma etapa é tentado de novo, sem ninguém lembrar. */
  const emails = await reenviarFalhas(host).catch((e) => ({ erro: String(e) }));
  // Rede de segurança do lembrete automático (o gatilho principal é o webhook).
  const lembretes = SITE.lembrete10min ? await lembretesAutomaticos(host).catch((e) => ({ erro: String(e) })) : { desligado: true };
  // Rede de segurança da recuperação de 1 h (o gatilho principal é /api/cron/recuperacao).
  const recuperacao = await processarFila(host).catch((e) => ({ erro: String(e) }));
  return new Response(JSON.stringify({ ok: true, ...resultado, emails, lembretes, recuperacao }), { status: 200, headers: { "Content-Type": "application/json" } });
};
