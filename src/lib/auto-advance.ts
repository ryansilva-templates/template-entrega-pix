import { kv } from "@vercel/kv";
import { SITE } from "../config/site.config";
import { provedorAtivo, sincronizarPedido } from "./transportadora";
import { lerPedido, mudarEtapa } from "./etapas";
import { vencidasNoRelogio, type Pedido } from "./pipeline";

/**
 * AUTOMAÇÃO DO CRON
 * ─────────────────────────────────────────────────────────────────────────────
 * Duas fontes, nesta ordem:
 *  1. RELÓGIO (SITE.relogio): enviado / em trânsito / saiu para entrega em
 *     horas fixas depois do pagamento — decisão do usuário em 21/09/2026.
 *     Também roda a cada consulta da página de rastreio (api/rastreio.ts),
 *     porque o cron do plano Hobby só passa uma vez por dia.
 *  2. Provedor de rastreio, se um dia houver: consulta os pedidos com código.
 * Nenhuma das duas passa de "saiu para entrega" (lib/pipeline.ts).
 * Os eventos que chegam por push (/api/transportadora/evento) são aplicados na hora.
 */
const ACOMPANHAVEIS = new Set(["paid", "shipped", "in_transit"]);

const regrasDo = (p: Pedido) =>
  /expresso|full/i.test(String((p as any).shipping?.name ?? "")) ? SITE.relogio.expresso : SITE.relogio.padrao;

/**
 * Aplica o que o relógio já venceu. Cada etapa leva o seu próprio horário;
 * só a ÚLTIMA manda e-mail, para o cliente não receber três no mesmo minuto
 * quando o cron chega atrasado. Devolve o pedido atualizado (ou o mesmo).
 */
export async function avancarPeloRelogio(orderId: string, host?: string, agora = Date.now()): Promise<Pedido | null> {
  const p = await lerPedido(orderId);
  if (!p) return null;
  const vencidas = vencidasNoRelogio(p, regrasDo(p), agora);
  for (let i = 0; i < vencidas.length; i++) {
    const v = vencidas[i];
    const patch = v.status === "shipped" && !p.trackingCode ? { trackingCode: orderId } : undefined;
    await mudarEtapa(orderId, v.status, "relogio", {
      host,
      em: v.em,
      patch,
      semEmail: i < vencidas.length - 1,
      nota: "relógio",
    });
  }
  return vencidas.length ? await lerPedido(orderId) : p;
}

export async function advanceAllDueOrders(host: string, limite = 500) {
  const provedor = provedorAtivo();
  const ids = (await kv.zrange<string[]>(SITE.kvIndexKey, 0, limite - 1, { rev: true })) ?? [];
  const avancados: Array<{ orderId: string; para: string }> = [];
  let consultados = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const lote = ids.slice(i, i + 50);
    const pedidos = await kv.mget<Array<Record<string, any> | null>>(...lote.map((id) => `order:${id}`));
    for (let j = 0; j < lote.length; j++) {
      const p = pedidos[j];
      if (!p || !ACOMPANHAVEIS.has(p.status)) continue;
      consultados++;
      const depois = await avancarPeloRelogio(lote[j], host);
      if (depois && depois.status !== p.status) avancados.push({ orderId: lote[j], para: String(depois.status) });
      if (!provedor || !depois?.trackingCode) continue;
      // Um de cada vez: provedor de rastreio costuma ter limite por segundo.
      const r = await sincronizarPedido(lote[j], host);
      if (r.aplicado) avancados.push({ orderId: lote[j], para: r.aplicado });
    }
  }
  return { consultados, avancados, ...(provedor ? {} : { aviso: "sem provedor de rastreio — só o relógio" }) };
}
