import { kv } from "@vercel/kv";
import { SITE } from "../config/site.config";
// Chaves com prefixo POR PRODUTO (SITE.kvPrefix). No SOARFLY ele era cravado
// como "soarfly:" aqui e no login.ts — o que só funciona enquanto existe um
// painel por banco. Copiado para outro produto sem trocar, dois painéis no
// mesmo banco dividiriam sessão e bloqueio de login.
const P = SITE.kvPrefix;

export const ADMIN_COOKIE = "admin_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 dias

export async function createAdminSession(): Promise<string> {
  const token = crypto.randomUUID();
  await kv.set(`${P}admin-session:${token}`, "1", { ex: SESSION_TTL_SECONDS });
  return token;
}

export async function isValidAdminSession(token: string | undefined | null): Promise<boolean> {
  if (!token) return false;
  // A sessão é válida se a chave existir no KV. NÃO comparamos com "1": o @vercel/kv
  // faz JSON.parse na leitura e devolveria o número 1, quebrando um `=== "1"`.
  const value = await kv.get(`${P}admin-session:${token}`);
  return value !== null && value !== undefined;
}

export async function destroyAdminSession(token: string | undefined | null): Promise<void> {
  if (!token) return;
  await kv.del(`${P}admin-session:${token}`);
}

export function getSessionTokenFromRequest(request: Request): string | undefined {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return undefined;
  const match = cookieHeader.match(new RegExp(`${ADMIN_COOKIE}=([^;]+)`));
  return match?.[1];
}

export const ADMIN_COOKIE_MAX_AGE = SESSION_TTL_SECONDS;
