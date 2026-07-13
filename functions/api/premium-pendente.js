// Cloudflare Pages Function — POST /api/premium-pendente
// Resgata um Premium comprado no Hotmart ANTES do cadastro no app.
//
// Fluxo: quando o webhook /api/hotmart não encontra o e-mail do comprador no
// Firebase Auth, ele grava pending_premium/{email}. Quando o usuário cria a
// conta e loga, o app chama este endpoint; se houver premium pendente para o
// e-mail da conta, ele é ativado em users/{uid} e o pendente é marcado como
// consumido (fica como trilha de auditoria, não é apagado).
//
// Segurança:
// - Exige "Authorization: Bearer <idToken>" do Firebase. O uid e o e-mail
//   saem do PRÓPRIO token (via accounts:lookup) — nunca do corpo da
//   requisição, então ninguém resgata premium de um e-mail que não é o seu.
// - Toda leitura/escrita usa a credencial de serviço (a mesma do webhook);
//   nada muda no firestore.rules e o client continua sem gravar premium.
//
// Variáveis de ambiente: as mesmas já usadas por /api/hotmart
// (FIREBASE_API_KEY, FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL,
//  FIREBASE_PRIVATE_KEY).

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

// ── Verifica o ID Token e devolve { uid, email, transient } ──────────────────
// transient = true quando NÃO foi possível validar por falha temporária do
// Google (429/5xx/erro de rede) — o token pode ser válido; não tratar como 401.
async function verifyFirebaseUser(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return { uid: null, email: '', transient: false };
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
      const u = data?.users?.[0];
      return {
        uid: u?.localId || null,
        email: (u?.email || '').trim().toLowerCase(),
        transient: false
      };
    }
    // 400 = resposta definitiva do Google; repetir não muda o resultado.
    if (res && res.status === 400) {
      let msg = '';
      try { msg = (JSON.parse(await res.text()))?.error?.message || ''; } catch (e) {}
      // "API key not valid" = FIREBASE_API_KEY errada no Cloudflare — erro de
      // configuração do SERVIDOR, não do token do usuário: nunca vira 401.
      if (/api key/i.test(msg)) {
        console.error('FIREBASE_API_KEY rejeitada pelo Google: ' + msg);
        return { uid: null, email: '', transient: false, configError: true };
      }
      // Token realmente inválido/expirado.
      return { uid: null, email: '', transient: false };
    }
    if (attempt < MAX_TRIES) {
      await new Promise((r) => setTimeout(r, attempt * 400));
    }
  }
  return { uid: null, email: '', transient: true };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const user = await verifyFirebaseUser(request, env);
    if (!user.uid) {
      if (user.configError) {
        // FIREBASE_API_KEY errada no Cloudflare: problema do servidor, não do
        // usuário — nunca mostrar "Não autenticado" para isso.
        return new Response(
          JSON.stringify({ error: 'Erro de configuração no servidor. Tente novamente mais tarde.' }),
          { status: 500, headers: CORS }
        );
      }
      if (user.transient) {
        return new Response(
          JSON.stringify({ error: 'Não consegui validar sua sessão agora. Tente novamente em instantes.', overloaded: true }),
          { status: 503, headers: CORS }
        );
      }
      return new Response(JSON.stringify({ error: 'Não autenticado.' }), { status: 401, headers: CORS });
    }
    if (!user.email) {
      return new Response(JSON.stringify({ activated: false }), { status: 200, headers: CORS });
    }

    const accessToken = await getGoogleAccessToken(env);
    const project = env.FIREBASE_PROJECT_ID;
    const base = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
    const pendingUrl = `${base}/pending_premium/${encodeURIComponent(user.email)}`;

    // 1. Existe premium pendente para o e-mail desta conta?
    const getRes = await fetch(pendingUrl, { headers: { 'Authorization': 'Bearer ' + accessToken } });
    if (getRes.status === 404) {
      return new Response(JSON.stringify({ activated: false }), { status: 200, headers: CORS });
    }
    if (!getRes.ok) {
      const err = await getRes.text();
      throw new Error(`Firestore error (leitura pending_premium): ${getRes.status} — ${err}`);
    }
    const doc = await getRes.json();
    const fields = doc.fields || {};
    const pendingPremium = fields.premium?.booleanValue === true;
    const consumedByUid = fields.consumedByUid?.stringValue || '';

    // Pendente já consumido por OUTRA conta: uma compra ativa um único usuário.
    // (O mesmo uid pode repetir a chamada — cobre retry se a marcação falhou.)
    if (consumedByUid && consumedByUid !== user.uid) {
      return new Response(JSON.stringify({ activated: false }), { status: 200, headers: CORS });
    }
    if (!pendingPremium) {
      return new Response(JSON.stringify({ activated: false }), { status: 200, headers: CORS });
    }

    // 2. Ativa o premium do usuário PRIMEIRO; só depois marca o pendente como
    //    consumido. Se a marcação falhar, uma nova chamada refaz as duas
    //    etapas sem efeito colateral (idempotente).
    const userRes = await fetch(
      `${base}/users/${user.uid}?updateMask.fieldPaths=premium`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken },
        body: JSON.stringify({ fields: { premium: { booleanValue: true } } })
      }
    );
    if (!userRes.ok) {
      const err = await userRes.text();
      throw new Error(`Firestore error (ativação premium): ${userRes.status} — ${err}`);
    }

    const markRes = await fetch(
      `${pendingUrl}?updateMask.fieldPaths=consumedByUid&updateMask.fieldPaths=consumedAt`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken },
        body: JSON.stringify({
          fields: {
            consumedByUid: { stringValue: user.uid },
            consumedAt: { timestampValue: new Date().toISOString() }
          }
        })
      }
    );
    if (!markRes.ok) {
      // Premium já foi ativado; só não conseguiu marcar o consumo. Loga e
      // segue — a próxima chamada do mesmo uid completa a marcação.
      console.warn(`Premium ativado para uid ${user.uid}, mas falhou ao marcar o pendente como consumido: ${markRes.status}`);
    }

    console.log(`Premium pendente ATIVADO para uid ${user.uid}`);
    return new Response(JSON.stringify({ activated: true }), { status: 200, headers: CORS });

  } catch (err) {
    console.error('Erro no resgate de premium pendente:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

// ── Helpers de credencial de serviço (mesmos de /api/hotmart) ─────────────────

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

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\r/g, '')
    .replace(/\n/g, '')
    .trim();
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function getGoogleAccessToken(env) {
  const clientEmail = env.FIREBASE_CLIENT_EMAIL;
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
