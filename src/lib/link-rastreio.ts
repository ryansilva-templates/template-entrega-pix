import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./env";
import { SITE } from "../config/site.config";

/**
 * LINK ÚNICO DE RASTREIO
 * ─────────────────────────────────────────────────────────────────────────────
 * O template abria o rastreio com código do pedido + e-mail digitado. O link
 * do e-mail levava só o código, então o cliente ainda tinha que digitar o
 * e-mail para ver alguma coisa.
 *
 * Agora o link carrega uma assinatura (HMAC-SHA256 do código do pedido com
 * TRACKING_LINK_SECRET). Quem tem o link vê o pedido na hora; quem só sabe
 * (ou chuta) um código de pedido não vê nada sem o e-mail. Não há tabela de
 * tokens para guardar nem expirar: a assinatura se confere sozinha.
 *
 * Sem TRACKING_LINK_SECRET o link sai sem assinatura e a página cai no
 * formulário de código + e-mail — funciona, só não é de um clique.
 */
function assinatura(orderId: string): string | null {
  const segredo = env("TRACKING_LINK_SECRET");
  if (!segredo) return null;
  return createHmac("sha256", segredo).update(orderId.toUpperCase()).digest("base64url").slice(0, 22);
}

export function linkDeRastreio(orderId: string, host?: string): string {
  const base = `https://${host || SITE.productionHost}/rastrear-pedido?codigo=${encodeURIComponent(orderId)}`;
  const t = assinatura(orderId);
  return t ? `${base}&t=${t}` : base;
}

export function assinaturaConfere(orderId: string, t: string | null | undefined): boolean {
  const esperado = assinatura(orderId);
  if (!esperado || !t) return false;
  const a = Buffer.from(String(t));
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}
