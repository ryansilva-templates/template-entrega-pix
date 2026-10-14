/* Teste de ponta a ponta SEM serviços externos: banco em memória e Resend falsa.
   Rodar:  node --import ./tools/teste/carregador.mjs tools/testar-fluxo.ts
   Percorre: webhook da Korvex → pago → rastreio real → eventos da transportadora
   → finalização manual, contando os e-mails. */

process.env.KORVEX_WEBHOOK_SECRET = "segredo-webhook-teste";
process.env.RESEND_API_KEY = "re_teste";
process.env.RESEND_FROM_EMAIL = "Sua Loja <pedidos@exemplo.com.br>";
process.env.ADMIN_PASSWORD = "senha-admin-de-teste-123";
process.env.TRACKING_LINK_SECRET = "segredo-link-teste";
process.env.TRACKING_EVENTS_SECRET = "segredo-eventos-teste";
process.env.CRON_SECRET = "segredo-cron-teste";

let falhas = 0;
const ok = (cond: unknown, nome: string, extra = "") => {
  console.log((cond ? "  ok  " : "  *** ") + nome + (extra ? "  — " + extra : ""));
  if (!cond) falhas++;
};

// Resend falsa: registra cada envio; pode ser mandada falhar.
const enviados: Array<{ to: string; subject: string; html: string }> = [];
let resendFalha = 0;
const fetchOriginal = globalThis.fetch;
globalThis.fetch = (async (url: any, opts: any) => {
  if (String(url).includes("api.resend.com")) {
    if (resendFalha > 0) { resendFalha--; return new Response("erro interno", { status: 500 }); }
    const b = JSON.parse(opts.body);
    enviados.push({ to: b.to, subject: b.subject, html: b.html });
    return new Response(JSON.stringify({ id: "email_" + enviados.length }), { status: 200 });
  }
  return fetchOriginal(url, opts);
}) as typeof fetch;

const { POST: webhook } = await import("../src/pages/api/webhook-pix.ts");
const { GET: rastreioGET, POST: rastreioPOST } = await import("../src/pages/api/rastreio.ts");
const { POST: eventoTransp } = await import("../src/pages/api/transportadora/evento.ts");
const { POST: pedidoAdmin } = await import("../src/pages/api/admin/pedido.ts");
const { POST: loginAdmin } = await import("../src/pages/api/admin/login.ts");
const { GET: cron } = await import("../src/pages/api/cron/advance-orders.ts");
const { linkDeRastreio } = await import("../src/lib/link-rastreio.ts");
const { kv } = await import("@vercel/kv" as any);

const HOST = "entrega-sualoja.vercel.app";
const ID = "ps-mu38sknc-utymuv";
const IDU = ID.toUpperCase();

function korvex(evento: string, status: string, extra: any = {}) {
  return {
    event: evento,
    token: "token-da-korvex",
    transaction: { id: "trx_1", status, amount: 49.9, createdAt: "2026-09-18T12:00:00Z", payedAt: status === "COMPLETED" ? "2026-09-18T12:03:00Z" : null, ...extra },
    client: { name: "Maria Teste Silva", email: "maria@exemplo.com", phone: "47999998888", cpf: "11144477735", address: null },
    orderItems: [{ id: "i1", price: 79.9, product: { id: "p1", name: "Kit Nome do Produto" } }],
    /* Igual ao metadata que template-loja-pix/api/criar-pix.js manda (14/10/2026). */
    trackProps: {
      provider: "LP Sua Loja",
      orderId: ID, entrega_endereco: "Rua 15 de Novembro, 100 | Centro | Blumenau/SC | CEP 89010000", entrega_cep: "89010000",
      entrega_cidade: "Blumenau", entrega_uf: "SC", entrega_destinatario: "Maria Teste Silva", entrega_telefone: "47999998888",
      frete: "Grátis (5 a 9 dias úteis)", kit: "kit2", unidades: "2",
    },
  };
}
const chamar = async (h: any, { url, body, headers = {}, method = "POST", cookies }: any) => {
  const u = new URL(url, "https://" + HOST);
  const req = new Request(u, { method, headers: { "content-type": "application/json", host: HOST, ...headers }, body: body ? JSON.stringify(body) : undefined });
  const resp: Response = await h({ request: req, url: u, cookies: cookies ?? { get: () => undefined, set: () => {} } } as any);
  return { status: resp.status, json: await resp.json() };
};
const pedido = async () => (await kv.get("order:" + IDU)) as any;
const assuntos = () => enviados.map((e) => e.subject.replace(/.*• /, "").replace(IDU, "#"));

