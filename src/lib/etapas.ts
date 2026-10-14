import { kv } from "@vercel/kv";
import { aplicarTransicao, type Origem, type Pedido } from "./pipeline";
import { sendOrderStatusEmail, type ResultadoEmail } from "./resend";
import { SITE } from "../config/site.config";

/**
 * Camada de banco em volta das regras puras de lib/pipeline.ts.
 * É o ÚNICO caminho que muda status de pedido — webhook, cron, eventos da
 * transportadora e admin passam todos por `mudarEtapa`.
 */

/* O template guardava o pedido por 30 dias. Um pedido entregue some do banco
   um mês depois — e com ele o link de rastreio, o histórico e a prova do que
   foi enviado. 400 dias cobre garantia legal, estorno e contestação. */
export const PEDIDO_TTL = 60 * 60 * 24 * 400;

export const chavePedido = (id: string) => `order:${id}`;
export const chaveRastreio = (codigo: string) => `tracking:${codigo.toUpperCase()}`;

export async function lerPedido(orderId: string): Promise<Pedido | null> {
  return ((await kv.get(chavePedido(orderId))) as Pedido | null) ?? null;
}

export async function gravarPedido(p: Pedido): Promise<void> {
  await kv.set(chavePedido(p.orderId), p, { ex: PEDIDO_TTL });
  await kv.zadd(SITE.kvIndexKey, { score: Number(p.createdAt) || Date.now(), member: p.orderId });
  if (p.trackingCode) await kv.set(chaveRastreio(String(p.trackingCode)), p.orderId, { ex: PEDIDO_TTL });
}

export type ResultadoEtapa =
  | { ok: true; mudou: boolean; status: string; email?: ResultadoEmail }
  | { ok: false; erro: string; naoEncontrado?: boolean };

/**
 * Lê o pedido, aplica `patch` (ex.: código de rastreio), tenta a transição e
 * grava. Manda o e-mail da etapa de DESTINO quando ela de fato mudou — nunca
 * das etapas puladas, para o cliente não receber três e-mails no mesmo minuto.
 */
export async function mudarEtapa(
  orderId: string,
  para: string,
  origem: Origem,
  opts: { host?: string; nota?: string; patch?: Partial<Pedido>; semEmail?: boolean; em?: number } = {}
): Promise<ResultadoEtapa> {
  const atual = await lerPedido(orderId);
  if (!atual) return { ok: false, erro: "Pedido não encontrado.", naoEncontrado: true };

  const base: Pedido = { ...atual, ...(opts.patch || {}) };
  const r = aplicarTransicao(base, para, origem, opts.em ?? Date.now(), opts.nota);
  if (!r.ok) return { ok: false, erro: r.erro };

  // Mesmo sem mudar de etapa, o patch (ex.: correção do código) é gravado.
  await gravarPedido(r.pedido);
  if (!r.mudou || opts.semEmail) return { ok: true, mudou: r.mudou, status: String(r.pedido.status) };

  const p = r.pedido as any;
  const email = await sendOrderStatusEmail(
    {
      orderId,
      cliente: p.cliente,
      trackingCode: p.trackingCode,
      carrier: p.carrier,
      carrierUrl: p.carrierUrl,
      offer: p.offer,
      pixCode: p.pixCode ?? null,
      pixExpiraEm: p.pixExpiraEm ?? null,
      guia: !!p.guia,
      brinde: p.brinde ?? null,
      bump: p.bump ?? null,
    },
    r.para,
    opts.host || SITE.productionHost
  );
  if (!email.enviado) console.warn("[etapas] e-mail não enviado", orderId, r.para, email.motivo);
  return { ok: true, mudou: true, status: r.para, email };
}
