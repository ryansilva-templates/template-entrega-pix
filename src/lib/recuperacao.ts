import { kv } from "@vercel/kv";
import { SITE } from "../config/site.config";
import { consultarCobranca } from "./pix-psp";
import { sendRecuperacaoEmail } from "./resend";
import { naoQuerContato, cancelamentoPedido, pedidosDoCliente, chavesDoCliente, linkParaSair } from "./contato";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  RECUPERAÇÃO DE VENDA — e-mail 1 HORA depois do Pix gerado (Fase 11, 14/10/2026)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Decisão do usuário: o canal é o E-MAIL (WhatsApp ficou de fora).
 *
 *  1. AGENDAR. Quando a Korvex confirma que o Pix foi GERADO (webhook
 *     TRANSACTION_CREATED/PENDING), o pedido entra numa fila no banco
 *     (`rec:fila`, ordenada pela hora de vencimento = Pix gerado + 1 h). A hora
 *     de partida é a da cobrança na Korvex (transaction.createdAt), não a do
 *     clique em "comprar". A fila vive no banco: fechar navegador ou reiniciar
 *     servidor não perde nada.
 *  2. CANCELAR. Pago, reembolsado, estornado, pedido de cancelamento ou "não
 *     quero contato" tiram o pedido da fila (e a checagem final repete tudo).
 *  3. PROCESSAR (`processarFila`). Para cada pedido vencido:
 *       - relê o pedido; pago/estornado → cancela, sem mensagem;
 *       - cliente pediu para não ser contatado ou pediu cancelamento → cancela;
 *       - o MESMO cliente pagou outro pedido, ou tem um pedido mais novo, ou já
 *         recebeu recuperação nas últimas 24 h → cancela (uma mensagem por
 *         pessoa, não uma por Pix);
 *       - consulta o PSP (a fonte que o app do banco lê):
 *           CONCLUIDA → pago → cancela, sem mensagem;
 *           ATIVA ou vencida sem pagamento → confirmado NÃO pago → envia;
 *           sem resposta confiável → NÃO envia; tenta de novo em 10 min, e
 *           depois de 3 tentativas vai para "análise" no admin.
 *     O envio tem trava própria (1 e-mail de recuperação por pedido, para sempre).
 *  4. REGISTRAR. Toda decisão vira uma linha em `rec:log` (hora, pedido, status
 *     consultado, mensagem, resultado), visível em /admin/atendimento.
 *
 *  QUEM DISPARA A FILA. O plano Hobby da Vercel só roda cron 1x por dia. A
 *  rota /api/cron/recuperacao precisa de um gatilho externo a cada 5 minutos
 *  (cron-job.org ou Upstash QStash — ver README). Sem ele a fila ainda anda,
 *  mas só quando chega um aviso da Korvex ou no cron diário: a mensagem sai
 *  DEPOIS de 1 h, nunca antes, e nunca duplicada.
 */

export const ESPERA_MS = 60 * 60 * 1000;
const NOVA_TENTATIVA_MS = 10 * 60 * 1000;
const MAX_TENTATIVAS = 3;
const POR_RODADA = 15;
const UMA_POR_CLIENTE_MS = 24 * 60 * 60 * 1000;

const P = SITE.kvPrefix;
export const kFila = `${P}rec:fila`;
export const kLog = `${P}rec:log`;
export const kRec = (orderId: string) => `${P}rec:${orderId}`;
const kTrava = (orderId: string) => `${P}rec:trava:${orderId}`;
const kContatado = (hashCliente: string) => `${P}rec:contatado:${hashCliente}`;
const kVarredura = `${P}rec:varredura`;

const PAGO_OU_ESTORNADO = new Set(["paid", "shipped", "in_transit", "out_for_delivery", "delivered", "lost", "refunded", "charged_back"]);

export type EstadoRec = "agendada" | "enviada" | "cancelada" | "analise";
export interface RegistroRec {
  orderId: string;
  estado: EstadoRec;
  pixGeradoEm: number;
  venceEm: number;
  tentativas: number;
  motivo?: string;
  atualizadoEm: number;
}

async function log(entrada: Record<string, unknown>) {
  try {
    await kv.lpush(kLog, { em: Date.now(), ...entrada });
    await kv.ltrim(kLog, 0, 999);
  } catch (e) {
    console.error("[recuperacao] log falhou:", e);
  }
}

/** Chamado pelo webhook quando a Korvex confirma o Pix gerado. Idempotente. */
export async function agendarRecuperacao(orderId: string, pixGeradoEm: number): Promise<RegistroRec | null> {
  const atual = (await kv.get(kRec(orderId))) as RegistroRec | null;
  if (atual) return atual; // reentrega do webhook não reagenda nem adia
  const reg: RegistroRec = {
    orderId,
    estado: "agendada",
    pixGeradoEm,
    venceEm: pixGeradoEm + ESPERA_MS,
    tentativas: 0,
    atualizadoEm: Date.now(),
  };
  await kv.set(kRec(orderId), reg, { ex: 60 * 60 * 24 * 60 });
  await kv.zadd(kFila, { score: reg.venceEm, member: orderId });
  await log({ orderId, acao: "agendada", venceEm: reg.venceEm });
  return reg;
}