console.log("\nFLUXO COMPLETO — Korvex → rastreio → transportadora → final manual\n");

// 1. Segurança do webhook
let r = await chamar(webhook, { url: "/api/webhook-pix", body: korvex("TRANSACTION_PAID", "COMPLETED") });
ok(r.status === 401, "webhook SEM segredo é recusado (401)");
r = await chamar(webhook, { url: "/api/webhook-pix?k=errado", body: korvex("TRANSACTION_PAID", "COMPLETED") });
ok(r.status === 401, "webhook com segredo ERRADO é recusado");
const outra = korvex("TRANSACTION_PAID", "COMPLETED"); outra.trackProps.orderId = "HB-12345";
r = await chamar(webhook, { url: "/api/webhook-pix?k=segredo-webhook-teste", body: outra });
ok(r.status === 200 && r.json.ignorado, "pedido de OUTRA loja (HB-) é ignorado com 200");

// 2. Criação e pagamento
r = await chamar(webhook, { url: "/api/webhook-pix?k=segredo-webhook-teste&via=api", body: korvex("TRANSACTION_CREATED", "PENDING") });
let p = await pedido();
ok(r.status === 200 && p?.status === "pending", "TRANSACTION_CREATED cria o pedido em 'Pedido realizado'");
ok(p?.endereco?.linha?.includes("Blumenau") && p?.cliente?.email === "maria@exemplo.com" && p?.offer?.amount === 49.9, "pedido montado do payload (endereço, e-mail, valor)");
ok(enviados.length === 0, "pendente não manda e-mail");

r = await chamar(webhook, { url: "/api/webhook-pix?k=segredo-webhook-teste&via=api", body: korvex("TRANSACTION_PAID", "COMPLETED") });
p = await pedido();
ok(p?.status === "paid" && p?.statusTimestamps?.paid === Date.parse("2026-09-18T12:03:00Z"), "TRANSACTION_PAID → pago, com a hora DA KORVEX");
ok(enviados.length === 1 && /Pagamento confirmado/.test(enviados[0].subject), "1 e-mail: pagamento confirmado");

// 3. Reentregas não duplicam nem rebaixam
await chamar(webhook, { url: "/api/webhook-pix?k=segredo-webhook-teste&via=api", body: korvex("TRANSACTION_PAID", "COMPLETED") });
await chamar(webhook, { url: "/api/webhook-pix?k=segredo-webhook-teste", body: korvex("TRANSACTION_PAID", "COMPLETED") });
ok(enviados.length === 1, "webhook de pago reentregue 2x → nenhum e-mail a mais");
await chamar(webhook, { url: "/api/webhook-pix?k=segredo-webhook-teste&via=api", body: korvex("TRANSACTION_CREATED", "PENDING") });
ok((await pedido()).status === "paid", "TRANSACTION_CREATED reentregue NÃO rebaixa o pago");

// 4. Admin: login e segurança
const cookiesSalvos: Record<string, string> = {};
const jar = { get: (n: string) => (cookiesSalvos[n] ? { value: cookiesSalvos[n] } : undefined), set: (n: string, v: string) => { cookiesSalvos[n] = v; } };
r = await chamar(pedidoAdmin, { url: "/api/admin/pedido", body: { orderId: IDU, status: "delivered" } });
ok(r.status === 401, "ação do admin SEM login é recusada");
r = await chamar(loginAdmin, { url: "/api/admin/login", body: { password: "errada" }, headers: { "x-forwarded-for": "1.1.1.1" } });
ok(r.status === 401, "senha errada recusada");
for (let i = 0; i < 5; i++) await chamar(loginAdmin, { url: "/api/admin/login", body: { password: "x" + i }, headers: { "x-forwarded-for": "2.2.2.2" } });
r = await chamar(loginAdmin, { url: "/api/admin/login", body: { password: "senha-admin-de-teste-123" }, headers: { "x-forwarded-for": "2.2.2.2" } });
ok(r.status === 429, "após 5 erros o IP fica bloqueado (mesmo com a senha certa)");
r = await chamar(loginAdmin, { url: "/api/admin/login", body: { password: "senha-admin-de-teste-123" }, headers: { "x-forwarded-for": "3.3.3.3" }, cookies: jar });
ok(r.status === 200 && !!cookiesSalvos["admin_session"], "login certo cria a sessão");

