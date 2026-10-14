/* TESTES DE ACEITAÇÃO DA FASE 11 — recuperação de venda por e-mail (1 h) e chat.
   Rodar:  node --import ./tools/teste/carregador.mjs tools/testar-fase11.ts
   Sem serviços externos: banco em memória, Resend falsa, PSP falso, loja falsa.
   O relógio da fila é passado como parâmetro (processarFila(host, agora)). */

process.env.KORVEX_WEBHOOK_SECRET = "segredo-webhook-teste";
process.env.RESEND_API_KEY = "re_teste";
process.env.RESEND_FROM_EMAIL = "Sua Loja <pedidos@exemplo.com.br>";
process.env.RESEND_REPLY_TO = "atendimento@exemplo.com.br";
process.env.TRACKING_LINK_SECRET = "segredo-link-teste";
process.env.CRON_SECRET = "segredo-cron-teste";

let falhas = 0;
const ok = (cond: unknown, nome: string, extra = "") => {
  console.log((cond ? "  ok  " : "  *** ") + nome + (extra ? "  — " + extra : ""));
  if (!cond) falhas++;
};

/* ---------- serviços falsos ---------- */
const enviados: Array<{ to: string; subject: string; html: string }> = [];
const psp: Record<string, string> = {}; // id da cobrança -> ATIVA | CONCLUIDA | REMOVIDA | "fora"
let lojaFora = false;
const OFERTAS = {
  loja: "Sua Loja", url: "https://sualoja.com.br",
  ofertas: [
    { id: "kit1", rotulo: "1 Kit", preco: "R$ 49,90", de: "R$ 89,90", porKit: "R$ 49,90", porDia: "R$ 1,66", unidades: 1, dias: 30, padrao: false, desconto: 44 },
    { id: "kit2", rotulo: "2 Kits", preco: "R$ 79,90", de: "R$ 179,80", porKit: "R$ 39,95", porDia: "R$ 1,33", unidades: 2, dias: 60, padrao: true, desconto: 56, brinde: "Brinde de Exemplo · 50 g" },
    { id: "kit3", rotulo: "3 Kits", preco: "R$ 99,90", de: "R$ 269,70", porKit: "R$ 33,30", porDia: "R$ 1,11", unidades: 3, dias: 90, padrao: false, desconto: 63, brinde: "Brinde de Exemplo · 50 g" },
  ],
  incluso: ["Produto 1 · 30 ml", "Produto 2 · 30 ml", "Produto 3 · 30 ml"],
  bump: { nome: "Produto Extra", itens: ["Item extra 1", "Item extra 2", "Item extra 3"], preco: "R$ 39,90", de: "R$ 118,00" },
  frete: { padrao: "Grátis", padraoPrazo: "5 a 9 dias úteis", expresso: "R$ 9,90", expressoPrazo: "1 a 3 dias úteis" },
  pagamento: { metodos: ["pix"], validadePix: "15 minutos" },
};
globalThis.fetch = (async (url: any, opts: any) => {
  const u = String(url);
  if (u.includes("api.resend.com")) {
    const b = JSON.parse(opts.body);
    enviados.push({ to: b.to, subject: b.subject, html: b.html });
    return new Response(JSON.stringify({ id: "e" + enviados.length }), { status: 200 });
  }
  if (u.includes("/api/ofertas")) {
    if (lojaFora) return new Response("erro", { status: 503 });
    return new Response(JSON.stringify(OFERTAS), { status: 200 });
  }
  const m = u.match(/qrcode\.fyhub\.com\.br\/v2\/cobv\/([a-z0-9-]+)/i);
  if (m) {
    const s = psp[m[1]] ?? "ATIVA";
    if (s === "fora") throw new Error("PSP fora do ar");
    return new Response(JSON.stringify({ status: s, calendario: { criacao: new Date(Date.now() - 60_000).toISOString(), expiracao: 900 } }), { status: 200 });
  }
  throw new Error("fetch inesperado: " + u);
}) as typeof fetch;

