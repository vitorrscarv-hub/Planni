// Cloudflare Pages Function - POST /api/extrato
// Recebe { text: "<conteudo do OFX/CSV>", filename: "<nome>" } OU { image: "<base64 sem prefixo>", mime: "<tipo>" }
// Devolve { transactions: [...], summary: {...} }
// A chave do Gemini fica em GEMINI_API_KEY (variavel de ambiente do Cloudflare).
// O arquivo enviado NUNCA e armazenado - so processado e descartado.
//
// ARQUITETURA EM CAMADAS:
//   Camada 1: parser nativo OFX/CSV (parser.js) - sem IA, custo zero, 100% confiavel.
//   Camada 2: Gemini com retry - usado para PDF/imagem ou texto que o parser nao entendeu.
//
// Exige autenticação: o client precisa mandar o header
// "Authorization: Bearer <idToken>" com o ID Token do Firebase do usuário
// logado. Sem isso, o endpoint recusa a requisição — mesmo a Camada 1
// (sem custo de IA) fica atrás do login, pra ninguém usar isso como
// processador de extrato genérico e gratuito fora do app.

import { parseLocal } from './parser.js';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };

const PROMPT = 'Voce e um assistente financeiro que analisa extratos bancarios brasileiros (PIX, cartao de credito, debito, TED, boletos, salario). Extraia TODAS as transacoes encontradas no conteudo fornecido. Para cada transacao, identifique: descricao curta e clara, valor (sempre positivo, numero), tipo (in para receita/credito, out para despesa/debito), data no formato YYYY-MM-DD, categoria, e quando for PIX ou TED, tente identificar o nome da pessoa ou empresa envolvida. As categorias possiveis sao: alimentacao, transporte, moradia, saude, lazer, compras, educacao, servicos, salario, investimentos, outros. Regras importantes: nunca invente transacoes que nao estao no texto; se um valor ou data estiver ilegivel, pule essa transacao; PIX recebido e credito (in), PIX enviado e debito (out); pagamento de fatura de cartao dentro do extrato da conta corrente deve ser categoria servicos; salario e tipo in categoria salario. Responda SOMENTE com JSON valido, sem texto antes ou depois, sem markdown, no formato exato: {"transactions":[{"desc":"texto curto","val":99.90,"type":"in ou out","cat":"categoria","date":"YYYY-MM-DD","pessoa":"nome ou null"}]}. Se nao encontrar nenhuma transacao valida, devolva {"transactions":[]}.';

// Tipos de arquivo aceitos para envio multimodal ao Gemini
const ALLOWED_MIMES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

// Limite de tamanho da imagem em base64 (~6MB de imagem/PDF original)
const MAX_IMAGE_LEN = 8 * 1024 * 1024;

