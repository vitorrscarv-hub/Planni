// Cloudflare Pages Function — POST /api/chat
// Agente conversacional sobre os dados do Planni, com function calling (Gemini).
// Recebe { message, history, context } e devolve { reply, actions }.
// actions = lista de ações que o app deve executar (criar evento/tarefa/etc).
// A chave fica em GEMINI_API_KEY (variável de ambiente), nunca no client.
//
// Exige autenticação: o client precisa mandar o header
// "Authorization: Bearer <idToken>" com o ID Token do Firebase do usuário
// logado. Sem isso, o endpoint recusa a requisição — isso evita que
// qualquer pessoa fora do app consuma sua cota do Gemini de graça.

const SYSTEM = `Você é o assistente do app Planni, um organizador pessoal de finanças, agenda, tarefas e notas (em português do Brasil).
Você recebe o estado atual do app no contexto. Use-o para responder perguntas e dar insights úteis, diretos e curtos.

COMO USAR O CONTEXTO FINANCEIRO:
- O campo "resumoTransacoes" traz os totais de TODAS as transações do usuário (receitas, despesas, saldo e gastos por categoria). Use-o para perguntas gerais como "quanto gastei", "qual meu saldo", "quanto gastei com alimentação".
- O campo "transacoesRelevantes" traz as transações que correspondem a um valor ou nome citado na pergunta. SEMPRE consulte esse campo primeiro quando o usuário perguntar sobre uma transação específica (um valor, uma pessoa, um estabelecimento).
- O campo "transacoes" traz as transações recentes (lista parcial). Para perguntas sobre uma transação específica, confie em "transacoesRelevantes", não apenas em "transacoes".
- IMPORTANTE: se o usuário perguntar se existe uma transação de determinado valor/pessoa e ela NÃO aparecer em "transacoesRelevantes", responda que não encontrou essa transação — mas só afirme isso com base nesse campo, que é a busca completa. Nunca conclua "não existe" olhando apenas a lista parcial "transacoes".

Quando o usuário pedir para CRIAR algo (evento, tarefa, transação ou nota), chame a função correspondente.
REGRA CRÍTICA CONTRA DUPLICAÇÃO: chame uma função de criação APENAS para o pedido ATUAL do usuário (a última mensagem). NUNCA recrie itens mencionados em mensagens anteriores do histórico — eles já foram processados. Se o histórico mostrar "(transação já registrada pelo app...)", ignore completamente aquele comando, ele já foi executado. Cada mensagem do usuário gera no máximo as ações que ela própria pede.
Nunca invente dados que não estão no contexto. Se faltar uma informação essencial para criar algo (ex: valor de uma transação), pergunte antes.
Para datas relativas (hoje, amanhã), calcule a partir da data atual fornecida no contexto.
Seja conciso e amigável. Responda sempre em português do Brasil.`;

const TOOLS = [{
  function_declarations: [
    {
      name: 'criar_evento',
      description: 'Cria um evento/compromisso na agenda',
      parameters: {
        type: 'object',
        properties: {
          titulo: { type: 'string', description: 'Nome do evento' },
          data: { type: 'string', description: 'Data no formato YYYY-MM-DD' },
          hora: { type: 'string', description: 'Hora no formato HH:MM' },
          lembrete_min: { type: 'integer', description: 'Minutos antes para lembrar (0,5,15,30,60,1440). Padrão 15.' }
        },
        required: ['titulo', 'data', 'hora']
      }
    },
    {
      name: 'criar_tarefa',
      description: 'Cria uma tarefa na matriz de prioridades',
      parameters: {
        type: 'object',
        properties: {
          texto: { type: 'string', description: 'Descrição da tarefa' },
          importante: { type: 'boolean', description: 'Se é importante. Padrão true.' },
          urgente: { type: 'boolean', description: 'Se é urgente. Padrão false.' }
        },
        required: ['texto']
      }
    },
    {
      name: 'criar_transacao',
      description: 'Registra uma receita ou despesa financeira',
      parameters: {
        type: 'object',
        properties: {
          descricao: { type: 'string', description: 'Descrição da transação' },
          valor: { type: 'number', description: 'Valor em reais (número positivo)' },
          tipo: { type: 'string', description: '"in" para receita, "out" para despesa' },
          data: { type: 'string', description: 'Data YYYY-MM-DD. Padrão hoje.' }
        },
        required: ['descricao', 'valor', 'tipo']
      }
    },
    {
      name: 'criar_nota',
      description: 'Cria uma nota de texto',
      parameters: {
        type: 'object',
        properties: {
          titulo: { type: 'string', description: 'Título da nota' },
          corpo: { type: 'string', description: 'Conteúdo da nota' }
        },
        required: ['titulo']
      }
    }
  ]
}];

