import { kv } from "@vercel/kv";
import { env } from "./env";
import { chaveRastreio, lerPedido, gravarPedido, mudarEtapa, type ResultadoEtapa } from "./etapas";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  FONTE REAL DAS ETAPAS "EM TRÂNSITO" E "SAIU PARA ENTREGA"
 * ─────────────────────────────────────────────────────────────────────────────
 *  Estas duas etapas só existem se ALGUÉM QUE ACOMPANHA O PACOTE disser que
 *  aconteceram. O repositório original não tinha essa fonte — inventava as
 *  duas por relógio. Aqui há duas portas de entrada, e ambas terminam em
 *  `registrarEventoTransportadora`:
 *
 *   1. PUSH  — POST /api/transportadora/evento (protegido por
 *      TRACKING_EVENTS_SECRET). Serve para o webhook de um serviço de
 *      rastreio, para o seu fornecedor ou para uma automação (Make/Zapier).
 *   2. PULL  — o cron consulta um provedor (`provedorAtivo`). Nenhum provedor
 *      vem implementado: ele depende de QUAL transportadora o fornecedor usa,
 *      e essa informação não está no repositório. Implementar um é plugar um
 *      objeto `Provedor` abaixo — o resto já está pronto.
 *
 *  O que a transportadora informar como "entregue" NÃO finaliza o pedido: vira
 *  a marca `transportadoraInformouEntrega` e o pedido aparece no admin em
 *  "Precisa de você" para a confirmação manual.
 */

export type EtapaEvento = "shipped" | "in_transit" | "out_for_delivery" | "delivered_reported" | "exception_reported";

export interface EventoTransportadora {
  etapa: EtapaEvento;
  /** Quando aconteceu (ms). Sem data, vale a hora do recebimento. */
  em?: number;
  descricao?: string;
}

export interface Provedor {
  id: string;
  /** Devolve os eventos conhecidos do código, do mais antigo ao mais recente. */
  consultar(codigo: string, transportadora?: string | null): Promise<EventoTransportadora[]>;
}

/** Nenhum provedor implementado ainda — ver o comentário do topo. */
export function provedorAtivo(): Provedor | null {
  const id = env("TRACKING_PROVIDER");
  if (!id) return null;
  console.warn(`[transportadora] TRACKING_PROVIDER=${id} não tem implementação neste projeto — ignorado.`);
  return null;
}

const ETAPAS_VALIDAS = new Set<EtapaEvento>(["shipped", "in_transit", "out_for_delivery", "delivered_reported", "exception_reported"]);
export const etapaValida = (e: unknown): e is EtapaEvento => ETAPAS_VALIDAS.has(e as EtapaEvento);

/** Acha o pedido pelo número dele ou pelo código de rastreio. */
export async function resolverPedido(ref: { orderId?: string; trackingCode?: string }): Promise<string | null> {
  if (ref.orderId) return ref.orderId.toUpperCase();
  if (ref.trackingCode) return ((await kv.get(chaveRastreio(ref.trackingCode))) as string | null) ?? null;
  return null;
}

/**
 * Aplica um evento da transportadora. "Entregue" e "problema" informados só
 * viram marca para o admin; as outras três passam pelo pipeline, que recusa
 * retrocesso e qualquer coisa acima de "saiu para entrega".
 */
export async function registrarEventoTransportadora(orderId: string, ev: EventoTransportadora, host?: string): Promise<ResultadoEtapa> {
  const em = ev.em && Number.isFinite(ev.em) ? ev.em : Date.now();

  if (ev.etapa === "delivered_reported" || ev.etapa === "exception_reported") {
    const p = await lerPedido(orderId);
    if (!p) return { ok: false, erro: "Pedido não encontrado.", naoEncontrado: true };
    const campo = ev.etapa === "delivered_reported" ? "transportadoraInformouEntrega" : "transportadoraInformouProblema";
    if (!p[campo]) {
      await gravarPedido({
        ...p,
        [campo]: em,
        historico: [...(p.historico || []), { de: p.status ?? null, para: p.status ?? "", origem: "transportadora", em, nota: `${campo}${ev.descricao ? ": " + ev.descricao : ""}` }],
        updatedAt: Date.now(),
      });
    }
    return { ok: true, mudou: false, status: String(p.status) };
  }

  return mudarEtapa(orderId, ev.etapa, "transportadora", { host, em, nota: ev.descricao });
}

/** Usado pelo cron: consulta o provedor (se houver) e aplica o evento mais recente. */
export async function sincronizarPedido(orderId: string, host?: string): Promise<{ aplicado: string | null; motivo?: string }> {
  const provedor = provedorAtivo();
  if (!provedor) return { aplicado: null, motivo: "sem provedor de rastreio configurado" };
  const p = await lerPedido(orderId);
  if (!p?.trackingCode) return { aplicado: null, motivo: "sem código de rastreio" };
  let eventos: EventoTransportadora[];
  try {
    eventos = await provedor.consultar(String(p.trackingCode), (p.carrier as string) ?? null);
  } catch (e) {
    return { aplicado: null, motivo: `provedor falhou: ${String(e).slice(0, 120)}` };
  }
  let aplicado: string | null = null;
  for (const ev of eventos) {
    if (!etapaValida(ev.etapa)) continue;
    const r = await registrarEventoTransportadora(orderId, ev, host);
    if (r.ok && r.mudou) aplicado = r.status;
  }
  return { aplicado };
}
