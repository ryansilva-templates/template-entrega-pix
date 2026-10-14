import type { APIRoute } from "astro";
import { lerPedido } from "../../lib/etapas";
import { avancarPeloRelogio } from "../../lib/auto-advance";
import { linhaDoTempo, labelDe } from "../../lib/pipeline";
import { assinaturaConfere } from "../../lib/link-rastreio";

export const prerender = false;

const NAO_ENCONTRADO = "Pedido não encontrado. Confira o código e o e-mail usado na compra.";
const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

/**
 * Visão PÚBLICA do pedido. Só o que o cliente precisa para acompanhar:
 * sem CPF, sem telefone, sem endereço, sem e-mail — o link pode ser encaminhado.
 */
function visaoPublica(p: any) {
  const { passos, problema } = linhaDoTempo(p);
  const atual = passos.find((x) => x.estado === "atual");
  const proximo = passos.find((x) => x.estado === "proximo");
  const carimbos = Object.values(p.statusTimestamps || {}).filter((n): n is number => typeof n === "number");
  return {
    orderId: p.orderId,
    status: p.status,
    statusLabel: labelDe(p.status),
    problema: problema ? { label: problema.label, descricao: problema.descricao } : null,
    atual: atual ? atual.label : labelDe(p.status),
    proximo: proximo ? proximo.label : null,
    passos,
    produto: p.offer?.name ? `${p.offer.name}${p.voltagem ? ` (${p.voltagem})` : ""}` : null,
    quantidade: p.offer?.quantity ?? 1,
    primeiroNome: String(p.cliente?.nome ?? "").split(" ")[0] || null,
    rastreio: p.trackingCode ? { codigo: p.trackingCode, transportadora: p.carrier ?? null, url: p.carrierUrl ?? null } : null,
    ultimaAtualizacao: Math.max(p.updatedAt ?? 0, ...carimbos) || null,
  };
}

/** Link único: /api/rastreio?codigo=AB-...&t=<assinatura> */
export const GET: APIRoute = async ({ url, request }) => {
  const orderId = String(url.searchParams.get("codigo") ?? "").trim().toUpperCase();
  const t = url.searchParams.get("t");
  if (!orderId || !assinaturaConfere(orderId, t)) return json({ error: "Link inválido. Use o código e o e-mail da compra." }, 403);
  // O cron passa 1x por dia; quem abre a página vê a etapa que já venceu.
  const p = await avancarPeloRelogio(orderId, request.headers.get("host") || undefined);
  if (!p) return json({ error: NAO_ENCONTRADO }, 404);
  return json(visaoPublica(p));
};

/** Consulta manual: código + e-mail da compra. */
export const POST: APIRoute = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Corpo da requisição inválido." }, 400);
  }
  const orderId = String(body?.orderId ?? "").trim().toUpperCase();
  const email = String(body?.email ?? "").trim().toLowerCase();
  if (!orderId || !email) return json({ error: "Informe o código do pedido e o e-mail usado na compra." }, 400);

  const p = await lerPedido(orderId);
  const emailDoPedido = String((p as any)?.cliente?.email ?? "").trim().toLowerCase();
  if (!p || !emailDoPedido || emailDoPedido !== email) return json({ error: NAO_ENCONTRADO }, 404);
  return json(visaoPublica((await avancarPeloRelogio(orderId, request.headers.get("host") || undefined)) ?? p));
};
