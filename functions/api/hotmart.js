// Cloudflare Pages Function — POST /api/hotmart
// Recebe webhooks do Hotmart e atualiza o campo premium no Firebase
// Variáveis de ambiente necessárias no Cloudflare:
//   HOTMART_SECRET      → chave secreta do webhook (Hottok)
//   FIREBASE_PROJECT_ID → ID do projeto Firebase (smart-life-finance)
//   FIREBASE_API_KEY    → Web API Key do Firebase

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-HOTMART-HOTTOK, hottok',
  'Content-Type': 'application/json'
};

// Eventos do Hotmart que ativam ou revogam o Premium
const PREMIUM_ON = [
  'PURCHASE_APPROVED',       // pagamento aprovado (inclui primeiro pagamento)
  'PURCHASE_COMPLETE',       // compra concluída
  'SUBSCRIPTION_REACTIVATED' // reativação após cancelamento
];

const PREMIUM_OFF = [
  'PURCHASE_CANCELED',        // cancelamento pelo cliente
  'PURCHASE_CHARGEBACK',      // chargeback
  'PURCHASE_REFUNDED',        // reembolso
  'SUBSCRIPTION_CANCELLATION' // cancelamento de assinatura
];

// ── Extrai o e-mail do comprador de várias estruturas possíveis do payload ──
// O Hotmart v2.0.0 pode aninhar o e-mail em lugares diferentes conforme o evento.
function extractEmail(payload) {
  const d = payload?.data || {};
  return (
    d?.buyer?.email ||
    d?.subscriber?.email ||
    d?.subscription?.subscriber?.email ||
    d?.purchase?.buyer?.email ||
    d?.contact?.email ||
    payload?.buyer?.email ||
    payload?.email ||
    ''
  );
}

// ── Extrai o nome do evento de várias estruturas possíveis ──
function extractEvent(payload) {
  return payload?.event || payload?.data?.event || payload?.webhook?.event || '';
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    // 1. Valida a chave secreta do Hotmart (Hottok)
    // O Hotmart envia esse token no cabeçalho "X-HOTMART-HOTTOK" (doc oficial).
    // Mantemos "hottok" como fallback só por segurança, mas o nome certo é o de cima.
    const hottok = request.headers.get('X-HOTMART-HOTTOK')
                || request.headers.get('hottok')
                || '';
    if (!env.HOTMART_SECRET || hottok !== env.HOTMART_SECRET) {
      console.warn('Webhook rejeitado: hottok inválido');
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: CORS });
    }

    // 2. Lê o payload
    const payload = await request.json();

    // ── LOG DE DIAGNÓSTICO ──
    // Registra o payload completo para inspecionarmos a estrutura real no log da function.
    // (Remover depois que o fluxo estiver validado, para não poluir os logs.)
    console.log('=== PAYLOAD RECEBIDO ===');
    console.log(JSON.stringify(payload));
    console.log('========================');

    const event = extractEvent(payload);
    const email = extractEmail(payload);

    console.log(`Evento extraído: "${event}" | E-mail extraído: "${email}"`);

    if (!event || !email) {
      // Log detalhado do que faltou, pra facilitar o diagnóstico
      console.warn(`Payload inválido — event: "${event}", email: "${email}". Chaves de data: ${JSON.stringify(Object.keys(payload?.data || {}))}`);
      return new Response(JSON.stringify({
        error: 'Payload inválido',
        debug: { event: event || null, emailFound: !!email, dataKeys: Object.keys(payload?.data || {}) }
      }), { status: 400, headers: CORS });
    }

    // 3. Determina ação
    let premiumValue = null;
    if (PREMIUM_ON.includes(event))  premiumValue = true;
    if (PREMIUM_OFF.includes(event)) premiumValue = false;

    if (premiumValue === null) {
      // Evento que não nos interessa — responde 200 pra o Hotmart não retentar
      return new Response(JSON.stringify({ ok: true, action: 'ignored', event }), { status: 200, headers: CORS });
    }

    // 4. Busca o UID do usuário pelo email no Firebase Auth REST API
    const uid = await getUidByEmail(email, env);
    if (!uid) {
      console.warn(`Usuário não encontrado no Firebase: ${email}`);
      // Mesmo sem UID, responde 200 pra Hotmart não retentar desnecessariamente
      return new Response(JSON.stringify({ ok: true, action: 'user_not_found', email }), { status: 200, headers: CORS });
    }

    // 5. Atualiza o campo premium no Firestore
    await setPremiumFirestore(uid, premiumValue, env);

    console.log(`Premium ${premiumValue ? 'ATIVADO' : 'REVOGADO'} para ${email} (${uid})`);
    return new Response(JSON.stringify({ ok: true, action: premiumValue ? 'activated' : 'revoked', email, uid }), { status: 200, headers: CORS });

  } catch (err) {
    console.error('Erro no webhook:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

// ── Busca o UID do Firebase pelo email via REST API ──────────────────────────
async function getUidByEmail(email, env) {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: [email] })
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.users?.[0]?.localId || null;
}

// ── Atualiza o campo premium no Firestore via REST API ───────────────────────
async function setPremiumFirestore(uid, value, env) {
  const project = env.FIREBASE_PROJECT_ID;
  const url = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/users/${uid}?updateMask.fieldPaths=premium&key=${env.FIREBASE_API_KEY}`;
  const body = {
    fields: {
      premium: { booleanValue: value }
    }
  };
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Firestore error: ${res.status} — ${err}`);
  }
  return res.json();
}
