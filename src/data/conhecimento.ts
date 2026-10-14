/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  BASE DE CONHECIMENTO DO CHAT — PREENCHER a parte de PRODUTO para cada loja
 * ─────────────────────────────────────────────────────────────────────────────
 *  Cada entrada responde UMA intenção. Regras desta base:
 *   - nada aqui é inventado: cada resposta diz de onde veio (`fonte`);
 *   - preço, frete, prazo e validade do Pix NUNCA são escritos à mão: vêm da
 *     própria loja (SITE.ofertasUrl = <loja>/api/ofertas) pelos marcadores {…} —
 *     ver `preencher` em lib/atendimento.ts;
 *   - cosmético: sem promessa de resultado, sem alegação médica; dúvida de
 *     saúde vai para o médico/dermatologista;
 *   - o que a página não diz (CNPJ, troca por defeito, mudar endereço…) é
 *     encaminhado para gente (`humano: true`), não improvisado.
 *  As entradas da seção PRODUTO são EXEMPLOS: reescreva com o texto da sua
 *  página (seções "Por dentro", "Como usar" e o FAQ). Os gatilhos são
 *  expressões regulares sobre o texto sem acento e em minúsculas.
 *  Mudou preço/política na loja? As respostas com marcador se atualizam
 *  sozinhas. Texto novo entra AQUI, revisado — o chat nunca escreve na base.
 *
 *  Marcadores: {kits} {kit1.preco} {kit2.preco} {kit3.preco} {kit1.de}…
 *  {kit3.porKit} {kit3.porDia} {frete.padraoPrazo} {frete.expresso}
 *  {frete.expressoPrazo} {pix.validade} {incluso} {loja} {whatsapp}
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { SITE } from "../config/site.config";

export type Acao = "consultar_pedido" | "consultar_pagamento" | "optout" | "cancelar" | "humano";

export interface Entrada {
  id: string;
  /** Nome curto da intenção, para o relatório. */
  intencao: string;
  produto: "produto" | "loja";
  /** Expressões já NORMALIZADAS (sem acento, minúsculas) e o peso de cada uma. */
  gatilhos: Array<[string, number]>;
  /** Frases reais de exemplo — servem de teste e de referência. */
  exemplos: string[];
  resposta: string;
  fonte: string;
  condicoes?: string;
  /** Também avisa o atendimento humano (a resposta já diz que alguém vai ver). */
  humano: boolean;
  acao?: Acao;
}

const PG = new URL(SITE.storeUrl).host;

