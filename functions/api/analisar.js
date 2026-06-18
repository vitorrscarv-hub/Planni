// Cloudflare Pages Function - POST /api/analisar
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const key = env.GEMINI_API_KEY;
    if (!key) return new Response(JSON.stringify({ error: 'GEMINI_API_KEY nao configurada.' }), { status: 500, headers: CORS });
    const body = await request.json();
    const image = body && body.image;
    if (!image) return new Response(JSON.stringify({ error: 'Imagem ausente.' }), { status: 400, headers: CORS });
    const prompt = 'Analise esta imagem (agenda, caderno, lista ou documento) e extraia itens acionaveis. Responda APENAS um array JSON, sem texto extra: [{"tipo":"agenda|tarefa|compra|financas","texto":"descricao","data":"YYYY-MM-DD ou vazio","hora":"HH:MM ou vazio","valor":"numero ou vazio"}]. Use o ano atual se nao houver. Se nada for identificado, responda [].';
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + key;
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [ { text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: image } } ] }], generationConfig: { temperature: 0.1 } }) });
    if (!r.ok) { const t = await r.text(); return new Response(JSON.stringify({ error: 'Erro Gemini: ' + r.status, detail: t }), { status: 502, headers: CORS }); }
    const data = await r.json();
    let txt = '';
    try { txt = data.candidates[0].content.parts[0].text || ''; } catch (e) {}
    txt = txt.replace(/```json/g, '').replace(/```/g, '').trim();
    let items = [];
    try { items = JSON.parse(txt); } catch (e) { items = []; }
    if (!Array.isArray(items)) items = [];
    return new Response(JSON.stringify({ items: items }), { status: 200, headers: CORS });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS });
  }
}
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });  
}
