import type { APIRoute } from "astro";
import { kv } from "@vercel/kv";
import { createHash, timingSafeEqual } from "node:crypto";
import { createAdminSession, ADMIN_COOKIE, ADMIN_COOKIE_MAX_AGE } from "../../../lib/admin-auth";
import { env } from "../../../lib/env";
import { SITE } from "../../../config/site.config";

export const prerender = false;

/*
 * Duas correções em relação ao template:
 *  - a senha era comparada com `!==` (o tempo de resposta vaza quantos
 *    caracteres batem). Agora compara o SHA-256 das duas em tempo constante;
 *  - não havia limite de tentativas: dava para testar senhas sem parar.
 *    Agora são 5 erros por IP a cada 15 minutos.
 */
const MAX_ERROS = 5;
const JANELA_S = 15 * 60;
const MIN_TAMANHO_SENHA = 12;

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });
const sha = (s: string) => createHash("sha256").update(s).digest();

export const POST: APIRoute = async ({ request, cookies }) => {
  const esperado = env("ADMIN_PASSWORD");
  if (!esperado || esperado.length < MIN_TAMANHO_SENHA) {
    console.error(`[admin/login] ADMIN_PASSWORD ausente ou com menos de ${MIN_TAMANHO_SENHA} caracteres.`);
    return json({ error: "Painel admin não configurado." }, 500);
  }

  const ip = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "sem-ip";
  const chave = `${SITE.kvPrefix}admin-login-erros:${ip}`;
  const erros = Number(await kv.get(chave)) || 0;
  if (erros >= MAX_ERROS) return json({ error: "Muitas tentativas. Tente de novo em 15 minutos." }, 429);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Corpo da requisição inválido." }, 400);
  }

  const confere = timingSafeEqual(sha(String(body?.password ?? "")), sha(esperado));
  if (!confere) {
    const n = await kv.incr(chave);
    if (n === 1) await kv.expire(chave, JANELA_S);
    return json({ error: "Senha incorreta." }, 401);
  }

  await kv.del(chave);
  const token = await createAdminSession();
  cookies.set(ADMIN_COOKIE, token, { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: ADMIN_COOKIE_MAX_AGE });
  return json({ ok: true });
};
