// investimentos.js - Motor de calculo de rentabilidade de Renda Fixa (Pessoa Fisica)
// 100% local, sem IA. Regras fiscais vigentes em 2026 (Receita Federal / tabela regressiva).
// Cobre: CDB, Tesouro Direto, LCI, LCA, poupanca, debentures, CRI, CRA.
//
// Fontes das regras (verificadas 2026):
//  - IR regressivo: 22,5% ate 180d | 20% 181-360 | 17,5% 361-720 | 15% acima de 720
//  - IOF regressivo diario: so em resgate < 30 dias, sobre o rendimento
//  - Isencao PF: LCI, LCA, CRI, CRA, debentures incentivadas, poupanca
//  - IR/IOF incidem somente sobre o RENDIMENTO, nunca sobre o principal

// ---------- Tabela IOF regressiva (dias 1..29; dia 30+ = 0) ----------
// Percentual do rendimento "perdido" para o IOF conforme o dia do resgate.
var IOF_TABELA = [0,0.96,0.93,0.90,0.86,0.83,0.80,0.76,0.73,0.70,0.66,0.63,0.60,0.56,0.53,0.50,0.46,0.43,0.40,0.36,0.33,0.30,0.26,0.23,0.20,0.16,0.13,0.10,0.06,0.03];

// Tipos isentos de IR para Pessoa Fisica
var ISENTOS_PF = ['lci','lca','cri','cra','poupanca','poupança','debenture_incentivada','lcd','lci/lca'];