// 5. Enviado só com rastreio real
r = await chamar(pedidoAdmin, { url: "/api/admin/pedido", body: { orderId: IDU, status: "in_transit" }, cookies: jar });
ok(r.status === 400, "sem rastreio o admin NÃO consegue pôr em trânsito", r.json.error);
r = await chamar(pedidoAdmin, { url: "/api/admin/pedido", body: { orderId: IDU, trackingCode: "aa 123456789 br", carrier: "Correios", carrierUrl: "https://rastreamento.exemplo/AA123456789BR" }, cookies: jar });
p = await pedido();
ok(r.status === 200 && p.status === "shipped" && p.trackingCode === "AA123456789BR", "rastreio real registrado → 'Pedido enviado'", p.trackingCode);
ok(enviados.length === 2 && enviados[1].html.includes("AA123456789BR") && enviados[1].html.includes("Correios"), "e-mail de enviado leva o código REAL e a transportadora");
ok(!enviados[1].html.includes("mesmo número do seu pedido"), "sem a frase 'o código é o número do pedido'");

// 6. Eventos da transportadora (fonte real, por push)
const auth = { authorization: "Bearer segredo-eventos-teste" };
r = await chamar(eventoTransp, { url: "/api/transportadora/evento", body: { trackingCode: "AA123456789BR", etapa: "in_transit" } });
ok(r.status === 401, "evento de transportadora sem segredo é recusado");
r = await chamar(eventoTransp, { url: "/api/transportadora/evento", headers: auth, body: { trackingCode: "AA123456789BR", etapa: "in_transit", em: "2026-09-20T09:00:00-03:00" } });
ok(r.status === 200 && (await pedido()).status === "in_transit", "evento real 'em trânsito' avança o pedido (achado pelo CÓDIGO de rastreio)");
r = await chamar(eventoTransp, { url: "/api/transportadora/evento", headers: auth, body: { eventos: [
  { trackingCode: "AA123456789BR", etapa: "in_transit" },
  { trackingCode: "AA123456789BR", etapa: "out_for_delivery" },
] } });
ok((await pedido()).status === "out_for_delivery", "lote de eventos: chega em 'saiu para entrega' (penúltima)");
ok(enviados.length === 4, "em trânsito e saiu para entrega: 1 e-mail cada, evento repetido não duplica", String(enviados.length));
r = await chamar(eventoTransp, { url: "/api/transportadora/evento", headers: auth, body: { trackingCode: "AA123456789BR", etapa: "delivered_reported", descricao: "Objeto entregue ao destinatário" } });
p = await pedido();
ok(p.status === "out_for_delivery" && !!p.transportadoraInformouEntrega, "transportadora diz 'entregue' → pedido NÃO finaliza, só fica marcado para o admin");
ok(enviados.length === 4, "nenhum e-mail de entregue sem a confirmação manual");

// 7. Cron sem provedor: só o relógio, e nunca além de "saiu para entrega"
r = await chamar(cron, { url: "/api/cron/advance-orders", method: "GET" });
ok(r.status === 401, "cron sem CRON_SECRET é recusado");
r = await chamar(cron, { url: "/api/cron/advance-orders", method: "GET", headers: { authorization: "Bearer segredo-cron-teste" } });
ok(r.status === 200 && /só o relógio/.test(r.json.aviso) && r.json.avancados.length === 0 && (await pedido()).status === "out_for_delivery",
  "cron sem provedor: pedido já em 'saiu para entrega' não anda mais, e diz que só há o relógio", JSON.stringify(r.json));

