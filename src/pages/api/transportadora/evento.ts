import type { APIRoute } from "astro";
import { timingSafeEqual } from "node:crypto";
import { env } from "../../../lib/env";
import { SITE } from "../../../config/site.config";
import { etapaValida, registrarEventoTransportadora, resolverPedido } from "../../../lib/transportadora";

export const prerender = false;

/**
 * POST /api/transportadora/evento — porta de entrada dos eventos REAIS do pacote.
 *
 * Quem chama: o webhook do serviço de rastreio que você contratar, o seu
 * fornecedor, ou uma automação (Make/Zapier) lendo a transportadora.
 *
 * Autenticação: header `Authorization: Bearer <TRACKING_EVENTS_SECRET>`.
 *
 * Corpo (JSON), um evento ou uma lista em `eventos`:
 *   { "trackingCode": "AA123456789BR", "etapa": "in_transit",
 *     "em": "2026-09-18T14:03:00-03:00", "descricao": "Objeto em trânsito" }
 *   ou { "orderId": "AB-...", ... }
 *
 * etapa: shipped | in_transit | out_for_delivery | delivered_reported | exception_reported
 *   - delivered_reported / exception_reported NÃO mudam o status: só marcam o
 *     pedido para você confirmar no admin (entregue/extraviado é manual).
 *   - qualquer coisa que faça o pedido andar para trás é ignorada.
 */
function autorizado(request: Request): boolean {
  const segredo = env("TRACKING_EVENTS_SECRET");
  if (!segredo) return false;
  const h = request.headers.get("authorization") || "";
  const enviado = h.startsWith("Bearer ") ? h.slice(7) : "";
  const a = Buffer.from(enviado);
  const b = Buffer.from(segredo);
  return a.length === b.length && timingSafeEqual(a, b);
}

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });

export const POST: APIRoute = async ({ request }) => {
  if (!env("TRACKING_EVENTS_SECRET")) return json({ error: "TRACKING_EVENTS_SECRET não configurado." }, 503);
  if (!autorizado(request)) return json({ error: "Não autorizado." }, 401);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "JSON inválido." }, 400);
  }
  const lista: any[] = Array.isArray(body?.eventos) ? body.eventos.slice(0, 200) : [body];
  const host = request.headers.get("host") || SITE.productionHost;
  const resultados: any[] = [];

  for (const ev of lista) {
    const ref = { orderId: ev?.orderId ? String(ev.orderId) : undefined, trackingCode: ev?.trackingCode ? String(ev.trackingCode) : undefined };
    if (!etapaValida(ev?.etapa)) {
      resultados.push({ ...ref, ok: false, erro: "etapa inválida" });
      continue;
    }
    const orderId = await resolverPedido(ref);
    if (!orderId) {
      resultados.push({ ...ref, ok: false, erro: "pedido não encontrado para este código" });
      continue;
    }
    const em = ev?.em ? Date.parse(String(ev.em)) : NaN;
    const r = await registrarEventoTransportadora(
      orderId,
      { etapa: ev.etapa, em: Number.isFinite(em) ? em : undefined, descricao: ev?.descricao ? String(ev.descricao).slice(0, 200) : undefined },
      host
    );
    resultados.push(r.ok ? { orderId, ok: true, status: r.status, mudou: r.mudou } : { orderId, ok: false, erro: r.erro });
  }
  return json({ ok: true, resultados });
};