/** Pago, estornado, cancelamento pedido, opt-out: tira da fila. */
export async function cancelarRecuperacao(orderId: string, motivo: string): Promise<boolean> {
  const atual = (await kv.get(kRec(orderId))) as RegistroRec | null;
  await kv.zrem(kFila, orderId);
  if (!atual || atual.estado !== "agendada") return false;
  await kv.set(kRec(orderId), { ...atual, estado: "cancelada", motivo, atualizadoEm: Date.now() }, { ex: 60 * 60 * 24 * 60 });
  await log({ orderId, acao: "cancelada", motivo });
  return true;
}

async function encerrar(reg: RegistroRec, estado: EstadoRec, motivo: string, extra: Record<string, unknown> = {}) {
  await kv.zrem(kFila, reg.orderId);
  await kv.set(kRec(reg.orderId), { ...reg, estado, motivo, atualizadoEm: Date.now() }, { ex: 60 * 60 * 24 * 60 });
  await log({ orderId: reg.orderId, acao: estado, motivo, ...extra });
}

export interface ResultadoRodada {
  pulado?: boolean;
  vencidos: number;
  enviadas: number;
  canceladas: number;
  adiadas: number;
  analise: number;
}

/**
 * Processa os pedidos cuja 1 h já passou. `agora` é parâmetro para os testes
 * poderem simular o relógio; em produção é Date.now().
 */
export async function processarFila(host: string, agora = Date.now()): Promise<ResultadoRodada> {
  const res: ResultadoRodada = { vencidos: 0, enviadas: 0, canceladas: 0, adiadas: 0, analise: 0 };
  // No máximo uma rodada a cada 30 s: webhook, cron e gatilho externo podem coincidir.
  const livre = await kv.set(kVarredura, agora, { nx: true, ex: 30 });
  if (livre === null) return { ...res, pulado: true };

  const ids = ((await kv.zrange<string[]>(kFila, 0, agora, { byScore: true, offset: 0, count: POR_RODADA })) ?? []).filter(Boolean);
  res.vencidos = ids.length;

  for (const orderId of ids) {
    // Trava por pedido: duas rodadas simultâneas não processam o mesmo pedido.
    const meu = await kv.set(kTrava(orderId), agora, { nx: true, ex: 120 });
    if (meu === null) continue;
    try {
      const r = await processarUm(String(orderId), host, agora);
      res[r]++;
    } catch (e) {
      console.error("[recuperacao] erro no pedido", orderId, e);
      await log({ orderId, acao: "erro", motivo: e instanceof Error ? e.message : String(e) });
    } finally {
      await kv.del(kTrava(orderId));
    }
  }
  if (ids.length) console.log("[recuperacao] rodada:", JSON.stringify(res));
  return res;
}