// 8. Final manual + Resend falhando uma vez
resendFalha = 3; // as três tentativas falham (1 + 2 repetições, como na Ritual da Pele)
r = await chamar(pedidoAdmin, { url: "/api/admin/pedido", body: { orderId: IDU, status: "delivered" }, cookies: jar });
p = await pedido();
ok(r.status === 200 && p.status === "delivered" && /não saiu/.test(r.json.aviso || ""), "Resend fora: pedido finaliza e o admin É AVISADO que o e-mail não saiu", r.json.aviso);
ok(!(await kv.get("email-sent:" + IDU + ":delivered")), "trava liberada após a falha (próxima tentativa pode enviar)");
r = await chamar(pedidoAdmin, { url: "/api/admin/pedido", body: { orderId: IDU, status: "lost" }, cookies: jar });
ok(r.status === 200 && (await pedido()).status === "lost" && /Atualização importante/.test(enviados[enviados.length - 1].subject), "admin corrige para 'Extraviado' → e-mail de extravio");
r = await chamar(pedidoAdmin, { url: "/api/admin/pedido", body: { orderId: IDU, status: "delivered" }, cookies: jar });
ok(r.status === 200 && /entregue/.test(enviados[enviados.length - 1].subject), "admin volta para 'Entregue' → e-mail de entregue (a trava foi liberada na falha)");
const antes = enviados.length;
await chamar(pedidoAdmin, { url: "/api/admin/pedido", body: { orderId: IDU, status: "lost" }, cookies: jar });
await chamar(pedidoAdmin, { url: "/api/admin/pedido", body: { orderId: IDU, status: "delivered" }, cookies: jar });
ok(enviados.length === antes + 0 || enviados.length === antes, "idas e vindas repetidas NÃO reenviam e-mails já enviados", `${antes} → ${enviados.length}`);
const porEtapa = new Map<string, number>();
for (const s of assuntos()) porEtapa.set(s, (porEtapa.get(s) || 0) + 1);
ok([...porEtapa.values()].every((n) => n === 1), "nenhum assunto repetido: 1 e-mail por etapa", [...porEtapa.keys()].join(" | "));

// 9. Link único de rastreio
const link = linkDeRastreio(IDU, HOST);
const t = new URL(link).searchParams.get("t");
ok(!!t, "link do e-mail tem assinatura", link);
ok(enviados[0].html.includes(link.replace(/&/g, "&amp;")), "o e-mail usa exatamente esse link (com & escapado no HTML, como deve)");
r = await chamar(rastreioGET, { url: `/api/rastreio?codigo=${IDU}&t=${t}`, method: "GET" });
ok(r.status === 200 && r.json.status === "delivered" && r.json.passos?.length === 6, "link abre o pedido direto, com a linha do tempo", r.json.passos?.map((x: any) => x.estado).join(","));
ok(!("cliente" in r.json) && !JSON.stringify(r.json).includes("11144477735") && !JSON.stringify(r.json).includes("Blumenau"), "visão pública sem CPF, e-mail ou endereço");
r = await chamar(rastreioGET, { url: `/api/rastreio?codigo=${IDU}&t=xxxxxxxxxxxxxxxxxxxxxx`, method: "GET" });
ok(r.status === 403, "assinatura falsa é recusada");
r = await chamar(rastreioPOST, { url: "/api/rastreio", body: { orderId: ID, email: "outra@exemplo.com" } });
ok(r.status === 404, "código + e-mail errado não mostra nada");
r = await chamar(rastreioPOST, { url: "/api/rastreio", body: { orderId: ID, email: "MARIA@exemplo.com" } });
ok(r.status === 200 && r.json.rastreio?.codigo === "AA123456789BR", "código + e-mail certo mostra o pedido");

// 10. Histórico
p = await pedido();
ok(p.historico?.map((h: any) => h.origem).join(",") === "korvex,korvex,rastreio,transportadora,transportadora,transportadora,admin,admin,admin,admin,admin", "histórico guarda a ORIGEM de cada mudança", p.historico?.map((h: any) => h.origem + ":" + h.para).join(" "));

// 11. E-mails como na Ritual da Pele: código Pix, lembrete, reenvio, falhas, teste
console.log("\nE-MAILS — Pix pendente, lembrete, reenvio, falhas\n");
const { POST: emailAdmin, GET: emailAdminGET } = await import("../src/pages/api/admin/email.ts");
const { POST: lembreteAdmin } = await import("../src/pages/api/admin/lembrete.ts");
const { saudeEmail } = await import("../src/lib/resend.ts");

// PSP falso (canpay, como a adquirente de 19/09/2026): status por txid.
const pspStatus: Record<string, string> = {};
const criacao = new Date(Date.now() - 5 * 60_000).toISOString();
const fetchComResend = globalThis.fetch;
globalThis.fetch = (async (url: any, opts: any) => {
  const m = String(url).match(/qrcode\.canpay\.com\.br\/pix\/([A-Z0-9]+)/);
  if (m) {
    const corpo = { calendario: { expiracao: 1800, criacao }, valor: { original: "117.90", modalidadeAlteracao: 0 }, txid: m[1], status: pspStatus[m[1]] ?? "ATIVA" };
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    return new Response(b64({ alg: "PS512" }) + "." + b64(corpo) + ".assinatura", { status: 200 });
  }
  return fetchComResend(url, opts);
}) as typeof fetch;

