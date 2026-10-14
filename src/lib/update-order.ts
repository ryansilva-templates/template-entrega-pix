import { mudarEtapa, lerPedido, gravarPedido } from "./etapas";
import { ehFinal } from "./pipeline";

export type UpdateOrderResult = { ok: true; aviso?: string } | { ok: false; error: string };

/** Etapas que o admin pode escolher. "pending" e os estados de pagamento vêm só da Korvex. */
export const ALLOWED_STATUS = new Set(["in_transit", "out_for_delivery", "delivered", "lost"]);

const limpa = (v: unknown, max = 120) => String(v ?? "").trim().slice(0, max);

/**
 * Ações do admin:
 *  - registrar/corrigir o CÓDIGO DE RASTREIO REAL (leva o pedido pago a "enviado");
 *  - avançar manualmente em trânsito / saiu para entrega (fallback sem provedor);
 *  - FINALIZAR: entregue ou extraviado — exclusivamente aqui.
 */
export async function updateOrderStatus(
  orderId: string,
  status: string | undefined,
  host: string,
  rastreio?: { trackingCode?: string; carrier?: string; carrierUrl?: string },
  nota?: string
): Promise<UpdateOrderResult> {
  if (!orderId) return { ok: false, error: "orderId obrigatório." };

  // 1) Código de rastreio real
  if (rastreio && rastreio.trackingCode !== undefined) {
    const codigo = limpa(rastreio.trackingCode, 60).toUpperCase().replace(/\s+/g, "");
    if (!codigo) return { ok: false, error: "Informe o código de rastreio." };
    const url = limpa(rastreio.carrierUrl, 400);
    if (url && !/^https:\/\//i.test(url)) return { ok: false, error: "O link da transportadora precisa começar com https://" };
    const patch = { trackingCode: codigo, carrier: limpa(rastreio.carrier, 60) || null, carrierUrl: url || null };

    const atual = await lerPedido(orderId);
    if (!atual) return { ok: false, error: "Pedido não encontrado." };
    if (atual.status === "paid") {
      const r = await mudarEtapa(orderId, "shipped", "rastreio", { host, patch, nota: `rastreio ${codigo}` });
      if (!r.ok) return { ok: false, error: r.erro };
      return { ok: true, aviso: r.mudou && r.email && !r.email.enviado ? `Salvo, mas o e-mail não saiu: ${r.email.motivo}` : undefined };
    }
    // Pedido já enviado: só corrige o código, sem mudar etapa nem mandar e-mail.
    await gravarPedido({ ...atual, ...patch, updatedAt: Date.now() });
    if (!status) return { ok: true, aviso: "Código atualizado (a etapa não mudou)." };
  }

  // 2) Mudança de etapa
  if (!status) return { ok: true };
  if (!ALLOWED_STATUS.has(status)) return { ok: false, error: "Status inválido para o admin." };
  const r = await mudarEtapa(orderId, status, "admin", { host, nota: limpa(nota, 300) || undefined });
  if (!r.ok) return { ok: false, error: r.erro };
  if (!r.mudou) return { ok: true, aviso: "O pedido já estava nessa etapa." };
  if (r.email && !r.email.enviado) {
    return { ok: true, aviso: `${ehFinal(status) ? "Pedido finalizado" : "Etapa alterada"}, mas o e-mail não saiu: ${r.email.motivo}` };
  }
  return { ok: true };
}
