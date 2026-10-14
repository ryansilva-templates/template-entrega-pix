import type { APIRoute } from "astro";
import { SITE } from "../../../config/site.config";
import { lerPedido } from "../../../lib/etapas";
import { assinaturaSairConfere, registrarOptout, pedidosDoCliente } from "../../../lib/contato";
import { cancelarRecuperacao } from "../../../lib/recuperacao";

export const prerender = false;

/**
 * "Não quero receber mensagens como esta" — link do e-mail de recuperação.
 *
 * GET mostra uma página com UM botão; só o POST grava. Motivo: provedores de
 * e-mail (Outlook, antivírus corporativos) abrem os links sozinhos para checar
 * segurança — se o GET descadastrasse, gente seria descadastrada sem clicar.
 * O link é assinado (HMAC com TRACKING_LINK_SECRET): ninguém descadastra outra
 * pessoa chutando número de pedido.
 *
 * Bloqueia a recuperação e outras mensagens que não são da entrega. Os e-mails
 * da ENTREGA do pedido (pago, enviado, entregue) continuam: são a informação
 * do que a pessoa comprou.
 */
const pagina = (titulo: string, corpo: string, status = 200) =>
  new Response(
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${titulo} · ${SITE.storeName}</title>
<style>body{margin:0;font-family:Arial,Helvetica,sans-serif;background:${SITE.email.brandLight};color:#1a1a1a;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
.c{max-width:420px;background:#fff;border:1px solid #e8dde2;border-radius:16px;padding:28px 24px;text-align:center}
h1{font-size:20px;color:${SITE.email.brandDark};margin:0 0 12px}p{font-size:15px;line-height:1.6;color:#444;margin:0 0 18px}
button,a.b{display:inline-block;border:0;border-radius:100px;padding:14px 26px;font-size:15px;font-weight:700;background:${SITE.email.brandAccent};color:#fff;cursor:pointer;text-decoration:none}</style></head>
<body><div class="c"><h1>${titulo}</h1>${corpo}</div></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
  );

function ler(url: URL) {
  const codigo = String(url.searchParams.get("codigo") ?? "").trim().toUpperCase();
  const t = url.searchParams.get("t");
  return { codigo, t, ok: !!codigo && assinaturaSairConfere(codigo, t) };
}

export const GET: APIRoute = async ({ url }) => {
  const { codigo, t, ok } = ler(url);
  if (!ok) return pagina("Link inválido", `<p>Este link não é válido ou foi alterado.</p>`, 403);
  return pagina(
    "Parar de receber mensagens",
    `<p>Confirme para não receber mais mensagens de lembrete da ${SITE.storeName}. Os avisos de entrega de um pedido pago continuam chegando.</p>
     <form method="post" action="/api/preferencias/sair?codigo=${encodeURIComponent(codigo)}&t=${encodeURIComponent(String(t))}"><button type="submit">Não quero receber</button></form>`
  );
};

export const POST: APIRoute = async ({ url }) => {
  const { codigo, ok } = ler(url);
  if (!ok) return pagina("Link inválido", `<p>Este link não é válido ou foi alterado.</p>`, 403);
  const p = await lerPedido(codigo);
  if (!p) return pagina("Pedido não encontrado", `<p>Não achamos este pedido.</p>`, 404);
  const cliente = { telefone: (p as any).cliente?.telefone, email: (p as any).cliente?.email };
  await registrarOptout(cliente, "email", `link do e-mail, pedido ${codigo}`);
  // Para toda recuperação agendada desta pessoa, não só a deste pedido.
  for (const id of await pedidosDoCliente(cliente)) await cancelarRecuperacao(id, "cliente pediu para não receber (link do e-mail)");
  return pagina("Pronto", `<p>Você não vai mais receber mensagens de lembrete da ${SITE.storeName}.</p><a class="b" href="${SITE.storeUrl}">Voltar para a loja</a>`);
};