// Limites de entrada (defesa extra, além da autenticação)
const MAX_MESSAGE_LEN = 4000;
const MAX_HISTORY_ITEMS = 20;
const MAX_CONTEXT_LEN = 30000; // caracteres, após JSON.stringify

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
    if (!key) return new Response(JSON.stringify({ error: 'GEMINI_API_KEY não configurada.' }), { status: 500, headers: cors });

    const body = await request.json();
    let message = (body && body.message) || '';
    let history = (body && body.history) || [];
    const ctx = (body && body.context) || {};
    if (!message) return new Response(JSON.stringify({ error: 'Mensagem ausente.' }), { status: 400, headers: cors });

    // Limites de tamanho — evita abuso mesmo vindo de um usuário autenticado
    if (message.length > MAX_MESSAGE_LEN) message = message.slice(0, MAX_MESSAGE_LEN);
    if (Array.isArray(history) && history.length > MAX_HISTORY_ITEMS) {
      history = history.slice(-MAX_HISTORY_ITEMS);
    }
    let ctxStr = JSON.stringify(ctx);
    if (ctxStr.length > MAX_CONTEXT_LEN) {
      return new Response(JSON.stringify({ error: 'Contexto enviado é grande demais.' }), { status: 400, headers: cors });
    }

    // Build conversation: system + context as first user turn, then history, then new message
    const contents = [];
    contents.push({ role: 'user', parts: [{ text: SYSTEM + '\n\n=== ESTADO ATUAL DO APP ===\n' + ctxStr }] });
    contents.push({ role: 'model', parts: [{ text: 'Entendido. Estou pronto para ajudar com seus dados.' }] });
    (history || []).forEach(function (h) {
      contents.push({ role: h.role === 'user' ? 'user' : 'model', parts: [{ text: String(h.text || '') }] });
    });
    contents.push({ role: 'user', parts: [{ text: message }] });

    const model = 'gemini-2.5-flash';
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key;
    const geminiBody = { contents: contents, tools: TOOLS, generationConfig: { temperature: 0.3 } };

    // Chamada ao Gemini com retry automatico para erros temporarios (503/429/500)
    const RETRYABLE = [429, 500, 503];
    const MAX_TRIES = 4;
    let gemResp = null;
    let lastErrText = '';
    let lastStatus = 0;

    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
      gemResp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiBody)
      });
      if (gemResp.ok) break;

      lastStatus = gemResp.status;
      lastErrText = await gemResp.text();
      if (RETRYABLE.indexOf(gemResp.status) === -1) break;
      if (attempt < MAX_TRIES) {
        await new Promise(function (r) { setTimeout(r, attempt * 800); });
      }
    }

    if (!gemResp || !gemResp.ok) {
      const overloaded = (lastStatus === 503 || lastStatus === 429);
      const friendly = overloaded
        ? 'O assistente está temporariamente sobrecarregado. Tente novamente em alguns instantes.'
        : 'Não consegui responder agora. Tente novamente em instantes.';
      return new Response(JSON.stringify({ error: friendly, overloaded: overloaded, geminiStatus: lastStatus, detail: lastErrText }), { status: 502, headers: cors });
    }

    const data = await gemResp.json();
    let reply = '';
    const actions = [];
    try {
      const parts = data.candidates[0].content.parts || [];
      parts.forEach(function (p) {
        if (p.text) reply += p.text;
        if (p.functionCall) {
          actions.push({ name: p.functionCall.name, args: p.functionCall.args || {} });
        }
      });
    } catch (e) { /* leave reply empty */ }

    if (!reply && actions.length) {
      reply = 'Feito! ' + actions.map(function (a) { return a.name.replace('criar_', '+ '); }).join(', ');
    }
    if (!reply) reply = 'Desculpe, não entendi. Pode reformular?';

    return new Response(JSON.stringify({ reply: reply, actions: actions }), { status: 200, headers: cors });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: cors });
  }
}

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
