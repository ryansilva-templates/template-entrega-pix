import type { APIRoute } from "astro";
import { isValidAdminSession, ADMIN_COOKIE } from "../../../lib/admin-auth";
import { registrarOptout, removerOptout, pedidosDoCliente, chavesDoCliente } from "../../../lib/contato";
import { cancelarRecuperacao } from "../../../lib/recuperacao";

export const prerender = false;

const json = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });

/** Admin: marcar ou liberar "não contatar" por e-mail e/ou telefone. */
export const POST: APIRoute = async ({ request, cookies }) => {
  if (!(await isValidAdminSession(cookies.get(ADMIN_COOKIE)?.value))) return json({ error: "Não autenticado." }, 401);
  let b: any;
  try { b = await request.json(); } catch { return json({ error: "Corpo inválido." }, 400); }
  const cliente = { email: String(b?.email ?? "").trim(), telefone: String(b?.telefone ?? "").trim() };
  if (!chavesDoCliente(cliente).length) return json({ error: "Informe um e-mail válido ou um telefone com DDD." }, 400);
  if (b?.acao === "liberar") {
    await removerOptout(cliente);
    return json({ ok: true });
  }
  await registrarOptout(cliente, "admin");
  for (const id of await pedidosDoCliente(cliente)) await cancelarRecuperacao(id, "admin marcou não contatar");
  return json({ ok: true });
};
