import { kv } from "@vercel/kv";
import { SITE } from "../config/site.config";
import { sendPixReminderEmail, chaveEnviado } from "./resend";
import { consultarCobranca } from "./pix-psp";

/**
 * LEMBRETE DE PIX AUTOMÁTICO (10/10/2026, pedido do usuário: "10 minutos depois"; mesma
 * versão do entrega-popozuda, onde foi provada primeiro).
 *
 * O plano Hobby da Vercel só agenda cron 1x por dia, então quem dispara a
 * varredura é o tráfego que já existe: todo aviso da Korvex que chega no
 * webhook (Pix gerado, pago ou vencido, de qualquer loja da conta) e o cron
 * diário. Cada varredura pega Pix pendentes com 10 min a 24 h de vida.
 * Na prática o lembrete sai entre 10 min e o próximo aviso da Korvex.
 *
 * As travas são as mesmas do botão do admin (api/admin/lembrete.ts): relê o
 * pedido, confere no PSP (só manda se a cobrança estiver ATIVA, nunca para
 * quem já pagou) e sendPixReminderEmail só envia uma vez por pedido.
 *
 * NÃO MARTELAR O PSP (ver incidente do monitor de 3 em 3 min que fez o WAF do
 * fornecedor bloquear a nossa origem): no máximo 1 varredura por minuto, até
 * LIMITE consultas por varredura, e pedido que já se mostrou pago/vencido não
 * é consultado de novo. Pedido "não verificado" só volta a ser tentado depois
 * de 15 min.
 */
export const LEMBRETE_APOS_MS = 10 * 60 * 1000;
const JANELA_MS = 24 * 60 * 60 * 1000;
const LIMITE = 5;
const visto = (id: string) => `lembrete-auto:visto:${id}`;
// Uma trava POR LOJA: o banco (KV) é compartilhado entre as entregas e a Korvex
// manda cada aviso para todas ao mesmo tempo — trava única faria uma bloquear a outra.
const travaVarredura = () => `lembrete-auto:varredura:${SITE.kvIndexKey}`;

export async function lembretesAutomaticos(host: string) {
  const livre = await kv.set(travaVarredura(), Date.now(), { nx: true, ex: 60 });
  if (livre === null) return { pulado: true };

  const agora = Date.now();
  const ids = ((await kv.zrange<string[]>(SITE.kvIndexKey, agora - JANELA_MS, agora - LEMBRETE_APOS_MS, { byScore: true })) ?? [])
    .filter(Boolean)
    .slice(-200);
  if (!ids.length) {
    console.log("[lembrete-auto] varredura: nenhum pedido entre 10 min e 24 h");
    return { candidatos: 0 };
  }

  const [pedidos, travas, vistos] = await Promise.all([
    kv.mget<any[]>(...ids.map((id) => `order:${id}`)),
    kv.mget<any[]>(...ids.map((id) => chaveEnviado(id, "pix-lembrete"))),
    kv.mget<any[]>(...ids.map(visto)),
  ]);
  const alvos = ids
    .filter((id, j) => pedidos[j]?.status === "pending" && pedidos[j]?.pixCode && travas[j] == null && vistos[j] == null)
    .reverse() // mais recentes primeiro: são os que ainda têm código vivo
    .slice(0, LIMITE);

  const cont = { enviado: 0, "ja-pago": 0, expirado: 0, "nao-verificado": 0, erro: 0 };
  for (const orderId of alvos) {
    const p = (await kv.get(`order:${orderId}`)) as Record<string, any> | null;
    if (!p || p.status !== "pending") continue;
    const c = await consultarCobranca(p.pixCode);
    if (c.estado === "paga") {
      cont["ja-pago"]++;
      await kv.set(visto(orderId), "paga", { ex: 2 * 24 * 3600 });
      console.warn("[lembrete-auto] pago no PSP e pendente aqui (conferir na Korvex):", orderId);
      continue;
    }
    if (c.estado === "expirada") {
      cont.expirado++;
      await kv.set(visto(orderId), "expirada", { ex: 2 * 24 * 3600 });
      continue;
    }
    if (c.estado !== "ativa") {
      cont["nao-verificado"]++;
      await kv.set(visto(orderId), "nao-verificado", { ex: 15 * 60 });
      continue;
    }
    const r = await sendPixReminderEmail({ ...(p as any), orderId, pixExpiraEm: c.expiraEm ?? p.pixExpiraEm }, host);
    if (r.enviado) cont.enviado++;
    else if (!/já enviado/.test(r.motivo)) {
      cont.erro++;
      await kv.set(visto(orderId), "erro", { ex: 15 * 60 });
    }
  }
  console.log("[lembrete-auto] varredura:", JSON.stringify({ pedidosNaJanela: ids.length, alvos: alvos.length, ...cont }));
  return { candidatos: alvos.length, ...cont };
}