function brcode(txid: string) {
  const url = "qrcode.canpay.com.br/pix/" + txid;
  const gui = "0014br.gov.bcb.pix25" + String(url.length).padStart(2, "0") + url;
  return "000201010212" + "26" + String(gui.length).padStart(2, "0") + gui + "52040000530398658 02BR5925AL DIGITAL ENTERPRISES LT6007TAUBATE62070503***6304ABCD".replace(" ", "");
}
async function novoPendente(id: string, txid: string) {
  const b = korvex("TRANSACTION_CREATED", "PENDING", { id: "trx_" + txid, pixInformation: { qrCode: brcode(txid) } });
  b.trackProps.orderId = id;
  return chamar(webhook, { url: "/api/webhook-pix?k=segredo-webhook-teste", body: b });
}

let n0 = enviados.length;
await novoPendente("ps-pix-ativo", "AAA111");
const ePix = enviados[enviados.length - 1];
ok(enviados.length === n0 + 1 && /Seu código Pix/.test(ePix.subject), "Pix gerado → e-mail 'Seu código Pix'");
ok(ePix.html.includes(brcode("AAA111")), "o e-mail leva o copia-e-cola inteiro");
ok(/Vale até \d\d:\d\d \(horário de Brasília\)/.test(ePix.html) && /O código vale até \d\d:\d\d/.test(ePix.html), "prazo REAL do PSP (30 min), não texto fixo");
ok(ePix.html.includes("da instituição que processa o pagamento") && !ePix.html.includes("ATLAS"), "Pix dinâmico: não afirma nome de recebedor (o banco não mostra o campo 59)");
const pAtivo = (await kv.get("order:PS-PIX-ATIVO")) as any;
ok(pAtivo?.pixCode && pAtivo?.pixExpiraEm === Date.parse(criacao) + 1800_000, "pedido guarda o código e a hora em que ele expira");

pspStatus["BBB222"] = "CONCLUIDA";
n0 = enviados.length;
await novoPendente("ps-pix-pago", "BBB222");
ok(enviados.length === n0 && (await kv.get("order:PS-PIX-PAGO") as any)?.status === "pending", "webhook atrasado de cobrança JÁ PAGA no PSP: não manda o código");

r = await chamar(lembreteAdmin, { url: "/api/admin/lembrete", body: { scope: "all-pending" } });
ok(r.status === 401, "lembrete sem login é recusado");
n0 = enviados.length;
r = await chamar(lembreteAdmin, { url: "/api/admin/lembrete", body: { scope: "all-pending" }, cookies: jar });
ok(r.status === 200 && r.json.enviado === 1 && r.json["ja-pago"] === 1 && r.json.jaPagos[0] === "PS-PIX-PAGO", "lembrete: sai para o ativo, NÃO para o pago no PSP (e o pago é apontado)", JSON.stringify(r.json));
ok(enviados.length === n0 + 1 && /ainda está reservado/.test(enviados[enviados.length - 1].subject), "lembrete leva o código de novo");
r = await chamar(lembreteAdmin, { url: "/api/admin/lembrete", body: { orderIds: ["PS-PIX-ATIVO"] }, cookies: jar });
ok(r.json.enviado === 0 && r.json["ja-enviado"] === 1, "lembrete é UMA vez por pedido");
pspStatus["AAA111"] = "REMOVIDA_PELO_PSP";
r = await chamar(emailAdmin, { url: "/api/admin/email", body: { acao: "reenviar", orderId: "PS-PIX-ATIVO" }, cookies: jar });
ok(r.status === 409 && /expirou/.test(r.json.error), "reenviar o código de um Pix expirado é recusado com o motivo");

