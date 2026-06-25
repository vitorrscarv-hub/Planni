// parser.js - Camada 1: leitura nativa de OFX e CSV (SEM IA)
// Custo zero, 100% confiavel, instantaneo. Roda dentro da Cloudflare Function.
// Devolve o MESMO formato do extrato.js:
//   { transactions: [{desc, val, type, cat, date, pessoa}], summary: {...} }
// Se nao conseguir parsear com confianca, devolve null -> o chamador cai para a IA.

// ---------- Categorizacao por palavra-chave (heuristica, sem IA) ----------
const CAT_RULES = [
  { cat: 'salario',       re: /\b(salario|sal[aá]rio|provento|pagamento de salario|folha|vencimento|remuneracao)\b/i },
  { cat: 'alimentacao',   re: /\b(ifood|rappi|restaurante|lanchonete|padaria|mercado|supermercado|hortifruti|acougue|pizzaria|burger|mc\s?donald|bk|subway|food)\b/i },
  { cat: 'transporte',    re: /\b(uber|99\s?app|99\s?pop|cabify|posto|combustivel|gasolina|etanol|estacionamento|pedagio|metro|brt|onibus|passagem|ipva|car|veiculo)\b/i },
  { cat: 'moradia',       re: /\b(aluguel|condominio|condom[ií]nio|imobiliaria|luz|energia|enel|light|cemig|copel|agua|saneamento|sabesp|cedae|gas|iptu)\b/i },
  { cat: 'saude',         re: /\b(farmacia|drogaria|drogasil|pacheco|hospital|clinica|medico|laboratorio|exame|plano de saude|unimed|amil|odonto|dentista|psicolog)\b/i },
  { cat: 'lazer',         re: /\b(netflix|spotify|disney|hbo|max|prime video|youtube premium|cinema|ingresso|show|bar|balada|viagem|hotel|airbnb|booking|game|steam|playstation|xbox)\b/i },
  { cat: 'compras',       re: /\b(amazon|mercado\s?livre|shopee|magalu|magazine luiza|americanas|casas bahia|aliexpress|shein|loja|shopping|renner|riachuelo|c&a|zara)\b/i },
  { cat: 'educacao',      re: /\b(escola|faculdade|universidade|curso|udemy|alura|mensalidade|matricula|livro|apostila|colegio|ensino)\b/i },
  { cat: 'investimentos', re: /\b(investimento|aplicacao|cdb|tesouro|acoes|a[cç][oõ]es|fii|fundo|corretora|xp|rico|nuinvest|b3|resgate de aplic)\b/i },
  { cat: 'servicos',      re: /\b(fatura|cartao de credito|cart[aã]o|anuidade|tarifa|taxa|juros|iof|seguro|assinatura|internet|vivo|claro|tim|oi|telefone|streaming)\b/i }
];

function guessCategory(desc, type) {
  var d = String(desc || '');
  for (var i = 0; i < CAT_RULES.length; i++) {
    if (CAT_RULES[i].re.test(d)) return CAT_RULES[i].cat;
  }
  if (type === 'in') return 'outros';
  return 'outros';
}

// Tenta extrair nome de pessoa/empresa de descricoes PIX/TED
function guessPessoa(desc) {
  var d = String(desc || '').trim();
  if (!/(pix|ted|doc|transf)/i.test(d)) return null;

  // Remove os termos de operacao para sobrar o nome
  var nome = d
    .replace(/\b(pix|ted|doc)\b/gi, '')
    .replace(/\b(transf(?:er[eê]ncia)?)\b/gi, '')
    .replace(/\b(enviad[ao]|recebid[ao]|recebida|enviada)\b/gi, '')
    .replace(/\b(para|de|p\/|pra|ao|a)\b/gi, ' ')
    .replace(/[:\-*]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Mantem apenas se sobrou algo parecido com nome (letras e espacos)
  if (nome.length >= 4 && /[A-Za-zÀ-ÿ]{3,}/.test(nome)) {
    return nome.slice(0, 60);
  }
  return null;
}

// ---------- Normalizacao de valores e datas ----------
function parseValorBR(raw) {
  if (raw == null) return NaN;
  var s = String(raw).trim();
  if (!s) return NaN;
  var neg = /^-/.test(s) || /\bD\b\s*$/i.test(s) || /\(.*\)/.test(s);
  s = s.replace(/[R$\s()CcDd]/g, '');
  // Formato BR: 1.234,56  ->  1234.56
  if (/,\d{1,2}$/.test(s)) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    // Pode ja vir 1234.56 (US) - remove virgulas de milhar
    s = s.replace(/,/g, '');
  }
  var v = parseFloat(s);
  if (isNaN(v)) return NaN;
  v = Math.abs(v);
  return neg ? -v : v;
}

function toISODate(raw) {
  if (!raw) return null;
  var s = String(raw).trim();
  // OFX: YYYYMMDD ou YYYYMMDDHHMMSS
  var ofx = s.match(/^(\d{4})(\d{2})(\d{2})/);
  if (ofx) return ofx[1] + '-' + ofx[2] + '-' + ofx[3];
  // DD/MM/YYYY ou DD-MM-YYYY
  var br = s.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})/);
  if (br) return br[3] + '-' + br[2] + '-' + br[1];
  // DD/MM/YY
  var br2 = s.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{2})$/);
  if (br2) return '20' + br2[3] + '-' + br2[2] + '-' + br2[1];
  // YYYY-MM-DD (ja correto)
  var iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3];
  return null;
}

