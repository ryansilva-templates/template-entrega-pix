import type { APIRoute } from "astro";
import { destroyAdminSession, ADMIN_COOKIE } from "../../../lib/admin-auth";

export const prerender = false;

export const POST: APIRoute = async ({ cookies }) => {
  const token = cookies.get(ADMIN_COOKIE)?.value;
  await destroyAdminSession(token);
  cookies.delete(ADMIN_COOKIE, { path: "/" });
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
};
