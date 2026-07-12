// Cloudflare Pages Function — POST /api/analisar
// Recebe { image: "<base64 sem prefixo>" } e devolve { items: [...] }
// A chave do Gemini fica em GEMINI_API_KEY (variável de ambiente do Cloudflare),
// NUNCA no index.html.
//
// Exige autenticação: o client precisa mandar o header
// "Authorization: Bearer <idToken>" com o ID Token do Firebase do usuário
// logado. Sem isso, o endpoint recusa a requisição — isso evita que
// qualquer pessoa fora do app consuma sua cota do Gemini de graça.

const PROMPT = `Analise esta imagem de uma agenda ou caderno manuscrito ou impresso.
Extraia TODOS os itens escritos e classifique cada um.
Responda SOMENTE com JSON válido, sem texto antes ou depois, sem markdown.
Formato exato:
{"items":[{"texto":"texto do item","tipo":"agenda|tarefa|compra|financas","data":"YYYY-MM-DD ou null","hora":"HH:MM ou null","valor":"valor numérico em reais ou null"}]}
Regras:
- tipo "agenda" para compromissos com horário (reuniões, consultas, eventos).
- tipo "tarefa" para afazeres sem horário fixo.
- tipo "compra" para itens de lista de compras.
- tipo "financas" para pagamentos, valores a pagar/receber, contas.
- Se a data aparecer sem ano, use o ano atual.
- Se não houver itens legíveis, devolva {"items":[]}.`;

// Limite de tamanho da imagem em base64 (~6MB de imagem original)
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

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };

  try {
    // 0. Autenticação — bloqueia qualquer chamada sem usuário logado válido
    const uid = await verifyFirebaseToken(request, env);
    if (!uid) {
      return new Response(JSON.stringify({ error: 'Não autenticado.' }), { status: 401, headers: cors });
    }

    const key = env.GEMINI_API_KEY;
    if (!key) {
      return new Response(JSON.stringify({ error: 'GEMINI_API_KEY não configurada no Cloudflare.' }), { status: 500, headers: cors });
    }

    const body = await request.json();
    const image = body && body.image;
    if (!image) {
      return new Response(JSON.stringify({ error: 'Imagem ausente.' }), { status: 400, headers: cors });
    }
    if (image.length > MAX_IMAGE_LEN) {
      return new Response(JSON.stringify({ error: 'Imagem grande demais.' }), { status: 400, headers: cors });
    }

    const model = 'gemini-2.5-flash';
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key;

    const geminiBody = {
      contents: [{
        parts: [
          { inline_data: { mime_type: 'image/jpeg', data: image } },
          { text: PROMPT }
        ]
      }],
      generationConfig: {
        temperature: 0.1,
        response_mime_type: 'application/json'
      }
    };

    const gemResp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody)
    });

    if (!gemResp.ok) {
      const errText = await gemResp.text();
      return new Response(JSON.stringify({ error: 'Erro Gemini: ' + gemResp.status, detail: errText }), { status: 502, headers: cors });
    }

    const data = await gemResp.json();
    // Extrai o texto retornado
    let text = '';
    try {
      const parts = data.candidates[0].content.parts;
      text = parts.map(function (p) { return p.text || ''; }).join('');
    } catch (e) {
      text = '';
    }

    // Limpa eventuais cercas de markdown e faz parse
    const clean = text.replace(/```json|```/g, '').trim();
    let parsed = { items: [] };
    try { parsed = JSON.parse(clean); } catch (e) { parsed = { items: [] }; }

    return new Response(JSON.stringify(parsed), { status: 200, headers: cors });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: cors });
  }
}

// Responde a preflight CORS
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  });
}
