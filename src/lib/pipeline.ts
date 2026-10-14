/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  REGRAS DO PIPELINE DE ENTREGA — módulo PURO (sem banco, sem rede)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Tudo o que decide "este pedido pode ir para esta etapa?" mora aqui, e só
 *  aqui. Webhook, cron, rastreio e admin chamam `aplicarTransicao` — nenhum
 *  deles escreve status por conta própria. Por ser puro, é testado sem KV
 *  (tools/testar-pipeline.ts).
 *
 *  POR QUE CADA ETAPA TEM UMA ORIGEM OBRIGATÓRIA
 *  O template original avançava tudo por RELÓGIO (+24h "preparando", +7 dias
 *  "enviado", +9 dias "em trânsito") numa "transportadora própria" cujo código
 *  de rastreio era o número do pedido. Nenhuma dessas etapas tinha um fato por
 *  trás: o e-mail dizia "enviado" sem pacote nenhum ter saído. Aqui cada etapa
 *  só acontece quando a fonte que SABE daquilo diz que aconteceu:
 *
 *    pending / paid / refunded / charged_back / failed  ← Korvex (webhook)
 *    shipped                                            ← código de rastreio REAL registrado
 *    in_transit / out_for_delivery                      ← eventos da transportadora
 *    shipped / in_transit / out_for_delivery            ← ou o RELÓGIO (SITE.relogio),
 *                                                          decisão do usuário no Abranuv
 *    delivered / lost                                   ← SÓ o admin. Nunca automático.
 *
 *  A automação para em "Saiu para entrega" (penúltima etapa). Mesmo que a
 *  transportadora informe "entregue", o pedido NÃO vira entregue sozinho: fica
 *  marcado para o admin confirmar.
 */

export type Origem = "korvex" | "rastreio" | "transportadora" | "relogio" | "admin";

export interface EtapaDef {
  id: string;
  label: string;
  /** Frase curta exibida ao cliente na linha do tempo. */
  descricao: string;
}

/** Caminho feliz, em ordem. A última posição é a etapa FINAL (manual). */
export const ETAPAS: EtapaDef[] = [
  { id: "pending", label: "Pedido realizado", descricao: "Aguardando a confirmação do Pix." },
  { id: "paid", label: "Pagamento aprovado", descricao: "Pagamento confirmado. Seu pedido entrou na fila de separação." },
  { id: "shipped", label: "Pedido enviado", descricao: "O pacote foi postado e já tem código de rastreio." },
  { id: "in_transit", label: "Em trânsito", descricao: "O pacote está a caminho da sua cidade." },
  { id: "out_for_delivery", label: "Saiu para entrega", descricao: "O entregador está a caminho do seu endereço." },
];

/** Etapa final — só o admin decide qual das duas. */
export const FINAIS: Record<string, EtapaDef> = {
  delivered: { id: "delivered", label: "Entregue", descricao: "Pedido entregue no endereço informado." },
  lost: { id: "lost", label: "Extraviado", descricao: "Houve um problema no transporte. Nossa equipe entrou em contato." },
};

/** Estados fora do caminho feliz, vindos do pagamento. */
export const PROBLEMAS: Record<string, EtapaDef> = {
  refunded: { id: "refunded", label: "Reembolsado", descricao: "O valor do pedido foi reembolsado." },
  charged_back: { id: "charged_back", label: "Estornado", descricao: "O pagamento foi estornado." },
  failed: { id: "failed", label: "Pagamento não concluído", descricao: "O Pix não foi pago dentro do prazo." },
};

const RANK: Record<string, number> = {
  pending: 0, paid: 1, shipped: 2, in_transit: 3, out_for_delivery: 4, delivered: 5, lost: 5,
};

/** Última etapa que a automação pode alcançar. */
export const TETO_AUTOMATICO = "out_for_delivery";

export function labelDe(id: string): string {
  return ETAPAS.find((e) => e.id === id)?.label ?? FINAIS[id]?.label ?? PROBLEMAS[id]?.label ?? id;
}