// ---------- Parser OFX ----------
function parseOFX(content) {
  var txs = [];
  // Cada transacao vem dentro de <STMTTRN>...</STMTTRN>
  var blocks = content.match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi);
  if (!blocks) {
    // OFX as vezes nao fecha as tags; tenta split por <STMTTRN>
    blocks = content.split(/<STMTTRN>/i).slice(1);
  }
  if (!blocks || !blocks.length) return null;

  function tag(block, name) {
    var m = block.match(new RegExp('<' + name + '>([^<\\r\\n]*)', 'i'));
    return m ? m[1].trim() : '';
  }

  blocks.forEach(function (b) {
    var trnType = tag(b, 'TRNTYPE');       // CREDIT, DEBIT, etc.
    var dt = tag(b, 'DTPOSTED');
    var amt = tag(b, 'TRNAMT');
    var memo = tag(b, 'MEMO') || tag(b, 'NAME');

    var val = parseFloat(String(amt).replace(',', '.'));
    if (isNaN(val) || val === 0) return;

    var date = toISODate(dt);
    if (!date) return;

    var type = val >= 0 ? 'in' : 'out';
    if (/DEBIT/i.test(trnType)) type = 'out';
    if (/CREDIT/i.test(trnType)) type = 'in';

    var desc = memo || (type === 'in' ? 'Crédito' : 'Débito');

    txs.push({
      desc: String(desc).slice(0, 80),
      val: Math.round(Math.abs(val) * 100) / 100,
      type: type,
      cat: guessCategory(desc, type),
      date: date,
      pessoa: guessPessoa(desc)
    });
  });

  return txs.length ? txs : null;
}

// ---------- Parser CSV ----------
function splitCSVLine(line, sep) {
  var out = [];
  var cur = '';
  var inQuotes = false;
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === sep && !inQuotes) {
      out.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map(function (c) { return c.trim(); });
}

function detectSeparator(sample) {
  var seps = [';', ',', '\t', '|'];
  var best = ';', bestCount = -1;
  seps.forEach(function (s) {
    var count = (sample.split(s).length - 1);
    if (count > bestCount) { bestCount = count; best = s; }
  });
  return best;
}

function findColumn(headers, candidates) {
  for (var i = 0; i < headers.length; i++) {
    var h = headers[i].toLowerCase();
    for (var j = 0; j < candidates.length; j++) {
      if (h.indexOf(candidates[j]) !== -1) return i;
    }
  }
  return -1;
}

function parseCSV(content) {
  var lines = content.split(/\r?\n/).filter(function (l) { return l.trim().length > 0; });
  if (lines.length < 2) return null;

  var sep = detectSeparator(lines[0]);
  var headers = splitCSVLine(lines[0], sep).map(function (h) { return h.toLowerCase(); });

  var iDate = findColumn(headers, ['data', 'date', 'dt', 'lançamento', 'lancamento']);
  var iDesc = findColumn(headers, ['descri', 'historico', 'histórico', 'lançamento', 'lancamento', 'memo', 'detalhe', 'name', 'estabelecimento']);
  var iVal = findColumn(headers, ['valor', 'value', 'amount', 'montante', 'quantia']);
  var iType = findColumn(headers, ['tipo', 'type', 'd/c', 'debito/credito', 'natureza']);

  // Se nao achar cabecalho reconhecivel, nao arrisca - deixa a IA cuidar
  if (iDate === -1 || iVal === -1) return null;

  var txs = [];
  for (var r = 1; r < lines.length; r++) {
    var cells = splitCSVLine(lines[r], sep);
    if (cells.length < 2) continue;

    var date = toISODate(cells[iDate]);
    var val = parseValorBR(cells[iVal]);
    if (!date || isNaN(val) || val === 0) continue;

    var desc = iDesc !== -1 ? cells[iDesc] : '';
    if (!desc) desc = (val >= 0 ? 'Crédito' : 'Débito');

    var type = val >= 0 ? 'in' : 'out';
    // Se houver coluna de tipo explicita, respeita
    if (iType !== -1 && cells[iType]) {
      var t = cells[iType].toLowerCase();
      if (/cr|credit|c$|entrada|receita/.test(t)) type = 'in';
      else if (/db|deb|debit|d$|saida|saída|despesa/.test(t)) type = 'out';
    }

    txs.push({
      desc: String(desc).slice(0, 80),
      val: Math.round(Math.abs(val) * 100) / 100,
      type: type,
      cat: guessCategory(desc, type),
      date: date,
      pessoa: guessPessoa(desc)
    });
  }

  return txs.length ? txs : null;
}

// ---------- Roteador da Camada 1 ----------
// Recebe o texto e (opcionalmente) o nome/extensao do arquivo.
// Retorna { transactions, summary } se conseguiu, ou null se deve cair para a IA.
export function parseLocal(text, filename) {
  if (!text || typeof text !== 'string') return null;
  var content = text.trim();
  if (!content) return null;

  var ext = filename ? String(filename).split('.').pop().toLowerCase() : '';
  var looksOFX = ext === 'ofx' || /<OFX>/i.test(content) || /<STMTTRN>/i.test(content);

  var txs = null;
  if (looksOFX) {
    txs = parseOFX(content);
  } else {
    // Tenta CSV; se falhar e parecer OFX disfarcado, tenta OFX
    txs = parseCSV(content);
    if (!txs && /<STMTTRN>/i.test(content)) txs = parseOFX(content);
  }

  if (!txs || !txs.length) return null;

  var totalIn = 0, totalOut = 0;
  txs.forEach(function (t) { if (t.type === 'in') totalIn += t.val; else totalOut += t.val; });

  return {
    transactions: txs,
    summary: {
      count: txs.length,
      totalIn: Math.round(totalIn * 100) / 100,
      totalOut: Math.round(totalOut * 100) / 100
    },
    source: 'local' // marca que veio do parser nativo (sem IA)
  };
}