// Falha de envio → marcador durável → admin vê → reenvio recupera
resendFalha = 3;
await chamar(webhook, { url: "/api/webhook-pix?k=segredo-webhook-teste", body: (() => { const b = korvex("TRANSACTION_PAID", "COMPLETED"); b.trackProps.orderId = "ps-pix-ativo"; return b; })() });
r = await chamar(emailAdminGET, { url: "/api/admin/email", method: "GET", cookies: jar });
ok(r.json.falhas?.some((f: any) => f.orderId === "PS-PIX-ATIVO" && f.status === "paid" && /500/.test(f.motivo)), "e-mail de pago que falhou fica registrado com o motivo", JSON.stringify(r.json.falhas));
n0 = enviados.length;
r = await chamar(emailAdmin, { url: "/api/admin/email", body: { acao: "reenviar-falhas" }, cookies: jar });
ok(r.json.enviado === 1 && enviados.length === n0 + 1 && /Pagamento confirmado/.test(enviados[enviados.length - 1].subject), "'Reenviar falhas' recupera o e-mail", JSON.stringify(r.json));
r = await chamar(emailAdminGET, { url: "/api/admin/email", method: "GET", cookies: jar });
ok(!r.json.falhas?.some((f: any) => f.orderId === "PS-PIX-ATIVO"), "marcador de falha some depois do envio");

n0 = enviados.length;
r = await chamar(emailAdmin, { url: "/api/admin/email", body: { acao: "reenviar", orderId: "PS-PIX-ATIVO" }, cookies: jar });
ok(r.status === 200 && enviados.length === n0 + 1, "reenvio manual do e-mail da etapa atual");
r = await chamar(emailAdmin, { url: "/api/admin/email", body: { acao: "reenviar", orderId: "PS-PIX-ATIVO" }, cookies: jar });
ok(r.status === 429, "clique duplo no reenvio é barrado por 2 minutos");

r = await chamar(emailAdmin, { url: "/api/admin/email", body: { acao: "teste", para: "dono@exemplo.com" }, cookies: jar });
ok(r.status === 200 && enviados[enviados.length - 1].to === "dono@exemplo.com", "e-mail de teste do painel");

ok(saudeEmail().ok === true, "saúde: chave + remetente de domínio próprio = ok");
process.env.RESEND_FROM_EMAIL = "Sua Loja <onboarding@resend.dev>";
ok(saudeEmail().ok === false && saudeEmail().problemas.some((x: string) => /resend\.dev/.test(x)), "saúde: remetente resend.dev é denunciado");

/* ---- o que a adaptação para o Abranuv mudou nos e-mails ----
   1. Botão "Acompanhar pedido": no SOARFLY era amarelo com texto grafite.
      Com o azul da marca, texto escuro por cima daria ~2:1 — o único link
      que o cliente clica, ilegível. Tem que sair em brandAccentInk.
   2. O brinde (Protocolo das 7 Noites) vai no e-mail de pago e no de
      entregue: a LP não manda e-mail, este é o canal que a pessoa guarda. */
const { SITE: CFG } = await import("../src/config/site.config.ts");
const botao = new RegExp(`background:${CFG.email.brandAccent};color:${CFG.email.brandAccentInk}`, "i");
const htmlPago = enviados.find((e) => /Pagamento confirmado/.test(e.subject))?.html || "";
const htmlEntregue = enviados.find((e) => /entregue/i.test(e.subject))?.html || "";
ok(botao.test(htmlPago), "botão do e-mail: texto claro sobre o azul (legível)");
ok(!new RegExp(`background:${CFG.email.brandAccent};color:${CFG.email.brandDark}`, "i").test(htmlPago),
  "botão do e-mail: NÃO é marinho sobre azul");
ok(!CFG.brinde || (htmlPago.includes(CFG.brinde.url) && htmlEntregue.includes(CFG.brinde.url)),
  "brinde vai no e-mail de pago e no de entregue");
ok(!/maleta|bateria|travesseiro|ritual|gueixa|aurea|moedor|tempero|voltagem|popozuda/i.test(enviados.map((e) => e.html + e.subject).join(" ")), "nenhum e-mail fala de produto de outra loja (SoarFly, Abranuv, Aurea, Moedor, Popozuda)");

// 12. Relógio (decisão do usuário em 21/09/2026): enviado/em trânsito/saiu para
//     entrega andam sozinhos; entregue/extraviado, nunca.
const HORA = 3_600_000;
async function pedidoPagoHa(id: string, horas: number, frete = "Grátis (5 a 10 dias úteis)") {
  const k = "order:" + id.toUpperCase();
  if (!(await kv.get(k))) {
    const b = korvex("TRANSACTION_PAID", "COMPLETED", { id: "trx_" + id }); b.trackProps.orderId = id; b.trackProps.frete = frete;
    await chamar(webhook, { url: "/api/webhook-pix?k=segredo-webhook-teste&via=api", body: b });
  }
  const q = (await kv.get(k)) as any;
  q.statusTimestamps.paid = Date.now() - horas * HORA;
  await kv.set(k, q);
  return async () => (await kv.get(k)) as any;
}
const cronOk = () => chamar(cron, { url: "/api/cron/advance-orders", method: "GET", headers: { authorization: "Bearer segredo-cron-teste" } });