export function ehFinal(id: string | undefined | null): boolean {
  return !!id && id in FINAIS;
}

export interface Pedido {
  orderId: string;
  status?: string;
  trackingCode?: string | null;
  carrier?: string | null;
  statusTimestamps?: Record<string, number>;
  /** Histórico: quem mudou o quê, quando. Só cresce. */
  historico?: Array<{ de: string | null; para: string; origem: Origem; em: number; nota?: string }>;
  /** A transportadora informou entrega, mas quem confirma é o admin. */
  transportadoraInformouEntrega?: number | null;
  updatedAt?: number;
  [k: string]: unknown;
}

export type Resultado =
  | { ok: true; mudou: false; pedido: Pedido }
  | { ok: true; mudou: true; pedido: Pedido; de: string | null; para: string }
  | { ok: false; erro: string };

/**
 * Decide se a transição é permitida para ESTA origem. Devolve null se pode,
 * ou a razão da recusa (texto para log e para o admin).
 */
export function motivoRecusa(atual: string | undefined, novo: string, origem: Origem, pedido: Pedido): string | null {
  const conhecido = novo in RANK || novo in PROBLEMAS;
  if (!conhecido) return `status desconhecido: ${novo}`;

  // Etapa final: exclusivamente manual.
  if (ehFinal(novo)) {
    if (origem !== "admin") return "entregue/extraviado só pode ser marcado manualmente no admin";
    if (!atual || !(atual in RANK) || RANK[atual] < RANK.paid) return "só pedido pago pode ser finalizado";
    return null;
  }

  // Estados de problema vêm do pagamento.
  if (novo in PROBLEMAS) {
    if (origem !== "korvex" && origem !== "admin") return "reembolso/estorno/falha vêm do pagamento";
    return null;
  }

  // Daqui para baixo: caminho feliz (pending..out_for_delivery).
  const rAtual = atual && atual in RANK ? RANK[atual] : -1;
  const rNovo = RANK[novo];

  // Nunca anda para trás. Reentrega de webhook (ex.: TRANSACTION_PAID
  // repetido com o pedido já "em trânsito") não pode rebaixar o pedido.
  if (rNovo <= rAtual) return `não retrocede (${atual} → ${novo})`;
  // Pedido finalizado ou em problema não volta para o caminho automático.
  if (atual && (ehFinal(atual) || atual in PROBLEMAS)) return `pedido já está em ${atual}`;

  switch (origem) {
    case "korvex":
      if (novo !== "pending" && novo !== "paid") return "a Korvex só informa pagamento";
      return null;
    case "rastreio":
      if (novo !== "shipped") return "registrar rastreio só leva a 'enviado'";
      if (rAtual < RANK.paid) return "pedido ainda não foi pago";
      if (!pedido.trackingCode) return "sem código de rastreio real";
      return null;
    case "relogio":
    case "transportadora":
      if (rNovo > RANK[TETO_AUTOMATICO]) return "automação para em 'saiu para entrega'";
      if (rAtual < RANK.paid) return "pedido ainda não foi pago";
      if (!pedido.trackingCode) return "sem código de rastreio";
      return null;
    case "admin":
      // Fallback manual para as etapas intermediárias (ex.: sem provedor de
      // rastreio configurado). "Enviado" continua exigindo código real.
      if (rAtual < RANK.paid) return "pedido ainda não foi pago";
      if (rNovo >= RANK.shipped && !pedido.trackingCode) return "registre o código de rastreio real antes";
      return null;
  }
}

/**
 * Aplica a transição (se permitida) e devolve o pedido novo. Não grava nada.
 * Quando um evento pula etapas (ex.: a transportadora já informa "em trânsito"
 * e o pedido estava em "pago"), as etapas intermediárias são carimbadas com o
 * mesmo horário — elas aconteceram, só não foram vistas antes — mas quem avisa
 * o cliente é quem chama, e só pela etapa de destino.
 */
