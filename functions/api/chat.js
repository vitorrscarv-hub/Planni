// Cloudflare Pages Function — POST /api/chat
// Agente conversacional sobre os dados do Planni, com function calling (Gemini).
// Recebe { message, history, context } e devolve { reply, actions }.
// actions = lista de ações que o app deve executar (criar evento/tarefa/etc).
// A chave fica em GEMINI_API_KEY (variável de ambiente), nunca no client.

const SYSTEM = `Você é o assistente do app Planni, um organizador pessoal de finanças, agenda, tarefas e notas (em português do Brasil).
Você recebe o estado atual do app no contexto. Use-o para responder perguntas e dar insights úteis, diretos e curtos.
Quando o usuário pedir para CRIAR algo (evento, tarefa, transação ou nota), chame a função correspondente.
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

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  try {
    const key = env.GEMINI_API_KEY;
    if (!key) return new Response(JSON.stringify({ error: 'GEMINI_API_KEY não configurada.' }), { status: 500, headers: cors });

    const body = await request.json();
    const message = (body && body.message) || '';
    const history = (body && body.history) || [];
    const ctx = (body && body.context) || {};
    if (!message) return new Response(JSON.stringify({ error: 'Mensagem ausente.' }), { status: 400, headers: cors });

    // Build conversation: system + context as first user turn, then history, then new message
    const contents = [];
    contents.push({ role: 'user', parts: [{ text: SYSTEM + '\n\n=== ESTADO ATUAL DO APP ===\n' + JSON.stringify(ctx) }] });
    contents.push({ role: 'model', parts: [{ text: 'Entendido. Estou pronto para ajudar com seus dados.' }] });
    (history || []).forEach(function (h) {
      contents.push({ role: h.role === 'user' ? 'user' : 'model', parts: [{ text: String(h.text || '') }] });
    });
    contents.push({ role: 'user', parts: [{ text: message }] });

    const model = 'gemini-2.5-flash';
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key;

    const gemResp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: contents, tools: TOOLS, generationConfig: { temperature: 0.3 } })
    });

    if (!gemResp.ok) {
      const errText = await gemResp.text();
      return new Response(JSON.stringify({ error: 'Erro Gemini: ' + gemResp.status, detail: errText }), { status: 502, headers: cors });
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
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