export const BASE: Entrada[] = [
  /* ═════════════════════════ PREFERÊNCIAS E PEDIDO (prioridade) ═════════════════════════ */
  {
    id: "optout",
    intencao: "Não quer mais receber mensagens",
    produto: "loja",
    gatilhos: [["nao quero (mais )?(receber )?(mensage|email|e mail|msg|lembrete|contato)", 6], ["para de (me )?mandar", 6], ["pare de (me )?mandar", 6], ["(descadastr|sair da lista|remover meu (email|contato))", 6], ["nao me mand", 5], ["^(stop|pare|parar|sair)$", 6]],
    exemplos: ["não quero mais mensagem", "para de me mandar email", "sair", "me tira da lista"],
    resposta: "Entendido! Me passe o número do pedido e o e-mail da compra que eu registro agora que você não quer mais receber nossas mensagens de lembrete. Os avisos de entrega de um pedido pago continuam, porque são do seu pedido.",
    fonte: "Política da loja: preferência de contato (Fase 11)",
    condicoes: "Precisa do nº do pedido + e-mail para identificar a pessoa. Com o link assinado da página de rastreio, registra direto.",
    humano: false,
    acao: "optout",
  },
  {
    id: "cancelar",
    intencao: "Quer cancelar o pedido",
    produto: "loja",
    gatilhos: [["cancel", 5], ["desist(ir|i|o) da compra", 4], ["nao quero mais o (pedido|kit|produto)", 5], ["quero (meu dinheiro|o dinheiro) de volta", 4]],
    exemplos: ["quero cancelar", "como cancelo meu pedido", "desisti da compra"],
    resposta: "Tudo bem! Me passe o número do pedido e o e-mail da compra: eu paro os lembretes na hora e passo o seu pedido para a nossa equipe, que cuida do cancelamento e do reembolso com você.\n\nSe o pedido já chegou, você tem 7 dias a partir do recebimento para desistir, com devolução integral (Código de Defesa do Consumidor).",
    fonte: `FAQ da página (${PG}): "Posso desistir da compra?" — art. 49 do CDC`,
    condicoes: "O cancelamento/reembolso é feito por uma pessoa: o chat não estorna nada.",
    humano: true,
    acao: "cancelar",
  },
  {
    id: "pagamento_nao_identificado",
    intencao: "Pagou e o pedido não atualizou",
    produto: "loja",
    gatilhos: [["(ja )?paguei", 4], ["fiz o pix", 4], ["pix (feito|pago|efetuado)", 4], ["fiz o pagamento", 4], ["(nao|nada).*(caiu|atualiz|confirm|chegou|aparec)", 3], ["e nada", 2], ["cade (meu )?(pedido|confirmacao)", 2], ["(debitou|saiu da (minha )?conta)", 3]],
    exemplos: ["fiz o pix e nada", "já paguei e não atualizou", "paguei, cadê a confirmação?", "o dinheiro saiu da conta e nada"],
    resposta: "Vou conferir o seu pagamento agora. Me passe o número do pedido (começa com PS) e o e-mail que você usou na compra.",
    fonte: "Status real do pedido (webhook da Korvex) + documento da cobrança no PSP",
    condicoes: "Só afirma 'pago' ou 'não pago' com a consulta feita. Sem confirmação, encaminha para a equipe.",
    humano: false,
    acao: "consultar_pagamento",
  },
  {
    id: "status_pedido",
    intencao: "Onde está / acompanhar o pedido",
    produto: "loja",
    gatilhos: [["rastre", 4], ["acompanh(ar|o)? (o |meu )?pedido", 4], ["(onde|cade) (esta )?(o |meu )?pedido", 4], ["status do (meu )?pedido", 4], ["codigo de rastreio", 4], ["meu pedido", 1]],
    exemplos: ["como acompanho meu pedido?", "cadê meu pedido", "quero o código de rastreio"],
    resposta: "Você acompanha tudo pelo link que vai no seu e-mail a cada etapa. Se preferir, me passe aqui o número do pedido e o e-mail da compra que eu te digo em que etapa ele está.",
    fonte: "Página de rastreio (entrega-sualoja.vercel.app) + e-mails de cada etapa",
    humano: false,
    acao: "consultar_pedido",
  },
  {
    id: "compra_aprovada",
    intencao: "Como saber se a compra foi aprovada",
    produto: "loja",
    gatilhos: [["(compra|pedido|pagamento) (foi )?aprovad", 4], ["como (sei|confirmo|saber) se (a compra|o pagamento|deu certo)", 4], ["deu certo (a compra|o pagamento)?", 3]],
    exemplos: ["como sei se a compra foi aprovada?", "deu certo o pagamento?"],
    resposta: "Assim que o Pix é confirmado, a tela da loja mostra \"Pagamento confirmado\" e você recebe um e-mail com o número do pedido e o link para acompanhar. Se quiser, me passe o número do pedido e o e-mail que eu confiro agora.",
    fonte: `Tela de pagamento confirmado do checkout (${PG}) + e-mail "Pagamento confirmado"`,
    humano: false,
    acao: "consultar_pedido",
  },
  {
    id: "sem_confirmacao",
    intencao: "Não recebeu e-mail de confirmação",
    produto: "loja",
    gatilhos: [["nao (recebi|chegou) (o |nenhum )?(email|e mail|confirmacao)", 5], ["(email|e mail) nao chegou", 5]],
    exemplos: ["não recebi a confirmação", "o e-mail não chegou"],
    resposta: "Dá uma olhadinha na caixa de spam e em \"Promoções\" — às vezes o e-mail cai lá. Se não estiver, me passe o número do pedido e o e-mail da compra que eu confiro o status pra você.",
    fonte: "E-mails transacionais da loja (Resend)",
    humano: false,
    acao: "consultar_pedido",
  },

  /* ═════════════════════════════ PAGAMENTO ═════════════════════════════ */
  {
    id: "formas_pagamento",
    intencao: "Formas de pagamento / cartão",
    produto: "loja",
    gatilhos: [["cart(ao|ao de credito)|credito|parcel|boleto|debito", 5], ["formas? de pagamento", 5], ["aceita(m)? (pix|cartao)", 4], ["so pix", 3]],
    exemplos: ["aceita cartão?", "dá pra parcelar?", "quais as formas de pagamento?", "tem boleto?"],
    resposta: "Por enquanto a loja trabalha só com Pix — é aprovado na hora e com o melhor preço. Não temos cartão, boleto nem parcelamento no momento.",
    fonte: `Página ${PG} (pagamento só no Pix) e checkout da Korvex (cartão/boleto indisponíveis)`,
    humano: false,
  },
  {
    id: "como_pagar",
    intencao: "Como pagar / gerei o Pix e não sei concluir",
    produto: "loja",
    gatilhos: [["como (eu )?(pago|faco o pagamento|pagar)", 5], ["gerei o pix", 4], ["(copia e cola|qr ?code)", 3], ["como (finalizo|concluo|termino)", 4]],
    exemplos: ["como faço pra pagar?", "gerei o pix mas não sei concluir", "onde fica o copia e cola?"],
    resposta: "É rapidinho: escolha o kit em {loja}, preencha seus dados e o QR Code e o código \"Pix Copia e Cola\" aparecem na própria página. No app do seu banco, vá em Pix → Pix Copia e Cola, cole o código e confirme. O código vale {pix.validade}. Assim que o banco confirma, o pedido entra sozinho — não precisa mandar comprovante.",
    fonte: `FAQ da página (${PG}): "Como funciona o pagamento no Pix?" + checkout`,
    humano: false,
  },
  {
    id: "pix_expirou",
    intencao: "Pix expirou / pagar de novo",
    produto: "loja",
    gatilhos: [["(pix|codigo) (expirou|venceu|vencido|expirado)", 6], ["(pagar|gerar) (de novo|novamente|outro pix)", 4], ["(nao|nao esta) (funciona|aceita)(ndo)? o (pix|codigo)", 3]],
    exemplos: ["o pix expirou", "como gero outro pix?", "o código venceu"],
    resposta: "Sem problema! O código Pix vale {pix.validade} por segurança. É só voltar em {loja}, escolher o kit de novo e gerar um código novo — o preço continua o mesmo. O código antigo não cobra nada depois que vence.",
    fonte: `Checkout ${PG}: validade do Pix da Korvex (padrão do painel)`,
    humano: false,
  },
  {
    id: "pagamento_recusado",
    intencao: "Pagamento recusado / erro no banco",
    produto: "loja",
    gatilhos: [["recusad|negad|nao autoriz", 5], ["(deu|da) erro (no|ao) (pagar|pix|banco)", 5], ["banco (nao deixa|bloqueou|recusou)", 5], ["alerta de golpe|golpe", 3]],
    exemplos: ["o pagamento foi recusado", "deu erro no pix", "o banco bloqueou"],
    resposta: "Quando o banco não conclui o Pix, nada é cobrado. Vale tentar de novo gerando um código novo em {loja}. No app do banco aparece o nome da empresa que processa os nossos pagamentos, não \"Sua Loja\" — isso é normal. Se o banco continuar recusando, me chama no WhatsApp que a gente te ajuda: {whatsapp}",
    fonte: "Checkout (texto do recebedor) + política de pagamento",
    condicoes: "O chat não vê o motivo da recusa no banco da pessoa.",
    humano: true,
    acao: "humano",
  },

  /* ═════════════════════════════ PREÇO E OFERTAS ═════════════════════════════ */
  {
    id: "preco",
    intencao: "Quanto custa",
    produto: "produto",
    gatilhos: [["(quanto|qto|qnto) (custa|e|sai|fica|ta)", 5], ["(preco|valor)", 4], ["quanto (e|sai) o kit", 5]],
    exemplos: ["quanto custa?", "qual o valor do kit?", "qto sai", "preço?"],
    resposta: "Os preços no Pix, com frete grátis:\n{kits}\nCada kit traz todos os produtos.",
    fonte: `Catálogo da loja (${PG}/api/ofertas) — o mesmo valor que o Pix cobra`,
    humano: false,
  },
  {
    id: "qual_compensa",
    intencao: "Qual kit vale mais a pena",
    produto: "produto",
    gatilhos: [["(qual|q) (kit )?(vale|compensa)", 5], ["vale (mais )?a pena", 4], ["melhor (kit|opcao|custo)", 4], ["(diferenca|diferente) entre os kits", 4], ["qual (kit )?(escolho|eu pego|comprar)", 4]],
    exemplos: ["qual vale mais a pena?", "qual kit compensa?", "qual a diferença entre os kits?"],
    resposta: "A diferença é a quantidade — todos trazem os mesmos produtos:\n{kits_comparativo}\nO de 3 kits sai mais barato por kit ({kit3.porKit} cada, {kit3.porDia} por dia de rotina). O de 2 kits é o mais escolhido.",
    fonte: `Catálogo da loja (${PG}/api/ofertas)`,
    condicoes: "\"Mais escolhido\" = a oferta marcada como Recomendado na página.",
    humano: false,
  },
  {
    id: "o_que_vem",
    intencao: "O que vem no kit",
    produto: "produto",
    gatilhos: [["o que vem", 5], ["(o que|q) (tem|inclui|acompanha)", 4], ["quais (os )?produtos", 4], ["(vem|sao) quantos (produtos|frascos)", 4], ["incluso|incluido", 4]],
    exemplos: ["o que vem no kit?", "quais produtos vêm?", "vem quantos frascos?"],
    resposta: "Cada kit traz:\n{incluso}\nNo kit de 2 vem 2 de cada; no de 3, 3 de cada.",
    fonte: `Config da loja (checkout.incluso) e seção "Por dentro do kit" (${PG})`,
    humano: false,
  },
  {
    id: "brinde",
    intencao: "Brinde / ganho algo de presente?",
    produto: "produto",
    gatilhos: [["brinde|presente|mimo|de graca|gratis junto|ganho algo|vem algo a mais|bonus", 5]],
    exemplos: ["tem brinde?", "ganho algum presente?", "vem algo de graça?"],
    resposta: "Tem sim! 🎁 Levando {brinde_kits}, você ganha {brinde} de brinde, no mesmo pacote e sem custo a mais. O kit de 1 não tem brinde.",
    fonte: `Página e checkout (${PG}): brinde por kit no catálogo (ofertas[].brinde)`,
    condicoes: "O brinde depende do kit escolhido — lido da loja, não escrito aqui.",
    humano: false,
  },
  {
    id: "upsell",
    intencao: "Upsell / levar mais um produto",
    produto: "produto",
    gatilhos: [["produto extra|upsell", 6], ["(leva|levar|comprar) (junto|mais algum)", 4], ["outros produtos", 4]], // PREENCHER: nome do seu upsell
    exemplos: ["tem o produto extra?", "dá pra levar mais algum produto junto?"],
    resposta: "Dá sim! Na hora do pagamento aparece a opção de levar junto o {bump.nome} ({bump.itens}) por + {bump.preco} (de {bump.de}). Ele só vale junto com um kit, no mesmo pedido.",
    fonte: `Checkout (${PG}): upsell do catálogo (bump)`,
    humano: false,
  },
  {
    id: "unidade_avulsa",
    intencao: "Comprar só um produto",
    produto: "produto",
    gatilhos: [["(so|somente|apenas) (um|1) (produto|serum|frasco)", 5], ["avuls", 5], ["vende separado", 5], ["(so|somente) o (produto|serum|creme)", 5]],
    exemplos: ["vende só um produto?", "posso comprar avulso?"],
    resposta: "Aqui a gente vende o kit completo — os produtos foram pensados para agir juntos. O menor é o de 1 kit, por {kit1.preco}.",
    fonte: `Página ${PG}: só são vendidos kits (1, 2 ou 3)`,
    humano: false,
  },
  {
    id: "desconto",
    intencao: "Desconto / cupom / preço final",
    produto: "produto",
    gatilhos: [["desconto|cupom|promoc", 5], ["(valor|preco) final", 5], ["tem taxa|taxa extra|frete (e )?gratis\\?", 3], ["(fica|sai) mais barato", 3]],
    exemplos: ["tem cupom?", "o preço é o valor final?", "tem desconto?"],
    resposta: "O preço que aparece já é o valor final no Pix, com o desconto aplicado e frete grátis: {kits_curto}. Não temos cupom no momento. Só muda se você escolher o frete expresso ({frete.expresso}).",
    fonte: `Catálogo e checkout (${PG})`,
    humano: false,
  },

  /* ═════════════════════════════ PRODUTO ═════════════════════════════
     PREENCHER: tudo abaixo é EXEMPLO. Reescreva com o que a SUA página diz —
     nada de promessa de resultado ou alegação médica. */
  {
    id: "para_que_serve",
    intencao: "Para que serve / benefícios",
    produto: "produto",
    gatilhos: [["(pra|para) (que|q) serve", 5], ["benefic", 4], ["(o que|q) (ele|o kit) faz", 4], ["(funciona|resultado)", 2]],
    exemplos: ["pra que serve?","quais os benefícios?","o que o kit faz?"],
    resposta: "PREENCHER: em 2 ou 3 frases, o que cada produto do kit faz, igual à página. Os resultados variam de pessoa para pessoa.",
    fonte: `Seção "Por dentro do kit" (${PG})`,
    condicoes: "Sem promessa de resultado garantido.",
    humano: false,
  },
  {
    id: "como_funciona",
    intencao: "Como funciona",
    produto: "produto",
    gatilhos: [["como (ele |o kit )?funciona", 5], ["como age", 5]],
    exemplos: ["como funciona?","como o kit age?"],
    resposta: "PREENCHER: como os produtos agem juntos, com o texto da seção \"Como o kit age\".",
    fonte: `Seção "Como o kit age" (${PG})`,
    humano: false,
  },
  {
    id: "ingredientes",
    intencao: "Ingredientes / composição",
    produto: "produto",
    gatilhos: [["ingredient|composic|formula|ativos?\\b", 5], ["(tem|leva) (o que|que)", 2], ["vegano|corante", 3]],
    exemplos: ["quais os ingredientes?","qual a fórmula?"],
    resposta: "Os principais ativos:\\n• Produto 1: PREENCHER\\n• Produto 2: PREENCHER\\nA fórmula completa está em \"Ver a fórmula de cada um\" na página.",
    fonte: `Seção "Ver a fórmula de cada um" (${PG})`,
    humano: false,
  },
  {
    id: "como_usar",
    intencao: "Como usar",
    produto: "produto",
    gatilhos: [["como (eu )?(usa|uso|usar|aplic|passo)", 5], ["modo de uso", 5], ["(manha|noite)", 2], ["ordem (de uso|dos produtos|certa)", 4]],
    exemplos: ["como usa?","qual a ordem?","modo de uso"],
    resposta: "PREENCHER: o passo a passo da seção \"Como usar\" da página.",
    fonte: `Seção "Como usar" (${PG})`,
    humano: false,
  },
  {
    id: "indicado",
    intencao: "Para quem é indicado / idade",
    produto: "produto",
    gatilhos: [["(pra|para) quem", 5], ["indicad", 5], ["(serve|funciona) (pra|para) (minha idade|homem|pele)", 4], ["(idade|anos)", 2]],
    exemplos: ["pra quem é indicado?","tenho 50 anos, serve?"],
    resposta: "PREENCHER: para quem o produto é, só com o que a página diz. Em caso de dúvida de saúde, converse antes com um profissional.",
    fonte: `Página (${PG})`,
    condicoes: "Não afirmar além do que a página diz.",
    humano: false,
  },
  {
    id: "cuidados",
    intencao: "Contraindicações / cuidados / gestantes",
    produto: "produto",
    gatilhos: [["gravid|gestant|amament|lactant|gravida", 6], ["sensivel|alergi|irrit|ardencia|vermelh", 5], ["contraindic|efeito colateral|faz mal|perigo", 5]],
    exemplos: ["grávida pode usar?","tem contraindicação?"],
    resposta: "PREENCHER: os cuidados que constam no rótulo e na página. Gestantes, lactantes ou quem tem alguma condição de saúde devem consultar o médico antes de usar. Se aparecer irritação, suspenda o uso e procure um profissional.",
    fonte: `Rótulo e FAQ da página (${PG})`,
    condicoes: "Não substitui orientação médica.",
    humano: false,
  },
  {
    id: "resultado_tempo",
    intencao: "Em quanto tempo vejo resultado",
    produto: "produto",
    gatilhos: [["quanto tempo|em quantos dias|quando (vejo|aparece)", 5], ["resultado (rapido|em quanto)", 5]],
    exemplos: ["em quanto tempo vejo resultado?"],
    resposta: "PREENCHER: o que a página diz sobre tempo de uso. Os resultados variam de pessoa para pessoa e dependem do uso contínuo.",
    fonte: `FAQ da página (${PG})`,
    condicoes: "Sem promessa de resultado garantido.",
    humano: false,
  },
  {
    id: "original",
    intencao: "É original / marca",
    produto: "produto",
    gatilhos: [["original|falsific|falso|pirat|replica", 6]],
    exemplos: ["é original?"],
    resposta: "PREENCHER: de onde vem o produto. Se você revende marca de terceiros, diga que é loja independente e não a loja oficial da marca.",
    fonte: `Rodapé/aviso legal da página (${PG})`,
    humano: false,
  },

  /* ═════════════════════════════ ENTREGA ═════════════════════════════ */
  {
    id: "prazo",
    intencao: "Prazo de entrega",
    produto: "loja",
    gatilhos: [["prazo", 5], ["(demora|leva) quanto", 5], ["quanto tempo (pra|para) chegar", 6], ["quando chega", 5], ["(chega|entrega) em quantos dias", 6], ["frete", 3], ["expresso", 4]],
    exemplos: ["demora quanto pra chegar?", "qual o prazo?", "quando chega?", "tem frete expresso?"],
    resposta: "O frete é grátis para todo o Brasil, com entrega em {frete.padraoPrazo} depois do envio. Se tiver pressa, no pagamento dá para escolher o frete expresso por {frete.expresso}, com entrega em {frete.expressoPrazo}. Você acompanha cada etapa pelo link que chega no e-mail.",
    fonte: `FAQ "Como funciona o frete?" e checkout (${PG})`,
    humano: false,
  },
  {
    id: "atraso",
    intencao: "Pedido atrasado",
    produto: "loja",
    gatilhos: [["atras", 5], ["(nao|ainda nao) chegou", 4], ["passou do prazo", 6], ["(ta|esta) demorando", 4]],
    exemplos: ["meu pedido está atrasado", "ainda não chegou", "passou do prazo"],
    resposta: "Poxa, vamos ver isso. Me passe o número do pedido e o e-mail da compra que eu confiro em que etapa ele está — e, se tiver passado do prazo, já aviso a nossa equipe para resolver com você.",
    fonte: "Prazo oficial da loja + status real do pedido",
    humano: true,
    acao: "consultar_pedido",
  },
  {
    id: "endereco",
    intencao: "Alterar endereço",
    produto: "loja",
    gatilhos: [["(mudar|alterar|trocar|corrigir|errei) (o )?endereco", 6], ["endereco (errado|incorreto)", 6], ["cep errado", 6]],
    exemplos: ["preciso mudar o endereço", "errei o endereço", "coloquei o CEP errado"],
    resposta: "Dá para ver isso sim, mas quem altera é a nossa equipe. Me chama no WhatsApp com o número do pedido e o endereço certo: {whatsapp}",
    fonte: "Política da loja (alteração manual antes do envio)",
    condicoes: "Depois que o pacote saiu, pode não ser possível alterar.",
    humano: true,
    acao: "humano",
  },

  /* ═════════════════════════════ CONFIANÇA E SUPORTE ═════════════════════════════ */
  {
    id: "confiavel",
    intencao: "A loja é confiável?",
    produto: "loja",
    gatilhos: [["confiavel|confianca|seguro|golpe|fraude|e verdade|e real|reclame aqui", 5], ["(posso|da pra) confiar", 6]],
    exemplos: ["a loja é confiável?", "é golpe?", "é seguro comprar?"],
    resposta: "Pode ficar tranquila(o): o pagamento é por Pix processado por uma empresa de pagamentos, o site é seguro (HTTPS), você recebe e-mail a cada etapa com link de rastreio e, se desistir, tem 7 dias a partir do recebimento para devolver com o valor integral, pelo Código de Defesa do Consumidor. Qualquer dúvida, fala com a gente no WhatsApp: {whatsapp}",
    fonte: `Rodapé, checkout e FAQ "Posso desistir da compra?" (${PG})`,
    condicoes: "Não citar CNPJ, endereço ou avaliações: não constam na página.",
    humano: false,
  },
  {
    id: "contato",
    intencao: "Falar com atendente / suporte",
    produto: "loja",
    gatilhos: [["atendente|humano|suporte|falar com (alguem|voces|uma pessoa|pessoa)", 5], ["whatsapp|telefone|contato", 4]],
    exemplos: ["quero falar com um atendente", "qual o whatsapp?", "tem telefone?"],
    resposta: "Claro! Fala com a gente pelo WhatsApp: {whatsapp} — ou responda qualquer e-mail do seu pedido.",
    fonte: `Rodapé da página (${PG})`,
    humano: true,
    acao: "humano",
  },
  {
    id: "troca_reembolso",
    intencao: "Trocas e reembolsos / devolução",
    produto: "loja",
    gatilhos: [["troca|trocar|devolv|devoluc|reembols|estorn", 5], ["dinheiro de volta", 5], ["garantia", 4]],
    exemplos: ["como funciona a troca?", "quero devolver", "tem garantia?", "como peço reembolso?"],
    resposta: "Pelo Código de Defesa do Consumidor, você tem 7 dias corridos a partir do recebimento para desistir da compra, com devolução integral do valor pago. Para pedir, fala com a gente no WhatsApp com o número do pedido: {whatsapp}",
    fonte: `FAQ "Posso desistir da compra?" e termos de uso (${PG})`,
    condicoes: "A loja não oferece garantia além da prevista em lei.",
    humano: true,
    acao: "humano",
  },
  {
    id: "defeito",
    intencao: "Produto com defeito / avariado",
    produto: "loja",
    gatilhos: [["defeito|quebrad|vazad|vazando|amassad|avariad|danificad|errad|faltando|veio faltando|lacre", 6]],
    exemplos: ["o produto veio vazando", "chegou quebrado", "veio faltando um sérum"],
    resposta: "Sinto muito por isso! Manda pra gente no WhatsApp o número do pedido e uma foto do produto e da caixa, que a nossa equipe resolve com você: {whatsapp}",
    fonte: "Política da loja (análise manual)",
    condicoes: "A solução (reenvio ou reembolso) é decidida pela equipe, não pelo chat.",
    humano: true,
    acao: "humano",
  },

  /* ═════════════════════════════ CONVERSA ═════════════════════════════ */
  {
    id: "saudacao",
    intencao: "Saudação",
    produto: "loja",
    gatilhos: [["^(oi+|ola|bom dia|boa tarde|boa noite|eai|e ai|opa|hey|hello)\\b", 3]],
    exemplos: ["oi", "boa tarde", "olá"],
    resposta: `Oi! 😊 Sou o atendimento da ${SITE.storeName}. Posso te ajudar com preço dos kits, como usar, pagamento no Pix, prazo de entrega ou o status do seu pedido. O que você quer saber?`,
    fonte: "—",
    humano: false,
  },
  {
    id: "agradecimento",
    intencao: "Agradecimento",
    produto: "loja",
    gatilhos: [["^(obrigad|valeu|vlw|brigad|thanks|perfeito|show|otimo|ok|blz|beleza)", 3]],
    exemplos: ["obrigada", "valeu!"],
    resposta: "Imagina! Se precisar de mais alguma coisa, é só chamar. 💕",
    fonte: "—",
    humano: false,
  },
];

/** Resposta quando nenhuma intenção bate: nunca improvisa. */
export const RESPOSTA_DESCONHECIDA =
  "Hmm, essa eu prefiro confirmar com a nossa equipe para não te passar nada errado. Pode me contar com outras palavras? Ou, se preferir, fala direto com a gente no WhatsApp: {whatsapp}";
