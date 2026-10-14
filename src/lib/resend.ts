import { kv } from "@vercel/kv";
import { getOrderStatus } from "../data/order-status";
import { SITE } from "../config/site.config";
import { env } from "./env";
import { linkDeRastreio } from "./link-rastreio";
import { recebedorDoBrCode, horaLimite } from "./pix-psp";

const RESEND_API = "https://api.resend.com/emails";
const { brandDark: ESCURO, brandAccent: DESTAQUE, brandLight: CLARO,
  brandAccentInk: TINTA_DESTAQUE, brandAccentOnDark: DESTAQUE_NO_ESCURO, brandTint: FUNDO_PIX } = SITE.email;

/** Bloco do guia digital (marcador {guia}). No "pago" ele chega para ler
 *  enquanto o pedido viaja; no "entregue", na hora em que serve. (Sua Loja: SITE.guia = null.) */
function blocoGuia(statusId: string): string {
  const g = SITE.guia;
  if (!g) return "";
  const frase = statusId === "delivered"
    ? `O seu <strong>${g.nome}</strong> está liberado:`
    : `O seu kit inclui o <strong>${g.nome}</strong>, já liberado enquanto o pedido chega:`;
  return `<br><br>${frase}<br><br><a href="${g.url}" style="display:inline-block;background:${ESCURO};color:${CLARO};font-weight:700;text-decoration:none;padding:12px 20px;border-radius:10px">Abrir o ${g.nome}</a>`;
}

/** Guarda da trava anti-duplicado: bem mais que a vida útil de um pedido. */
const TRAVA_TTL = 60 * 60 * 24 * 400;
/** Marcador de falha: sobrevive ao log da Vercel, que rotaciona em ~1 hora. */
const FALHA_TTL = 60 * 60 * 24 * 30;
const COM_RASTREIO = new Set(["shipped", "in_transit", "out_for_delivery", "delivered", "lost"]);
const RECEBEDOR_GENERICO = "da instituição que processa o pagamento";

export const chaveEnviado = (id: string, etapa: string) => `email-sent:${id}:${etapa}`;
export const chaveFalha = (id: string, etapa: string) => `email-falhou:${id}:${etapa}`;

export interface PedidoParaEmail {
  orderId: string;
  cliente?: { nome?: string; email?: string };
  trackingCode?: string | null;
  carrier?: string | null;
  carrierUrl?: string | null;
  offer?: { name?: string; quantity?: number } | null;
  /** Copia-e-cola. Só aparece nos e-mails de Pix (pendente e lembrete). */
  pixCode?: string | null;
  /** Quando o código morre (ms), lido do PSP. */
  pixExpiraEm?: number | null;
  /** Kit com o guia digital: o marcador {guia} vira o link. */
  guia?: boolean;
  /** Brinde do kit e upsell comprado junto — aparecem na caixa "Seu pedido". */
  brinde?: string | null;
  bump?: string | null;
}

export type ResultadoEmail = { enviado: true } | { enviado: false; motivo: string };

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/* ─────────────────────── SAÚDE DA CONFIGURAÇÃO ───────────────────────
   O modo de falha mais silencioso: sem RESEND_FROM_EMAIL o remetente cai em
   onboarding@resend.dev, a Resend responde 200 e só entrega na caixa do DONO
   da conta. Log diz "enviado", nenhum cliente recebe nada. O admin mostra
   isto no topo da página, em vez de deixar para alguém descobrir por
   reclamação. */