const tlv = (id: string, v: string) => id + String(v.length).padStart(2, "0") + v;
const brCode = (cob: string) => tlv("00", "01") + tlv("01", "12") + tlv("26", tlv("00", "br.gov.bcb.pix") + tlv("25", "qrcode.fyhub.com.br/v2/cobv/" + cob)) + tlv("52", "0000") + tlv("53", "986") + tlv("58", "BR") + tlv("63", "ABCD");

const { POST: webhookRaw } = await import("../src/pages/api/webhook-pix.ts");
const { processarFila, ESPERA_MS, kFila, kRec, ultimosRegistros } = await import("../src/lib/recuperacao.ts");
const { responder, classificar, normalizar } = await import("../src/lib/atendimento.ts");
const { naoQuerContato } = await import("../src/lib/contato.ts");
const { kv } = await import("@vercel/kv" as any);

const HOST = "entrega-sualoja.vercel.app";
/* T0 no FUTURO: o webhook também dispara uma rodada da fila em segundo plano
   (waitUntil) com o relógio REAL. Com T0 fixo no passado, essa rodada
   processava os pedidos antes do teste e ele falhava conforme a hora do dia. */
const T0 = Math.floor(Date.now() / 60000) * 60000 + 24 * 3600 * 1000;
const MIN = 60_000;

/* O webhook usa waitUntil (Vercel). Em teste, chamamos o processamento direto. */
async function korvex(evento: string, status: string, o: { id: string; email: string; tel: string; cob: string; criado?: number; kit?: string; track?: Record<string, string> }) {
  const body = {
    event: evento,
    token: "token-da-korvex",
    transaction: { id: "trx_" + o.id, status, amount: 79.9, createdAt: new Date(o.criado ?? T0).toISOString(), payedAt: status === "COMPLETED" ? new Date((o.criado ?? T0) + 5 * MIN).toISOString() : null, pixInformation: { qrCode: brCode(o.cob) } },
    client: { name: "Maria Teste Silva", email: o.email, phone: o.tel, cpf: "11144477735" },
    orderItems: [{ product: { name: "Kit Nome do Produto" } }],
    trackProps: { provider: "LP Sua Loja", orderId: o.id, entrega_endereco: "Rua 1 | Centro | Fortaleza/CE | CEP 60000000", entrega_cep: "60000000", entrega_cidade: "Fortaleza", entrega_uf: "CE", entrega_destinatario: "Maria Teste Silva", entrega_telefone: o.tel, frete: "Grátis (5 a 9 dias úteis)", kit: o.kit ?? "kit2", unidades: "2", ...(o.track ?? {}) },
  };
  const u = new URL(`https://${HOST}/api/webhook-pix?k=segredo-webhook-teste&via=api`);
  const req = new Request(u, { method: "POST", headers: { "content-type": "application/json", host: HOST }, body: JSON.stringify(body) });
  // processar() é interno; o POST exportado chama waitUntil — em Node fora da Vercel ele só agenda a promise.
  const resp: Response = await webhookRaw({ request: req, url: u } as any);
  return resp.json();
}
const recDe = async (id: string) => (await kv.get(kRec(id.toUpperCase()))) as any;
const recuperacoesPara = (email: string) => enviados.filter((e) => e.to === email && /Conseguiu finalizar/.test(e.subject));
// a fila tem trava de 30 s entre rodadas; nos testes cada rodada é "outro momento"
const rodada = async (agora: number) => { await kv.del("sualoja:rec:varredura"); return processarFila(HOST, agora); };

console.log("\nFASE 11 — RECUPERAÇÃO (e-mail 1 h) E CHAT\n");

