// Cloudflare Pages Function - POST /api/extrato
// Recebe { text: "<conteudo do OFX/CSV>" } OU { image: "<base64 sem prefixo>" }
// Devolve { transactions: [...], summary: {...} }
// A chave do Gemini fica em GEMINI_API_KEY (variavel de ambiente do Cloudflare).
// O arquivo enviado NUNCA e armazenado - so processado e descartado.

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };

const PROMPT = 'Voce e um assistente financeiro que analisa extratos bancarios brasileiros (PIX, cartao de credito, debito, TED, boletos, salario). Extraia TODAS as transacoes encontradas no conteudo fornecido. Para cada transacao, identifique: descricao curta e clara, valor (sempre positivo, numero), tipo (in para receita/credito, out para despesa/debito), data no formato YYYY-MM-DD, categoria, e quando for PIX ou TED, tente identificar o nome da pessoa ou empresa envolvida. As categorias possiveis sao: alimentacao, transporte, moradia, saude, lazer, compras, educacao, servicos, salario, investimentos, outros. Regras importantes: nunca invente transacoes que nao estao no texto; se um valor ou data estiver ilegivel, pule essa transacao; PIX recebido e credito (in), PIX enviado e debito (out); pagamento de fatura de cartao dentro do extrato da conta corrente deve ser categoria servicos; salario e tipo in categoria salario. Responda SOMENTE com JSON valido, sem texto antes ou depois, sem markdown, no formato exato: {"transactions":[{"desc":"texto curto","val":99.90,"type":"in ou out","cat":"categoria","date":"YYYY-MM-DD","pessoa":"nome ou null"}]}. Se nao encontrar nenhuma transacao valida, devolva {"transactions":[]}.';

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const key = env.GEMINI_API_KEY;
    if (!key) return new Response(JSON.stringify({ error: 'GEMINI_API_KEY nao configurada.' }), { status: 500, headers: CORS });

    const body = await request.json();
    const text = body && body.text;
    const image = body && body.image;
    if (!text && !image) return new Response(JSON.stringify({ error: 'Nenhum conteudo enviado.' }), { status: 400, headers: CORS });

    // Limite de segurança: corta textos muito grandes para não estourar o limite da API
    const safeText = text ? String(text).slice(0, 60000) : null;

    const parts = [];
    if (safeText) {
      parts.push({ text: PROMPT + '\n\nCONTEUDO DO EXTRATO:\n' + safeText });
    } else {
      parts.push({ inline_data: { mime_type: 'image/jpeg', data: image } });
      parts.push({ text: PROMPT });
    }

    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + key;
    const geminiBody = {
      contents: [{ parts: parts }],
      generationConfig: { temperature: 0.1, response_mime_type: 'application/json' }
    };

    const gemResp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(geminiBody) });
    if (!gemResp.ok) {
      const errText = await gemResp.text();
      return new Response(JSON.stringify({ error: 'Erro Gemini: ' + gemResp.status, detail: errText }), { status: 502, headers: CORS });
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
