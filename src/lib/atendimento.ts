import { kv } from "@vercel/kv";
import { createHash } from "node:crypto";
import { SITE } from "../config/site.config";
import { BASE, RESPOSTA_DESCONHECIDA, type Entrada, type Acao } from "../data/conhecimento";
import { lerPedido } from "./etapas";
import { labelDe } from "./pipeline";
import { consultarCobranca } from "./pix-psp";
import { linkDeRastreio, assinaturaConfere } from "./link-rastreio";
import { registrarOptout, registrarPedidoDeCancelamento, pedidosDoCliente } from "./contato";
import { cancelarRecuperacao } from "./recuperacao";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  ATENDIMENTO AUTOMÁTICO (chat do site) — Fase 11, 14/10/2026
 * ─────────────────────────────────────────────────────────────────────────────
 *  Sem IA generativa de propósito: a resposta SEMPRE sai da base revisada
 *  (data/conhecimento.ts) — o chat não tem como inventar preço, prazo ou
 *  promessa. O que ele faz:
 *   1. normaliza o texto (acento, abreviação, letra repetida: "qto sai",
 *      "fiz o pix e nadaaa", "vc");
 *   2. pontua cada intenção pelos gatilhos e escolhe a mais forte;
 *   3. preenche os marcadores com os dados reais da loja (api/ofertas);
 *   4. executa a ação, se houver: consultar pedido/pagamento, registrar
 *      "não quero mensagem", registrar pedido de cancelamento;
 *   5. registra a pergunta (intenção, pontuação, se precisou de gente).
 *  Pergunta que não bate em nada → resposta de "vou confirmar" + WhatsApp, e
 *  entra na lista de "não respondidas" do admin, para virar entrada nova.
 *
 *  Pedido só é mostrado com nº + e-mail da compra (ou o link assinado da
 *  página de rastreio) — a mesma regra da página de rastreio.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const P = SITE.kvPrefix;
export const kChatLog = `${P}chat:log`;
export const kChatContagem = `${P}chat:contagem`;
export const kChatDesconhecidas = `${P}chat:desconhecidas`;
export const kChatHumano = `${P}chat:humano`;

/* ───────────────────────────── normalização ───────────────────────────── */

const ABREV: Record<string, string> = {
  vc: "voce", vcs: "voces", q: "que", oq: "o que", pq: "porque", tb: "tambem", tbm: "tambem",
  nd: "nada", msg: "mensagem", msgs: "mensagens", mt: "muito", mto: "muito", qto: "quanto", qnto: "quanto",
  qt: "quanto", qdo: "quando", qnd: "quando", td: "tudo", blz: "beleza", obg: "obrigado", obgd: "obrigado",
  pfv: "por favor", pf: "por favor", n: "nao", nn: "nao", kd: "cade", ta: "esta", tá: "esta", to: "estou",
  pra: "pra", p: "pra", hj: "hoje", amanha: "amanha", whats: "whatsapp", zap: "whatsapp", wpp: "whatsapp",
  ped: "pedido", pgto: "pagamento", pagto: "pagamento", info: "informacao", eh: "e", tah: "esta",
};

