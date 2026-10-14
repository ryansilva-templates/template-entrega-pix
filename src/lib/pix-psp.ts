/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  O CÓDIGO PIX, LIDO ONDE O BANCO LÊ
 * ─────────────────────────────────────────────────────────────────────────────
 *  A Korvex devolve Pix DINÂMICO: o BR Code não traz valor nem prazo, só a URL
 *  do documento da cobrança no PSP (campo 26 → subcampo 25). É esse documento
 *  que o app do banco busca, e ele diz a verdade que a Korvex às vezes não diz:
 *
 *    status ATIVA      → dá para pagar
 *    status CONCLUIDA  → já foi pago (mesmo com a Korvex ainda em PENDING)
 *    qualquer outro    → removido/expirado: o copia-e-cola não paga mais nada
 *
 *  O adquirente muda sem aviso (19/09/2026: canpay, 30 minutos de validade;
 *  antes Atlas/somossimpay, 1 hora; antes woovi, 24 horas). Por isso o prazo
 *  NUNCA é escrito à mão em e-mail: sai de `calendario` de cada cobrança.
 *
 *  Não precisa de credencial: a URL vem do próprio código guardado no pedido.
 */

export function campoEmv(br: string, alvo: string): string | null {
  const s = String(br || "");
  let i = 0;
  while (i + 4 <= s.length) {
    const id = s.slice(i, i + 2);
    const tam = parseInt(s.slice(i + 2, i + 4), 10);
    if (!Number.isInteger(tam) || tam < 0) return null;
    const ini = i + 4;
    const fim = ini + tam;
    if (fim > s.length) return null;
    if (id === alvo) return s.slice(ini, fim);
    i = fim;
  }
  return null;
}

/* Só PSPs conhecidos. A URL vem de dado gravado; buscar qualquer host que
   apareça ali seria um SSRF de graça. Adquirente novo = uma linha aqui. */
// fyhub: adquirente da Korvex desde 06/10/2026 (cobrança real: 900 s de validade).
// magenpay: adquirente da Korvex em 10/10/2026 (cobrança real: 86400 s = 24 h).
const PSPS_CONHECIDOS = /^[a-z0-9.-]+\.(magenpay\.io|fyhub\.com\.br|canpay\.com\.br|somossimpay\.com\.br|woovi\.com|openpix\.com(\.br)?)\//i;

export function urlDoDocumentoPix(pixCode: unknown): string | null {
  const s = typeof pixCode === "string" ? pixCode : "";
  if (s.length < 20) return null;
  const url = campoEmv(campoEmv(s, "26") ?? "", "25");
  if (!url) return null;
  const limpa = url.replace(/^https?:\/\//i, "");
  if (!PSPS_CONHECIDOS.test(limpa)) return null;
  return "https://" + limpa;
}

/** Nome do recebedor — só em código ESTÁTICO. No dinâmico o banco não usa o 59. */
export function recebedorDoBrCode(br: string | null | undefined): string | null {
  if (!br) return null;
  if (campoEmv(br, "01") === "12") return null;
  const nome = (campoEmv(br, "59") || "").trim();
  if (!nome || nome.length < 3 || /^\*+$/.test(nome)) return null;
  return nome;
}

export type EstadoPix = "ativa" | "paga" | "expirada" | "sem-verificacao" | "falhou";

export interface CobrancaPsp {
  estado: EstadoPix;
  /** Quando o código deixa de pagar (ms). null se o PSP não disse. */
  expiraEm: number | null;
  valor: string | null;
}

export async function consultarCobranca(pixCode: unknown, timeoutMs = 3500): Promise<CobrancaPsp> {
  const url = urlDoDocumentoPix(pixCode);
  if (!url) return { estado: "sem-verificacao", expiraEm: null, valor: null };

  const corte = new AbortController();
  const relogio = setTimeout(() => corte.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: corte.signal, headers: { Accept: "application/json" } });
    /* NÃO olhe o HTTP: PSP responde 404 COM o JWS válido quando a cobrança
       não está mais vigente. Quem manda é o corpo. */
    const corpo = (await r.text()).trim();
    let json: any = null;
    const meio = corpo.split(".")[1];
    if (meio) {
      try {
        json = JSON.parse(Buffer.from(meio.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
      } catch { json = null; }
    }
    if (!json) { try { json = JSON.parse(corpo); } catch { return { estado: "falhou", expiraEm: null, valor: null }; } }

    const status = String(json?.status ?? "").toUpperCase();
    const criacao = Date.parse(String(json?.calendario?.criacao ?? ""));
    const exp = Number(json?.calendario?.expiracao);
    const expiraEm = Number.isFinite(criacao) && Number.isFinite(exp) && exp > 0 ? criacao + exp * 1000 : null;
    const valor = json?.valor?.original != null ? String(json.valor.original) : null;

    if (status === "CONCLUIDA") return { estado: "paga", expiraEm, valor };
    if (status === "ATIVA") {
      // ATIVA mas com o relógio vencido: o PSP ainda não removeu, o banco já recusa.
      if (expiraEm && expiraEm <= Date.now()) return { estado: "expirada", expiraEm, valor };
      return { estado: "ativa", expiraEm, valor };
    }
    return { estado: status ? "expirada" : "falhou", expiraEm, valor };
  } catch {
    return { estado: "falhou", expiraEm: null, valor: null };
  } finally {
    clearTimeout(relogio);
  }
}

/** "até 14:32 (horário de Brasília)" — ou null. */
export function horaLimite(expiraEm: number | null | undefined): string | null {
  if (!expiraEm) return null;
  const hhmm = new Date(expiraEm).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
  return `até ${hhmm} (horário de Brasília)`;
}