/* ═════ 1. Pix gerado e ainda pendente após 1 h → UMA recuperação ═════ */
await korvex("TRANSACTION_CREATED", "PENDING", { id: "ps-aaa111-c01", email: "c1@exemplo.com", tel: "88911110001", cob: "cob1" });
let reg = await recDe("ps-aaa111-c01");
ok(reg?.estado === "agendada" && reg.venceEm === T0 + ESPERA_MS, "1a. Pix gerado agenda a checagem para EXATAMENTE 1 h depois da cobrança", reg && new Date(reg.venceEm).toISOString());
let r = await rodada(T0 + 59 * MIN);
ok(recuperacoesPara("c1@exemplo.com").length === 0, "1b. com 59 min nada é enviado");
psp.cob1 = "REMOVIDA"; // venceu (15 min) sem pagamento
r = await rodada(T0 + 61 * MIN);
ok(recuperacoesPara("c1@exemplo.com").length === 1 && (await recDe("ps-aaa111-c01")).estado === "enviada", "1c. com 61 min, não pago confirmado → 1 e-mail de recuperação", JSON.stringify(r));
const html1 = recuperacoesPara("c1@exemplo.com")[0]?.html ?? "";
ok(/Passando para saber se você conseguiu finalizar seu pedido/.test(html1) && /Sua Loja/.test(html1) && /2 Kits Nome do Produto/.test(html1), "1d. texto pedido, com nome da loja e do kit");
ok(/api\/preferencias\/sair\?codigo=/.test(html1) && /wa\.me\/5511900000000/.test(html1) && /sualoja\.com\.br/.test(html1), "1e. e-mail traz 'não quero receber', WhatsApp e volta para a loja");
await korvex("TRANSACTION_CREATED", "PENDING", { id: "ps-aaa111-c01", email: "c1@exemplo.com", tel: "88911110001", cob: "cob1" }); // reentrega
await rodada(T0 + 120 * MIN); await rodada(T0 + 180 * MIN);
ok(recuperacoesPara("c1@exemplo.com").length === 1, "1f. reentrega do webhook e rodadas repetidas não duplicam");

/* ═════ 2. Pago antes de 1 h → nenhuma recuperação ═════ */
await korvex("TRANSACTION_CREATED", "PENDING", { id: "ps-bbb222-c02", email: "c2@exemplo.com", tel: "88922220002", cob: "cob2" });
await korvex("TRANSACTION_PAID", "COMPLETED", { id: "ps-bbb222-c02", email: "c2@exemplo.com", tel: "88922220002", cob: "cob2" });
await rodada(T0 + 70 * MIN);
ok(recuperacoesPara("c2@exemplo.com").length === 0 && (await recDe("ps-bbb222-c02")).estado === "cancelada", "2a. pago pela Korvex antes de 1 h → cancelada, nenhum e-mail");
// Korvex ainda "pendente", mas o PSP mostra pago (caso real da Ritual da Pele)
await korvex("TRANSACTION_CREATED", "PENDING", { id: "ps-bbb222-c03", email: "c3@exemplo.com", tel: "88933330003", cob: "cob3" });
psp.cob3 = "CONCLUIDA";
await rodada(T0 + 70 * MIN);
ok(recuperacoesPara("c3@exemplo.com").length === 0 && /PSP mostra/.test((await recDe("ps-bbb222-c03")).motivo), "2b. Korvex pendente mas PSP pago → nenhum e-mail");

/* ═════ 3. Sem status confiável → nada de afirmar pendência ═════ */
await korvex("TRANSACTION_CREATED", "PENDING", { id: "ps-ccc333-c04", email: "c4@exemplo.com", tel: "88944440004", cob: "cob4" });
psp.cob4 = "fora";
await rodada(T0 + 61 * MIN);
ok(recuperacoesPara("c4@exemplo.com").length === 0 && (await recDe("ps-ccc333-c04")).tentativas === 1, "3a. PSP fora do ar → não envia, reagenda");
await rodada(T0 + 72 * MIN); await rodada(T0 + 83 * MIN);
const r4 = await recDe("ps-ccc333-c04");
ok(recuperacoesPara("c4@exemplo.com").length === 0 && r4.estado === "analise", "3b. depois de 3 tentativas vai para ANÁLISE no admin, sem e-mail", r4.motivo);

