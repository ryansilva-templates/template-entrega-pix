import { kv } from "@vercel/kv";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { SITE } from "../config/site.config";
import { env } from "./env";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  CONTATO COM O CLIENTE — preferências e vínculo entre pedidos
 * ─────────────────────────────────────────────────────────────────────────────
 *  1. NÃO CONTATAR (opt-out). "Não quero mais mensagem" no WhatsApp, o link
 *     "não quero receber" do e-mail ou o botão do admin gravam a preferência
 *     por TELEFONE e por E-MAIL (hash, sem guardar o dado em claro na chave).
 *     A recuperação de Pix consulta isto antes de cada envio. Não expira:
 *     quem pediu para parar não volta a receber sozinho.
 *  2. CANCELAMENTO PEDIDO pelo cliente: interrompe a recuperação daquele
 *     cliente e marca o pedido para o atendimento humano resolver.
 *  3. ÍNDICE DO CLIENTE: os pedidos de um mesmo telefone/e-mail. É o que
 *     permite (a) não mandar recuperação para quem já pagou OUTRO pedido,
 *     (b) não mandar uma mensagem por pedido quando a pessoa gerou três Pix,
 *     (c) o atendimento achar o pedido pelo número de quem escreve.
 *
 *  Chaves com SITE.kvPrefix: o banco é compartilhado entre as lojas.
 */

export const soDigitos = (v: unknown) => String(v ?? "").replace(/\D/g, "");

/** Telefone brasileiro normalizado com DDI 55 (o WhatsApp manda assim). */
export function telefoneNormalizado(v: unknown): string {
  let d = soDigitos(v);
  if (!d) return "";
  if (d.length === 10 || d.length === 11) d = "55" + d;
  return d;
}

const h = (tipo: "tel" | "email", valor: string) =>
  createHash("sha256").update(tipo + ":" + valor).digest("hex").slice(0, 32);

export function chavesDoCliente(c: { telefone?: unknown; email?: unknown }): string[] {
  const out: string[] = [];
  const tel = telefoneNormalizado(c.telefone);
  const email = String(c.email ?? "").trim().toLowerCase();
  if (tel.length >= 12) out.push(h("tel", tel));
  if (email.includes("@")) out.push(h("email", email));
  return out;
}

const kOptout = (hash: string) => `${SITE.kvPrefix}optout:${hash}`;
const kCliente = (hash: string) => `${SITE.kvPrefix}cliente:${hash}`;
const kCancelamento = (orderId: string) => `${SITE.kvPrefix}cancelamento:${orderId}`;

/* ───────────────────────────── opt-out ───────────────────────────── */

export async function registrarOptout(
  c: { telefone?: unknown; email?: unknown },
  origem: "whatsapp" | "email" | "admin",
  nota?: string
): Promise<number> {
  const chaves = chavesDoCliente(c);
  for (const k of chaves) await kv.set(kOptout(k), { em: Date.now(), origem, nota: nota ?? null });
  return chaves.length;
}

export async function removerOptout(c: { telefone?: unknown; email?: unknown }): Promise<void> {
  for (const k of chavesDoCliente(c)) await kv.del(kOptout(k));
}

/** Qualquer um dos contatos bloqueado = não contatar. */
export async function naoQuerContato(c: { telefone?: unknown; email?: unknown }): Promise<boolean> {
  const chaves = chavesDoCliente(c);
  if (!chaves.length) return false;
  const vals = await kv.mget<any[]>(...chaves.map(kOptout));
  return vals.some((v) => v !== null && v !== undefined);
}

/* ─────────────────────── cancelamento pedido ─────────────────────── */

export async function registrarPedidoDeCancelamento(orderId: string, origem: string, texto?: string) {
  await kv.set(kCancelamento(orderId), { em: Date.now(), origem, texto: String(texto ?? "").slice(0, 300) }, { ex: 60 * 60 * 24 * 400 });
}

export async function cancelamentoPedido(orderId: string): Promise<any | null> {
  return ((await kv.get(kCancelamento(orderId))) as any) ?? null;
}

/* ───────────────────────── índice do cliente ───────────────────────── */

export async function indexarCliente(orderId: string, c: { telefone?: unknown; email?: unknown }, criadoEm: number) {
  for (const k of chavesDoCliente(c)) {
    await kv.zadd(kCliente(k), { score: criadoEm, member: orderId });
    await kv.expire(kCliente(k), 60 * 60 * 24 * 400);
  }
}

/** Pedidos do cliente (pelo telefone e/ou e-mail), mais recentes primeiro, sem repetir. */
export async function pedidosDoCliente(c: { telefone?: unknown; email?: unknown }): Promise<string[]> {
  const ids = new Set<string>();
  for (const k of chavesDoCliente(c)) {
    const lista = ((await kv.zrange<string[]>(kCliente(k), 0, 49, { rev: true })) ?? []).filter(Boolean);
    lista.forEach((id) => ids.add(String(id)));
  }
  return [...ids];
}

/* ─────────────────── link "não quero receber" (e-mail) ───────────────────
   Assinado como o link de rastreio, mas com outro propósito no HMAC: um link
   de rastreio não serve para descadastrar, e vice-versa. */
function assinaturaSair(orderId: string): string | null {
  const segredo = env("TRACKING_LINK_SECRET");
  if (!segredo) return null;
  return createHmac("sha256", segredo).update("sair:" + orderId.toUpperCase()).digest("base64url").slice(0, 22);
}

export function linkParaSair(orderId: string, host?: string): string | null {
  const t = assinaturaSair(orderId);
  if (!t) return null;
  return `https://${host || SITE.productionHost}/api/preferencias/sair?codigo=${encodeURIComponent(orderId)}&t=${t}`;
}

export function assinaturaSairConfere(orderId: string, t: string | null | undefined): boolean {
  const esperado = assinaturaSair(orderId);
  if (!esperado || !t) return false;
  const a = Buffer.from(String(t));
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}
