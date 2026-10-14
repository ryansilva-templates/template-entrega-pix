import type { APIRoute } from "astro";
import { kv } from "@vercel/kv";
import { isValidAdminSession, ADMIN_COOKIE } from "../../../lib/admin-auth";
import { sendOrderStatusEmail, sendTestEmail } from "../../../lib/resend";
import { levantarFalhas, reenviarFalhas } from "../../../lib/emails-falhos";
import { consultarCobranca } from "../../../lib/pix-psp";
import { getOrderStatus } from "../../../data/order-status";
import { SITE } from "../../../config/site.config";

export const prerender = false;

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });

/** GET — lista os e-mails que falharam e ainda podem ser reenviados. */
export const GET: APIRoute = async ({ cookies }) => {
  if (!(await isValidAdminSession(cookies.get(ADMIN_COOKIE)?.value))) return json({ error: "Não autenticado." }, 401);
  return json({ falhas: await levantarFalhas() });
};

/**
 * POST — ações de e-mail do painel:
 *   { acao: "reenviar", orderId }   reenvia o e-mail da etapa ATUAL do pedido
 *   { acao: "reenviar-falhas" }     reenvia tudo que falhou (ainda na mesma etapa)
 *   { acao: "teste", para }         manda um e-mail de teste para você
 */
export const POST: APIRoute = async ({ request, cookies }) => {
  if (!(await isValidAdminSession(cookies.get(ADMIN_COOKIE)?.value))) return json({ error: "Não autenticado." }, 401);
  let body: any;
  try { body = await request.json(); } catch { return json({ error: "Corpo inválido." }, 400); }
  const host = request.headers.get("host") || SITE.productionHost;

  if (body?.acao === "teste") {
    const para = String(body?.para ?? "").trim();
    const r = await sendTestEmail(para, host);
    return r.enviado ? json({ ok: true }) : json({ error: `Não saiu: ${r.motivo}` }, 502);
  }

  if (body?.acao === "reenviar-falhas") {
    return json({ ok: true, ...(await reenviarFalhas(host)) });
  }

  if (body?.acao === "reenviar") {
    const orderId = String(body?.orderId ?? "").trim().toUpperCase();
    const p = (await kv.get(`order:${orderId}`)) as Record<string, any> | null;
    if (!p) return json({ error: "Pedido não encontrado." }, 404);
    if (!getOrderStatus(p.status)?.email) return json({ error: `A etapa "${p.status}" não tem e-mail.` }, 400);

    /* Trava anti clique-duplo: um reenvio manual por pedido+etapa a cada 2 min. */
    const trava = await kv.set(`email-reenvio:${orderId}:${p.status}`, 1, { nx: true, ex: 120 });
    if (trava === null) return json({ error: "Reenviado há menos de 2 minutos — aguarde antes de repetir." }, 429);

    /* Pendente: só com a cobrança ATIVA. Código pago ou morto no e-mail faz a
       pessoa pagar duas vezes ou achar que é golpe. */
    if (p.status === "pending") {
      const c = await consultarCobranca(p.pixCode);
      if (c.estado === "paga") return json({ error: "O PSP diz que este Pix JÁ FOI PAGO — confira na Korvex; não reenvie o código." }, 409);
      if (c.estado === "expirada") return json({ error: "O código Pix deste pedido já expirou. O cliente precisa gerar outro na loja." }, 409);
      if (c.expiraEm) p.pixExpiraEm = c.expiraEm;
    }
    const r = await sendOrderStatusEmail({ ...(p as any), orderId }, p.status, host, { forcar: true });
    return r.enviado ? json({ ok: true }) : json({ error: `Não saiu: ${r.motivo}` }, 502);
  }

  return json({ error: "Ação desconhecida." }, 400);
};