export function normalizar(texto: string): string {
  let s = String(texto ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  s = s.replace(/[^a-z0-9@.\s-]/g, " ").replace(/[.\-]/g, " ");
  s = s.replace(/([a-z])\1{2,}/g, "$1"); // "nadaaa" -> "nada", "oiii" -> "oi"
  s = s.split(/\s+/).filter(Boolean).map((w) => ABREV[w] ?? w).join(" ");
  return s.trim();
}

/* ───────────────────────────── classificação ───────────────────────────── */

const COMPILADOS = BASE.map((e) => ({ e, re: e.gatilhos.map(([p, w]) => [new RegExp(p), w] as const) }));

export function classificar(texto: string): { entrada: Entrada | null; pontos: number; segunda: string | null } {
  const n = normalizar(texto);
  let melhor: { e: Entrada; pts: number } | null = null;
  let segunda: { e: Entrada; pts: number } | null = null;
  for (const { e, re } of COMPILADOS) {
    let pts = 0;
    for (const [r, w] of re) if (r.test(n)) pts += w;
    if (pts <= 0) continue;
    if (!melhor || pts > melhor.pts) { segunda = melhor; melhor = { e, pts }; }
    else if (!segunda || pts > segunda.pts) segunda = { e, pts };
  }
  // Abaixo de 3 pontos o "acerto" é só uma palavra solta: melhor perguntar.
  if (!melhor || melhor.pts < 3) return { entrada: null, pontos: melhor?.pts ?? 0, segunda: melhor?.e.id ?? null };
  return { entrada: melhor.e, pontos: melhor.pts, segunda: segunda?.e.id ?? null };
}

/* ───────────────────────── dados reais da loja ───────────────────────── */

export interface DadosLoja {
  ofertas: Array<{ id: string; rotulo: string; preco: string; de: string; porKit: string; porDia: string; unidades: number; dias: number; padrao: boolean; desconto: number; brinde?: string | null }>;
  incluso: string[];
  bump?: { nome: string; itens: string[]; preco: string; de: string } | null;
  frete: { padraoPrazo: string; expresso: string; expressoPrazo: string };
  pagamento: { validadePix: string };
}

let cache: { em: number; dados: DadosLoja } | null = null;

/** Lê api/ofertas da loja (cache de 5 min). Falhou? Devolve null — e o chat NÃO chuta preço. */
export async function dadosDaLoja(): Promise<DadosLoja | null> {
  if (cache && Date.now() - cache.em < 5 * 60 * 1000) return cache.dados;
  try {
    const r = await fetch(SITE.ofertasUrl, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const dados = (await r.json()) as DadosLoja;
    if (!Array.isArray(dados?.ofertas) || !dados.ofertas.length) throw new Error("sem ofertas");
    cache = { em: Date.now(), dados };
    return dados;
  } catch (e) {
    console.error("[atendimento] não li as ofertas da loja:", e instanceof Error ? e.message : e);
    return cache?.dados ?? null;
  }
}

export function linkWhatsapp(texto?: string): string {
  return `https://wa.me/${SITE.whatsappLoja}${texto ? "?text=" + encodeURIComponent(texto) : ""}`;
}

/** Troca os marcadores. Marcador de preço sem dado da loja = resposta não sai (devolve null). */
export function preencher(resposta: string, d: DadosLoja | null): string | null {
  const precisaLoja = /\{(kit|kits|frete|pix|incluso|brinde|bump)/.test(resposta);
  if (precisaLoja && !d) return null;
  let s = resposta
    .replaceAll("{loja}", SITE.storeUrl.replace(/^https?:\/\//, ""))
    .replaceAll("{whatsapp}", linkWhatsapp("Oi! Vim pelo site da " + SITE.storeName + "."));
  if (d) {
    const linha = (o: DadosLoja["ofertas"][number]) => `• ${o.rotulo}: ${o.preco} (de ${o.de})${o.padrao ? " ⭐ recomendado" : ""}`;
    s = s
      .replaceAll("{kits}", d.ofertas.map(linha).join("\n"))
      .replaceAll("{kits_curto}", d.ofertas.map((o) => `${o.rotulo} ${o.preco}`).join(", "))
      .replaceAll("{kits_comparativo}", d.ofertas.map((o) => `• ${o.rotulo}: ${o.preco} — ${o.unidades} de cada sérum, ${o.dias / 30 === 1 ? "1 mês" : o.dias / 30 + " meses"} de rotina (${o.porKit} por kit)`).join("\n"))
      .replaceAll("{incluso}", d.incluso.map((i) => "• " + i).join("\n"))
      .replaceAll("{frete.padraoPrazo}", d.frete.padraoPrazo)
      .replaceAll("{frete.expresso}", d.frete.expresso)
      .replaceAll("{frete.expressoPrazo}", d.frete.expressoPrazo)
      .replaceAll("{pix.validade}", d.pagamento.validadePix);
    // Brinde e upsell: só se a loja informar — sem dado, o marcador sobra e a resposta não sai.
    const comBrinde = d.ofertas.filter((o) => o.brinde);
    if (comBrinde.length) {
      s = s.replaceAll("{brinde}", String(comBrinde[0].brinde)).replaceAll("{brinde_kits}", comBrinde.map((o) => o.rotulo).join(" ou "));
    }
    if (d.bump) {
      s = s.replaceAll("{bump.nome}", d.bump.nome).replaceAll("{bump.preco}", d.bump.preco)
        .replaceAll("{bump.de}", d.bump.de).replaceAll("{bump.itens}", d.bump.itens.join(", "));
    }
    s = s.replace(/\{(kit\d)\.(preco|de|porKit|porDia)\}/g, (_m, id: string, campo: string) => {
      const o = d.ofertas.find((x) => x.id === id) as any;
      return o?.[campo] ?? _m;
    });
  }
  return /\{[a-z0-9_.]+\}/i.test(s) ? null : s; // sobrou marcador = dado faltando: não manda
}

/* ───────────────────────── identificação do pedido ───────────────────────── */

/* Número do pedido = "PS-xxxx-yyyy" (dois blocos depois do prefixo, como a LP
   gera). Exigir o hífen evita ler "psicóloga" ou "PS: obrigado" como pedido. */
const RE_PEDIDO = new RegExp(`\\b(${SITE.orderIdPrefix}-[a-z0-9]{3,}(?:-[a-z0-9]{3,})+)\\b`, "i");
const RE_EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

export function extrairIdentificacao(texto: string): { orderId: string | null; email: string | null } {
  const bruto = String(texto ?? "");
  const email = bruto.match(RE_EMAIL)?.[0]?.toLowerCase() ?? null;
  const semEmail = email ? bruto.replace(email, " ") : bruto;
  const m = semEmail.match(RE_PEDIDO)?.[1];
  const orderId = m ? m.toUpperCase() : null;
  return { orderId, email };
}

export interface Contexto {
  /** Pedido já identificado (link assinado da página de rastreio ou conversa anterior). */
  orderId?: string | null;
  email?: string | null;
  t?: string | null;
  /** Ação que o chat pediu dados para executar ("me passe o nº do pedido…"). */
  aguardando?: Acao | null;
}

async function pedidoAutorizado(ctx: Contexto): Promise<{ p: any | null; motivo?: string }> {
  if (!ctx.orderId) return { p: null, motivo: "sem pedido" };
  const p = await lerPedido(String(ctx.orderId).toUpperCase());
  if (!p) return { p: null, motivo: "não encontrado" };
  const porLink = !!ctx.t && assinaturaConfere(String(ctx.orderId).toUpperCase(), ctx.t);
  const porEmail = !!ctx.email && String((p as any).cliente?.email ?? "").toLowerCase() === String(ctx.email).toLowerCase();
  if (!porLink && !porEmail) return { p: null, motivo: "e-mail não confere" };
  return { p };
}

const PAGOS = new Set(["paid", "shipped", "in_transit", "out_for_delivery", "delivered"]);

async function executar(acao: Acao, ctx: Contexto, host: string): Promise<{ texto: string; humano: boolean; feito: boolean }> {
  if (acao === "humano") return { texto: "", humano: true, feito: true };
  const { p, motivo } = await pedidoAutorizado(ctx);
  if (!p) {
    if (motivo === "não encontrado" || motivo === "e-mail não confere") {
      return { texto: "Não achei um pedido com esse número e esse e-mail juntos. Confere se o e-mail é o mesmo da compra? O número começa com PS e está no e-mail de confirmação.", humano: false, feito: false };
    }
    return { texto: "", humano: false, feito: false }; // ainda faltam os dados
  }
  const orderId = String(p.orderId);
  const link = linkDeRastreio(orderId, host);
  const cliente = { telefone: p.cliente?.telefone, email: p.cliente?.email };

  if (acao === "optout") {
    await registrarOptout(cliente, "email", `chat do site, pedido ${orderId}`);
    for (const id of await pedidosDoCliente(cliente)) await cancelarRecuperacao(id, "cliente pediu para não receber (chat)");
    return { texto: "Pronto, registrado: você não vai mais receber nossas mensagens de lembrete. Os avisos de entrega de pedido pago continuam, porque são do seu pedido.", humano: false, feito: true };
  }
  if (acao === "cancelar") {
    await registrarPedidoDeCancelamento(orderId, "chat do site", ctx.email ?? "");
    for (const id of await pedidosDoCliente(cliente)) await cancelarRecuperacao(id, "cliente pediu cancelamento (chat)");
    return {
      texto: `Anotado o pedido de cancelamento do ${orderId}. Os lembretes foram parados e a nossa equipe vai falar com você para concluir o cancelamento e o reembolso. Se quiser agilizar, chama a gente no WhatsApp: ${linkWhatsapp(`Oi! Quero cancelar o pedido ${orderId}.`)}`,
      humano: true,
      feito: true,
    };
  }

  const status = String(p.status ?? "");
  if (PAGOS.has(status)) {
    return { texto: `Encontrei! O pedido ${orderId} está em "${labelDe(status)}" — o pagamento foi confirmado. Você acompanha cada etapa aqui: ${link}`, humano: false, feito: true };
  }
  if (status === "refunded" || status === "charged_back") {
    return { texto: `O pedido ${orderId} aparece como "${labelDe(status)}". Para qualquer dúvida sobre isso, a nossa equipe te ajuda no WhatsApp: ${linkWhatsapp(`Oi! Sobre o pedido ${orderId}.`)}`, humano: true, feito: true };
  }
  // pendente / não concluído: só afirma com a fonte real
  if (acao === "consultar_pagamento" || status === "pending" || status === "failed") {
    const c = p.pixCode ? await consultarCobranca(String(p.pixCode)) : { estado: "sem-verificacao" as const };
    if (c.estado === "paga") {
      return { texto: `O banco já mostra o pagamento do pedido ${orderId} como concluído. A confirmação no nosso sistema pode levar alguns minutos — e eu já avisei a equipe para conferir. Você recebe o e-mail de "Pagamento confirmado" em seguida.`, humano: true, feito: true };
    }
    if (c.estado === "ativa") {
      return { texto: `Ainda não identificamos o pagamento do pedido ${orderId}, e o código Pix dele ainda está valendo. Confere no app do banco se o Pix foi concluído (às vezes fica pendente de confirmação). Se o valor saiu da sua conta, me chama no WhatsApp com o comprovante: ${linkWhatsapp(`Oi! Paguei o pedido ${orderId} e não atualizou.`)}`, humano: true, feito: true };
    }
    if (c.estado === "expirada" || status === "failed") {
      return { texto: `O código Pix do pedido ${orderId} venceu sem pagamento identificado. Se o valor saiu da sua conta, me manda o comprovante no WhatsApp que a gente confere: ${linkWhatsapp(`Oi! Paguei o pedido ${orderId} e aparece como não pago.`)} — se não saiu, é só gerar um novo Pix em ${SITE.storeUrl.replace(/^https?:\/\//, "")}.`, humano: true, feito: true };
    }
    return { texto: `Não consegui confirmar agora o status do pagamento do pedido ${orderId}, então prefiro não te dizer nada errado. Já passei para a nossa equipe conferir — se quiser, chama no WhatsApp com o comprovante: ${linkWhatsapp(`Oi! Quero confirmar o pagamento do pedido ${orderId}.`)}`, humano: true, feito: true };
  }
  return { texto: `O pedido ${orderId} está em "${labelDe(status)}". Acompanhe aqui: ${link}`, humano: false, feito: true };
}

/* ───────────────────────────── registro ───────────────────────────── */

async function registrar(e: { texto: string; intencao: string; pontos: number; humano: boolean; orderId?: string | null }) {
  try {
    const texto = e.texto.replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, "[e-mail]").slice(0, 300);
    await kv.lpush(kChatLog, { em: Date.now(), texto, intencao: e.intencao, pontos: e.pontos, humano: e.humano });
    await kv.ltrim(kChatLog, 0, 1999);
    await kv.hincrby(kChatContagem, e.intencao, 1);
    if (e.intencao === "desconhecida") {
      await kv.lpush(kChatDesconhecidas, { em: Date.now(), texto });
      await kv.ltrim(kChatDesconhecidas, 0, 499);
    }
    if (e.humano) {
      await kv.lpush(kChatHumano, { em: Date.now(), texto, intencao: e.intencao, orderId: e.orderId ?? null });
      await kv.ltrim(kChatHumano, 0, 499);
    }
  } catch (err) {
    console.error("[atendimento] registro falhou:", err);
  }
}

/* ───────────────────────────── resposta ───────────────────────────── */

export interface Resposta {
  resposta: string;
  intencao: string;
  humano: boolean;
  /** O chat devolve isto na próxima mensagem (ele não guarda conversa no servidor). */
  contexto: Contexto;
  whatsapp: string;
}

export async function responder(texto: string, ctxIn: Contexto, host: string): Promise<Resposta> {
  const ctx: Contexto = { ...ctxIn };
  const id = extrairIdentificacao(texto);
  if (id.orderId) ctx.orderId = id.orderId;
  if (id.email) ctx.email = id.email;
  const temIdentificacao = !!(id.orderId || id.email);

  /* A intenção é lida SEM o e-mail e o nº do pedido: "outra@pessoa.com" não pode
     virar "quero falar com uma pessoa", nem "PS-…-CANCEL…" virar cancelamento. */
  let semIds = texto;
  if (id.email) semIds = semIds.replace(new RegExp(id.email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), " ");
  if (id.orderId) semIds = semIds.replace(new RegExp(id.orderId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), " ");
  const { entrada, pontos } = classificar(semIds);
  const whatsapp = linkWhatsapp("Oi! Vim pelo chat do site da " + SITE.storeName + ".");
  const fim = async (resposta: string, intencao: string, humano: boolean, pts = pontos): Promise<Resposta> => {
    await registrar({ texto, intencao, pontos: pts, humano, orderId: ctx.orderId });
    return { resposta, intencao, humano, contexto: ctx, whatsapp };
  };

  // 1. Resposta a um pedido de dados ("me passe o nº do pedido e o e-mail")
  const acaoPendente = !entrada && ctx.aguardando ? ctx.aguardando : null;
  const acao: Acao | null = entrada?.acao ?? acaoPendente ?? (temIdentificacao && !entrada ? "consultar_pedido" : null);

  if (acao && acao !== "humano") {
    if (ctx.orderId && (ctx.email || ctx.t)) {
      const r = await executar(acao, ctx, host);
      if (r.feito || r.texto) {
        ctx.aguardando = r.feito ? null : acao;
        return fim(r.texto || "Pronto.", entrada?.id ?? acao, r.humano);
      }
    }
    // faltam dados: pede o que falta
    ctx.aguardando = acao;
    if (entrada) {
      const base = preencher(entrada.resposta, await dadosDaLoja()) ?? entrada.resposta;
      return fim(base, entrada.id, false);
    }
    const falta = !ctx.orderId ? "o número do pedido (começa com PS)" : "o e-mail usado na compra";
    return fim(`Obrigado! Agora só preciso de ${falta}.`, acaoPendente ?? "identificacao", false);
  }

  if (!entrada) {
    const r = preencher(RESPOSTA_DESCONHECIDA, null) ?? RESPOSTA_DESCONHECIDA;
    return fim(r, "desconhecida", true);
  }

  const texto2 = preencher(entrada.resposta, await dadosDaLoja());
  if (texto2 === null) {
    // Sem os dados reais da loja não se fala de preço/prazo.
    return fim(`Não consegui confirmar essa informação agora. Para não te passar nada errado, fala com a gente no WhatsApp: ${whatsapp}`, entrada.id, true);
  }
  return fim(texto2, entrada.id, entrada.humano);
}

/* ───────────────────────────── relatório ───────────────────────────── */

export async function relatorio() {
  const [contagem, desconhecidas, humano, log] = await Promise.all([
    kv.hgetall<Record<string, number>>(kChatContagem),
    kv.lrange(kChatDesconhecidas, 0, 99),
    kv.lrange(kChatHumano, 0, 49),
    kv.lrange(kChatLog, 0, 49),
  ]);
  const ranking = Object.entries(contagem ?? {})
    .map(([id, n]) => ({ id, n: Number(n), intencao: BASE.find((b) => b.id === id)?.intencao ?? id }))
    .sort((a, b) => b.n - a.n);
  return { ranking, desconhecidas: (desconhecidas as any[]) ?? [], humano: (humano as any[]) ?? [], log: (log as any[]) ?? [] };
}

/** Rate limit simples por IP (hash): 20 mensagens por minuto. */
export async function dentroDoLimite(ip: string): Promise<boolean> {
  const h = createHash("sha256").update(ip || "?").digest("hex").slice(0, 16);
  const k = `${P}chat:rl:${h}:${Math.floor(Date.now() / 60000)}`;
  const n = await kv.incr(k);
  if (n === 1) await kv.expire(k, 90);
  return n <= 20;
}
