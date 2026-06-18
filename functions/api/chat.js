// Cloudflare Pages Function - POST /api/chat
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
const SYS = 'Voce e o assistente do app Planni (financas, agenda, tarefas, notas, em portugues do Brasil). Use o contexto para responder curto e criar itens quando pedirem. Para criar, chame a funcao certa. Nao invente dados. Datas relativas a partir da data no contexto.';
const TOOLS = [{ function_declarations: [
  { name: 'criar_evento', description: 'Cria evento', parameters: { type: 'object', properties: { titulo: { type: 'string' }, data: { type: 'string' }, hora: { type: 'string' }, lembrete_min: { type: 'integer' } }, required: ['titulo','data','hora'] } },
  { name: 'criar_tarefa', description: 'Cria tarefa', parameters: { type: 'object', properties: { texto: { type: 'string' }, importante: { type: 'boolean' }, urgente: { type: 'boolean' } }, required: ['texto'] } },
  { name: 'criar_transacao', description: 'Cria receita ou despesa', parameters: { type: 'object', properties: { descricao: { type: 'string' }, valor: { type: 'number' }, tipo: { type: 'string' }, data: { type: 'string' } }, required: ['descricao','valor','tipo'] } },
  { name: 'criar_nota', description: 'Cria nota', parameters: { type: 'object', properties: { titulo: { type: 'string' }, corpo: { type: 'string' } }, required: ['titulo'] } }
]}];
export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const key = env.GEMINI_API_KEY;
    if (!key) return new Response(JSON.stringify({ error: 'GEMINI_API_KEY nao configurada.' }), { status: 500, headers: CORS });
    const body = await request.json();
    const message = (body && body.message) || '';
    const history = (body && body.history) || [];
    const ctx = (body && body.context) || {};
    if (!message) return new Response(JSON.stringify({ error: 'Mensagem ausente.' }), { status: 400, headers: CORS });
    const contents = [];
    contents.push({ role: 'user', parts: [{ text: SYS + ' CONTEXTO: ' + JSON.stringify(ctx) }] });
    contents.push({ role: 'model', parts: [{ text: 'Ok.' }] });
    (history || []).forEach(function (h) { contents.push({ role: h.role === 'user' ? 'user' : 'model', parts: [{ text: String(h.text || '') }] }); });
    contents.push({ role: 'user', parts: [{ text: message }] });
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + key;
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: contents, tools: TOOLS, generationConfig: { temperature: 0.3 } }) });
    if (!r.ok) { const t = await r.text(); return new Response(JSON.stringify({ error: 'Erro Gemini: ' + r.status, detail: t }), { status: 502, headers: CORS }); }
    const data = await r.json();
    let reply = '';
    const actions = [];
    try { (data.candidates[0].content.parts || []).forEach(function (p) { if (p.text) reply += p.text; if (p.functionCall) actions.push({ name: p.functionCall.name, args: p.functionCall.args || {} }); }); } catch (e) {}
    if (!reply && actions.length) reply = 'Feito!';
    if (!reply) reply = 'Desculpe, nao entendi. Pode reformular?';
    return new Response(JSON.stringify({ reply: reply, actions: actions }), { status: 200, headers: CORS });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS });
  }
}
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}
