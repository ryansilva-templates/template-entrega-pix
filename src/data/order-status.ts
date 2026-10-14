import { SITE } from "../config/site.config";
import { ETAPAS, FINAIS, PROBLEMAS, labelDe } from "../lib/pipeline";

const PRODUCT = SITE.productName;
const STORE = SITE.storeName;

export interface OrderStatusDef {
  id: string;
  label: string;
  isProblem?: boolean;
  /** Se ausente, nenhum e-mail sai nessa transição. */
  email?: { subject: string; heading: string; body: string };
}

/* ─────────────────────────────────────────────────────────────────────────────
   COPY DOS E-MAILS
   Diferenças deliberadas em relação ao template original:
   - as etapas andam pelo
     relógio (SITE.relogio) e o código de rastreio é o número do pedido. Os
     textos não citam transportadora nem prometem rastreio fora da nossa
     página — o link do botão é o único lugar onde o código funciona;
   - sem a etapa "Caminhão roubado" (não é uma etapa de entrega; é um
     acontecimento, e se acontecer é tratado caso a caso, fora da automação);
   - o e-mail de extravio não promete prazo nem desfecho que a loja não
     definiu — ⚠️ CONFIRME o texto de `lost` com a sua política antes de usar.
   ───────────────────────────────────────────────────────────────────────────── */
/* O brinde vai no e-mail de pagamento aprovado e no de entregue. A LP não
   manda e-mail; até aqui o guia só aparecia na tela de pagamento confirmado,
   que a pessoa fecha e nunca mais acha. No "entregue" ele chega na hora exata
   em que serve. Esta oferta não tem brinde (SITE.brinde = null). */
const B = SITE.brinde;
const linkBrinde = (frase: string) =>
  B ? `<br><br>${frase} <a href="${B.url}" style="color:${SITE.email.brandAccent};font-weight:700">Abrir o ${B.nome}</a>` : "";

/* {guia}: trocado em lib/resend.ts pelo link do guia SÓ nos pedidos de kit com
   guia (order.guia); nos outros some sem deixar rastro. */
const EMAILS: Record<string, OrderStatusDef["email"]> = {
  /* "Seu código Pix" — a rede de segurança da compra, como na Ritual da Pele:
     quem fecha a aba recebe o copia-e-cola na caixa de entrada.
     {prazo} é trocado pelo prazo REAL lido no PSP a cada envio (hoje 30
     minutos, conferido numa cobrança real em 20/09/2026). Prazo escrito à mão
     mentiu em todas as trocas de adquirente. */
  pending: {
    subject: `${STORE} • Seu código Pix do pedido {orderId}`,
    heading: "Seu código Pix está aqui 💳",
    body: `O seu <strong>${PRODUCT}</strong> está reservado — falta só o pagamento. Copie o código abaixo e cole no app do seu banco, em <strong>Pix Copia e Cola</strong>.<br><br><strong>O código vale {prazo}.</strong> Depois disso ele para de funcionar e é preciso gerar outro na loja.<br><br>Assim que o pagamento cair, a gente te avisa por aqui.`,
  },
  paid: {
    subject: `${STORE} • Pagamento confirmado — pedido {orderId}`,
    heading: "Pagamento confirmado ✅",
    body: `Recebemos o pagamento do seu <strong>${PRODUCT}</strong>. O pedido entrou na fila de separação. Você vai receber um e-mail a cada etapa da entrega, e pode acompanhar tudo pelo botão abaixo.{guia}` +
      linkBrinde(""),
  },
  shipped: {
    subject: `${STORE} • Seu pedido {orderId} foi enviado`,
    heading: "Seu pedido foi enviado 🚚",
    body: `O seu <strong>${PRODUCT}</strong> saiu do nosso estoque. O código de rastreio é o número do seu pedido, <strong>{orderId}</strong>, e cada etapa da entrega aparece no botão abaixo — você recebe um e-mail quando ela mudar.`,
  },
  in_transit: {
    subject: `${STORE} • Seu pedido {orderId} está em trânsito`,
    heading: "Seu pedido está a caminho",
    body: `O seu <strong>${PRODUCT}</strong> está em trânsito para a sua cidade.`,
  },
  out_for_delivery: {
    subject: `${STORE} • Seu pedido {orderId} saiu para entrega`,
    heading: "Seu pedido saiu para entrega 📦",
    body: `O seu <strong>${PRODUCT}</strong> saiu para entrega. Se puder, deixe alguém no endereço para receber.`,
  },
  /* Entregue: a rotina vem de SITE.comoUsarHtml (copiada da LP). */
  delivered: {
    subject: `${STORE} • Pedido {orderId} entregue`,
    heading: "Seu pedido foi entregue 🎉",
    body: `O seu <strong>${PRODUCT}</strong> foi entregue no endereço informado.${SITE.comoUsarHtml ? "<br><br>" + SITE.comoUsarHtml : ""}{guia}` +
      `<br><br>Se algo não estiver certo, é só responder este e-mail.`,
  },
  /* ⚠️ CONFIRME com a sua política antes de usar. O texto não promete prazo.
     Oferece reenvio OU reembolso porque é o que o CDC já garante quando o
     produto não chega (a loja responde pelo transporte até a entrega) — não é
     uma promessa nova, é a lei escrita em português. */
  lost: {
    subject: `${STORE} • Atualização importante sobre o pedido {orderId}`,
    heading: "Houve um problema na entrega do seu pedido",
    body: `Houve um problema no transporte do seu <strong>${PRODUCT}</strong> e ele não chegou até você. Isso não é responsabilidade sua: responda este e-mail e a gente combina o <strong>reenvio ou o reembolso</strong>, como você preferir. Você não precisa fazer nenhuma compra nova.`,
  },
  refunded: {
    subject: `${STORE} • Reembolso do pedido {orderId}`,
    heading: "Seu reembolso foi processado",
    body: `O valor do seu pedido <strong>${PRODUCT}</strong> foi reembolsado. Dependendo do seu banco, pode levar alguns dias para aparecer.`,
  },
};

export const ORDER_STATUSES: OrderStatusDef[] = [
  ...ETAPAS.map((e) => ({ id: e.id, label: e.label, email: EMAILS[e.id] })),
  ...Object.values(FINAIS).map((e) => ({ id: e.id, label: e.label, email: EMAILS[e.id] })),
  ...Object.values(PROBLEMAS).map((e) => ({ id: e.id, label: e.label, isProblem: true, email: EMAILS[e.id] })),
];

export function getOrderStatus(id: string): OrderStatusDef | undefined {
  return ORDER_STATUSES.find((s) => s.id === id);
}

export { labelDe };