async function processarUm(orderId: string, host: string, agora: number): Promise<"enviadas" | "canceladas" | "adiadas" | "analise"> {
  const reg = (await kv.get(kRec(orderId))) as RegistroRec | null;
  if (!reg || reg.estado !== "agendada") {
    await kv.zrem(kFila, orderId);
    return "canceladas";
  }
  if (agora < reg.venceEm) return "adiadas"; // segurança: nunca antes de 1 h

  const p = (await kv.get(`order:${orderId}`)) as Record<string, any> | null;
  if (!p) { await encerrar(reg, "cancelada", "pedido não existe mais"); return "canceladas"; }

  const status = String(p.status ?? "");
  if (PAGO_OU_ESTORNADO.has(status)) {
    await encerrar(reg, "cancelada", `pedido já está "${status}"`, { statusConsultado: status });
    return "canceladas";
  }

  const cliente = { telefone: p.cliente?.telefone, email: p.cliente?.email };
  if (await naoQuerContato(cliente)) {
    await encerrar(reg, "cancelada", "cliente pediu para não ser contatado");
    return "canceladas";
  }
  if (await cancelamentoPedido(orderId)) {
    await encerrar(reg, "cancelada", "cliente pediu cancelamento");
    return "canceladas";
  }

  // Outros pedidos do mesmo cliente
  const irmaos = (await pedidosDoCliente(cliente)).filter((id) => id !== orderId);
  if (irmaos.length) {
    const outros = await kv.mget<any[]>(...irmaos.map((id) => `order:${id}`));
    const criado = Number(p.createdAt) || reg.pixGeradoEm;
    const pagouOutro = outros.find((o) => o && PAGO_OU_ESTORNADO.has(String(o.status)) && (Number(o.createdAt) || 0) >= criado - ESPERA_MS);
    if (pagouOutro) {
      await encerrar(reg, "cancelada", `cliente pagou outro pedido (${pagouOutro.orderId})`);
      return "canceladas";
    }
    const maisNovo = outros.find((o) => o && (Number(o.createdAt) || 0) > criado);
    if (maisNovo) {
      await encerrar(reg, "cancelada", `cliente tem pedido mais novo (${maisNovo.orderId}) — a mensagem vai por ele`);
      return "canceladas";
    }
  }

  // Fonte real do pagamento: o documento da cobrança no PSP.
  const c = p.pixCode ? await consultarCobranca(String(p.pixCode)) : { estado: "sem-verificacao" as const };
  const statusConsultado = `korvex:${status || "?"} | psp:${c.estado}`;
  if (c.estado === "paga") {
    await encerrar(reg, "cancelada", "PSP mostra a cobrança paga", { statusConsultado });
    return "canceladas";
  }
  /* "Não pago" CONFIRMADO: a cobrança está ativa ou venceu no PSP, ou a própria
     Korvex já avisou que venceu ("failed"). Qualquer outra coisa é dúvida — e
     com dúvida não se diz nada ao cliente. */
  const naoPagoConfirmado = c.estado === "ativa" || c.estado === "expirada" || status === "failed";
  if (!naoPagoConfirmado) {
    const tentativas = reg.tentativas + 1;
    if (tentativas >= MAX_TENTATIVAS) {
      await encerrar(reg, "analise", `status não confirmado após ${tentativas} tentativas — conferir na Korvex`, { statusConsultado });
      return "analise";
    }
    await kv.set(kRec(orderId), { ...reg, tentativas, atualizadoEm: Date.now() }, { ex: 60 * 60 * 24 * 60 });
    await kv.zadd(kFila, { score: agora + NOVA_TENTATIVA_MS, member: orderId });
    await log({ orderId, acao: "adiada", motivo: "status não confirmado — nova tentativa em 10 min", statusConsultado, tentativas });
    return "adiadas";
  }

  // Uma recuperação por PESSOA a cada 24 h, mesmo com vários pedidos.
  const chaves = chavesDoCliente(cliente);
  for (const k of chaves) {
    if (await kv.get(kContatado(k))) {
      await encerrar(reg, "cancelada", "cliente já recebeu recuperação nas últimas 24 h", { statusConsultado });
      return "canceladas";
    }
  }

  const loja = SITE.storeUrl;
  const whatsapp = SITE.whatsappLoja
    ? `https://wa.me/${SITE.whatsappLoja}?text=${encodeURIComponent(`Oi! Fiz o pedido ${orderId} na ${SITE.storeName} e queria ajuda com o pagamento.`)}`
    : null;
  const r = await sendRecuperacaoEmail(
    { orderId, cliente: p.cliente, offer: p.offer } as any,
    host,
    { loja, sair: linkParaSair(orderId, host), whatsapp }
  );
  if (r.enviado) {
    for (const k of chaves) await kv.set(kContatado(k), orderId, { ex: Math.round(UMA_POR_CLIENTE_MS / 1000) });
    await encerrar(reg, "enviada", "e-mail de recuperação enviado", {
      statusConsultado, canal: "email", para: String(p.cliente?.email ?? ""), mensagem: r.texto,
    });
    return "enviadas";
  }
  if (/já enviada/.test(r.motivo)) {
    await encerrar(reg, "cancelada", r.motivo, { statusConsultado });
    return "canceladas";
  }
  if (/sem e-mail/.test(r.motivo)) {
    await encerrar(reg, "cancelada", r.motivo, { statusConsultado });
    return "canceladas";
  }
  // Falha de envio (Resend fora, cota): tenta de novo, sem duplicar (trava liberada).
  const tentativas = reg.tentativas + 1;
  if (tentativas >= MAX_TENTATIVAS) {
    await encerrar(reg, "analise", `e-mail falhou ${tentativas}x: ${r.motivo}`, { statusConsultado });
    return "analise";
  }
  await kv.set(kRec(orderId), { ...reg, tentativas, atualizadoEm: Date.now() }, { ex: 60 * 60 * 24 * 60 });
  await kv.zadd(kFila, { score: agora + NOVA_TENTATIVA_MS, member: orderId });
  await log({ orderId, acao: "adiada", motivo: `e-mail falhou: ${r.motivo}`, statusConsultado, tentativas });
  return "adiadas";
}

/** Para o admin: os registros mais recentes. */
export async function ultimosRegistros(n = 100): Promise<any[]> {
  return ((await kv.lrange(kLog, 0, n - 1)) as any[]) ?? [];
}

/** Tamanho da fila e quantos já venceram. */
export async function resumoFila(agora = Date.now()) {
  const total = (await kv.zcard(kFila)) ?? 0;
  const vencidos = ((await kv.zrange<string[]>(kFila, 0, agora, { byScore: true })) ?? []).length;
  return { total, vencidos };
}