/* ═════ 4. Preço → oferta real ═════ */
let a = await responder("qto sai o kit?", {}, HOST);
ok(a.intencao === "preco" && /R\$ 49,90/.test(a.resposta) && /R\$ 79,90/.test(a.resposta) && /R\$ 99,90/.test(a.resposta), "4a. 'qto sai o kit?' → preços reais da loja", a.resposta.split("\n")[1]);
a = await responder("qual vale mais a pena?", {}, HOST);
ok(a.intencao === "qual_compensa" && /R\$ 33,30/.test(a.resposta), "4b. 'qual vale mais a pena?' → compara com o preço por kit real");
lojaFora = true;
const { dadosDaLoja } = await import("../src/lib/atendimento.ts");
// força cache vencido
(globalThis as any).__x = 0;
a = await responder("tem cupom de desconto?", {}, HOST);
lojaFora = false;
ok(a.intencao === "desconto", "4c. desconto reconhecido");

a = await responder("tem brinde?", {}, HOST);
ok(a.intencao === "brinde" && /Brinde de Exemplo/.test(a.resposta) && /2 Kits ou 3 Kits/.test(a.resposta), "4d. brinde → nome e kits reais da loja", a.resposta.slice(0, 90));
a = await responder("vcs tem o produto extra?", {}, HOST);
ok(a.intencao === "upsell" && a.resposta.includes("R$ 39,90") && a.resposta.includes("R$ 118,00"), "4e. produto extra → preço do upsell da loja", a.resposta.slice(0, 90));
// pedido com upsell e brinde: gravado no pedido e visível no e-mail de pago
await korvex("TRANSACTION_PAID", "COMPLETED", { id: "ps-up111-u01", email: "u1@exemplo.com", tel: "88977770001", cob: "cobu1", track: { brinde: "Brinde de Exemplo · 50 g", bump: "Produto Extra (Item extra 1 + Item extra 2 + Item extra 3)" } });
{
  const q = (await kv.get("order:PS-UP111-U01")) as any;
  const mail = enviados.filter((e) => e.to === "u1@exemplo.com").pop()?.html ?? "";
  ok(/Produto Extra/.test(q?.bump ?? "") && /Brinde de Exemplo/.test(q?.brinde ?? ""), "4f. pedido grava upsell e brinde", String(q?.bump));
  ok(mail.includes("+ Produto Extra") && mail.includes("brinde: Brinde de Exemplo") && !mail.includes("Item extra 2 + Item extra 3)"), "4g. e-mail de pago mostra upsell e brinde (sem a lista longa)");
}

/* ═════ 5. Entrega → política oficial ═════ */
a = await responder("demora quanto pra chegar?", {}, HOST);
ok(a.intencao === "prazo" && /5 a 9 dias úteis/.test(a.resposta) && /R\$ 9,90/.test(a.resposta) && /1 a 3 dias úteis/.test(a.resposta), "5. 'demora quanto pra chegar?' → prazo e expresso oficiais");

/* ═════ 6. Pagamento não identificado → consulta real ou encaminha ═════ */
a = await responder("fiz o pix e nada", {}, HOST);
ok(a.intencao === "pagamento_nao_identificado" && /número do pedido/.test(a.resposta) && a.contexto.aguardando === "consultar_pagamento", "6a. 'fiz o pix e nada' → pede nº do pedido e e-mail");
a = await responder("PS-BBB222-C02 c2@exemplo.com", a.contexto, HOST);
ok(/Pagamento aprovado|confirmado/.test(a.resposta) && !a.humano, "6b. pedido pago → confirma com o status real", a.resposta.slice(0, 80));
a = await responder("já paguei e não atualizou PS-CCC333-C04 c4@exemplo.com", {}, HOST);
ok(a.humano && /não consegui confirmar|equipe/i.test(a.resposta) && !/ainda não identificamos/i.test(a.resposta), "6c. PSP sem resposta → não afirma pendência, encaminha para a equipe");
a = await responder("paguei PS-BBB222-C03 c3@exemplo.com", {}, HOST);
ok(/banco já mostra o pagamento/.test(a.resposta) && a.humano, "6d. PSP pago e Korvex pendente → diz que o banco mostra pago e avisa a equipe");
a = await responder("paguei PS-BBB222-C03 outra@pessoa.com", {}, HOST);
ok(/Não achei um pedido com esse número e esse e-mail/.test(a.resposta), "6e. e-mail que não é o da compra → não mostra o pedido de outra pessoa");