export function aplicarTransicao(pedido: Pedido, novo: string, origem: Origem, em: number, nota?: string): Resultado {
  const atual = pedido.status;
  if (atual === novo) return { ok: true, mudou: false, pedido };
  const recusa = motivoRecusa(atual, novo, origem, pedido);
  if (recusa) return { ok: false, erro: recusa };

  const statusTimestamps = { ...(pedido.statusTimestamps || {}) };
  if (novo in RANK && !ehFinal(novo)) {
    const rNovo = RANK[novo];
    for (const e of ETAPAS) {
      if (RANK[e.id] > (atual && atual in RANK ? RANK[atual] : -1) && RANK[e.id] < rNovo && e.id !== "pending") {
        statusTimestamps[e.id] = statusTimestamps[e.id] ?? em;
      }
    }
  }
  statusTimestamps[novo] = statusTimestamps[novo] ?? em;

  const historico = [...(pedido.historico || []), { de: atual ?? null, para: novo, origem, em, ...(nota ? { nota } : {}) }];
  return {
    ok: true,
    mudou: true,
    de: atual ?? null,
    para: novo,
    pedido: { ...pedido, status: novo, statusTimestamps, historico, updatedAt: em },
  };
}

export interface PassoLinha {
  id: string;
  label: string;
  descricao: string;
  estado: "feito" | "atual" | "proximo" | "futuro";
  em: number | null;
}

/** Linha do tempo para a página do cliente. */
export function linhaDoTempo(pedido: Pedido): { passos: PassoLinha[]; problema: EtapaDef | null } {
  const st = pedido.status || "pending";
  const ts = pedido.statusTimestamps || {};
  const problema = PROBLEMAS[st] ?? null;

  const final = ehFinal(st) ? FINAIS[st] : { id: "final", label: "Entrega concluída", descricao: "Confirmamos a entrega assim que ela acontecer." };
  const todos: EtapaDef[] = [...ETAPAS, final];
  const rAtual = st in RANK ? RANK[st] : (problema ? RANK.paid : 0);

  let proximoMarcado = false;
  const passos = todos.map((e) => {
    const r = e.id in RANK ? RANK[e.id] : 5;
    // Pedido reembolsado/estornado/falho: vale o que de fato aconteceu antes.
    if (problema) {
      return { id: e.id, label: e.label, descricao: e.descricao, estado: (ts[e.id] ? "feito" : "futuro") as PassoLinha["estado"], em: ts[e.id] ?? null };
    }
    let estado: PassoLinha["estado"];
    if (r < rAtual) estado = "feito";
    else if (r === rAtual && !problema) estado = e.id === st ? "atual" : "futuro";
    else if (!proximoMarcado && !problema && !ehFinal(st)) { estado = "proximo"; proximoMarcado = true; }
    else estado = "futuro";
    if (ehFinal(st) && e.id === st) estado = "atual";
    return { id: e.id, label: e.label, descricao: e.descricao, estado, em: ts[e.id] ?? null };
  });
  return { passos, problema };
}

/**
 * Etapas que o relógio já deveria ter aplicado, em ordem, cada uma com o seu
 * horário (pagamento + horas). Puro: quem aplica é lib/auto-advance.ts.
 * Só vale para pedido PAGO no caminho feliz, e nunca passa do teto automático.
 */
export function vencidasNoRelogio(
  pedido: Pedido,
  regras: Array<{ status: string; horas: number }>,
  agora: number
): Array<{ status: string; em: number }> {
  const st = pedido.status;
  if (!st || !(st in RANK) || ehFinal(st) || RANK[st] < RANK.paid) return [];
  const pagoEm = pedido.statusTimestamps?.paid;
  if (typeof pagoEm !== "number") return [];
  return regras
    .filter((r) => r.status in RANK && RANK[r.status] > RANK[st] && RANK[r.status] <= RANK[TETO_AUTOMATICO])
    .map((r) => ({ status: r.status, em: pagoEm + r.horas * 3_600_000 }))
    .filter((r) => r.em <= agora)
    .sort((a, b) => RANK[a.status] - RANK[b.status]);
}
