/* Testa as regras do pipeline sem banco e sem rede.
   Rodar:  node tools/testar-pipeline.ts   (Node 22.6+ remove os tipos sozinho) */
import { aplicarTransicao, linhaDoTempo, vencidasNoRelogio, type Pedido } from "../src/lib/pipeline.ts";

let falhas = 0;
const ok = (cond: unknown, nome: string, extra = "") => {
  console.log((cond ? "  ok  " : "  *** ") + nome + (extra ? "  — " + extra : ""));
  if (!cond) falhas++;
};
const T = 1_000_000;
const base = (o: Partial<Pedido> = {}): Pedido => ({ orderId: "PZ-TESTE-1", status: undefined, trackingCode: null, statusTimestamps: {}, ...o });
const vai = (p: Pedido, para: string, origem: any, nota?: string) => aplicarTransicao(p, para, origem, T, nota);

console.log("\nPIPELINE — regras de transição\n");

// Pagamento
let r = vai(base(), "pending", "korvex");
ok(r.ok && r.mudou && r.pedido.status === "pending", "Korvex cria o pedido em pending");
r = vai((r as any).pedido, "paid", "korvex");
ok(r.ok && r.mudou && r.pedido.status === "paid", "Korvex marca pago");
const pago = (r as any).pedido as Pedido;

// Reentrega do webhook não rebaixa
r = vai({ ...pago, status: "in_transit", trackingCode: "AB123BR" }, "paid", "korvex");
ok(!r.ok, "TRANSACTION_PAID repetido NÃO rebaixa pedido em trânsito", !r.ok ? (r as any).erro : "");
r = vai(pago, "pending", "korvex");
ok(!r.ok, "TRANSACTION_CREATED repetido NÃO rebaixa pedido pago");

// Enviado exige rastreio real
r = vai(pago, "shipped", "rastreio");
ok(!r.ok, "sem código de rastreio não vira 'enviado'");
r = vai({ ...pago, trackingCode: "AB123456789BR" }, "shipped", "rastreio");
ok(r.ok && r.mudou, "com código real vira 'enviado'");
const enviado = (r as any).pedido as Pedido;

// Transportadora
r = vai(enviado, "in_transit", "transportadora");
ok(r.ok && r.mudou, "transportadora leva a 'em trânsito'");
r = vai((r as any).pedido, "out_for_delivery", "transportadora");
ok(r.ok && r.mudou, "transportadora leva a 'saiu para entrega' (penúltima)");
const saiu = (r as any).pedido as Pedido;
r = vai(saiu, "delivered", "transportadora");
ok(!r.ok, "transportadora NUNCA marca 'entregue'", !r.ok ? (r as any).erro : "");
r = vai(saiu, "lost", "transportadora");
ok(!r.ok, "transportadora NUNCA marca 'extraviado'");
r = vai(saiu, "delivered", "korvex");
ok(!r.ok, "Korvex NUNCA marca 'entregue'");
r = vai(saiu, "delivered", "rastreio");
ok(!r.ok, "registro de rastreio NUNCA marca 'entregue'");

// Pulo de etapa carimba as intermediárias
r = vai({ ...pago, trackingCode: "X1" }, "in_transit", "transportadora");
ok(r.ok && r.mudou && !!(r as any).pedido.statusTimestamps.shipped, "pular de pago para em trânsito carimba 'enviado'");

// Final manual
r = vai(saiu, "delivered", "admin");
ok(r.ok && r.mudou && r.pedido.status === "delivered", "admin marca 'entregue'");
r = vai(saiu, "lost", "admin");
ok(r.ok && r.mudou && r.pedido.status === "lost", "admin marca 'extraviado'");
r = vai(pago, "delivered", "admin");
ok(r.ok, "admin pode finalizar pedido pago (entrega sem rastreio visto)");
r = vai(base({ status: "pending" }), "delivered", "admin");
ok(!r.ok, "admin NÃO finaliza pedido não pago");
r = vai({ ...saiu, status: "delivered" }, "lost", "admin");
ok(r.ok && r.mudou, "admin pode corrigir entregue → extraviado");