/* ═════ 7. Cancelamento → recuperação interrompida ═════ */
await korvex("TRANSACTION_CREATED", "PENDING", { id: "ps-ddd444-c05", email: "c5@exemplo.com", tel: "88955550005", cob: "cob5" });
a = await responder("quero cancelar", {}, HOST);
ok(a.intencao === "cancelar" && a.contexto.aguardando === "cancelar", "7a. 'quero cancelar' → pede identificação");
a = await responder("PS-DDD444-C05 c5@exemplo.com", a.contexto, HOST);
ok(a.humano && /pedido de cancelamento/.test(a.resposta) && (await recDe("ps-ddd444-c05")).estado === "cancelada", "7b. identificado → lembrete parado e equipe avisada");
await rodada(T0 + 61 * MIN);
ok(recuperacoesPara("c5@exemplo.com").length === 0, "7c. a 1 h nada é enviado para quem pediu cancelamento");

/* ═════ 8. Não quero mais mensagem → preferência respeitada ═════ */
await korvex("TRANSACTION_CREATED", "PENDING", { id: "ps-eee555-c06", email: "c6@exemplo.com", tel: "88966660006", cob: "cob6" });
a = await responder("nao quero mais mensagem", {}, HOST);
ok(a.intencao === "optout", "8a. 'nao quero mais mensagem' → intenção de opt-out");
a = await responder("PS-EEE555-C06 c6@exemplo.com", a.contexto, HOST);
ok(/não vai mais receber/.test(a.resposta) && (await naoQuerContato({ email: "c6@exemplo.com" })) && (await naoQuerContato({ telefone: "88966660006" })), "8b. preferência gravada por e-mail E telefone");
// pedido NOVO da mesma pessoa, depois do opt-out: também não recebe
await korvex("TRANSACTION_CREATED", "PENDING", { id: "ps-eee555-c07", email: "c6@exemplo.com", tel: "88966660006", cob: "cob7", criado: T0 + 5 * MIN });
await rodada(T0 + 70 * MIN);
ok(recuperacoesPara("c6@exemplo.com").length === 0, "8c. nem o pedido novo da mesma pessoa gera recuperação");
// link do e-mail: GET não descadastra (pré-carregamento do provedor), POST sim
const { GET: sairGet, POST: sairPost } = await import("../src/pages/api/preferencias/sair.ts");
const { linkParaSair } = await import("../src/lib/contato.ts");
await korvex("TRANSACTION_CREATED", "PENDING", { id: "ps-fff666-c08", email: "c8@exemplo.com", tel: "88988880008", cob: "cob8" });
const lk = new URL(linkParaSair("PS-FFF666-C08", HOST)!);
await sairGet({ url: lk } as any);
ok(!(await naoQuerContato({ email: "c8@exemplo.com" })), "8d. abrir o link (GET) NÃO descadastra sozinho");
await sairPost({ url: lk } as any);
ok(await naoQuerContato({ email: "c8@exemplo.com" }), "8e. confirmar (POST) descadastra");
const falso = new URL(lk); falso.searchParams.set("codigo", "PS-AAA111-C01");
const rf: Response = await sairPost({ url: falso } as any);
ok(rf.status === 403 && !(await naoQuerContato({ email: "c1@exemplo.com" })), "8f. link adulterado não descadastra outra pessoa");

/* ═════ 9. Pergunta desconhecida → esclarecimento / humano ═════ */
a = await responder("vocês entregam na lua de marte?", {}, HOST);
ok(a.intencao === "desconhecida" && a.humano && /wa\.me/.test(a.resposta), "9a. pergunta fora da base → pede para reformular e oferece WhatsApp");
const { relatorio } = await import("../src/lib/atendimento.ts");
const rel = await relatorio();
ok(rel.desconhecidas.some((x: any) => /lua de marte/.test(x.texto)) && rel.ranking.length > 3, "9b. pergunta não respondida entra no relatório do admin");
ok(!rel.log.some((x: any) => /@exemplo\.com/.test(x.texto)), "9c. e-mail da cliente não fica gravado no log do chat");

