// Cloudflare Pages Function — POST /api/hotmart
// Recebe webhooks do Hotmart e atualiza o campo premium no Firebase
// Variáveis de ambiente necessárias no Cloudflare:
//   HOTMART_SECRET        → chave secreta do webhook (Hottok)
//   FIREBASE_PROJECT_ID   → ID do projeto Firebase (smart-life-finance)
//   FIREBASE_API_KEY      → Web API Key do Firebase (usada só para o lookup de e-mail)
//   FIREBASE_CLIENT_EMAIL → "client_email" do JSON da conta de serviço do Firebase
//   FIREBASE_PRIVATE_KEY  → "private_key" do JSON da conta de serviço do Firebase
//
// FIREBASE_CLIENT_EMAIL e FIREBASE_PRIVATE_KEY vêm do arquivo JSON gerado em:
// Firebase Console → Configurações do projeto → Contas de serviço →
// Gerar nova chave privada. Cole o valor de "private_key" inteiro (com as
// quebras de linha \n) no secret do Cloudflare.

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
    const hottok = request.headers.get('X-HOTMART-HOTTOK')
                || request.headers.get('hottok')
                || '';
    if (!env.HOTMART_SECRET || hottok !== env.HOTMART_SECRET) {
      console.warn('Webhook rejeitado: hottok inválido');
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: CORS });
    }

    // 2. Lê o payload
    const payload = await request.json();

    const event = extractEvent(payload);
    // E-mail normalizado (minúsculas, sem espaços): é a chave usada tanto no
    // lookup do Firebase quanto no documento pending_premium/{email}.
    const email = (extractEmail(payload) || '').trim().toLowerCase();

    // Log só do essencial (sem o payload inteiro, pra não vazar dado de comprador no log)
    console.log(`Webhook recebido — evento: "${event}", e-mail presente: ${!!email}`);

    if (!event || !email) {
      console.warn(`Payload inválido — event: "${event}", emailFound: ${!!email}. Chaves de data: ${JSON.stringify(Object.keys(payload?.data || {}))}`);
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
      return new Response(JSON.stringify({ ok: true, action: 'ignored', event }), { status: 200, headers: CORS });
    }

    // 4. Busca o UID do usuário pelo email no Firebase Auth REST API
    const uid = await getUidByEmail(email, env);
    if (!uid) {
      // Compra (ou reembolso) ANTES do cadastro no app: sem isto, a informação
      // era descartada e o premium ficava perdido para sempre. Agora fica
      // guardada em pending_premium/{email} e é resgatada pelo endpoint
      // /api/premium-pendente no primeiro login do usuário com esse e-mail.
      await setPendingPremiumAdmin(email, premiumValue, event, env);
      console.warn(`Usuário não encontrado no Firebase: ${email} — premium pendente gravado (${premiumValue})`);
      return new Response(JSON.stringify({ ok: true, action: 'pending_saved', premium: premiumValue, email }), { status: 200, headers: CORS });
    }

    // 5. Atualiza o campo premium no Firestore usando credencial de SERVIÇO
    //    (ignora as regras de segurança, como o firestore.rules já pressupõe).
    await setPremiumFirestoreAdmin(uid, premiumValue, env);

    console.log(`Premium ${premiumValue ? 'ATIVADO' : 'REVOGADO'} para uid ${uid}`);
    return new Response(JSON.stringify({ ok: true, action: premiumValue ? 'activated' : 'revoked', uid }), { status: 200, headers: CORS });

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
  if (!res.ok) {
    let msg = '';
    try { msg = (JSON.parse(await res.text()))?.error?.message || ''; } catch (e) {}
    // FIREBASE_API_KEY errada no Cloudflare: falhar alto (vira 500, e o
    // Hotmart reenvia) em vez de fingir "usuário não encontrado" para uma
    // conta que existe.
    if (/api key/i.test(msg)) throw new Error('FIREBASE_API_KEY rejeitada pelo Google: ' + msg);
    return null;
  }
  const data = await res.json();
  return data?.users?.[0]?.localId || null;
}