export function saudeEmail() {
  const chave = !!env("RESEND_API_KEY");
  const from = env("RESEND_FROM_EMAIL") || "";
  const dominio = (from.match(/@([^>\s]+)/)?.[1] || "").toLowerCase();
  const remetenteReal = !!from && dominio !== "resend.dev";
  const problemas: string[] = [];
  if (!chave) problemas.push("RESEND_API_KEY não configurada — nenhum e-mail sai.");
  if (!from) problemas.push("RESEND_FROM_EMAIL não configurada — a Resend só entrega na caixa do dono da conta.");
  else if (!remetenteReal) problemas.push("Remetente em resend.dev — só entrega na caixa do dono da conta Resend.");
  if (!env("RESEND_REPLY_TO")) problemas.push("RESEND_REPLY_TO vazio — o e-mail convida a responder, mas a resposta não chega em ninguém.");
  if (!env("TRACKING_LINK_SECRET")) problemas.push("TRACKING_LINK_SECRET vazio — o link do e-mail pede o e-mail do cliente para abrir.");
  return { ok: chave && remetenteReal, chave, from: from || SITE.email.from, dominio: dominio || null, problemas };
}

function remetente(): string {
  const from = env("RESEND_FROM_EMAIL");
  if (!from) {
    console.error("[resend] RESEND_FROM_EMAIL NÃO CONFIGURADA — usando " + SITE.email.from + ", que só entrega na caixa do dono da conta Resend.");
    return SITE.email.from;
  }
  return from;
}

function blocoPix(code: string, expiraEm?: number | null) {
  const limite = horaLimite(expiraEm);
  return `<div style="border:2px dashed ${DESTAQUE};border-radius:8px;padding:14px 16px;margin:0 0 20px;background:${FUNDO_PIX}">
    <p style="margin:0 0 8px;font-size:12px;color:#5a5d63;text-transform:uppercase;letter-spacing:.08em">Pix copia e cola</p>
    <p style="margin:0 0 10px;font-family:'Courier New',Courier,monospace;font-size:12px;line-height:1.5;color:#1a1a1a;word-break:break-all;background:#fff;border:1px solid #ddddd8;border-radius:6px;padding:10px">${esc(code)}</p>
    <p style="margin:0;font-size:12px;line-height:1.6;color:#5a5d63">
      Copie o código e cole no app do seu banco, em <strong>Pix Copia e Cola</strong>.${limite ? `<br><strong>Vale ${esc(limite)}.</strong>` : ""}<br>
      No banco vai aparecer o nome <strong>${esc(recebedorDoBrCode(code) ?? RECEBEDOR_GENERICO)}</strong> — não é a loja. O pedido é da ${esc(SITE.storeName)} e chega normalmente.
    </p>
  </div>`;
}

