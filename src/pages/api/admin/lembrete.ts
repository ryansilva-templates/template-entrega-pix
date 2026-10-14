import type { APIRoute } from "astro";
import { kv } from "@vercel/kv";
import { isValidAdminSession, ADMIN_COOKIE } from "../../../lib/admin-auth";
import { sendPixReminderEmail, chaveEnviado } from "../../../lib/resend";
import { consultarCobranca } from "../../../lib/pix-psp";
import { SITE } from "../../../config/site.config";

export const prerender = false;

/**
 * LEMBRETE DE PIX — disparado à mão, uma vez por pedido (como na Ritual da Pele).
 *
 * A REGRA QUE NÃO PODE FALHAR: nunca mandar para quem já pagou, nem mandar
 * código morto. O status é relido do banco no clique e, em seguida, conferido
 * no PSP — que é a fonte real (na Ritual, 6 de 9 Pix pagos ainda constavam
 * PENDING na Korvex). Só passa quem está ATIVA.
 *
 * Com esta adquirente o código vive 30 minutos: na prática o lembrete serve
 * para quem gerou o Pix há pouco. O resto aparece como "expirado" — não é
 * erro, é o prazo da cobrança.
 */
const MAX_LOTE = 50;
const CHUNK = 5;
const PAUSA_MS = 550;

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });

async function pendentesSemLembrete(): Promise<string[]> {
  const ids = ((await kv.zrange<string[]>(SITE.kvIndexKey, 0, 499, { rev: true })) ?? []).filter(Boolean);
  const alvos: string[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const b = ids.slice(i, i + 100);
    if (!b.length) break;
    const [pedidos, travas] = await Promise.all([
      kv.mget<any[]>(...b.map((id) => `order:${id}`)),
      kv.mget<any[]>(...b.map((id) => chaveEnviado(id, "pix-lembrete"))),
    ]);
    b.forEach((id, j) => {
      if (pedidos[j]?.status === "pending" && pedidos[j]?.pixCode && (travas[j] === null || travas[j] === undefined)) alvos.push(id);
    });
  }
  return alvos;
}

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!(await isValidAdminSession(cookies.get(ADMIN_COOKIE)?.value))) return json({ error: "Não autenticado." }, 401);
  let body: any;
  try { body = await request.json(); } catch { return json({ error: "Corpo inválido." }, 400); }
  const host = request.headers.get("host") || SITE.productionHost;

  let ids: string[] = body?.scope === "all-pending"
    ? await pendentesSemLembrete()
    : (Array.isArray(body?.orderIds) ? body.orderIds.map((x: unknown) => String(x).toUpperCase()) : []);
  if (!ids.length) return json({ error: "Nenhum pedido aguardando Pix sem lembrete." }, 400);
  const restantes = Math.max(0, ids.length - MAX_LOTE);
  ids = ids.slice(0, MAX_LOTE);

  const cont = { enviado: 0, "ja-pago": 0, expirado: 0, "nao-verificado": 0, "nao-pendente": 0, "ja-enviado": 0, erro: 0 };
  const jaPagos: string[] = [];
  let motivo: string | null = null;

  for (let i = 0; i < ids.length; i += CHUNK) {
    if (i > 0) await new Promise((r) => setTimeout(r, PAUSA_MS));
    await Promise.all(ids.slice(i, i + CHUNK).map(async (orderId) => {
      const p = (await kv.get(`order:${orderId}`)) as Record<string, any> | null;
      if (!p || p.status !== "pending") { cont["nao-pendente"]++; return; }
      const c = await consultarCobranca(p.pixCode);
      if (c.estado === "paga") { cont["ja-pago"]++; jaPagos.push(orderId); return; }
      if (c.estado === "expirada") { cont.expirado++; return; }
      // Sem conferência não envia: errar o e-mail é pior que esperar o próximo clique.
      if (c.estado !== "ativa") { cont["nao-verificado"]++; return; }
      const r = await sendPixReminderEmail({ ...(p as any), orderId, pixExpiraEm: c.expiraEm ?? p.pixExpiraEm }, host);
      if (r.enviado) cont.enviado++;
      else if (/já enviado/.test(r.motivo)) cont["ja-enviado"]++;
      else { cont.erro++; motivo = motivo ?? r.motivo; }
    }));
  }
  if (jaPagos.length) console.warn("[lembrete] pagos no PSP e pendentes aqui (conferir na Korvex):", jaPagos.join(", "));
  return json({ ok: true, total: ids.length, restantes, ...cont, jaPagos, motivo });
};
