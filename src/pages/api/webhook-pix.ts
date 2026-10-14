import type { APIRoute, APIContext } from "astro";
import { waitUntil } from "@vercel/functions";
import { lembretesAutomaticos } from "../../lib/lembrete-auto";
import { SITE } from "../../config/site.config";
import { env } from "../../lib/env";
import { lerPedido, gravarPedido, mudarEtapa } from "../../lib/etapas";
import { consultarCobranca } from "../../lib/pix-psp";
import { agendarRecuperacao, cancelarRecuperacao, processarFila } from "../../lib/recuperacao";
import { indexarCliente } from "../../lib/contato";

export const prerender = false;

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  ENTRADA DE PEDIDOS — webhook da Korvex
 * ─────────────────────────────────────────────────────────────────────────────
 *  A venda acontece na LP (sualoja.com.br), não aqui. Quando a Korvex
 *  avisa, ESTE handler cria o pedido a partir do payload e o põe no índice do
 *  admin. Base: a versão de produção de entrega-ritualdapele, que já corrigia
 *  três defeitos do template:
 *
 *   1. o template aceitava QUALQUER POST — quem achasse a URL marcava pedido
 *      como pago e disparava o e-mail. Aqui exige KORVEX_WEBHOOK_SECRET,
 *      comparado em tempo constante, e falha FECHADO se ele não existir;
 *   2. o template só atualizava pedido criado pelo próprio checkout dele; aqui
 *      o pedido nasce do payload (endereço vem em trackProps.entrega_*);
 *   3. pedido de outra loja é ignorado com 200 (pelo prefixo).
 *
 *  E um quarto, novo: STATUS NÃO RETROCEDE. A versão anterior só barrava
 *  "pending" depois de pago; um TRANSACTION_PAID reentregue com o pedido já
 *  "em trânsito" o rebaixava para "pago". Agora quem decide é lib/pipeline.ts.
 *
 *  Não envia nada para a UTMify nem para a Meta: quem faz isso é a LP, e
 *  fazer aqui também duplicaria o pedido lá.
 */

const STATUS_MAP: Record<string, string> = {
  COMPLETED: "paid",
  PENDING: "pending",
  FAILED: "failed",
  /* Pix que venceu sem pagamento: a Korvex manda TRANSACTION_CANCELED com status
     CANCELED ~15 min depois (provado no Popozuda em 07/10/2026). Sem este mapa o
     pedido ficava "Pedido realizado" para sempre no admin. */
  CANCELED: "failed",
  REFUNDED: "refunded",
  CHARGED_BACK: "charged_back",
};

function segredoConfere(enviado: unknown, esperado: string): boolean {
  const a = String(enviado ?? "");
  if (!a || !esperado || a.length !== esperado.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ esperado.charCodeAt(i);
  return diff === 0;
}

const texto = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max);
const digitos = (v: unknown) => String(v ?? "").replace(/\D/g, "");
const quando = (iso: unknown): number | null => {
  const t = Date.parse(String(iso ?? ""));
  return Number.isFinite(t) ? t : null;
};
/** Valor em REAIS como a Korvex manda (55.16), aceitando string com vírgula. */
function valorEmReais(bruto: unknown): number | null {
  if (bruto === null || bruto === undefined) return null;
  let n: number;
  if (typeof bruto === "number") n = bruto;
  else {
    const s = String(bruto).trim().replace(/[^\d,.-]/g, "");
    if (!s) return null;
    n = s.includes(",") ? Number(s.replace(/\./g, "").replace(",", ".")) : Number(s);
  }
  return Number.isFinite(n) && n > 0 ? n : null;
}
const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });

/* Todo aviso da Korvex (de qualquer loja, autenticado ou não) aproveita para
   lembrar os Pix pendentes há 10+ min — ver lib/lembrete-auto.ts. Roda depois
   da resposta (waitUntil), então não atrasa a Korvex nem muda o que ela recebe. */