// ── Codifica em base64url (string ou ArrayBuffer/Uint8Array) ─────────────────
function base64UrlEncode(input) {
  let bytes;
  if (typeof input === 'string') {
    bytes = new TextEncoder().encode(input);
  } else {
    bytes = new Uint8Array(input);
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── Converte a chave privada PEM em ArrayBuffer (formato PKCS8) ──────────────
function pemToArrayBuffer(pem) {
  // Tolerante a colagens imperfeitas do secret no Cloudflare (aspas, barras
  // soltas, espaços, quebras): remove os marcadores BEGIN/END, mantém apenas
  // o alfabeto base64 do miolo e refaz o padding final.
  let b64 = pem
    .replace(/-----[^-]*-----/g, '')
    .replace(/[^A-Za-z0-9+/]/g, '');
  while (b64.length % 4) b64 += '=';
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// ── Gera um Access Token do Google via conta de serviço (JWT assertion) ──────
// Esse token, ao contrário da Web API Key, é tratado pelo Firestore como
// acesso administrativo e IGNORA as regras de segurança — igual ao Admin SDK.
async function getGoogleAccessToken(env) {
  // .trim() em tudo que vem de variável de ambiente: espaço/quebra
  // sobrando no paste do painel não pode derrubar a autenticação.
  const clientEmail = (env.FIREBASE_CLIENT_EMAIL || '').trim();
  const privateKeyPem = (env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!clientEmail || !privateKeyPem) {
    throw new Error('FIREBASE_CLIENT_EMAIL ou FIREBASE_PRIVATE_KEY não configuradas.');
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };

  const unsigned = base64UrlEncode(JSON.stringify(header)) + '.' + base64UrlEncode(JSON.stringify(claims));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(unsigned)
  );

  const jwt = unsigned + '.' + base64UrlEncode(signature);

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + encodeURIComponent(jwt)
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    throw new Error(`Falha ao obter access token do Google: ${tokenRes.status} — ${errText}`);
  }

  const tokenData = await tokenRes.json();
  return tokenData.access_token;
}

// ── Atualiza o campo premium no Firestore com credencial de serviço ──────────
async function setPremiumFirestoreAdmin(uid, value, env) {
  const accessToken = await getGoogleAccessToken(env);
  const project = (env.FIREBASE_PROJECT_ID || '').trim();
  const url = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/users/${uid}?updateMask.fieldPaths=premium`;
  const body = { fields: { premium: { booleanValue: value } } };

  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + accessToken
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Firestore error: ${res.status} — ${err}`);
  }
  return res.json();
}

// ── Grava o premium pendente para um e-mail que ainda não tem conta ──────────
// Documento pending_premium/{email}: consumido por /api/premium-pendente
// quando o usuário criar a conta com esse e-mail e fizer login.
// Também grava premium=false (reembolso/chargeback antes do cadastro),
// sobrescrevendo um pendente anterior — senão um reembolso pré-cadastro
// ainda daria premium.
async function setPendingPremiumAdmin(email, value, event, env) {
  const accessToken = await getGoogleAccessToken(env);
  const project = (env.FIREBASE_PROJECT_ID || '').trim();
  const mask = ['email', 'premium', 'event', 'updatedAt']
    .map((f) => 'updateMask.fieldPaths=' + f).join('&');
  const url = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/pending_premium/${encodeURIComponent(email)}?${mask}`;
  const body = {
    fields: {
      email: { stringValue: email },
      premium: { booleanValue: value },
      event: { stringValue: event },
      updatedAt: { timestampValue: new Date().toISOString() }
    }
  };

  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + accessToken
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Firestore error (pending_premium): ${res.status} — ${err}`);
  }
  return res.json();
}