await cronOk(); // pedidos das seções anteriores, pagos há dias, andam aqui — fora da conta
let ler = await pedidoPagoHa("ps-relogio-um", 10);
let e0 = enviados.length;
await cronOk();
ok((await ler()).status === "paid" && enviados.length === e0, "relógio: 10h depois do pago nada muda", (await ler()).status + " " + enviados.slice(e0).map((e) => e.subject).join(" | "));
ler = await pedidoPagoHa("ps-relogio-um", 100);
e0 = enviados.length;
await cronOk();
let q = await ler();
ok(q.status === "in_transit" && q.trackingCode === "PS-RELOGIO-UM", "relógio: 100h → em trânsito, rastreio = nº do pedido", q.status + " " + q.trackingCode);
ok(q.statusTimestamps.shipped === q.statusTimestamps.paid + 24 * HORA && q.statusTimestamps.in_transit === q.statusTimestamps.paid + 72 * HORA,
  "relógio: cada etapa com o SEU horário (pago+24h, pago+72h)");
ok(enviados.length === e0 + 1 && /em trânsito/.test(enviados[enviados.length - 1].subject), "relógio atrasado: 1 e-mail só, o da etapa de destino",
  enviados.slice(e0).map((e) => e.subject).join(" | "));
ok(q.historico.filter((h: any) => h.origem === "relogio").length === 2, "histórico marca a origem 'relogio'");

// Página de rastreio aplica o que venceu, sem esperar o cron
q.statusTimestamps.paid = Date.now() - 300 * HORA; await kv.set("order:PS-RELOGIO-UM", q);
e0 = enviados.length;
r = await chamar(rastreioPOST, { url: "/api/rastreio", body: { orderId: "ps-relogio-um", email: "maria@exemplo.com" } });
ok(r.status === 200 && r.json.status === "out_for_delivery" && enviados.length === e0 + 1, "consulta de rastreio: 300h → saiu para entrega na hora, 1 e-mail", r.json.status);
q = await ler(); q.statusTimestamps.paid = Date.now() - 5000 * HORA; await kv.set("order:PS-RELOGIO-UM", q);
await cronOk(); await cronOk();
ok((await ler()).status === "out_for_delivery" && enviados.length === e0 + 1, "relógio NUNCA marca entregue, e cron repetido não reenvia");

// Código real registrado no admin continua valendo
ler = await pedidoPagoHa("ps-relogio-real", 100);
q = await ler(); q.trackingCode = "QB987654321BR"; q.status = "shipped"; q.statusTimestamps.shipped = Date.now(); await kv.set("order:PS-RELOGIO-REAL", q);
await cronOk();
q = await ler();
ok(q.status === "in_transit" && q.trackingCode === "QB987654321BR", "relógio não troca um código real pelo nº do pedido");

// Pedido não pago não anda
const pend = korvex("TRANSACTION_CREATED", "PENDING", { id: "trx_pend" }); pend.trackProps.orderId = "ps-relogio-pend";
await chamar(webhook, { url: "/api/webhook-pix?k=segredo-webhook-teste&via=api", body: pend });
await cronOk();
ok(((await kv.get("order:PS-RELOGIO-PEND")) as any).status === "pending", "pedido pendente não anda pelo relógio");

// Sua Loja: a LP manda o kit como código ("kit2"); o pedido guarda o NOME
q = (await kv.get("order:PS-RELOGIO-REAL")) as any;
ok(q.offer?.name === "2 Kits Nome do Produto" && q.offer?.quantity === 2, "nome do kit traduzido do código (kit2 → nome da página)", q.offer?.name + " x" + q.offer?.quantity);
ok(!enviados.some((e) => /\bkit[123]\b/.test(e.html)), "nenhum e-mail mostra o código cru do kit");