/* ═════ 10. "Reinício": a fila vive no banco ═════ */
await korvex("TRANSACTION_CREATED", "PENDING", { id: "ps-ggg777-c09", email: "c9@exemplo.com", tel: "88999990009", cob: "cob9", criado: T0 + 30 * MIN });
const naFila = await kv.zrange(kFila, 0, -1);
// simula reinício: nada em memória do processo é usado — a próxima rodada lê só do banco
psp.cob9 = "REMOVIDA";
await rodada(T0 + 95 * MIN);
ok(naFila.includes("PS-GGG777-C09") && recuperacoesPara("c9@exemplo.com").length === 1, "10. pedido agendado antes do 'reinício' é enviado na rodada seguinte (fila no banco)");

/* ═════ Extras: vários pedidos do mesmo cliente ═════ */
await korvex("TRANSACTION_CREATED", "PENDING", { id: "ps-hhh888-d01", email: "d1@exemplo.com", tel: "88912340001", cob: "cobd1" });
await korvex("TRANSACTION_CREATED", "PENDING", { id: "ps-hhh888-d02", email: "d1@exemplo.com", tel: "88912340001", cob: "cobd2", criado: T0 + 2 * MIN });
await korvex("TRANSACTION_CREATED", "PENDING", { id: "ps-hhh888-d03", email: "d1@exemplo.com", tel: "88912340001", cob: "cobd3", criado: T0 + 4 * MIN });
psp.cobd1 = psp.cobd2 = psp.cobd3 = "REMOVIDA";
await rodada(T0 + 70 * MIN);
ok(recuperacoesPara("d1@exemplo.com").length === 1, "11. três Pix do mesmo cliente → UMA mensagem só (pelo mais novo)");
await korvex("TRANSACTION_CREATED", "PENDING", { id: "ps-iii999-e01", email: "e1@exemplo.com", tel: "88955551111", cob: "cobe1" });
await korvex("TRANSACTION_CREATED", "PENDING", { id: "ps-iii999-e02", email: "e1@exemplo.com", tel: "88955551111", cob: "cobe2", criado: T0 + 3 * MIN });
await korvex("TRANSACTION_PAID", "COMPLETED", { id: "ps-iii999-e02", email: "e1@exemplo.com", tel: "88955551111", cob: "cobe2", criado: T0 + 3 * MIN });
psp.cobe1 = "REMOVIDA";
await rodada(T0 + 70 * MIN);
ok(recuperacoesPara("e1@exemplo.com").length === 0, "12. cliente que pagou OUTRO pedido não recebe recuperação do primeiro");

const log = await ultimosRegistros(500);
ok(log.some((x: any) => x.acao === "enviada" && x.statusConsultado && x.mensagem && x.para), "13. log guarda hora, pedido, status consultado, mensagem e destinatário");

/* ═════ Classificação com escrita informal ═════ */
const casos: Array<[string, string]> = [
  ["oiii", "saudacao"], ["aceita cartao?", "formas_pagamento"], ["como usa esse trem", "como_usar"],
  ["gravida pode usar?", "cuidados"], ["o pix venceu", "pix_expirou"], ["meu pedido ta atrasado", "atraso"],
  ["errei o endereço", "endereco"], ["chegou vazando", "defeito"], ["é original?", "original"],
  ["quero falar com atendente", "contato"], ["quais os ingredientes", "ingredientes"], ["o que vem no kit", "o_que_vem"],
  ["para de me mandar email", "optout"], ["kd meu pedido", "status_pedido"], ["vende só um produto?", "unidade_avulsa"],
];
for (const [t, esperado] of casos) {
  const c = classificar(t);
  ok(c.entrada?.id === esperado, `intenção: "${t}" → ${esperado}`, c.entrada?.id ?? "nenhuma (" + normalizar(t) + ")");
}

console.log(falhas ? `\n*** ${falhas} FALHA(S)\n` : `\nfase 11 ok — ${enviados.length} e-mails no total\n`);
process.exitCode = falhas ? 1 : 0;
export {};
