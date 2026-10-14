/* =============================================================================
   CHAT DE ATENDIMENTO (balão no canto da página)
   Carregado pela LP e pela página de rastreio:
     <script src="https://entrega-sualoja.vercel.app/chat.js" defer
             data-api="https://entrega-sualoja.vercel.app/api/atendimento"
             data-loja="Nome da Loja" data-whatsapp="5511900000000"></script>
   As respostas vêm de /api/atendimento (base de conhecimento revisada).
   Nada aqui guarda dado pessoal fora da aba: o contexto (nº do pedido,
   e-mail) fica em sessionStorage e some quando a aba fecha.
   ============================================================================= */
(function () {
  'use strict';
  if (window.__dsChat) return;
  window.__dsChat = true;

  var eu = document.currentScript;
  var API = (eu && eu.getAttribute('data-api')) || 'https://entrega-sualoja.vercel.app/api/atendimento';
  var LOJA = (eu && eu.getAttribute('data-loja')) || '';
  var ZAP = (eu && eu.getAttribute('data-whatsapp')) || '';
  var BAIXO = 16; // distância mínima do rodapé da tela
  /* Elemento fixo que o balão NÃO pode cobrir (a barra de compra da loja).
     O balão sobe só quando ele está visível — antes ficava sempre a 96 px,
     cobrindo o conteúdo no meio da página (auditoria mobile 14/10/2026). */
  var EVITAR = (eu && eu.getAttribute('data-evitar')) || '.stickycta';
  var COR = (eu && eu.getAttribute('data-cor')) || '#8C2456';
  var ESCURO = '#2A1220';
  var CHAVE = 'ds-chat-v1';

  var estado = { aberto: false, msgs: [], contexto: {} };
  try { var salvo = JSON.parse(sessionStorage.getItem(CHAVE) || 'null'); if (salvo) estado = salvo; } catch (e) {}
  function salvar() { try { sessionStorage.setItem(CHAVE, JSON.stringify(estado)); } catch (e) {} }

  // Página de rastreio aberta pelo link assinado: o chat já sabe qual é o pedido.
  try {
    var sp = new URLSearchParams(location.search);
    if (sp.get('codigo') && sp.get('t')) { estado.contexto.orderId = sp.get('codigo'); estado.contexto.t = sp.get('t'); }
  } catch (e) {}

  var css = '' +
    '.dsc-btn{position:fixed;right:16px;z-index:2147483000;width:58px;height:58px;border-radius:50%;border:0;cursor:pointer;background:linear-gradient(135deg,' + COR + ',' + ESCURO + ');color:#fff;box-shadow:0 12px 28px -8px rgba(42,18,32,.55);display:grid;place-items:center;transition:transform .2s}' +
    '.dsc-btn:hover{transform:translateY(-2px)}.dsc-btn svg{width:26px;height:26px}' +
    '.dsc-badge{position:absolute;top:-2px;right:-2px;width:14px;height:14px;border-radius:50%;background:#16a34a;border:2px solid #fff}' +
    '.dsc-pan{position:fixed;right:16px;z-index:2147483001;width:min(370px,calc(100vw - 32px));height:min(560px,calc(100dvh - 120px));background:#fff;border-radius:20px;box-shadow:0 24px 60px -20px rgba(42,18,32,.5);display:none;flex-direction:column;overflow:hidden;font:15px/1.45 "Plus Jakarta Sans",system-ui,-apple-system,sans-serif;color:#1d1d1f}' +
    '.dsc-pan.on{display:flex}' +
    '.dsc-hd{background:linear-gradient(135deg,' + COR + ',' + ESCURO + ');color:#fff;padding:14px 16px;display:flex;align-items:center;gap:10px}' +
    '.dsc-hd b{display:block;font-size:15px}.dsc-hd span{font-size:12px;opacity:.85}.dsc-x{margin-left:auto;background:rgba(255,255,255,.15);border:0;color:#fff;width:34px;height:34px;border-radius:50%;cursor:pointer;font-size:18px}' +
    '.dsc-corpo{flex:1;overflow-y:auto;padding:14px;background:#FFFBFC;display:flex;flex-direction:column;gap:8px}' +
    '.dsc-m{max-width:86%;padding:9px 12px;border-radius:14px;white-space:pre-line;word-wrap:break-word;font-size:14px}' +
    '.dsc-m.b{background:#fff;border:1px solid #F1E2E9;align-self:flex-start;border-bottom-left-radius:4px}' +
    '.dsc-m.c{background:' + COR + ';color:#fff;align-self:flex-end;border-bottom-right-radius:4px}' +
    '.dsc-m a{color:inherit;font-weight:700;text-decoration:underline;word-break:break-all}' +
    '.dsc-chips{display:flex;flex-wrap:wrap;gap:6px;padding:8px 12px 0;background:#FFFBFC}' +
    '.dsc-chip{border:1px solid #E5CCD8;background:#fff;color:' + COR + ';border-radius:100px;padding:6px 11px;font-size:12.5px;font-weight:700;cursor:pointer}' +
    '.dsc-f{display:flex;gap:8px;padding:10px 12px;border-top:1px solid #F1E2E9;background:#fff}' +
    '.dsc-f input{flex:1;border:1.5px solid #E5CCD8;border-radius:100px;padding:10px 14px;font:inherit;font-size:15px;outline:none}' +
    '.dsc-f input:focus{border-color:' + COR + '}' +
    '.dsc-f button{border:0;border-radius:100px;padding:0 16px;background:' + COR + ';color:#fff;font-weight:800;cursor:pointer}' +
    '.dsc-dig{align-self:flex-start;color:#6b5463;font-size:12px;padding:2px 4px}' +
    /* Checkout aberto (o app.js da loja põe body.ck-open): o balão sai da frente —
       ele cobria o campo "Nome completo" no celular. */
    'body.ck-open .dsc-btn,body.ck-open .dsc-pan{display:none!important}' +
    '.dsc-btn{transition:transform .2s,bottom .25s}' +
    /* Celular: painel ocupa a tela (em 320 px o topo ficava cortado, sem o X),
       letra de 16 px no campo (abaixo disso o iPhone dá zoom ao tocar) e
       sugestões numa linha que rola de lado. */
    '.dsc-f input{font-size:16px}' +
    '@media (max-width:520px){' +
      '.dsc-btn{width:52px;height:52px;right:12px}.dsc-btn svg{width:23px;height:23px}' +
      '.dsc-pan{left:8px;right:8px;top:8px;bottom:8px!important;width:auto;height:auto;border-radius:16px}' +
      'html.dsc-aberto .dsc-btn{display:none}' +
      '.dsc-chips{flex-wrap:nowrap;overflow-x:auto;padding-bottom:6px;scrollbar-width:none}.dsc-chips::-webkit-scrollbar{display:none}.dsc-chip{flex:none}' +
    '}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  var btn = document.createElement('button');
  btn.className = 'dsc-btn'; btn.type = 'button'; btn.setAttribute('aria-label', 'Abrir atendimento');
  btn.style.bottom = BAIXO + 'px';
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5z"/></svg><i class="dsc-badge" aria-hidden="true"></i>';

  var pan = document.createElement('div');
  pan.className = 'dsc-pan'; pan.setAttribute('role', 'dialog'); pan.setAttribute('aria-label', 'Atendimento' + (LOJA ? ' ' + LOJA : ''));
  pan.style.bottom = (BAIXO + 70) + 'px';
  pan.innerHTML = '<div class="dsc-hd"><div><b>Atendimento' + (LOJA ? ' ' + esc(LOJA) : '') + '</b><span>Respostas na hora · 24h</span></div><button type="button" class="dsc-x" aria-label="Fechar">×</button></div>' +
    '<div class="dsc-corpo" aria-live="polite"></div><div class="dsc-chips"></div>' +
    '<form class="dsc-f"><input type="text" maxlength="500" placeholder="Escreva sua dúvida…" aria-label="Sua mensagem" autocomplete="off"><button type="submit">Enviar</button></form>';

  document.body.appendChild(btn); document.body.appendChild(pan);
  var corpo = pan.querySelector('.dsc-corpo'), chips = pan.querySelector('.dsc-chips'), form = pan.querySelector('form'), input = form.querySelector('input');

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function linkar(s) {
    return esc(s).replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, function (u) {
      var rot = /wa\.me/.test(u) ? 'abrir WhatsApp' : (/rastrear-pedido/.test(u) ? 'acompanhar pedido' : u.replace(/^https?:\/\//, ''));
      return '<a href="' + u + '" target="_blank" rel="noopener">' + rot + '</a>';
    });
  }
  function desenhar() {
    corpo.innerHTML = '';
    estado.msgs.forEach(function (m) {
      var d = document.createElement('div'); d.className = 'dsc-m ' + (m.de === 'c' ? 'c' : 'b'); d.innerHTML = linkar(m.t); corpo.appendChild(d);
    });
    corpo.scrollTop = corpo.scrollHeight;
  }
  var SUGESTOES = ['Quanto custa?', 'Qual kit vale mais a pena?', 'Demora quanto pra chegar?', 'Como usar?', 'Já paguei e não atualizou', 'Falar com atendente'];
  function desenharChips() {
    chips.innerHTML = '';
    SUGESTOES.forEach(function (s) {
      var c = document.createElement('button'); c.type = 'button'; c.className = 'dsc-chip'; c.textContent = s;
      c.addEventListener('click', function () { enviar(s); }); chips.appendChild(c);
    });
  }
  /* Posição do balão: 16 px do rodapé, ou logo acima da barra de compra quando
     ela está na tela. Lido no scroll/resize, no máximo 1x por quadro. */
  var pendente = false;
  function posicionar() {
    pendente = false;
    var alvo = document.querySelector(EVITAR);
    var fundo = BAIXO;
    if (alvo) {
      var r = alvo.getBoundingClientRect();
      var visivel = r.height > 0 && r.top < window.innerHeight - 4 && getComputedStyle(alvo).display !== 'none' && getComputedStyle(alvo).visibility !== 'hidden';
      if (visivel) fundo = Math.max(BAIXO, Math.round(window.innerHeight - r.top) + 10);
    }
    btn.style.bottom = fundo + 'px';
    if (window.innerWidth > 520) { pan.style.bottom = (fundo + 66) + 'px'; pan.style.maxHeight = 'calc(100dvh - ' + (fundo + 66 + 16) + 'px)'; }
  }
  function agendar() { if (!pendente) { pendente = true; requestAnimationFrame(posicionar); } }
  addEventListener('scroll', agendar, { passive: true });
  addEventListener('resize', agendar);
  setInterval(posicionar, 700); // a barra anima por CSS sem disparar scroll

  function abrir(sim) {
    estado.aberto = sim; pan.classList.toggle('on', sim); btn.setAttribute('aria-expanded', String(sim));
    document.documentElement.classList.toggle('dsc-aberto', sim);
    if (sim && !estado.msgs.length) {
      estado.msgs.push({ de: 'b', t: 'Oi! 😊 Sou o atendimento' + (LOJA ? ' da ' + LOJA : '') + '. Posso te ajudar com preço dos kits, como usar, pagamento no Pix, prazo de entrega ou o status do seu pedido.' });
    }
    desenhar(); desenharChips(); salvar();
    if (sim) setTimeout(function () { input.focus(); }, 50);
  }
  var ocupado = false;
  function enviar(texto) {
    texto = String(texto || '').trim(); if (!texto || ocupado) return;
    ocupado = true;
    estado.msgs.push({ de: 'c', t: texto }); desenhar(); salvar();
    var dig = document.createElement('div'); dig.className = 'dsc-dig'; dig.textContent = 'digitando…'; corpo.appendChild(dig); corpo.scrollTop = corpo.scrollHeight;
    fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ texto: texto, contexto: estado.contexto }) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.contexto) estado.contexto = j.contexto;
        estado.msgs.push({ de: 'b', t: (j && (j.resposta || j.error)) || 'Não consegui responder agora.' });
      })
      .catch(function () { estado.msgs.push({ de: 'b', t: 'Fiquei sem conexão. Tenta de novo' + (ZAP ? ' ou fala com a gente no WhatsApp: https://wa.me/' + ZAP : '.') }); })
      .then(function () { ocupado = false; estado.msgs = estado.msgs.slice(-40); desenhar(); salvar(); });
  }
  btn.addEventListener('click', function () { abrir(!estado.aberto); });
  pan.querySelector('.dsc-x').addEventListener('click', function () { abrir(false); });
  form.addEventListener('submit', function (e) { e.preventDefault(); var t = input.value; input.value = ''; enviar(t); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && estado.aberto) abrir(false); });
  posicionar();
  if (estado.aberto) abrir(true);
})();