export const POST: APIRoute = async (ctx) => {
  const resposta = await processar(ctx);
  const host = ctx.request.headers.get("host") || SITE.productionHost;
  /* Todo aviso também empurra a fila de recuperação (lib/recuperacao.ts) — é a
     rede de segurança caso o gatilho externo de 5 em 5 min falte. */
  waitUntil(
    Promise.all([
      SITE.lembrete10min
        ? lembretesAutomaticos(host).catch((e) => console.error("[lembrete-auto] falhou:", e instanceof Error ? e.message : e))
        : Promise.resolve(),
      processarFila(host).catch((e) => console.error("[recuperacao] falhou:", e instanceof Error ? e.message : e)),
    ])
  );
  return resposta;
};

async function processar({ request, url }: APIContext): Promise<Response> {
  const esperado = env("KORVEX_WEBHOOK_SECRET");
  if (!esperado) {
    console.error("[webhook-pix] KORVEX_WEBHOOK_SECRET não configurado — recusando.");
    return json({ error: "Webhook não configurado." }, 503);
  }

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Payload inválido." }, 400);
  }

  // A Korvex manda um `token` DELA no corpo; o nosso vem no ?k= da URL.
  const candidatos = [url.searchParams.get("k"), payload?.token, request.headers.get("x-webhook-secret")];
  if (!candidatos.some((c) => segredoConfere(c, esperado))) {
    console.warn("[webhook-pix] recusado: nenhum segredo bateu.");
    return json({ error: "Não autorizado." }, 401);
  }

  const track = payload?.trackProps ?? {};
  const orderId = texto(track.orderId || payload?.transaction?.identifier, 64).toUpperCase();
  if (!orderId) return json({ error: "trackProps.orderId ausente no payload." }, 400);

  if (!orderId.startsWith(SITE.orderIdPrefix.toUpperCase())) {
    console.warn("[webhook-pix] pedido de outra loja — ignorado:", orderId);
    return json({ ok: true, ignorado: "pedido de outra loja", orderId });
  }

  const statusKorvex = String(payload?.transaction?.status ?? "").toUpperCase();
  const novoStatus = STATUS_MAP[statusKorvex] ?? null;
  const agora = Date.now();
  const atual = await lerPedido(orderId);
  const item = Array.isArray(payload?.orderItems) ? payload.orderItems[0] : null;
  const valor = valorEmReais(payload?.transaction?.amount) ?? valorEmReais((atual as any)?.offer?.amount);

  // Dados do pedido: o que já está gravado vale; o payload só preenche o que falta.
  const pedido: any = {
    ...(atual || {}),
    orderId,
    transactionId: payload?.transaction?.id ?? (atual as any)?.transactionId ?? null,
    event: payload?.event ?? null,
    cliente: (atual as any)?.cliente ?? {
      nome: texto(payload?.client?.name || track.entrega_destinatario, 120),
      email: texto(payload?.client?.email, 160).toLowerCase(),
      telefone: digitos(payload?.client?.phone || track.entrega_telefone),
      cpf: digitos(payload?.client?.cpf),
    },
    endereco: (atual as any)?.endereco ?? {
      linha: texto(track.entrega_endereco, 240),
      cep: digitos(track.entrega_cep),
      cidade: texto(track.entrega_cidade, 80),
      uf: texto(track.entrega_uf, 2).toUpperCase(),
    },
    offer: {
      ...((atual as any)?.offer ?? {
        // A LP da Sua Loja manda o kit como CÓDIGO (trackProps.kit = "kit2");
        // SITE.kits traduz para o nome que a cliente viu na página.
        name: SITE.kits[texto(track.kit, 20)] || texto(item?.product?.name, 120) || SITE.productName,
        quantity: Number(track.unidades) || Number(item?.quantity) || 1,
        /* O que vai na caixa ("2 moedores elétricos inox…", "+ Baggio Café Bourbon 500g")
           e a VOLTAGEM: o aparelho não é bivolt, e separar na errada queima o motor. */
        itens: texto(track.itens, 400) || null,
        voltagem: texto(track.voltagem, 10).toUpperCase() || null,
      }),
      amount: valor,
    },
    shipping: (atual as any)?.shipping ?? { name: texto(track.frete, 80) || null },
    brinde: (atual as any)?.brinde ?? (texto(track.brinde, 120) || SITE.brindeFisico || null),
    /* Upsell do checkout (Produto Extra, 14/10/2026): a LP manda o nome e os itens em
       trackProps.bump. Quem separa o pedido precisa ver que vai mais coisa na caixa. */
    bump: (atual as any)?.bump ?? (texto(track.bump, 300) || null),
    voltagem: (atual as any)?.voltagem ?? (texto(track.voltagem, 10).toUpperCase() || null),
    /* Kit com o guia digital (LP: KITS[i].guia → trackProps.guia = "1"). */
    guia: (atual as any)?.guia ?? (String(track.guia ?? "") === "1"),
    /* Copia-e-cola da cobrança. É o que vai no e-mail "Seu código Pix" e no
       lembrete — sem ele, quem fecha a aba perde o código e teria que
       preencher tudo de novo na loja. A Korvex manda em pixInformation.qrCode. */
    pixCode: (atual as any)?.pixCode ?? (texto(payload?.transaction?.pixInformation?.qrCode, 600) || null),
    pixExpiraEm: (atual as any)?.pixExpiraEm ?? null,
    createdAt: (atual as any)?.createdAt ?? quando(payload?.transaction?.createdAt) ?? agora,
    updatedAt: agora,
  };
  await gravarPedido(pedido);
  // Liga este pedido aos outros do mesmo telefone/e-mail (recuperação e chat).
  await indexarCliente(orderId, pedido.cliente, Number(pedido.createdAt) || agora).catch((e) =>
    console.error("[webhook-pix] índice do cliente falhou:", e instanceof Error ? e.message : e)
  );

  if (!novoStatus) {
    console.warn("[webhook-pix] status desconhecido, dados gravados sem mudar etapa:", statusKorvex, orderId);
    return json({ ok: true, orderId, status: pedido.status ?? null, aviso: "status desconhecido" });
  }

  // `?sememail=1`: importar venda antiga sem mandar o e-mail atrasado.
  let semEmail = url.searchParams.get("sememail") === "1";

  /* Pix pendente: o e-mail só sai se a cobrança estiver ATIVA no PSP, e com o
     prazo real dela. O webhook pode chegar atrasado (ou ser reentregue), e o
     código desta adquirente vive só 30 minutos: mandar "seu código está aqui"
     com um código já pago ou morto é pior que não mandar. PSP fora do ar não
     barra o e-mail (o código acabou de nascer) — só não diz a hora exata. */
  if (novoStatus === "pending" && pedido.pixCode && !semEmail) {
    const c = await consultarCobranca(pedido.pixCode);
    if (c.expiraEm) {
      pedido.pixExpiraEm = c.expiraEm;
      await gravarPedido(pedido);
    }
    if (c.estado === "paga" || c.estado === "expirada") {
      semEmail = true;
      console.warn("[webhook-pix] e-mail do Pix não enviado: cobrança", c.estado, "no PSP |", orderId);
    }
  }
  const em = novoStatus === "paid" ? quando(payload?.transaction?.payedAt) ?? quando(payload?.transaction?.paidAt) ?? agora : agora;

  const r = await mudarEtapa(orderId, novoStatus, "korvex", {
    host: request.headers.get("host") || SITE.productionHost,
    semEmail,
    em,
    nota: `Korvex ${payload?.event ?? statusKorvex}`,
  });

  /* Recuperação de venda (Fase 11): Pix gerado CONFIRMADO pela Korvex agenda a
     checagem de 1 h, contada da criação da cobrança; pago/estornado cancela.
     Vale mesmo se a transição foi recusada (ex.: "pago" reentregue). */
  try {
    if (novoStatus === "pending" && r.ok) {
      await agendarRecuperacao(orderId, quando(payload?.transaction?.createdAt) ?? agora);
    } else if (novoStatus === "paid" || novoStatus === "refunded" || novoStatus === "charged_back") {
      await cancelarRecuperacao(orderId, `Korvex: ${novoStatus}`);
    }
  } catch (e) {
    console.error("[webhook-pix] recuperação:", e instanceof Error ? e.message : e);
  }

  if (!r.ok) {
    // Transição recusada (ex.: reentrega de "pago" com o pedido já em trânsito).
    // 200 de propósito: é entrega válida, só não muda nada — 4xx faria a Korvex reentregar.
    console.warn("[webhook-pix] sem mudança de etapa:", orderId, statusKorvex, "—", r.erro);
    return json({ ok: true, orderId, ignorado: r.erro });
  }
  return json({ ok: true, orderId, status: r.status, mudou: r.mudou });
}