// Nada volta do final para o automático
r = vai({ ...saiu, status: "delivered" }, "out_for_delivery", "transportadora");
ok(!r.ok, "pedido entregue não volta para 'saiu para entrega'");

// Idempotência
r = vai(saiu, "out_for_delivery", "transportadora");
ok(r.ok && !r.mudou, "mesma etapa de novo = sem mudança (sem e-mail)");

// Histórico
r = vai(saiu, "delivered", "admin", "confirmado pelo cliente");
const h = (r as any).pedido.historico;
ok(Array.isArray(h) && h[h.length - 1].origem === "admin" && h[h.length - 1].nota, "histórico registra origem e nota");

// Linha do tempo
const lt = linhaDoTempo(saiu);
const estados = lt.passos.map((p) => p.id + ":" + p.estado).join(" ");
ok(lt.passos.find((p) => p.id === "out_for_delivery")?.estado === "atual" && lt.passos[lt.passos.length - 1].estado === "proximo", "linha do tempo: atual e próxima certas", estados);
const ltEnt = linhaDoTempo({ ...saiu, status: "delivered", statusTimestamps: { ...saiu.statusTimestamps, delivered: T } });
ok(ltEnt.passos[ltEnt.passos.length - 1].label === "Entregue" && ltEnt.passos[ltEnt.passos.length - 1].estado === "atual", "linha do tempo: etapa final mostra 'Entregue'");
const ltLost = linhaDoTempo({ ...saiu, status: "lost" });
ok(ltLost.passos[ltLost.passos.length - 1].label === "Extraviado", "linha do tempo: etapa final mostra 'Extraviado'");
const ltRef = linhaDoTempo({ ...pago, status: "refunded" });
ok(!!ltRef.problema && ltRef.passos.find((p) => p.id === "paid")?.estado === "feito", "reembolsado mostra o problema e mantém 'pago' como feito");

// Relógio
const H = 3_600_000;
const REG = [{ status: "shipped", horas: 24 }, { status: "in_transit", horas: 72 }, { status: "out_for_delivery", horas: 216 }, { status: "delivered", horas: 300 }];
const pagoRel = { ...pago, statusTimestamps: { paid: 0 } };
ok(vencidasNoRelogio(pagoRel, REG, 23 * H).length === 0, "relógio: antes de 24h nada vence");
ok(vencidasNoRelogio(pagoRel, REG, 100 * H).map((v) => v.status).join() === "shipped,in_transit", "relógio: 100h vence enviado e em trânsito, em ordem");
ok(vencidasNoRelogio(pagoRel, REG, 9999 * H).every((v) => v.status !== "delivered"), "relógio: regra de 'entregue' é ignorada (teto automático)");
ok(vencidasNoRelogio({ ...pagoRel, status: "in_transit" }, REG, 100 * H).length === 0, "relógio: não reaplica etapa já passada");
ok(vencidasNoRelogio({ ...pagoRel, status: "delivered" }, REG, 9999 * H).length === 0, "relógio: pedido finalizado não anda");
ok(vencidasNoRelogio({ ...pagoRel, status: "refunded" }, REG, 9999 * H).length === 0, "relógio: reembolsado não anda");
ok(vencidasNoRelogio({ ...pagoRel, statusTimestamps: {} }, REG, 9999 * H).length === 0, "relógio: sem hora do pagamento não inventa");
r = vai({ ...pago, trackingCode: "PZ-TESTE-1" }, "shipped", "relogio");
ok(r.ok && r.mudou, "origem 'relogio' leva a 'enviado' com o nº do pedido como código");
r = vai(pago, "shipped", "relogio");
ok(!r.ok, "origem 'relogio' sem código nenhum é recusada");
r = vai({ ...pago, status: "out_for_delivery", trackingCode: "X" }, "delivered", "relogio");
ok(!r.ok, "origem 'relogio' NUNCA finaliza");

console.log(falhas ? `\n*** ${falhas} FALHA(S)\n` : "\ntodas as regras ok\n");
process.exitCode = falhas ? 1 : 0;
