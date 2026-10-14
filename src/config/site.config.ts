/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  CONFIGURAÇÃO DA LOJA — o único arquivo que muda de uma loja para outra.
 * ─────────────────────────────────────────────────────────────────────────────
 *  Este projeto NÃO vende. A venda acontece na LP (template-loja-pix, checkout
 *  Pix próprio). Aqui chega o webhook da Korvex, o pedido é gravado e daí em
 *  diante este projeto cuida de: e-mails (Resend), rastreio público com link
 *  único, automação por relógio, recuperação de Pix, chat e o painel /admin.
 *
 *  Procure por PREENCHER. Formato do pedido que a LP manda:
 *  `trackProps.orderId` = "xx-…", endereço em `trackProps.entrega_*`, frete em
 *  `trackProps.frete` e o kit em `trackProps.kit` / `trackProps.unidades`.
 *
 *  Segredos (Korvex, Resend, senha do admin, segredo do link) ficam em
 *  variáveis de ambiente na Vercel — NUNCA neste arquivo. Ver .env.example.
 */
export const SITE = {
  storeName: "Sua Loja", // PREENCHER

  /** Nome do produto nos e-mails e na página de rastreio. */
  productName: "Nome do Produto", // PREENCHER

  /** Como o produto aparece no meio de uma frase ("seu pedido ainda está separado"). */
  productShort: "pedido",

  /**
   * Prefixo dos pedidos DESTE produto = checkout.prefixoPedido da LP, em
   * MAIÚSCULAS. PREENCHER (os testes usam "PS"). O número fica "PS-MV7…". O webhook ignora
   * (com 200) qualquer pedido que não comece por isto.
   */
  orderIdPrefix: "PS",

  /** Índice (zset) dos pedidos no banco compartilhado. Único por produto. */
  kvIndexKey: "orders:index:sualoja", // PREENCHER: único por loja

  /** Prefixo das chaves do PAINEL no banco compartilhado (sessão e bloqueio de login). */
  kvPrefix: "sualoja:", // PREENCHER: único por loja

  /** Domínio deste projeto — usado nos links dos e-mails. */
  productionHost: "entrega-sualoja.vercel.app", // PREENCHER

  /** Loja onde a venda acontece (link "voltar para a loja"). */
  storeUrl: "https://sualoja.com.br", // PREENCHER

  /** WhatsApp de atendimento da loja (só dígitos, com 55) — chat e e-mail de recuperação. */
  whatsappLoja: "5511900000000", // PREENCHER

  /**
   * Preços, kits e frete NÃO moram aqui: o chat lê da própria loja
   * (template-loja-pix: api/ofertas.js, que sai do catalogo.js dela). Preço tem
   * fonte única — nada de copiar valor para este projeto.
   */
  ofertasUrl: "https://sualoja.com.br/api/ofertas", // PREENCHER

  /**
   * Lembrete de Pix 10 min depois. Desligado: a recuperação manda UMA
   * mensagem 1 h depois do Pix (lib/recuperacao.ts). Os dois juntos dariam
   * duas mensagens por pedido.
   */
  lembrete10min: false,

  /** Brinde/guia DIGITAL (link no e-mail). O brinde físico por kit vem da LP. */
  brinde: null as { nome: string; url: string } | null,
  brindeFisico: null as string | null,
  guia: null as { nome: string; url: string } | null,

  /**
   * A LP manda o kit como CÓDIGO em `trackProps.kit` ("kit1"…), não como nome.
   * Sem esta tabela o e-mail diria "seu kit2". Nomes = `ofertas[].nome` do
   * config da LP (config/produtos/<produto>.js). PREENCHER.
   */
  kits: {
    kit1: "1 Kit Nome do Produto",
    kit2: "2 Kits Nome do Produto",
    kit3: "3 Kits Nome do Produto",
  } as Record<string, string>,

  /** Sem order bump nesta LP. */
  bumpNome: null as string | null,

  /**
   * Como usar, no e-mail de "entregue". HTML curto. Copie da seção "Como usar"
   * da LP — nada além do que a página diz. Vazio = o e-mail não traz rotina.
   */
  comoUsarHtml: "<strong>Como usar:</strong><br>☀️ <strong>Manhã:</strong> PREENCHER.<br>🌙 <strong>Noite:</strong> PREENCHER.", // PREENCHER

  email: {
    /** Padrão só para teste; produção vem da env RESEND_FROM_EMAIL. */
    from: "Sua Loja <onboarding@resend.dev>",
    /** Cores da LP (as mesmas de config cores: t1, rs, pp). PREENCHER. */
    brandDark: "#2A1220",
    brandAccent: "#8C2456",
    brandLight: "#FFFBFC",
    brandAccentInk: "#FFFFFF",
    brandAccentOnDark: "#F4B6CF",
    brandTint: "#FBEEF4",
  },

  /**
   * RELÓGIO DA ENTREGA — horas depois do PAGAMENTO em que cada etapa acontece
   * sozinha (cron diário + toda consulta na página de rastreio).
   *
   * Escolha da operação:
   * numa pergunta que explicava que o relógio NÃO é fonte real: sem serviço de
   * rastreio integrado; o código de rastreio é o número do pedido e os e-mails
   * de "enviado"/"em trânsito"/"saiu para entrega" saem pelo relógio, tenha o
   * pacote saído ou não. Um código REAL salvo no admin tem prioridade.
   * Entregue/Extraviado: SÓ no admin (lib/pipeline.ts recusa qualquer outra origem).
   *
   * Ajuste aos prazos da LP (exemplo: grátis 5 a 9 dias úteis; expresso 1 a 3).
   */
  relogio: {
    padrao: [
      { status: "shipped", horas: 24 },
      { status: "in_transit", horas: 72 },
      { status: "out_for_delivery", horas: 216 },
    ],
    // Expresso: "saiu para entrega" no 3º dia, dentro do prazo prometido na loja.
    expresso: [
      { status: "shipped", horas: 24 },
      { status: "in_transit", horas: 48 },
      { status: "out_for_delivery", horas: 72 },
    ],
  } as Record<"padrao" | "expresso", Array<{ status: string; horas: number }>>,
};