// Pix vencido: TRANSACTION_CANCELED/CANCELED → "Pagamento não concluído"
const venc = korvex("TRANSACTION_CREATED", "PENDING", { id: "trx_venc" }); venc.trackProps.orderId = "ps-pix-vencido";
await chamar(webhook, { url: "/api/webhook-pix?k=segredo-webhook-teste&via=api", body: venc });
const canc = korvex("TRANSACTION_CANCELED", "CANCELED", { id: "trx_venc" }); canc.trackProps.orderId = "ps-pix-vencido";
r = await chamar(webhook, { url: "/api/webhook-pix?k=segredo-webhook-teste&via=api", body: canc });
ok(((await kv.get("order:PS-PIX-VENCIDO")) as any)?.status === "failed", "Pix vencido (CANCELED) vira 'Pagamento não concluído'", JSON.stringify(r.json));

// Pedido do Popozuda (PZ) que chegue aqui é ignorado com 200
const outraPZ = korvex("TRANSACTION_PAID", "COMPLETED", { id: "trx_outra_pz" }); outraPZ.trackProps.orderId = "PZ1234567890";
r = await chamar(webhook, { url: "/api/webhook-pix?k=segredo-webhook-teste&via=api", body: outraPZ });
ok(r.status === 200 && r.json.ignorado && !(await kv.get("order:PZ1234567890")), "pedido de outra loja (PZ) ignorado com 200");

// Só o admin finaliza — e escolhe entre Entregue e Extraviado, cada um com o seu e-mail
let e1 = enviados.length;
r = await chamar(pedidoAdmin, { url: "/api/admin/pedido", body: { orderId: "ps-relogio-um", status: "delivered" }, cookies: jar });
ok(r.status === 200 && (await kv.get("order:PS-RELOGIO-UM") as any).status === "delivered" && /entregue/.test(enviados[enviados.length - 1]?.subject ?? ""), "admin marca ENTREGUE → e-mail de entregue");
r = await chamar(pedidoAdmin, { url: "/api/admin/pedido", body: { orderId: "ps-relogio-real", status: "lost" }, cookies: jar });
ok(r.status === 200 && (await kv.get("order:PS-RELOGIO-REAL") as any).status === "lost" && /Atualização importante/.test(enviados[enviados.length - 1]?.subject ?? ""), "admin marca EXTRAVIADO → e-mail de extravio");
ok(enviados.length === e1 + 2, "um e-mail por finalização");
r = await chamar(pedidoAdmin, { url: "/api/admin/pedido", body: { orderId: "ps-relogio-um", status: "delivered" }, cookies: jar });
ok(enviados.length === e1 + 2, "marcar entregue de novo não reenvia o e-mail");

// Sem guia digital nesta loja: nenhum marcador {guia} solto em e-mail nenhum
ok(!enviados.some((e) => /\{guia\}|\{prazo\}|\{orderId\}/.test(e.html + e.subject)), "nenhum marcador solto ({guia}, {prazo}, {orderId}) nos e-mails");
// E-mail de entregue traz a rotina do kit (SITE.comoUsarHtml)
const htmlFinal = enviados[e1]?.html ?? "";
ok(htmlFinal.includes(CFG.comoUsarHtml), "e-mail de entregue traz a rotina do kit (SITE.comoUsarHtml)");

// PSP atual da Korvex (fyhub) é consultado; host desconhecido continua barrado
const { urlDoDocumentoPix } = await import("../src/lib/pix-psp.ts");
const tlv = (id: string, v: string) => id + String(v.length).padStart(2, "0") + v;
const brCom = (url: string) => tlv("00", "01") + tlv("26", tlv("00", "br.gov.bcb.pix") + tlv("25", url)) + tlv("52", "0000") + tlv("53", "986") + tlv("58", "BR");
ok(urlDoDocumentoPix(brCom("qrcode.fyhub.com.br/v2/cobv/abc123")) === "https://qrcode.fyhub.com.br/v2/cobv/abc123", "PSP fyhub reconhecido");
ok(urlDoDocumentoPix(brCom("pix.magenpay.io/qr/v2/cobv/abc123")) === "https://pix.magenpay.io/qr/v2/cobv/abc123", "PSP magenpay reconhecido (Korvex desde 10/10)");
ok(urlDoDocumentoPix(brCom("qrcode.evil.example.com/v2/cobv/abc123")) === null, "PSP desconhecido barrado (sem SSRF)");

console.log(falhas ? `\n*** ${falhas} FALHA(S)\n` : `\nfluxo completo ok — ${enviados.length} e-mails, nenhum duplicado\n`);
process.exitCode = falhas ? 1 : 0;

export {};
