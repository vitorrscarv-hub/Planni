// Cloudflare Pages Function — POST /api/chat

const SYSTEM = `Você é o assistente do app Planni, organizador pessoal de finanças, agenda, tarefas e notas (português do Brasil). Você recebe o estado atual do app no contexto. Use-o para responder perguntas e dar insights curtos. Quando o usuário pedir para CRIAR algo (evento, tarefa, transação ou nota), chame a função correspondente. Nunca invente dados. Se faltar info essencial, pergunte. Para datas relativas (hoje, amanhã), calcule a partir da data atual no contexto. Seja conciso e amigável.`;

const TOOLS = [{
  function_declarations: [
    { name: 'criar_evento', description: 'Cria um evento na agenda', parameters: { type: 'object', properties: { titulo: { type: 'string' }, data: { type: 'string', description: 'YYYY-MM-DD' }, hora: { type: 'string', description: 'HH:MM' }, lembrete_min: { type: 'integer' } }, required: ['titulo', 'data', 'hora'] } },
    { name: 'criar_tarefa', description: 'Cria uma tarefa', parameters: { type: 'object', properties: { texto: { type: 'string' }, importante: { type: 'boolean' }, urgente: { type: 'boolean' } }, required: ['texto'] } },
    { name: 'criar_transacao', description: 'Registra receita ou despesa', parameters: { type: 'object', properties: { descricao: { type: 'string' }, valor: { type: 'number' }, tipo: { type: 'string', description: 'in ou out' }, data: { type: 'string' } }, required: ['descricao', 'valor', 'tipo'] } },
    { name: 'criar_nota', description: 'Cria uma nota', parameters: { type: 'object', properties: { titulo: { type: 'string' }, corpo: { type: 'string' } }, required: ['titulo'] } }
  ]
}];

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
  try {
    const key = env.GEMINI_API_KEY;
    if (!key) return new Response(JSON.stringify({ error: 'GEMINI_API_KEY nao configurada.' }), { status: 500, headers: cors });
    const body = await request.json();
    const message = (body && body.message) || '';
    const history = (body && body.history) || [];
    const ctx = (body && body.context) || {};
    if (!message) return new Response(JSON.stringify({ error: 'Mensagem ausente.' }), { status: 400, headers: cors });
    const contents = [];
    contents.push({ role: 'user', parts: [{ text: SYSTEM + ' ESTADO ATUAL: ' + JSON.stringify(ctx) }] });
    contents.push({ role: 'model', parts: [{ text: 'Entendido.' }] });
    (history || []).forEach(function (h) { contents.push({ role: h.role === 'user' ? 'user' : 'model', parts: [{ text: String(h.text || '') }] }); });
    contents.push({ role: 'user', parts: [{ text: message }] });
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + key;
    const gemResp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: contents, tools: TOOLS, generationConfig: { tem