// ── Verifica o ID Token do Firebase enviado no header Authorization ──────────
// Retorna o uid do usuário se o token for válido, ou null caso contrário.
async function verifyFirebaseToken(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const idToken = match[1];

  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken })
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.users?.[0]?.localId || null;
  } catch (e) {
    return null;
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    // 0. Autenticação — bloqueia qualquer chamada sem usuário logado válido
    const uid = await verifyFirebaseToken(request, env);
    if (!uid) {
      return new Response(JSON.stringify({ error: 'Não autenticado.' }), { status: 401, headers: CORS });
    }

    const key = env.GEMINI_API_KEY;
    if (!key) return new Response(JSON.stringify({ error: 'GEMINI_API_KEY nao configurada.' }), { status: 500, headers: CORS });

    const body = await request.json();
    const text = body && body.text;
    const image = body && body.image;
    // Tipo real do arquivo informado pelo frontend; se ausente, assume JPEG por compatibilidade
    let mime = body && body.mime ? String(body.mime) : 'image/jpeg';
    if (ALLOWED_MIMES.indexOf(mime) === -1) mime = 'image/jpeg';
    if (!text && !image) return new Response(JSON.stringify({ error: 'Nenhum conteudo enviado.' }), { status: 400, headers: CORS });
    if (image && image.length > MAX_IMAGE_LEN) {
      return new Response(JSON.stringify({ error: 'Arquivo grande demais.' }), { status: 400, headers: CORS });
    }

    // ===== CAMADA 1: parser nativo OFX/CSV (sem IA) =====
    // Se veio texto (OFX/CSV), tenta ler localmente. Custo zero, instantaneo, nunca da 503.
    if (text) {
      try {
        const filename = body && body.filename ? String(body.filename) : '';
        const local = parseLocal(String(text), filename);
        if (local && local.transactions && local.transactions.length) {
          // Sucesso na Camada 1 - nem chega a usar a IA
          return new Response(JSON.stringify(local), { status: 200, headers: CORS });
        }
      } catch (e) {
        // Se o parser falhar por qualquer motivo, segue para a IA (Camada 2)
      }
    }

    // ===== CAMADA 2: Gemini (PDF, imagem, ou texto que o parser nao entendeu) =====
    // Limite de seguranca: corta textos muito grandes para nao estourar o limite da API
    const safeText = text ? String(text).slice(0, 60000) : null;

    const parts = [];
    if (safeText) {
      parts.push({ text: PROMPT + '\n\nCONTEUDO DO EXTRATO:\n' + safeText });
    } else {
      parts.push({ inline_data: { mime_type: mime, data: image } });
      parts.push({ text: PROMPT });
    }

    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + key;
    const geminiBody = {
      contents: [{ parts: parts }],
      generationConfig: { temperature: 0.1, response_mime_type: 'application/json' }
    };

    // Tenta chamar o Gemini com retry automatico em caso de sobrecarga temporaria.
    // Codigos 503 (UNAVAILABLE), 429 (rate limit) e 500 sao tentados novamente.
    const RETRYABLE = [429, 500, 503];
    const MAX_TRIES = 4;
    let gemResp = null;
    let lastErrText = '';
    let lastStatus = 0;

    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
      gemResp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(geminiBody) });
      if (gemResp.ok) break;

      lastStatus = gemResp.status;
      lastErrText = await gemResp.text();

      // Se nao for um erro temporario, nao adianta tentar de novo
      if (RETRYABLE.indexOf(gemResp.status) === -1) break;

      // Espera progressiva antes da proxima tentativa: 0.8s, 1.6s, 2.4s
      if (attempt < MAX_TRIES) {
        await new Promise(function (r) { setTimeout(r, attempt * 800); });
      }
    }

    if (!gemResp || !gemResp.ok) {
      // Mensagem amigavel para o caso mais comum (servico sobrecarregado)
      const overloaded = (lastStatus === 503 || lastStatus === 429);
      const friendly = overloaded
        ? 'O serviço de IA está temporariamente sobrecarregado. Aguarde alguns minutos e tente novamente.'
        : 'Não foi possível processar o extrato agora. Tente novamente em instantes.';
      return new Response(JSON.stringify({
        error: friendly,
        overloaded: overloaded,
        geminiStatus: lastStatus,
        detail: lastErrText
      }), { status: 502, headers: CORS });
    }

    const data = await gemResp.json();
    let raw = '';
    try {
      raw = data.candidates[0].content.parts.map(function (p) { return p.text || ''; }).join('');
    } catch (e) { raw = ''; }

    const clean = raw.replace(/```json/g, '').replace(/```/g, '').trim();
    let parsed = { transactions: [] };
    try { parsed = JSON.parse(clean); } catch (e) { parsed = { transactions: [] }; }
    if (!Array.isArray(parsed.transactions)) parsed.transactions = [];

    // Validação básica de cada transação antes de devolver
    var clean_tx = [];
    parsed.transactions.forEach(function (t) {
      if (!t || typeof t !== 'object') return;
      var val = parseFloat(t.val);
      if (isNaN(val) || val <= 0) return;
      if (t.type !== 'in' && t.type !== 'out') return;
      if (!t.date || !/^\d{4}-\d{2}-\d{2}$/.test(t.date)) return;
      clean_tx.push({
        desc: String(t.desc || 'Transação importada').slice(0, 80),
        val: Math.round(val * 100) / 100,
        type: t.type,
        cat: String(t.cat || 'outros').toLowerCase(),
        date: t.date,
        pessoa: t.pessoa ? String(t.pessoa).slice(0, 60) : null
      });
    });

    // Resumo para exibição rápida antes de confirmar
    var totalIn = 0, totalOut = 0;
    clean_tx.forEach(function (t) { if (t.type === 'in') totalIn += t.val; else totalOut += t.val; });

    return new Response(JSON.stringify({
      transactions: clean_tx,
      summary: { count: clean_tx.length, totalIn: Math.round(totalIn * 100) / 100, totalOut: Math.round(totalOut * 100) / 100 }
    }), { status: 200, headers: CORS });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}
