import type { APIRoute } from "astro";
import { isValidAdminSession, ADMIN_COOKIE } from "../../../lib/admin-auth";
import { updateOrderStatus } from "../../../lib/update-order";
import { SITE } from "../../../config/site.config";

export const prerender = false;

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });

/**
 * Ação individual do admin. Corpo:
 *   { orderId, status? , trackingCode?, carrier?, carrierUrl?, nota? }
 * - trackingCode (pedido pago) → registra o rastreio REAL e marca "enviado";
 * - status: in_transit | out_for_delivery (manual) | delivered | lost (final).
 */
export const POST: APIRoute = async ({ request, cookies }) => {
  if (!(await isValidAdminSession(cookies.get(ADMIN_COOKIE)?.value))) return json({ error: "Não autenticado." }, 401);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Corpo da requisição inválido." }, 400);
  }
  const orderId = String(body?.orderId ?? "").trim().toUpperCase();
  const status = body?.status ? String(body.status) : undefined;
  const rastreio = typeof body?.trackingCode === "string"
    ? { trackingCode: body.trackingCode, carrier: body?.carrier ?? "", carrierUrl: body?.carrierUrl ?? "" }
    : undefined;

  const host = request.headers.get("host") || SITE.productionHost;
  const r = await updateOrderStatus(orderId, status, host, rastreio, body?.nota);
  if (!r.ok) return json({ error: r.error }, r.error === "Pedido não encontrado." ? 404 : 400);
  return json({ ok: true, aviso: r.aviso });
};