function html(p: {
  nome: string; orderId: string; heading: string; body: string; link: string;
  rastreio?: string | null; transportadora?: string | null; urlTransportadora?: string | null; produto?: string | null;
  pixCode?: string | null; pixExpiraEm?: number | null;
  /** Texto do botão (padrão: "Acompanhar meu pedido"). */
  botao?: string;
  /** Link "não quero receber" (só nos e-mails que não são da entrega em si). */
  sair?: string | null;
}) {
  const primeiroNome = esc(p.nome.split(" ")[0] || "");
  const bloco = p.rastreio
    ? `<p style="margin:12px 0 0;font-size:14px;color:#333"><strong>Rastreio${p.transportadora ? " " + esc(p.transportadora) : ""}:</strong> <span style="font-family:monospace">${esc(p.rastreio)}</span>${
        p.urlTransportadora ? `<br><a href="${esc(p.urlTransportadora)}" style="color:${ESCURO}">Ver no site da transportadora</a>` : ""
      }</p>`
    : "";
  return `
<div style="background:${CLARO};padding:24px 12px;font-family:Arial,Helvetica,sans-serif">
 <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #ddddd8">
  <div style="background:${ESCURO};padding:18px 24px;text-align:center;border-bottom:4px solid ${DESTAQUE}">
   <div style="letter-spacing:.12em;font-size:18px;color:#fff;text-transform:uppercase;font-weight:bold">${esc(SITE.storeName)}<span style="color:${DESTAQUE_NO_ESCURO}">.</span></div>
  </div>
  <div style="padding:28px 24px;color:#1a1a1a">
   <h1 style="font-size:21px;line-height:1.3;margin:0 0 16px;color:${ESCURO}">${p.heading}</h1>
   <p style="font-size:15px;line-height:1.6;margin:0 0 12px">${primeiroNome ? `Olá, ${primeiroNome}!` : "Olá!"}</p>
   <p style="font-size:15px;line-height:1.65;margin:0 0 20px;color:#333">${p.body}</p>
   ${p.pixCode ? blocoPix(p.pixCode, p.pixExpiraEm) : ""}
   <div style="background:${CLARO};border:1px solid #ddddd8;border-radius:8px;padding:14px 16px;margin:0 0 20px">
    <p style="margin:0 0 6px;font-size:12px;color:#5a5d63;text-transform:uppercase;letter-spacing:.08em">Seu pedido</p>
    <p style="margin:0;font-size:17px;font-weight:bold;color:${ESCURO}">Nº ${esc(p.orderId)}</p>
    ${p.produto ? `<p style="margin:6px 0 0;font-size:14px;color:#333">${esc(p.produto)}</p>` : ""}
    ${bloco}
   </div>
   <div style="text-align:center;margin:0 0 8px">
    <a href="${esc(p.link)}" style="display:inline-block;background:${DESTAQUE};color:${TINTA_DESTAQUE};text-decoration:none;padding:14px 28px;border-radius:6px;font-size:15px;font-weight:bold;text-transform:uppercase;letter-spacing:.04em">${esc(p.botao || "Acompanhar meu pedido")}</a>
   </div>
   <p style="text-align:center;font-size:12px;color:#8a8a8a;margin:8px 0 0;word-break:break-all">ou copie este link: ${esc(p.link)}</p>
  </div>
  <div style="background:${CLARO};border-top:1px solid #ddddd8;padding:18px 24px">
   <p style="font-size:12px;line-height:1.6;color:#5a5d63;margin:0">Você recebeu este e-mail porque comprou na ${esc(SITE.storeName)}. Dúvidas sobre o pedido? Responda este e-mail.</p>
   ${p.sair ? `<p style="font-size:12px;line-height:1.6;color:#5a5d63;margin:8px 0 0"><a href="${esc(p.sair)}" style="color:#5a5d63">Não quero receber mensagens como esta</a></p>` : ""}
  </div>
 </div>
</div>`;
}

async function registrarFalha(orderId: string, etapa: string, motivo: string, detalhe?: string) {
  try {
    await kv.set(chaveFalha(orderId, etapa), { em: Date.now(), motivo, detalhe: String(detalhe ?? "").slice(0, 300) }, { ex: FALHA_TTL });
  } catch (e) {
    console.error("[resend] não consegui registrar a falha:", orderId, etapa, e);
  }
}

/** A frase útil da Resend vem em "message" no corpo JSON. */
function mensagemResend(texto: string): string {
  return texto.match(/"message"\s*:\s*"([^"]{0,200})"/)?.[1] || texto.slice(0, 200);
}

/**
 * Uma chamada à Resend com as regras que custaram caro na Ritual da Pele:
 * - cota DIÁRIA estourada não se repete (só volta na virada do dia);
 * - 429 de ritmo e 5xx repetem com espera aleatória (sem jitter, a repetição
 *   refaz a rajada que causou o 429);
 * - qualquer outro 4xx é payload/domínio ruim: repetir não adianta.
 */
async function postarResend(corpo: Record<string, unknown>, idempotencia?: string): Promise<{ ok: true } | { ok: false; motivo: string; detalhe: string }> {
  const apiKey = env("RESEND_API_KEY");
  if (!apiKey) return { ok: false, motivo: "RESEND_API_KEY não configurada", detalhe: "" };
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  if (idempotencia) headers["Idempotency-Key"] = idempotencia;

  let ultimo = { motivo: "não enviado", detalhe: "" };
  for (const espera of [0, 800, 2400]) {
    if (espera) await new Promise((r) => setTimeout(r, espera + Math.floor(Math.random() * 700)));
    try {
      const resp = await fetch(RESEND_API, { method: "POST", headers, body: JSON.stringify(corpo) });
      if (resp.ok) return { ok: true };
      const texto = await resp.text();
      if (/daily_quota_exceeded|sending quota/i.test(texto)) {
        return { ok: false, motivo: "cota diária da Resend esgotada", detalhe: texto };
      }
      ultimo = { motivo: `Resend ${resp.status}: ${mensagemResend(texto)}`, detalhe: texto };
      if (!(resp.status === 429 || resp.status >= 500)) break;
    } catch (err) {
      ultimo = { motivo: "falha de rede ao chamar a Resend", detalhe: err instanceof Error ? err.message : String(err) };
    }
  }
  return { ok: false, ...ultimo };
}

