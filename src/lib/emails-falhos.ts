import { kv } from "@vercel/kv";
import { SITE } from "../config/site.config";
import { getOrderStatus } from "../data/order-status";
import { sendOrderStatusEmail, chaveFalha, chaveEnviado } from "./resend";

/**
 * E-MAILS QUE FALHARAM — levantamento e reenvio.
 *
 * Fonte: o marcador `email-falhou:<pedido>:<etapa>` (30 dias) que o envio grava
 * quando desiste. O log da Vercel só guarda ~1 hora; na Ritual da Pele, 14
 * compras aprovadas ficaram sem aviso porque ninguém tinha como saber disso.
 *
 * REGRA: só reenvia se o pedido AINDA estiver na etapa que falhou. Um
 * "saiu para entrega" atrasado para um pedido já entregue é pior que silêncio.
 * O pendente (código Pix) nunca é reenviado aqui: o código vive 30 minutos, e
 * quem decide se ainda vale é o lembrete, que confere no PSP.
 */
const VARREDURA = 1000;
const BLOCO = 100;
const MAX = 40;
/* Um por vez com 300ms: cada envio que falha pode gastar 3 chamadas, e levas
   paralelas refizeram a rajada de 429 na Ritual (60 de 60 em 07/09/2026). */
const PAUSA_MS = 300;

export interface Falha { orderId: string; status: string; motivo: string; em: number | null }

async function pedidosDoIndice() {
  const ids = ((await kv.zrange<string[]>(SITE.kvIndexKey, 0, VARREDURA - 1, { rev: true })) ?? []).filter(Boolean);
  const pedidos: Array<Record<string, any> | null> = [];
  for (let i = 0; i < ids.length; i += BLOCO) {
    const b = ids.slice(i, i + BLOCO);
    if (b.length) pedidos.push(...(await kv.mget<Array<Record<string, any> | null>>(...b.map((id) => `order:${id}`))));
  }
  return { ids, pedidos };
}

export async function levantarFalhas(): Promise<Falha[]> {
  const { ids, pedidos } = await pedidosDoIndice();
  const marcas: any[] = [];
  for (let i = 0; i < ids.length; i += BLOCO) {
    const b = ids.slice(i, i + BLOCO);
    if (b.length) marcas.push(...(await kv.mget<any[]>(...b.map((id, j) => chaveFalha(id, pedidos[i + j]?.status ?? "_")))));
  }
  const falhas: Falha[] = [];
  ids.forEach((orderId, i) => {
    const m = marcas[i];
    const p = pedidos[i];
    if (!m || !p || p.status === "pending" || !getOrderStatus(p.status)?.email) return;
    falhas.push({ orderId, status: p.status, motivo: String(m.motivo ?? "?"), em: typeof m.em === "number" ? m.em : null });
  });
  return falhas.sort((a, b) => (b.em ?? 0) - (a.em ?? 0));
}

export async function reenviarFalhas(host: string) {
  const falhas = (await levantarFalhas()).slice(0, MAX);
  const cont = { enviado: 0, erro: 0, pulado: 0 };
  let motivo: string | null = null;
  for (let i = 0; i < falhas.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, PAUSA_MS));
    const f = falhas[i];
    const p = (await kv.get(`order:${f.orderId}`)) as Record<string, any> | null;
    if (!p || p.status !== f.status) { cont.pulado++; continue; }
    // Se outro caminho já entregou, a trava existe: só limpa o marcador velho.
    if (await kv.get(chaveEnviado(f.orderId, f.status))) { await kv.del(chaveFalha(f.orderId, f.status)); cont.pulado++; continue; }
    const r = await sendOrderStatusEmail({ ...(p as any), orderId: f.orderId }, f.status, host);
    if (r.enviado) cont.enviado++;
    else { cont.erro++; motivo = motivo ?? r.motivo; }
    // Cota diária: insistir hoje não entrega nada.
    if (!r.enviado && /cota/.test(r.motivo)) break;
  }
  return { total: falhas.length, ...cont, motivo };
}

/** Estado do e-mail da etapa atual de cada pedido — para a lista do admin. */
export async function estadoDosEmails(pedidos: Array<{ orderId: string; status: string }>) {
  if (!pedidos.length) return {} as Record<string, { enviado: boolean; falha: string | null; lembrete: boolean }>;
  const [env, fal, lem] = await Promise.all([
    kv.mget<any[]>(...pedidos.map((p) => chaveEnviado(p.orderId, p.status))),
    kv.mget<any[]>(...pedidos.map((p) => chaveFalha(p.orderId, p.status))),
    kv.mget<any[]>(...pedidos.map((p) => chaveEnviado(p.orderId, "pix-lembrete"))),
  ]);
  const out: Record<string, { enviado: boolean; falha: string | null; lembrete: boolean }> = {};
  pedidos.forEach((p, i) => {
    out[p.orderId] = {
      enviado: env[i] !== null && env[i] !== undefined,
      falha: fal[i] ? String(fal[i].motivo ?? "falhou") : null,
      lembrete: lem[i] !== null && lem[i] !== undefined,
    };
  });
  return out;
}
