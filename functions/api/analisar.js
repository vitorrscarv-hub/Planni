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
// Retorna { uid, transient }:
//   uid       = id do usuário se o token for válido, ou null.
//   transient = true quando NÃO foi possível validar por falha temporária do
//               Google (429/5xx/erro de rede) — o token pode ser válido.
// Distinguir os dois casos evita rejeitar com 401 um usuário logado só porque
// a consulta ao identitytoolkit falhou momentaneamente.
async function verifyFirebaseToken(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return { uid: null, transient: false };
  const idToken = match[1];

  const MAX_TRIES = 3;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    let res = null;
    try {
      res = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken })
        }
      );
    } catch (e) {
      res = null; // erro de rede: trata como temporário e tenta de novo
    }
    if (res && res.ok) {
      const data = await res.json().catch(() => null);
      return { uid: data?.users?.[0]?.localId || null, transient: false };
    }
    // 400 = o Google analisou o token e ele é realmente inválido/expirado;
    // repetir não muda o resultado.
    if (res && res.status === 400) return { uid: null, transient: false };
    if (attempt < MAX_TRIES) {
      await new Promise((r) => setTimeout(r, attempt * 400));
    }
  }
  return { uid: null, transient: true };
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
    const auth = await verifyFirebaseToken(request, env);
    if (!auth.uid) {
      if (auth.transient) {
        // Falha temporária ao validar (não é culpa do usuário): 503 com
        // mensagem amigável, em vez de um 401 enganoso de "Não autenticado".
        return new Response(
          JSON.stringify({ error: 'Não consegui validar sua sessão agora. Tente novamente em instantes.', overloaded: true }),
          { status: 503, headers: cors }
        );
      }
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