function nomeProduto(order: PedidoParaEmail) {
  const base = order.offer?.name
    ? (order.offer.quantity && order.offer.quantity > 1 ? `${order.offer.quantity}x ` : "") + order.offer.name
    : SITE.productName;
  // Upsell: só o nome (antes do parêntese com os itens); brinde por extenso.
  const extra = String(order.bump ?? "").split(" (")[0];
  return base + (extra ? ` + ${extra}` : "") + (order.brinde ? ` + brinde: ${order.brinde}` : "");
}

function prazoPorExtenso(expiraEm?: number | null) {
  return horaLimite(expiraEm) ?? "por pouco tempo";
}

/**
 * Envia o e-mail da etapa `statusId`, NO MÁXIMO UMA VEZ por (pedido, etapa).
 *
 * A trava `email-sent:<pedido>:<etapa>` é gravada com NX antes de chamar a
 * Resend: webhook reentregue, cron e admin disputando a mesma transição — só
 * um passa. Falhou? A trava é solta e a falha fica registrada por 30 dias em
 * `email-falhou:<pedido>:<etapa>`, que o admin lista e o cron reenvia.
 *
 * `forcar`: reenvio manual do admin — ignora a trava de duplicado.
 */
export async function sendOrderStatusEmail(
  order: PedidoParaEmail,
  statusId: string,
  host: string,
  opts: { forcar?: boolean } = {}
): Promise<ResultadoEmail> {
  const def = getOrderStatus(statusId);
  if (!def?.email) return { enviado: false, motivo: "etapa sem e-mail" };
  const to = String(order.cliente?.email ?? "").trim();
  if (!to || !to.includes("@")) return { enviado: false, motivo: "pedido sem e-mail do cliente" };
  if (statusId === "pending" && !order.pixCode) return { enviado: false, motivo: "pedido sem código Pix guardado" };
  if (!env("RESEND_API_KEY")) {
    console.warn("[resend] RESEND_API_KEY ausente — e-mail não enviado:", statusId, order.orderId);
    await registrarFalha(order.orderId, statusId, "RESEND_API_KEY não configurada");
    return { enviado: false, motivo: "RESEND_API_KEY não configurada" };
  }

  const trava = chaveEnviado(order.orderId, statusId);
  if (opts.forcar) await kv.del(trava);
  const primeira = await kv.set(trava, Date.now(), { nx: true, ex: TRAVA_TTL });
  if (primeira === null) return { enviado: false, motivo: "já enviado antes (duplicado evitado)" };

  const link = linkDeRastreio(order.orderId, host);
  const mostraRastreio = COM_RASTREIO.has(statusId);
  const replyTo = env("RESEND_REPLY_TO");

  const r = await postarResend(
    {
      from: remetente(),
      to,
      subject: def.email.subject.replace("{orderId}", order.orderId),
      html: html({
        nome: String(order.cliente?.nome ?? ""),
        orderId: order.orderId,
        heading: def.email.heading,
        body: def.email.body
          .replace("{prazo}", esc(prazoPorExtenso(order.pixExpiraEm)))
          .replaceAll("{orderId}", esc(order.orderId))
          .replace("{guia}", order.guia && SITE.guia ? blocoGuia(statusId) : ""),
        link,
        produto: nomeProduto(order),
        rastreio: mostraRastreio ? order.trackingCode : null,
        transportadora: mostraRastreio ? order.carrier : null,
        urlTransportadora: mostraRastreio ? order.carrierUrl : null,
        // Só no pendente: repetir o código depois de pago faz a pessoa pagar de novo.
        pixCode: statusId === "pending" ? order.pixCode : null,
        pixExpiraEm: order.pixExpiraEm,
      }),
      ...(replyTo ? { reply_to: replyTo } : {}),
    },
    // Reenvio forçado precisa de chave nova, senão a própria Resend o descarta por 24h.
    opts.forcar ? `${trava}:${Date.now()}` : trava
  );

  if (r.ok) {
    await kv.del(chaveFalha(order.orderId, statusId)).catch(() => {});
    console.log("[resend] enviado |", order.orderId, statusId, "->", to);
    return { enviado: true };
  }
  await kv.del(trava);
  console.error(`[resend] falhou ${order.orderId}/${statusId}: ${r.motivo}`);
  await registrarFalha(order.orderId, statusId, r.motivo, r.detalhe);
  return { enviado: false, motivo: r.motivo };
}

