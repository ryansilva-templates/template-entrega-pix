import type { APIRoute } from "astro";
import { isValidAdminSession, ADMIN_COOKIE } from "../../../lib/admin-auth";
import { updateOrderStatus, ALLOWED_STATUS } from "../../../lib/update-order";
import { listAttentionOrderIds } from "../../../lib/orders";
import { SITE } from "../../../config/site.config";

export const prerender = false;

// Sanity bound bem acima do tamanho real da loja — só pra evitar payload absurdo,
// não deve ser atingido na prática. Não é o motivo de nenhuma loja real ser barrada.
const MAX_BATCH = 5000;
// Tamanho do lote processado em paralelo por vez (KV + Resend). Evita estourar rate
// limit da Resend e o tempo máximo da function ao marcar centenas de pedidos de uma vez.
const CHUNK_SIZE = 25;
// Status permitidos pra ação em lote (scope=all-attention): confirmar entrega ou
// registrar extravio de carga — cenários que plausivelmente afetam vários pedidos
// de uma vez (mesma leva/caminhão). Outros problemas seguem individuais.
const BULK_ALLOWED_STATUS = new Set(["delivered", "lost"]);

export const POST: APIRoute = async ({ request, cookies }) => {
  const token = cookies.get(ADMIN_COOKIE)?.value;
  if (!(await isValidAdminSession(token))) {
    return new Response(JSON.stringify({ error: "Não autenticado." }), { status: 401 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Corpo da requisição inválido." }), { status: 400 });
  }

  const status = String(body?.status ?? "");
  if (!ALLOWED_STATUS.has(status)) {
    return new Response(JSON.stringify({ error: "Status inválido." }), { status: 400 });
  }

  const host = request.headers.get("host") || SITE.productionHost;

  // scope "all-attention": marca TODOS os pedidos que hoje precisam de ação manual,
  // não só os da página atual — evita depender da paginação no client.
  let orderIds: string[];
  if (body?.scope === "all-attention") {
    if (!BULK_ALLOWED_STATUS.has(status)) {
      return new Response(JSON.stringify({ error: 'Ação em massa só permitida para "entregue" ou "extraviado/roubo" — outros problemas devem ser marcados individualmente.' }), { status: 400 });
    }
    orderIds = await listAttentionOrderIds(host);
  } else {
    orderIds = Array.isArray(body?.orderIds) ? body.orderIds.map(String).filter(Boolean) : [];
  }

  if (orderIds.length === 0) {
    return new Response(JSON.stringify({ error: "Nenhum pedido para atualizar." }), { status: 400 });
  }
  if (orderIds.length > MAX_BATCH) {
    return new Response(JSON.stringify({ error: `Máximo de ${MAX_BATCH} pedidos por vez.` }), { status: 400 });
  }

  // Processa em lotes pequenos (não tudo de uma vez): protege a Resend de rate limit
  // e a function da Vercel de estourar o tempo máximo quando são centenas de pedidos.
  const failed: string[] = [];
  let okCount = 0;
  for (let i = 0; i < orderIds.length; i += CHUNK_SIZE) {
    const chunk = orderIds.slice(i, i + CHUNK_SIZE);
    const results = await Promise.all(chunk.map((orderId) => updateOrderStatus(orderId, status, host)));
    chunk.forEach((orderId, j) => {
      if (results[j].ok) okCount++;
      else failed.push(orderId);
    });
  }

  return new Response(JSON.stringify({ ok: true, updated: okCount, failed }), { status: 200 });
};
