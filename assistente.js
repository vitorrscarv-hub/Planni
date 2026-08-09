// assistente.js — Lógica do Assistente (chat) do Planni.
// Extraído do app.js sem alteração de comportamento (recorte-e-cola literal).
// Carregado DEPOIS de investimentos.js e app.js: depende de globais dos dois
// (state, save, fm, toast, uid, _aiAddBubble, _ensureJsPDF, compararPorGrossUp...).
// Todas as funções permanecem no escopo global (chamadas por onclick no HTML).
//
// Incremento A: núcleo de mensagens e consultas.

var _aiChatHistory = [];
function _aiBuildContext(userMsg){
  // Compact snapshot so we don't blow the token budget
  function slim(arr,fields,max){
    return (arr||[]).slice(0,max||40).map(function(o){
      var r={}; fields.forEach(function(f){ if(o[f]!==undefined) r[f]=o[f]; }); return r;
    });
  }

  var allTx = state.transactions || [];

  // ---- Resumo agregado das transacoes (leve, cobre perguntas genericas) ----
  var totalIn=0, totalOut=0, porCat={};
  allTx.forEach(function(t){
    if(t.type==='in') totalIn += (t.val||0); else totalOut += (t.val||0);
    var c=t.cat||'outros';
    if(!porCat[c]) porCat[c]={in:0,out:0,count:0};
    if(t.type==='in') porCat[c].in += (t.val||0); else porCat[c].out += (t.val||0);
    porCat[c].count++;
  });
  var resumoTx = {
    total: allTx.length,
    totalReceitas: Math.round(totalIn*100)/100,
    totalDespesas: Math.round(totalOut*100)/100,
    saldo: Math.round((totalIn-totalOut)*100)/100,
    porCategoria: porCat
  };

  // ---- Busca inteligente: se a pergunta cita valor ou nome, garante essas transacoes ----
  var relevantes = [];
  var msg = String(userMsg||'').toLowerCase();
  if(msg){
    // Valores citados na pergunta: "1000", "R$1.000,00", "55,00", "1.234,56" etc.
    var valuesFound = [];
    // Captura numeros com separadores BR (1.000,00), US (1,000.00) ou simples (1000 / 55,90)
    var vm = msg.match(/\d[\d.,]*/g);
    if(vm){
      vm.forEach(function(raw){
        var s = String(raw);
        var n;
        if(/,\d{1,2}$/.test(s)){
          // formato BR: ponto = milhar, virgula = decimal
          n = parseFloat(s.replace(/\./g,'').replace(',','.'));
        } else if(/\.\d{1,2}$/.test(s) && s.indexOf(',')!==-1){
          // formato US: virgula = milhar, ponto = decimal
          n = parseFloat(s.replace(/,/g,''));
        } else {
          // numero simples, remove separadores de milhar
          n = parseFloat(s.replace(/[.,]/g,''));
        }
        if(!isNaN(n) && n>0) valuesFound.push(n);
      });
    }
    // Palavras "fortes" da pergunta (nomes, lugares) - ignora palavras curtas/comuns
    var stop = ['de','da','do','com','para','por','que','uma','um','no','na','os','as','meu','minha','qual','quanto','houve','algum','algo','nesse','neste','extrato','pagamento','transacao','transacao','valor','este','essa','esse'];
    var words = msg.replace(/[^a-zà-ÿ0-9\s]/gi,' ').split(/\s+/).filter(function(w){ return w.length>=4 && stop.indexOf(w)===-1; });

    allTx.forEach(function(t){
      var hit=false;
      // bate por valor (com tolerancia de centavos)
      valuesFound.forEach(function(v){ if(Math.abs((t.val||0)-v)<0.01) hit=true; });
      // bate por nome/descricao
      if(!hit){
        var dl=String(t.desc||'').toLowerCase()+' '+String(t.pessoa||'').toLowerCase();
        for(var i=0;i<words.length;i++){ if(dl.indexOf(words[i])!==-1){ hit=true; break; } }
      }
      if(hit) relevantes.push({desc:t.desc,val:t.val,type:t.type,cat:t.cat,date:t.date,pessoa:t.pessoa||null});
    });
  }
  // Limita para nao estourar (suficiente para qualquer pergunta pontual)
  relevantes = relevantes.slice(0,40);

  return {
    hoje: today(),
    mesAtual: state.viewMonth,
    eventos: slim(state.events,['title','date','time'],40),
    tarefas: slim(state.tasks,['text','done','importante','urgente'],40),
    // Transacoes recentes (teto elevado) + resumo agregado de TODAS
    transacoes: slim(allTx,['desc','val','type','cat','date','pessoa'],120),
    resumoTransacoes: resumoTx,
    transacoesRelevantes: relevantes,
    notas: slim(state.notes,['title'],30),
    contas: slim(state.bills,['name','val','due','paid'],30)
  };
}
function _interpretarPeriodo(cmd){
  var hoje = new Date();
  var y = hoje.getFullYear(), m = hoje.getMonth();
  var pad = function(n){ return (n<10?'0':'')+n; };
  var iso = function(d){ return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()); };
  var primeiroDia = function(ano,mes){ return ano+'-'+pad(mes+1)+'-01'; };
  var ultimoDia = function(ano,mes){ return iso(new Date(ano, mes+1, 0)); };

  // últimos N dias
  var mDias = cmd.match(/[úu]ltimos?\s+(\d+)\s+dias/);
  if(mDias){
    var n = parseInt(mDias[1],10);
    var ini = new Date(hoje); ini.setDate(ini.getDate()-n+1);
    return { ini:iso(ini), fim:iso(hoje), rotulo:'nos últimos '+n+' dias' };
  }
  // esta semana (segunda a hoje)
  if(/(essa|esta)\s+semana/.test(cmd)){
    var diaSem = hoje.getDay(); var diff = (diaSem===0?6:diaSem-1);
    var iniS = new Date(hoje); iniS.setDate(iniS.getDate()-diff);
    return { ini:iso(iniS), fim:iso(hoje), rotulo:'nesta semana' };
  }
  // mês passado
  if(/m[êe]s\s+passado|m[êe]s\s+anterior/.test(cmd)){
    var ym = m===0 ? y-1 : y; var mm = m===0 ? 11 : m-1;
    return { ini:primeiroDia(ym,mm), fim:ultimoDia(ym,mm), rotulo:'no mês passado' };
  }
  // este mês
  if(/(esse|este|do)\s+m[êe]s|mensal|neste\s+m[êe]s/.test(cmd)){
    return { ini:primeiroDia(y,m), fim:ultimoDia(y,m), rotulo:'neste mês' };
  }
  // ano passado
  if(/ano\s+passado|ano\s+anterior/.test(cmd)){
    return { ini:(y-1)+'-01-01', fim:(y-1)+'-12-31', rotulo:'no ano passado' };
  }
  // este ano
  if(/(esse|este)\s+ano|anual|no\s+ano/.test(cmd)){
    return { ini:y+'-01-01', fim:y+'-12-31', rotulo:'neste ano' };
  }
  // mês por nome (janeiro..dezembro)
  var meses={janeiro:0,fevereiro:1,'março':2,marco:2,abril:3,maio:4,junho:5,julho:6,agosto:7,setembro:8,outubro:9,novembro:10,dezembro:11};
  for(var nome in meses){
    if(cmd.indexOf(nome)!==-1){
      var mi=meses[nome]; var ano = mi>m ? y-1 : y; // mês futuro assume ano passado
      return { ini:primeiroDia(ano,mi), fim:ultimoDia(ano,mi), rotulo:'em '+nome };
    }
  }
  return null; // nenhum período específico → o chamador decide o padrão
}
function _tryLocalQuery2_body(msg){
  var cmd = msg.toLowerCase();
  var txs = state.transactions || [];
  if(!txs.length) return null;

  var per = _interpretarPeriodo(cmd); // {ini,fim,rotulo} ou null
  var noPeriodo = function(t){ if(!per) return true; return t.date && t.date>=per.ini && t.date<=per.fim; };

  // RESUMO FINANCEIRO: "como está minha vida financeira", "resumo do mês"
  if(/como\s+est[áa].*financ|resumo\s+(financeiro|do\s+m[êe]s|geral)|minha\s+vida\s+financeira|panorama/.test(cmd)){
    var p = per || _interpretarPeriodo('esse mês');
    var noP = function(t){ return t.date && t.date>=p.ini && t.date<=p.fim; };
    var rel = txs.filter(noP);
    if(!rel.length) return 'Não encontrei transações '+p.rotulo+'.';
    var ins = rel.filter(function(t){return t.type==='in';}).reduce(function(s,t){return s+t.val;},0);
    var outs = rel.filter(function(t){return t.type==='out';}).reduce(function(s,t){return s+t.val;},0);
    var saldo = ins-outs;
    // top categoria de despesa
    var porCat={};
    rel.filter(function(t){return t.type==='out';}).forEach(function(t){ var c=t.cat||'outros'; porCat[c]=(porCat[c]||0)+t.val; });
    var topCat=null,topVal=0; for(var c in porCat){ if(porCat[c]>topVal){topVal=porCat[c];topCat=c;} }
    var r = '📊 Resumo '+p.rotulo+':\n\n';
    r += '• Receitas: R$ '+fm(ins)+'\n';
    r += '• Despesas: R$ '+fm(outs)+'\n';
    r += '• Saldo: R$ '+fm(saldo)+(saldo>=0?' 🟢':' 🔴')+'\n';
    if(topCat) r += '• Onde mais gastou: '+topCat+' (R$ '+fm(topVal)+')\n';
    r += saldo>=0 ? '\n✅ Você fechou no positivo.' : '\n⚠️ Você gastou mais do que recebeu.';
    return r;
  }

  // "quanto gastei [com X] [período]"
  if(/quanto\s+(gastei|gasto|paguei|despesas?)/.test(cmd)){
    var base = txs.filter(function(t){ return t.type==='out' && noPeriodo(t); });
    var termo = null;
    var tm = cmd.match(/(?:com|no|na|em)\s+([a-zãàáâçéêíóôõú]+)/);
    if(tm) termo = tm[1];
    if(termo && ['esse','este','mes','mês','passado','ano','semana','hoje','ontem','ultimos','últimos'].indexOf(termo)!==-1) termo=null;
    var filtrada = base, rotulo = per ? per.rotulo : 'no total';
    if(termo){
      filtrada = base.filter(function(t){ return (t.cat && t.cat.indexOf(termo)!==-1) || (t.desc && t.desc.toLowerCase().indexOf(termo)!==-1); });
      rotulo = 'com '+termo+(per?' '+per.rotulo:'');
    }
    if(!filtrada.length) return termo ? ('Não encontrei despesas '+rotulo+'.') : ('Não encontrei despesas '+rotulo+'.');
    var total = filtrada.reduce(function(s,t){ return s+t.val; },0);
    return 'Você gastou R$'+fm(total)+' '+rotulo+' ('+filtrada.length+' '+(filtrada.length===1?'transação':'transações')+').';
  }

  // "quanto recebi [período]"
  if(/quanto\s+(recebi|ganhei|entrou|de receita)/.test(cmd)){
    var receitas = txs.filter(function(t){ return t.type==='in' && noPeriodo(t); });
    var rotR = per ? per.rotulo : 'no total';
    if(!receitas.length) return 'Não encontrei receitas '+rotR+'.';
    var totalR = receitas.reduce(function(s,t){ return s+t.val; },0);
    return 'Você recebeu R$'+fm(totalR)+' '+rotR+' ('+receitas.length+' '+(receitas.length===1?'entrada':'entradas')+').';
  }

  // "qual meu saldo [período]"
  if(/(qual|meu)\s+.*saldo|saldo\s+(atual|do m[êe]s)?/.test(cmd) || /^saldo/.test(cmd)){
    var rel2 = txs.filter(noPeriodo);
    var ins2 = rel2.filter(function(t){return t.type==='in';}).reduce(function(s,t){return s+t.val;},0);
    var outs2 = rel2.filter(function(t){return t.type==='out';}).reduce(function(s,t){return s+t.val;},0);
    var per2 = per ? ' '+per.rotulo : '';
    return 'Seu saldo'+per2+' é de R$'+fm(ins2-outs2)+' (R$'+fm(ins2)+' em receitas − R$'+fm(outs2)+' em despesas).';
  }

  // "quantas vezes [comprei/gastei] [com/no X] [período]" - CONTAGEM
  if(/quantas?\s+vezes|quantos?\s+(pix|pagamentos?|compras?)/.test(cmd)){
    var termoC=null;
    var tmC=cmd.match(/(?:com|no|na|em|para|pro|pra)\s+([a-zãàáâçéêíóôõú0-9]+)/);
    if(tmC) termoC=tmC[1];
    var baseC=txs.filter(function(t){ return noPeriodo(t); });
    if(termoC) baseC=baseC.filter(function(t){ return (t.desc && t.desc.toLowerCase().indexOf(termoC)!==-1)||(t.cat && t.cat.indexOf(termoC)!==-1); });
    var rotC=(termoC?'com '+termoC:'')+(per?' '+per.rotulo:'');
    if(!baseC.length) return 'Não encontrei transações '+rotC+'.';
    var somaC=baseC.reduce(function(s,t){return s+t.val;},0);
    return 'Encontrei '+baseC.length+' '+(baseC.length===1?'transação':'transações')+' '+rotC+', somando R$'+fm(somaC)+'.';
  }

  // média de gastos
  if(/m[ée]dia\s+(de\s+)?(gastos?|despesas?|gasto)/.test(cmd)){
    var termoM = null;
    var tmM = cmd.match(/(?:com|no|na|em|de)\s+([a-zãàáâçéêíóôõú]+)\s*\??$/);
    if(tmM && ['gastos','gasto','despesas','despesa'].indexOf(tmM[1])===-1) termoM = tmM[1];
    var baseAvg = txs.filter(function(t){ return t.type==='out' && noPeriodo(t); });
    if(termoM){ baseAvg = baseAvg.filter(function(t){ return (t.cat && t.cat.indexOf(termoM)!==-1) || (t.desc && t.desc.toLowerCase().indexOf(termoM)!==-1); }); }
    if(!baseAvg.length) return termoM ? ('Não encontrei despesas com '+termoM+'.') : 'Não encontrei despesas registradas.';
    var somaM = baseAvg.reduce(function(s,t){ return s+t.val; },0);
    return 'A média de gastos'+(termoM?' com '+termoM:'')+(per?' '+per.rotulo:'')+' é R$'+fm(somaM/baseAvg.length)+' por transação ('+baseAvg.length+' transações, total R$'+fm(somaM)+').';
  }

  // maior/menor gasto
  var mmM = cmd.match(/(maior|menor)\s+(gasto|despesa|valor)/);
  if(mmM){
    var termoMM = null;
    var tmMM = cmd.match(/(?:com|no|na|em|de)\s+([a-zãàáâçéêíóôõú]+)\s*\??$/);
    if(tmMM && ['gasto','despesa','valor'].indexOf(tmMM[1])===-1) termoMM = tmMM[1];
    var baseMM = txs.filter(function(t){ return t.type==='out' && noPeriodo(t); });
    if(termoMM){ baseMM = baseMM.filter(function(t){ return (t.cat && t.cat.indexOf(termoMM)!==-1) || (t.desc && t.desc.toLowerCase().indexOf(termoMM)!==-1); }); }
    if(!baseMM.length) return 'Não encontrei despesas'+(termoMM?' com '+termoMM:'')+'.';
    var ordenada = baseMM.slice().sort(function(a,b){ return mmM[1]==='maior' ? b.val-a.val : a.val-b.val; });
    var alvo = ordenada[0];
    return 'Seu '+mmM[1]+' gasto'+(termoMM?' com '+termoMM:'')+(per?' '+per.rotulo:'')+' foi R$'+fm(alvo.val)+' ('+alvo.desc+', em '+alvo.date+').';
  }

  // "quais minhas maiores despesas" - TOP N
  if(/(maiores|principais)\s+(gastos?|despesas?)|onde\s+(gasto|gastei)\s+mais/.test(cmd)){
    var baseTop = txs.filter(function(t){ return t.type==='out' && noPeriodo(t); });
    if(!baseTop.length) return 'Não encontrei despesas'+(per?' '+per.rotulo:'')+'.';
    // agrupa por categoria
    var cats={}; baseTop.forEach(function(t){ var c=t.cat||'outros'; cats[c]=(cats[c]||0)+t.val; });
    var arr=Object.keys(cats).map(function(c){return {cat:c,val:cats[c]};}).sort(function(a,b){return b.val-a.val;}).slice(0,3);
    var r='Suas maiores despesas'+(per?' '+per.rotulo:'')+':\n';
    arr.forEach(function(x,i){ r+='\n'+(i+1)+'. '+x.cat+': R$ '+fm(x.val); });
    return r;
  }

  return null;
}
function _tryLocalQuery(msg){
  // versão melhorada: períodos flexíveis, resumo, contagem, top despesas
  var melhorada = _tryLocalQuery2_body(msg);
  if(melhorada) return melhorada;
  // (fallback antigo abaixo, mantido por segurança)
  var cmd = msg.toLowerCase();
  var txs = state.transactions || [];
  if(!txs.length) return null;

  var thisMonth = today().slice(0,7);
  var inMonth = function(t){ return t.date && t.date.slice(0,7)===thisMonth; };

  // "quanto gastei [no/com X] [esse mes]" - total de despesas, opcional por categoria/termo
  if(/quanto\s+(gastei|gasto|paguei|despesas?)/.test(cmd)){
    var soMes = /(esse|este|do)\s+m[êe]s|mensal/.test(cmd);
    var base = txs.filter(function(t){ return t.type==='out' && (!soMes || inMonth(t)); });

    // tenta filtrar por categoria ou termo citado
    var termo = null;
    var tm = cmd.match(/(?:com|no|na|em|de)\s+([a-zãàáâçéêíóôõú]+)/);
    if(tm) termo = tm[1];
    // ignora palavras de tempo como "termo"
    if(termo && ['esse','este','mes','mês','hoje','ontem'].indexOf(termo)!==-1) termo=null;

    var filtrada = base, rotulo = soMes ? 'neste mês' : 'no total';
    if(termo){
      filtrada = base.filter(function(t){
        return (t.cat && t.cat.indexOf(termo)!==-1) ||
               (t.desc && t.desc.toLowerCase().indexOf(termo)!==-1);
      });
      rotulo = 'com '+termo+(soMes?' neste mês':'');
    }
    if(!filtrada.length){
      return termo ? ('Não encontrei despesas '+rotulo+'.') : 'Não encontrei despesas registradas.';
    }
    var total = filtrada.reduce(function(s,t){ return s+t.val; },0);
    return 'Você gastou R$'+fm(total)+' '+rotulo+' ('+filtrada.length+' '+(filtrada.length===1?'transação':'transações')+').';
  }

  // "quanto recebi [esse mes]"
  if(/quanto\s+(recebi|ganhei|entrou|de receita)/.test(cmd)){
    var soMesR = /(esse|este|do)\s+m[êe]s/.test(cmd);
    var receitas = txs.filter(function(t){ return t.type==='in' && (!soMesR || inMonth(t)); });
    if(!receitas.length) return 'Não encontrei receitas registradas'+(soMesR?' neste mês':'')+'.';
    var totalR = receitas.reduce(function(s,t){ return s+t.val; },0);
    return 'Você recebeu R$'+fm(totalR)+(soMesR?' neste mês':' no total')+' ('+receitas.length+' '+(receitas.length===1?'entrada':'entradas')+').';
  }

  // "qual meu saldo" - receitas menos despesas
  if(/(qual|meu)\s+.*saldo|saldo\s+(atual|do m[êe]s)?/.test(cmd) || /^saldo/.test(cmd)){
    var soMesS = /(esse|este|do)\s+m[êe]s/.test(cmd);
    var rel = txs.filter(function(t){ return !soMesS || inMonth(t); });
    var ins = rel.filter(function(t){return t.type==='in';}).reduce(function(s,t){return s+t.val;},0);
    var outs = rel.filter(function(t){return t.type==='out';}).reduce(function(s,t){return s+t.val;},0);
    var saldo = ins-outs;
    var per = soMesS?' neste mês':'';
    return 'Seu saldo'+per+' é de R$'+fm(saldo)+' (R$'+fm(ins)+' em receitas − R$'+fm(outs)+' em despesas).';
  }

  // "qual a media de gastos [em X]"
  if(/m[ée]dia\s+(de\s+)?(gastos?|despesas?|gasto)/.test(cmd)){
    var termoM = null;
    var tmM = cmd.match(/(?:com|no|na|em|de)\s+([a-zãàáâçéêíóôõú]+)\s*\??$/);
    if(tmM && ['gastos','gasto','despesas','despesa'].indexOf(tmM[1])===-1) termoM = tmM[1];
    var baseM = txs.filter(function(t){ return t.type==='out'; });
    if(termoM){
      baseM = baseM.filter(function(t){
        return (t.cat && t.cat.indexOf(termoM)!==-1) || (t.desc && t.desc.toLowerCase().indexOf(termoM)!==-1);
      });
    }
    if(!baseM.length) return termoM ? ('Não encontrei despesas com '+termoM+'.') : 'Não encontrei despesas registradas.';
    var somaM = baseM.reduce(function(s,t){ return s+t.val; },0);
    var med = somaM / baseM.length;
    return 'A média de gastos'+(termoM?' com '+termoM:'')+' é R$'+fm(med)+' por transação ('+baseM.length+' transações, total R$'+fm(somaM)+').';
  }

  // "qual o maior/menor gasto [em X]"
  var mmM = cmd.match(/(maior|menor)\s+(gasto|despesa|valor)/);
  if(mmM){
    var termoMM = null;
    var tmMM = cmd.match(/(?:com|no|na|em|de)\s+([a-zãàáâçéêíóôõú]+)\s*\??$/);
    if(tmMM && ['gasto','despesa','valor'].indexOf(tmMM[1])===-1) termoMM = tmMM[1];
    var baseMM = txs.filter(function(t){ return t.type==='out'; });
    if(termoMM){
      baseMM = baseMM.filter(function(t){
        return (t.cat && t.cat.indexOf(termoMM)!==-1) || (t.desc && t.desc.toLowerCase().indexOf(termoMM)!==-1);
      });
    }
    if(!baseMM.length) return 'Não encontrei despesas'+(termoMM?' com '+termoMM:'')+'.';
    var ordenada = baseMM.slice().sort(function(a,b){ return mmM[1]==='maior' ? b.val-a.val : a.val-b.val; });
    var alvo = ordenada[0];
    return 'Seu '+mmM[1]+' gasto'+(termoMM?' com '+termoMM:'')+' foi R$'+fm(alvo.val)+' ('+alvo.desc+', em '+alvo.date+').';
  }

  return null;
}
async function aiChatSend(){
  // Se estiver gravando, para antes de enviar
  if(_chatRecording) _stopChatVoice();
  var input=document.getElementById('ai-chat-input');
  if(!input) return;
  var msg=input.value.trim();
  if(!msg) return;
  input.value='';
  _updateChatBtn();
  _aiAddBubble(msg,'ai-user');

  // CALCULADORA LOCAL: perguntas de gasto/saldo respondidas pelo proprio app, sem IA
  var localAns = _tryLocalQuery(msg);
  if(localAns){
    _localReply(localAns);
    _aiChatHistory.push({role:'user',text:msg});
    _aiChatHistory.push({role:'model',text:localAns});
    return;
  }

  // CRIACAO LOCAL: tarefa, nota e evento criados pelo app, sem IA
  var createAns = _tryLocalCreate(msg);
  if(createAns){
    _localReply(createAns);
    _aiChatHistory.push({role:'user',text:msg});
    _aiChatHistory.push({role:'model',text:'(item já criado pelo app, nenhuma ação adicional necessária)'});
    return;
  }

  // ATALHO NATIVO: comandos simples de transacao nao passam pela IA (instantaneo, sem 503)
  if(_tryLocalTransaction(msg)){
    // Marca no historico que JA foi executado, para a IA nunca reprocessar este comando
    _aiChatHistory.push({role:'user',text:msg});
    _aiChatHistory.push({role:'model',text:'(transação já registrada pelo app, nenhuma ação adicional necessária)'});
    return;
  }

  // CALCULADORA DE INVESTIMENTOS LOCAL: comparar/calcular renda fixa sem IA (preciso e privado)
  var invAns = _tryLocalInvestimento(msg);
  if(invAns){
    var invTexto = (typeof invAns==='object') ? invAns.texto : invAns;
    var temPDF = (typeof invAns==='object') && invAns.pdf;
    if(temPDF){ _localReplyComPDF(invTexto); }
    else { _localReply(invTexto); }
    _aiChatHistory.push({role:'user',text:msg});
    _aiChatHistory.push({role:'model',text:invTexto});
    return;
  }

  // DESAMBIGUAÇÃO: pedido vago → oferece sub-perguntas em chips (sem gastar IA)
  var vago = _tryDesambiguar(msg);
  if(vago){
    _aiChatHistory.push({role:'user',text:msg});
    return; // a resposta com chips já foi mostrada
  }

  var typing=_aiAddBubble('digitando...','ai-typing');

  try{
    var resp=await _fetchAutenticado('/api/chat',
      JSON.stringify({ message:msg, history:_aiChatHistory.slice(-8), context:_aiBuildContext(msg) }));
    if(typing) typing.remove();

    // Le o corpo sempre, mesmo em erro, para aproveitar a mensagem do backend
    var data={};
    try{ data=await resp.json(); }catch(e){ data={}; }

    // Assistente sobrecarregado (Gemini 503/429)
    if(data && data.overloaded){
      _aiAddBubble('⏳ '+(data.error||'O assistente está sobrecarregado. Tente novamente em alguns instantes.'),'ai-bot');
      return;
    }
    if(!resp.ok || (data && data.error)){
      _aiAddBubble((data && data.error) ? data.error : 'Ops, não consegui responder agora. Tente novamente.','ai-bot');
      return;
    }

    // Execute any actions returned
    var done=[];
    (data.actions||[]).forEach(function(a){
      var label=_aiExecuteAction(a);
      if(label) done.push(label);
    });

    _aiAddBubble(data.reply||'Feito!','ai-bot');
    if(done.length){
      _aiAddBubble('✓ '+done.join('<br>✓ '),'ai-action');
      save(); updateHome();
    }

    _aiChatHistory.push({role:'user',text:msg});
    _aiChatHistory.push({role:'model',text:data.reply||''});

  }catch(err){
    if(typing) typing.remove();
    _aiAddBubble('Ops, não consegui responder agora. Verifique sua conexão e tente novamente.','ai-bot');
  }
}
