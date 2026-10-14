import type { APIRoute } from "astro";
import { SITE } from "../../config/site.config";
import { responder, dentroDoLimite, type Contexto } from "../../lib/atendimento";

export const prerender = false;

/**
 * Chat de atendimento do site (balão em sualoja.com.br e na página de
 * rastreio). Público, mas: limite de 20 mensagens/min por IP, texto até 500
 * caracteres, e pedido só aparece com nº + e-mail (ou link assinado).
 * CORS só para a loja e para este próprio domínio.
 */
const ORIGENS = new Set([SITE.storeUrl, `https://${SITE.productionHost}`, "https://www.sualoja.com.br"]);

function cors(origem: string | null): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json", "Cache-Control": "no-store", Vary: "Origin" };
  if (origem && ORIGENS.has(origem)) {
    h["Access-Control-Allow-Origin"] = origem;
    h["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Content-Type";
  }
  return h;
}

export const OPTIONS: APIRoute = async ({ request }) => new Response(null, { status: 204, headers: cors(request.headers.get("origin")) });

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const headers = cors(request.headers.get("origin"));
  let corpo: any;
  try { corpo = await request.json(); } catch { return new Response(JSON.stringify({ error: "Corpo inválido." }), { status: 400, headers }); }

  const texto = String(corpo?.texto ?? "").trim().slice(0, 500);
  if (!texto) return new Response(JSON.stringify({ error: "Mensagem vazia." }), { status: 400, headers });

  let ip = "";
  try { ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || clientAddress || ""; } catch { /* sem IP em teste */ }
  if (!(await dentroDoLimite(ip))) {
    return new Response(JSON.stringify({ error: "Muitas mensagens em pouco tempo. Espere um minutinho." }), { status: 429, headers });
  }

  const c = corpo?.contexto ?? {};
  const ctx: Contexto = {
    orderId: c.orderId ? String(c.orderId).slice(0, 64) : null,
    email: c.email ? String(c.email).slice(0, 160) : null,
    t: c.t ? String(c.t).slice(0, 64) : null,
    aguardando: c.aguardando ?? null,
  };
  try {
    const r = await responder(texto, ctx, SITE.productionHost);
    return new Response(JSON.stringify(r), { status: 200, headers });
  } catch (e) {
    console.error("[atendimento] erro:", e);
    return new Response(
      JSON.stringify({ resposta: `Tive um problema para responder agora. Fala com a gente no WhatsApp: https://wa.me/${SITE.whatsappLoja}`, intencao: "erro", humano: true, contexto: ctx }),
      { status: 200, headers }
    );
  }
};