function _diasEntre(dataIni, dataFim){
  var a = new Date(dataIni + 'T00:00:00');
  var b = new Date(dataFim + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

// Aliquota de IR conforme dias decorridos (tabela regressiva)
function aliquotaIR(dias){
  if (dias <= 180) return 0.225;
  if (dias <= 360) return 0.20;
  if (dias <= 720) return 0.175;
  return 0.15;
}

// Aliquota de IOF conforme dias (so < 30 dias)
function aliquotaIOF(dias){
  if (dias >= 30) return 0;
  if (dias < 1) return 0.96;
  return IOF_TABELA[dias] || 0;
}

function _isElegivelIsencao(tipo){
  if (!tipo) return false;
  var t = String(tipo).toLowerCase().trim();
  return ISENTOS_PF.indexOf(t) !== -1;
}

/**
 * Calcula a rentabilidade liquida de um investimento de renda fixa (PF).
 * @param {Object} p
 *   p.tipo          - 'cdb' | 'tesouro' | 'lci' | 'lca' | 'cri' | 'cra' | 'poupanca' | 'debenture' | 'debenture_incentivada'
 *   p.valorAplicado - numero (principal investido)
 *   p.dataAplicacao - 'YYYY-MM-DD'
 *   p.dataResgate   - 'YYYY-MM-DD' (data do calculo/resgate)
 *   p.valorBruto    - numero OPCIONAL (valor atual informado pelo usuario). Se ausente, usa taxa.
 *   p.rendimentoBruto - numero OPCIONAL (rendimento ja calculado). Alternativa a valorBruto.
 *   p.ipcaPeriodo   - numero OPCIONAL (inflacao acumulada do periodo, em %, ex: 2.5). Se presente e descontarInflacao, calcula retorno real.
 *   p.descontarInflacao - boolean
 * @returns {Object} detalhamento completo
 */
function calcularRendaFixa(p){
  var erros = [];
  if (!p || typeof p !== 'object') return { erro: 'Parametros ausentes.' };
  var valorAplicado = parseFloat(p.valorAplicado);
  if (isNaN(valorAplicado) || valorAplicado <= 0) erros.push('Valor aplicado invalido.');
  if (!p.dataAplicacao || !/^\d{4}-\d{2}-\d{2}$/.test(p.dataAplicacao)) erros.push('Data de aplicacao invalida.');
  if (!p.dataResgate || !/^\d{4}-\d{2}-\d{2}$/.test(p.dataResgate)) erros.push('Data de resgate invalida.');
  if (erros.length) return { erro: erros.join(' ') };

  var dias = _diasEntre(p.dataAplicacao, p.dataResgate);
  if (dias < 0) return { erro: 'A data de resgate e anterior a data de aplicacao.' };

  // 1) Determinar o rendimento bruto
  var valorBruto, rendimentoBruto;
  if (p.valorBruto != null && !isNaN(parseFloat(p.valorBruto))) {
    valorBruto = parseFloat(p.valorBruto);
    rendimentoBruto = valorBruto - valorAplicado;
  } else if (p.rendimentoBruto != null && !isNaN(parseFloat(p.rendimentoBruto))) {
    rendimentoBruto = parseFloat(p.rendimentoBruto);
    valorBruto = valorAplicado + rendimentoBruto;
  } else {
    return { erro: 'Informe o valor bruto atual ou o rendimento (ou use o calculo por taxa).' };
  }
  if (rendimentoBruto < 0) rendimentoBruto = 0; // nao ha IR sobre prejuizo

  var tipo = (p.tipo || 'cdb').toLowerCase().trim();
  var isento = _isElegivelIsencao(tipo);

  // 2) IOF (somente resgate < 30 dias, sobre o rendimento) - vale mesmo para isentos? 
  //    LCI/LCA/poupanca: poupanca tem regra propria; demais isentos de IR ainda podem ter IOF.
  //    Para simplificar e por seguranca, IOF aplica a renda fixa tributavel; isentos PF nao sofrem IOF aqui.
  var aliqIOF = isento ? 0 : aliquotaIOF(dias);
  var valorIOF = rendimentoBruto * aliqIOF;
  var rendimentoPosIOF = rendimentoBruto - valorIOF;

  // 3) IR (tabela regressiva, sobre o rendimento ja descontado o IOF)
  var aliqIR = isento ? 0 : aliquotaIR(dias);
  var valorIR = rendimentoPosIOF * aliqIR;

  // 4) Valor liquido
  var valorLiquido = valorAplicado + rendimentoPosIOF - valorIR;
  var rendimentoLiquido = valorLiquido - valorAplicado;

  // 5) Rentabilidades
  var rentNominal = valorAplicado > 0 ? (rendimentoLiquido / valorAplicado) * 100 : 0;

  // 6) Inflacao (opcional) - retorno real pela formula de Fisher
  var rentReal = null, valorReal = null;
  if (p.descontarInflacao && p.ipcaPeriodo != null && !isNaN(parseFloat(p.ipcaPeriodo))) {
    var ipca = parseFloat(p.ipcaPeriodo) / 100;
    // retorno real = (1+nominal)/(1+inflacao) - 1
    var rNom = rentNominal / 100;
    rentReal = ((1 + rNom) / (1 + ipca) - 1) * 100;
    valorReal = valorAplicado * (1 + rentReal/100);
  }

  return {
    tipo: tipo,
    isento: isento,
    dias: dias,
    valorAplicado: round2(valorAplicado),
    valorBruto: round2(valorBruto),
    rendimentoBruto: round2(rendimentoBruto),
    aliquotaIOF: aliqIOF,
    valorIOF: round2(valorIOF),
    aliquotaIR: aliqIR,
    valorIR: round2(valorIR),
    valorLiquido: round2(valorLiquido),
    rendimentoLiquido: round2(rendimentoLiquido),
    rentabilidadeNominal: round2(rentNominal),
    descontouInflacao: !!(p.descontarInflacao && rentReal != null),
    rentabilidadeReal: rentReal != null ? round2(rentReal) : null,
    valorReal: valorReal != null ? round2(valorReal) : null
  };
}

// Calculo do rendimento bruto a partir de uma taxa contratada e indice acumulado.
// Ex: 110% do CDI, com CDI acumulado do periodo = 5% -> rendimento aplicado sobre o principal.
//  p.percentualIndice: ex 110 (= 110% do indice)
//  p.indiceAcumulado: ex 5.2 (% acumulado do CDI/Selic no periodo)
//  p.tipoTaxa: 'pos_cdi' | 'pos_selic' | 'prefixado' | 'ipca_mais'
//  p.taxaPrefixada / p.ipcaAcumulado conforme o caso
function rendimentoPorTaxa(p){
  var principal = parseFloat(p.valorAplicado);
  if (isNaN(principal) || principal <= 0) return null;

  var fator = null;
  if (p.tipoTaxa === 'pos_cdi' || p.tipoTaxa === 'pos_selic') {
    var idx = parseFloat(p.indiceAcumulado);     // % acumulado do CDI/Selic no periodo
    var perc = parseFloat(p.percentualIndice);   // ex: 110 (% do indice)
    if (isNaN(idx) || isNaN(perc)) return null;
    fator = (idx/100) * (perc/100);
  } else if (p.tipoTaxa === 'prefixado') {
    var taxaAa = parseFloat(p.taxaPrefixada);     // % ao ano
    var dias = _diasEntre(p.dataAplicacao, p.dataResgate);
    if (isNaN(taxaAa)) return null;
    fator = Math.pow(1 + taxaAa/100, dias/365) - 1;
  } else if (p.tipoTaxa === 'ipca_mais') {
    var ipcaAc = parseFloat(p.ipcaAcumulado);     // % IPCA acumulado no periodo
    var jurosAa = parseFloat(p.taxaPrefixada);    // % ao ano (parte fixa)
    var dias2 = _diasEntre(p.dataAplicacao, p.dataResgate);
    if (isNaN(ipcaAc) || isNaN(jurosAa)) return null;
    var fatorJuros = Math.pow(1 + jurosAa/100, dias2/365) - 1;
    fator = (1 + ipcaAc/100) * (1 + fatorJuros) - 1;
  } else {
    return null;
  }
  return round2(principal * fator);
}

function round2(v){ return Math.round(v * 100) / 100; }

// ---------- GROSS-UP: equivalencia entre isentos e tributados ----------
// Coloca produtos isentos (LCI/LCA/CRI/CRA/deb. incentivada) e tributados (CDB/Tesouro)
// na MESMA base de comparacao. Regra de ouro: nunca comparar taxa bruta de tributado
// com taxa de isento diretamente.
//
// Formula (confirmada, fontes de mercado 2026):
//   - Isento -> base de tributado (CDB equivalente):  taxaIsenta / (1 - aliqIR)
//   - Tributado -> base de isento (LCI equivalente):  taxaTributado * (1 - aliqIR)
//
// IMPORTANTE: o gross-up assume manutencao ate o vencimento (buy and hold).
// Resgate antecipado pode ter variacao de mercado nao refletida aqui.

// Converte a taxa de um produto ISENTO para o CDB equivalente (base tributada).
// taxaIsenta: ex 90 (= 90% do CDI). dias: prazo ate o vencimento.
function grossUp(taxaIsenta, dias){
  var aliq = aliquotaIR(dias);
  var equivalente = taxaIsenta / (1 - aliq);
  return {
    taxaOriginal: round2(taxaIsenta),
    aliquotaIR: aliq,
    cdbEquivalente: round2(equivalente),  // quanto um CDB tributado precisaria pagar para empatar
    dias: dias
  };
}

// Converte a taxa de um produto TRIBUTADO para a base isenta (LCI equivalente).
function grossDown(taxaTributada, dias){
  var aliq = aliquotaIR(dias);
  var equivalente = taxaTributada * (1 - aliq);
  return {
    taxaOriginal: round2(taxaTributada),
    aliquotaIR: aliq,
    lciEquivalente: round2(equivalente), // quanto um isento precisaria pagar para empatar
    dias: dias
  };
}

// Tipos isentos (reaproveita ISENTOS_PF). Retorna true se o tipo e isento de IR para PF.
function tipoEhIsento(tipo){ return _isElegivelIsencao(tipo); }

// Compara uma lista de investimentos colocando TODOS na base de "CDB equivalente"
// (taxa bruta equivalente em % do CDI), permitindo ranking justo.
//  itens: [{ nome, tipo, taxaCDI (% do CDI), dias }]
function compararPorGrossUp(itens){
  if(!Array.isArray(itens) || !itens.length) return { erro: 'Informe ao menos um investimento.' };
  var resultado = itens.map(function(it){
    var isento = _isElegivelIsencao(it.tipo);
    var aliq = aliquotaIR(it.dias);
    var baseCDB; // taxa em % do CDI ja na base tributada (CDB equivalente)
    if(isento){
      baseCDB = it.taxaCDI / (1 - aliq); // gross-up
    } else {
      baseCDB = it.taxaCDI; // tributado ja esta na propria base bruta
    }
    return {
      nome: it.nome || (it.tipo || '').toUpperCase(),
      tipo: it.tipo,
      isento: isento,
      taxaInformada: round2(it.taxaCDI),
      aliquotaIR: aliq,
      cdbEquivalente: round2(baseCDB),
      dias: it.dias
    };
  });
  // ordena do melhor (maior CDB equivalente) para o pior
  resultado.sort(function(a,b){ return b.cdbEquivalente - a.cdbEquivalente; });
  if(resultado.length) resultado[0].vencedor = true;
  return { itens: resultado, observacao: 'Cálculo de equivalência (gross-up) assume manutenção até o vencimento.' };
}

// ---------- Busca de indices acumulados no BACEN (CDI, Selic, IPCA) ----------
// Series SGS: CDI=12 (diaria), Selic=11 (diaria), IPCA=433 (mensal).
// Acumulacao por capitalizacao composta: produto de (1 + taxa_dia/100) - 1.
// A API ja retorna apenas dias uteis para CDI/Selic.
function _formatBR(dataISO){
  var p = dataISO.split('-');
  return p[2] + '/' + p[1] + '/' + p[0];
}

async function buscarIndiceAcumulado(serie, dataIni, dataFim){
  // serie: 12 (CDI), 11 (Selic), 433 (IPCA)
  var url = 'https://api.bcb.gov.br/dados/serie/bcdata.sgs.' + serie +
            '/dados?formato=json&dataInicial=' + _formatBR(dataIni) +
            '&dataFinal=' + _formatBR(dataFim);
  var resp = await fetch(url);
  if(!resp.ok) throw new Error('BACEN HTTP ' + resp.status);
  var dados = await resp.json();
  if(!Array.isArray(dados) || !dados.length) throw new Error('Sem dados do BACEN no período.');

  // Capitalizacao composta dos fatores diarios/mensais
  var fator = 1;
  dados.forEach(function(d){
    var taxa = parseFloat(String(d.valor).replace(',', '.'));
    if(!isNaN(taxa)) fator *= (1 + taxa/100);
  });
  var acumulado = (fator - 1) * 100; // em %
  return {
    acumulado: round2(acumulado),
    pontos: dados.length,
    primeiraData: dados[0].data,
    ultimaData: dados[dados.length-1].data
  };
}

// Atalhos por tipo de indice
function cdiAcumulado(dataIni, dataFim){ return buscarIndiceAcumulado(12, dataIni, dataFim); }
function selicAcumulada(dataIni, dataFim){ return buscarIndiceAcumulado(11, dataIni, dataFim); }
function ipcaAcumulado(dataIni, dataFim){ return buscarIndiceAcumulado(433, dataIni, dataFim); }

// Mensagem padrao para quando o IPCA nao esta disponivel no periodo.
// O assistente pode usar isso ao responder o usuario.
var IPCA_INDISPONIVEL_MSG = 'O IPCA é um índice mensal, divulgado pelo IBGE por volta do dia 10 do mês seguinte. '
  + 'Por isso, em períodos muito curtos (poucos dias) ou para um mês que ainda não fechou/foi divulgado, '
  + 'o valor pode não estar disponível. Para prazos de alguns meses ou mais, o cálculo funciona normalmente. '
  + 'Você também pode informar o IPCA manualmente se já souber.';

// Export (para uso no app e em testes)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { calcularRendaFixa, rendimentoPorTaxa, aliquotaIR, aliquotaIOF,
                     buscarIndiceAcumulado, cdiAcumulado, selicAcumulada, ipcaAcumulado,
                     IPCA_INDISPONIVEL_MSG,
                     grossUp, grossDown, tipoEhIsento, compararPorGrossUp };
}