/* ─────────────────────────────────────────────────────────────────────────
   LEMBRETE DE PIX — disparado à mão pelo admin, UMA vez por pedido.
   Quem decide se ainda vale mandar é api/admin/lembrete.ts, que confere no
   PSP que a cobrança está ATIVA: com código de 30 minutos, a janela é curta,
   e lembrete com código morto é pior que silêncio.
   ───────────────────────────────────────────────────────────────────────── */
export async function sendPixReminderEmail(order: PedidoParaEmail, host: string): Promise<ResultadoEmail> {
  const to = String(order.cliente?.email ?? "").trim();
  if (!to.includes("@")) return { enviado: false, motivo: "pedido sem e-mail do cliente" };
  if (!order.pixCode) return { enviado: false, motivo: "pedido sem código Pix guardado" };

  const trava = chaveEnviado(order.orderId, "pix-lembrete");
  const primeira = await kv.set(trava, Date.now(), { nx: true, ex: FALHA_TTL });
  if (primeira === null) return { enviado: false, motivo: "lembrete já enviado para este pedido" };

  const primeiroNome = (order.cliente?.nome ?? "").trim().split(/\s+/)[0] || "";
  const produto = nomeProduto(order);
  const replyTo = env("RESEND_REPLY_TO");
  const body = `Você gerou o Pix da sua <strong>${esc(produto)}</strong> e o pagamento ainda não chegou.
    <br><br><strong>O pedido continua reservado e o código abaixo ainda está valendo</strong> — conferimos agora, antes de escrever. Mas ele vale ${esc(prazoPorExtenso(order.pixExpiraEm))}; depois disso para de funcionar.
    <br><br>Se alguma coisa travou — o código não colou, ficou uma dúvida — é só responder este e-mail.`;

  const r = await postarResend(
    {
      from: remetente(),
      to,
      subject: `${SITE.storeName} • Seu pedido ${order.orderId} ainda está reservado`,
      html: html({
        nome: String(order.cliente?.nome ?? ""),
        orderId: order.orderId,
        /* Estava "sua maleta" cravado — texto do SOARFLY no motor. Agora sai do
           config, e o gênero vem certo: "seu kit ... separado". */
        heading: primeiroNome ? `${esc(primeiroNome)}, seu ${SITE.productShort} ainda está separado` : `Seu ${SITE.productShort} ainda está separado`,
        body,
        link: linkDeRastreio(order.orderId, host),
        produto,
        pixCode: order.pixCode,
        pixExpiraEm: order.pixExpiraEm,
      }),
      ...(replyTo ? { reply_to: replyTo } : {}),
    },
    trava
  );
  if (r.ok) return { enviado: true };
  await kv.del(trava);
  await registrarFalha(order.orderId, "pix-lembrete", r.motivo, r.detalhe);
  return { enviado: false, motivo: r.motivo };
}

/* ─────────────────────────────────────────────────────────────────────────
   RECUPERAÇÃO DE VENDA — 1 hora depois do Pix gerado (lib/recuperacao.ts).
   Quem decide SE manda é a fila (status conferido na fonte, opt-out, outro
   pedido pago, cliente já contatado). Aqui só a trava final de UMA vez por
   pedido e o texto. O texto não afirma que o Pix "está pendente": com 1 hora
   ele já venceu (vale 15 min) — por isso o botão leva para a loja, e não um
   código morto.
   ───────────────────────────────────────────────────────────────────────── */
