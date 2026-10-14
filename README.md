# Template Entrega Pix

Pós-venda da loja feita com o **template-loja-pix**. Ele cuida de:

- link único de rastreio para o cliente;
- e-mail a cada etapa (Resend);
- recuperação de Pix não pago (1 e-mail, 1 h depois);
- chat de atendimento no site, com base de respostas revisada;
- painel `/admin`.

**Este projeto não vende.** A venda acontece na LP. A Korvex avisa este projeto
por webhook, e daí em diante ele cuida da entrega.

## Como usar numa loja nova

1. Faça uma cópia deste repositório (**Use this template** no GitHub).
2. Preencha `src/config/site.config.ts`: procure por **PREENCHER**.
   - `orderIdPrefix` = o `checkout.prefixoPedido` da LP, em MAIÚSCULAS;
   - `kvIndexKey` e `kvPrefix` precisam ser **únicos por loja**, porque o banco é compartilhado;
   - `kits` = os nomes das ofertas da LP;
   - `comoUsarHtml` = a rotina copiada da LP.
3. Em `src/data/conhecimento.ts`, reescreva a seção **PRODUTO** com o texto da
   sua página. A parte de loja (Pix, frete, prazo, troca) já está pronta e lê
   preços e prazos da própria LP (`/api/ofertas`).
4. Confira os textos dos e-mails em `src/data/order-status.ts`.
5. Rode os testes (abaixo).
6. Na Vercel:
   - crie o projeto;
   - conecte o banco (Storage → Upstash);
   - cole as variáveis do `.env.example` no painel. **Nunca** coloque chave em arquivo.
7. Na Korvex, crie o webhook `https://SEU-PROJETO.vercel.app/api/webhook-pix?k=SEGREDO`
   (o mesmo segredo de `KORVEX_WEBHOOK_SECRET`).
8. No cron-job.org, chame `/api/cron/recuperacao` a cada 5 min com o
   `CRON_SECRET`. Sem isso, a recuperação de Pix não roda.
9. Na LP, preencha `atendimento.chatUrl` e `paginas.rastreioUrl` com o endereço
   deste projeto. No `<script>` do chat, coloque `data-loja` e
   `data-whatsapp`.

## Etapas e de onde cada uma vem

| Etapa | Quem move | Automático? |
|---|---|---|
| Pedido realizado | webhook da Korvex (`TRANSACTION_CREATED`) | sim |
| Pagamento aprovado | webhook da Korvex (`TRANSACTION_PAID`) | sim |
| Pedido enviado | relógio (24h após o pago; expresso 24h) ou código de rastreio real no admin | sim |
| Em trânsito | relógio (72h após o pago; expresso 48h) | sim |
| Saiu para entrega (penúltima) | relógio (216h após o pago; expresso 72h) | sim |
| **Entregue / Extraviado** | **somente o admin**, com confirmação | **nunca** |

As regras moram em `src/lib/pipeline.ts` (puro, testado). Nada anda para trás; nada passa de
"saiu para entrega" sozinho; "a transportadora informou entrega" só marca o pedido para você confirmar.

Por padrão, as etapas intermediárias andam por relógio, sem
serviço de rastreio integrado, e o código de rastreio é o número do pedido. Os e-mails de enviado/em
trânsito/saiu para entrega saem no horário, tenha o pacote saído ou não. Um código REAL salvo no admin
continua valendo e aparece no lugar do número.

A LP manda o kit como código (`trackProps.kit` = kit1/kit2/kit3); `SITE.kits` traduz para o nome da página.

## Variáveis de ambiente

Veja `.env.example`. Todas em **Vercel → entrega-sualoja → Settings → Environment Variables**
(Production), ou `vercel env add NOME production` nesta pasta.

## Testes (sem serviços externos)

```bash
node tools/testar-pipeline.ts
node --import ./tools/teste/carregador.mjs tools/testar-fluxo.ts
node --import ./tools/teste/carregador.mjs tools/testar-fase11.ts
```

## Rotas

| Rota | O que é |
|---|---|
| `/rastrear-pedido?codigo=…&t=…` | página do cliente (link do e-mail abre direto) |
| `/rastrear-pedido` | consulta por código + e-mail |
| `/admin` | painel (senha `ADMIN_PASSWORD`) |
| `POST /api/webhook-pix?k=SEGREDO` | entrada da Korvex |
| `POST /api/transportadora/evento` | entrada manual/Make/Zapier dos eventos reais do pacote (Bearer `TRACKING_EVENTS_SECRET`) |
| `GET /api/cron/recuperacao` | recuperação de Pix pendente (chamar a cada 5 min, Bearer `CRON_SECRET`) |
| `POST /api/atendimento` | chat do site |
| `/admin/atendimento` | relatório do chat e lista de quem pediu para sair |
| `GET /api/cron/advance-orders` | Vercel Cron, 1x/dia: aplica o relógio e reenvia e-mails que falharam (Bearer `CRON_SECRET`) |

### Formato de `POST /api/transportadora/evento`

```json
{ "trackingCode": "AA123456789BR", "etapa": "in_transit", "em": "2026-09-20T09:00:00-03:00", "descricao": "Objeto em trânsito" }
```

`etapa`: `shipped` · `in_transit` · `out_for_delivery` · `delivered_reported` · `exception_reported`.
Aceita também `{ "eventos": [ … ] }` com até 200 itens, e `orderId` no lugar de `trackingCode`.