export const TEXTO_RECUPERACAO = (primeiroNome: string, produto: string) =>
  `Oi${primeiroNome ? ", " + primeiroNome : ""}, tudo bem? 😊 Aqui é da ${SITE.storeName}. Passando para saber se você conseguiu finalizar seu pedido do ${produto}. Caso tenha tido alguma dificuldade com o Pix ou com o pagamento, posso te ajudar!`;

export async function sendRecuperacaoEmail(
  order: PedidoParaEmail,
  host: string,
  links: { loja: string; sair: string | null; whatsapp: string | null }
): Promise<ResultadoEmail & { assunto?: string; texto?: string }> {
  const to = String(order.cliente?.email ?? "").trim();
  if (!to.includes("@")) return { enviado: false, motivo: "pedido sem e-mail do cliente" };
  if (!env("RESEND_API_KEY")) return { enviado: false, motivo: "RESEND_API_KEY não configurada" };

  const trava = chaveEnviado(order.orderId, "recuperacao");
  const primeira = await kv.set(trava, Date.now(), { nx: true, ex: FALHA_TTL });
  if (primeira === null) return { enviado: false, motivo: "recuperação já enviada para este pedido" };

  const primeiroNome = (order.cliente?.nome ?? "").trim().split(/\s+/)[0] || "";
  const produto = nomeProduto(order);
  const texto = TEXTO_RECUPERACAO(primeiroNome, produto);
  const assunto = `${SITE.storeName} • Conseguiu finalizar seu pedido?`;
  const replyTo = env("RESEND_REPLY_TO");
  const corpo =
    esc(texto) +
    `<br><br>O Pix que você gerou vale só alguns minutos, então se ele venceu é só voltar à loja e gerar um novo — leva menos de um minuto.` +
    (links.whatsapp
      ? `<br><br>Prefere falar com a gente? <a href="${esc(links.whatsapp)}" style="color:${ESCURO};font-weight:700">Chame no WhatsApp</a> ou responda este e-mail.`
      : `<br><br>Prefere falar com a gente? É só responder este e-mail.`);

  const r = await postarResend(
    {
      from: remetente(),
      to,
      subject: assunto,
      html: html({
        nome: "",
        orderId: order.orderId,
        heading: "Conseguiu finalizar seu pedido?",
        body: corpo,
        link: links.loja,
        botao: "Voltar para a loja",
        produto,
        sair: links.sair,
      }),
      ...(replyTo ? { reply_to: replyTo } : {}),
    },
    trava
  );
  if (r.ok) return { enviado: true, assunto, texto };
  await kv.del(trava);
  await registrarFalha(order.orderId, "recuperacao", r.motivo, r.detalhe);
  return { enviado: false, motivo: r.motivo };
}

/** E-mail de teste do admin: prova de ponta a ponta que a Resend entrega. */
export async function sendTestEmail(to: string, host: string): Promise<ResultadoEmail> {
  if (!to.includes("@")) return { enviado: false, motivo: "e-mail inválido" };
  const replyTo = env("RESEND_REPLY_TO");
  const r = await postarResend({
    from: remetente(),
    to,
    subject: `${SITE.storeName} • Teste de e-mail do painel`,
    html: html({
      nome: "",
      orderId: `${SITE.orderIdPrefix}TESTE`,
      heading: "Teste de e-mail ✅",
      body: `Se você está lendo isto, a Resend está entregando os e-mails da <strong>${esc(SITE.storeName)}</strong> com o remetente configurado. Este é o mesmo layout que o cliente recebe.`,
      link: `https://${host}/rastrear-pedido`,
      produto: SITE.productName,
    }),
    ...(replyTo ? { reply_to: replyTo } : {}),
  });
  return r.ok ? { enviado: true } : { enviado: false, motivo: r.motivo };
}
