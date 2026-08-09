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

// Incremento B: criação/transação e desambiguação/chips.

function _tryLocalTransaction(msg){
  var cmd = msg.toLowerCase();

  // Despesa: gastei/paguei/comprei/pix/ted... <valor> <descricao>
  var saidaM = cmd.match(/(?:gastei|paguei|comprei|passei|cartão|cartao|pix de?|ted de?|transferi|enviei|mandei|debitou|cobrou|saiu|gastar)\s+(?:r\$\s*)?(\d+(?:[.,]\d{1,2})?)\s*(?:reais?)?\s*(?:com|de|no|na|em|pra|para)?\s*(.*)?/);
  if(saidaM){
    var val = parseFloat(saidaM[1].replace(/\./g,'').replace(',','.'));
    if(!isNaN(val) && val>0){
      var descRaw = (saidaM[2]||'').trim();
      // Remove palavras de tempo que sobram no fim ("hoje", "ontem", "agora")
      descRaw = descRaw.replace(/\b(hoje|ontem|agora|de manhã|de manha|à tarde|a tarde|à noite|a noite)\b/gi,'').replace(/\s{2,}/g,' ').trim();
      var cat = /pix|ted|transferi|enviei/.test(cmd) ? 'pix' : detectCat(cmd+' '+descRaw);
      var descFinal = descRaw ? descRaw.charAt(0).toUpperCase()+descRaw.slice(1) : 'Despesa';
      state.transactions.unshift({id:uid(),desc:descFinal,val:val,type:'out',cat:cat,date:today()});
      save(); renderFinance(); updateHome();
      _aiAddBubble('✓ Registrei R$'+fm(val)+' em '+getCatInfo(cat).label+' ('+descFinal+').','ai-bot');
      return true;
    }
  }

  // Despesa com valor por extenso: "comprei um biscoito de seis reais"
  var saidaExt = cmd.match(/(?:gastei|paguei|comprei|custou|saiu)\s+(.*?)\s+(?:de|por|a)\s+([a-zãçéêíóôú\s]+?)\s+reais?/);
  if(saidaExt){
    var valExt = _palavraParaNumero(saidaExt[2]);
    if(valExt && valExt>0){
      var d = (saidaExt[1]||'').replace(/\b(um|uma|uns|umas|o|a|os|as)\b/gi,'').replace(/\s{2,}/g,' ').trim();
      var catExt = detectCat(cmd+' '+d);
      var descE = d ? d.charAt(0).toUpperCase()+d.slice(1) : 'Despesa';
      state.transactions.unshift({id:uid(),desc:descE,val:valExt,type:'out',cat:catExt,date:today()});
      save(); renderFinance(); updateHome();
      _aiAddBubble('✓ Registrei R$'+fm(valExt)+' em '+getCatInfo(catExt).label+' ('+descE+').','ai-bot');
      return true;
    }
  }

  // Despesa com valor por extenso em qualquer posicao: "gastei seis reais com biscoito" / "comprei um biscoito de seis reais"
  if(/(?:gastei|paguei|comprei|custou|saiu|gastar)/.test(cmd) && /reais?/.test(cmd)){
    // procura "<numero por extenso> reais"
    var extMatch = cmd.match(/((?:zero|um|uma|dois|duas|tr[êe]s|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|treze|quatorze|catorze|quinze|dezesseis|dezessete|dezoito|dezenove|vinte|trinta|quarenta|cinquenta|sessenta|setenta|oitenta|noventa|cem|cento|duzentos|trezentos|quatrocentos|quinhentos|mil)(?:\s+e\s+\w+)*)\s+reais?/);
    if(extMatch){
      var valExt2 = _palavraParaNumero(extMatch[1]);
      if(valExt2 && valExt2>0){
        // descricao = o que vem depois de "com/de/no/na/em" OU o que sobra
        var descX = '';
        var dm = cmd.match(/(?:com|de|no|na|em|pra|para)\s+([a-zãàáâçéêíóôõú\s]+?)(?:\s+(?:reais?|hoje|ontem|agora)|$)/);
        if(dm) descX = dm[1].trim();
        descX = descX.replace(extMatch[1],'').replace(/\b(um|uma|uns|umas|o|a|os|as|de|com|reais?)\b/gi,'').replace(/\s{2,}/g,' ').trim();
        var catX = detectCat(cmd);
        var descFin = descX ? descX.charAt(0).toUpperCase()+descX.slice(1) : 'Despesa';
        state.transactions.unshift({id:uid(),desc:descFin,val:valExt2,type:'out',cat:catX,date:today()});
        save(); renderFinance(); updateHome();
        _aiAddBubble('✓ Registrei R$'+fm(valExt2)+' em '+getCatInfo(catX).label+' ('+descFin+').','ai-bot');
        return true;
      }
    }
  }

  // Receita: recebi/ganhei/salario/entrou... <valor>
  var entM = cmd.match(/(?:recebi|salário de?|salario de?|ganhei|entrou|depositou|caiu)\s+(?:r\$\s*)?(\d+(?:[.,]\d{1,2})?)\s*(?:reais?)?\s*(?:de|do|da)?\s*(.*)?/);
  if(entM){
    var val2 = parseFloat(entM[1].replace(/\./g,'').replace(',','.'));
    if(!isNaN(val2) && val2>0){
      var d2 = (entM[2]||'').trim();
      var ehSalario = /salário|salario/.test(cmd);
      var desc2 = ehSalario ? 'Salário' : (d2 ? d2.charAt(0).toUpperCase()+d2.slice(1) : 'Receita');
      var cat2 = ehSalario ? 'salario' : 'outros';
      state.transactions.unshift({id:uid(),desc:desc2,val:val2,type:'in',cat:cat2,date:today()});
      save(); renderFinance(); updateHome();
      _aiAddBubble('✓ Registrei entrada de R$'+fm(val2)+' ('+desc2+').','ai-bot');
      return true;
    }
  }

  return false;
}
function _tryLocalCreate(msg){
  var cmd = msg.toLowerCase();

  // ----- TAREFA: "crie uma tarefa [com o nome de] X" -----
  var tarM = cmd.match(/(?:crie|criar|adicione|adicionar|nova|novo|faz|fazer|bota|colar?)\s+(?:uma?\s+)?tarefa(?:\s+(?:com o nome de|chamada|de|:|para|pra))?\s*(.*)/);
  if(tarM){
    var txt = (tarM[1]||'').trim();
    // pega o texto original (preserva acentos/maiusculas) a partir da posicao
    var origMatch = msg.match(/tarefa(?:\s+(?:com o nome de|chamada|de|:|para|pra))?\s*(.*)/i);
    if(origMatch && origMatch[1]) txt = origMatch[1].trim();
    if(txt){
      if(!isPremium){
        var ativas = state.tasks.filter(function(t){ return !t.done; });
        if(ativas.length >= (typeof PREMIUM_TASK_LIMIT!=='undefined'?PREMIUM_TASK_LIMIT:10)){
          return 'Você atingiu o limite de tarefas do plano gratuito. Considere o Premium para tarefas ilimitadas.';
        }
      }
      var urgente = /urgente/.test(cmd);
      var importante = /importante/.test(cmd) || !urgente;
      state.tasks.unshift({ id:uid(), text:txt.charAt(0).toUpperCase()+txt.slice(1), done:false, importante:importante, urgente:urgente });
      save(); renderTasks(); updateHome();
      return '✓ Criei a tarefa "'+txt+'".';
    }
  }

  // ----- NOTA: "adicione uma nota [:] X" -----
  var notaM = cmd.match(/(?:crie|criar|adicione|adicionar|nova|novo|anote|anotar|escreva)\s+(?:uma?\s+)?nota(?:\s*(?::|com o nome de|chamada|de|sobre))?\s*(.*)/);
  if(notaM){
    var origN = msg.match(/nota(?:\s*(?::|com o nome de|chamada|de|sobre))?\s*(.*)/i);
    var conteudo = (origN && origN[1]) ? origN[1].trim() : (notaM[1]||'').trim();
    if(conteudo){
      var titulo = conteudo.length>40 ? conteudo.slice(0,40)+'…' : conteudo;
      state.notes.unshift({ id:uid(), title:titulo.charAt(0).toUpperCase()+titulo.slice(1), body:'', date:new Date().toISOString(), folderId:null });
      save(); if(typeof renderNotes==='function') renderNotes(); updateHome();
      return '✓ Criei a nota "'+titulo+'".';
    }
  }

  // ----- EVENTO: "crie um evento X amanha as 15h" / "reuniao hoje as 9h" -----
  var evtM = cmd.match(/(?:crie|criar|adicione|adicionar|agende|agendar|marque|marcar)\s+(?:um\s+)?(?:evento|compromisso|reuni[ãa]o)\s+(.*?)\s+(?:às|as|para as|pra)\s+(\d{1,2})(?:[:h](\d{2}))?/);
  if(evtM){
    var origE = msg.match(/(?:evento|compromisso|reuni[ãa]o)\s+(.*?)\s+(?:às|as|para as|pra)\s+\d/i);
    var titEv = (origE && origE[1]) ? origE[1].trim() : (evtM[1]||'Evento').trim();
    // Remove palavras de tempo que vazam para o titulo (sem \b por causa dos acentos)
    titEv = titEv.replace(/(^|\s)(amanhã|amanha|hoje|depois de amanhã|depois de amanha|de manhã|de manha|à tarde|a tarde|à noite|a noite)(\s|$)/gi,' ').replace(/\s{2,}/g,' ').trim();
    if(!titEv) titEv = 'Evento';
    var hh = evtM[2].padStart(2,'0');
    var mm = (evtM[3]||'00').padStart(2,'0');
    var dEv = new Date();
    if(/amanhã|amanha/.test(cmd)) dEv.setDate(dEv.getDate()+1);
    if(/depois de amanhã|depois de amanha/.test(cmd)) dEv.setDate(dEv.getDate()+2);
    state.events.push({ id:uid(), title:titEv.charAt(0).toUpperCase()+titEv.slice(1), date:dEv.toISOString().slice(0,10), time:hh+':'+mm, color:'#2d6c97', remind:15 });
    save(); if(typeof renderEvents==='function') renderEvents(); updateHome();
    var quando = /amanhã|amanha/.test(cmd) ? 'amanhã' : 'hoje';
    return '✓ Agendei "'+titEv+'" para '+quando+' às '+hh+':'+mm+'.';
  }

  return null;
}
function _chipPergunta(texto){
  var input=document.getElementById('ai-chat-input');
  if(input){ input.value=texto; _updateChatBtn(); }
  aiChatSend();
}
function _localReplyComChips(texto, chips){
  var typing=_aiAddBubble('digitando...','ai-typing');
  setTimeout(function(){
    if(typing) typing.remove();
    var bubble=_aiAddBubble(texto,'ai-bot');
    if(bubble){
      var wrap=document.createElement('div');
      wrap.style.cssText='display:flex;flex-wrap:wrap;gap:6px;margin-top:10px';
      chips.forEach(function(c){
        var b=document.createElement('button');
        b.textContent=c.label;
        b.style.cssText='border:1px solid var(--sky);background:var(--sky-xl);color:var(--sky);font-size:12px;font-weight:700;padding:7px 12px;border-radius:100px;cursor:pointer';
        b.onclick=function(){ if(c.acao){ c.acao(); } else { _chipPergunta(c.pergunta); } };
        wrap.appendChild(b);
      });
      bubble.appendChild(wrap);
    }
  }, 500);
}
function _tryDesambiguar(msg){
  var c=msg.toLowerCase().trim();
  // já tem período ou termo específico? então não é vago
  var temPeriodo=/m[êe]s|ano|semana|hoje|ontem|dias|janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro/.test(c);

  // "meus gastos" / "gastos" / "quanto gastei" (sem período nem categoria)
  if(/^(meus\s+)?gastos?$/.test(c) || (/gast(ei|os|o)\b/.test(c) && c.split(/\s+/).length<=2 && !temPeriodo)){
    _localReplyComChips('De qual período você quer ver seus gastos?', [
      {label:'📅 Esse mês', pergunta:'quanto gastei esse mês'},
      {label:'📅 Mês passado', pergunta:'quanto gastei mês passado'},
      {label:'📅 Esse ano', pergunta:'quanto gastei esse ano'},
      {label:'🔝 Maiores despesas', pergunta:'quais minhas maiores despesas esse mês'}
    ]);
    return true;
  }

  // "investimento" / "investir" / "aplicar" (vago)
  if(/^(investimentos?|investir|aplicar|renda fixa)$/.test(c)){
    _localReplyComChips('O que você quer fazer com investimentos?', [
      {label:'⚖️ Comparar CDB e LCI', pergunta:'compara CDB 110% com LCI 95% por 2 anos'},
      {label:'💰 Simular carteira', acao:function(){ abrirCalcInv('lucro'); }},
      {label:'📊 Equivalência', pergunta:'quanto rende uma LCI de 95%'}
    ]);
    return true;
  }

  // "resumo" / "como estou" (vago)
  if(/^(resumo|como\s+estou|situa[çc][ãa]o|balan[çc]o)$/.test(c)){
    _localReplyComChips('Quer ver o resumo de qual período?', [
      {label:'📊 Esse mês', pergunta:'como está minha vida financeira esse mês'},
      {label:'📊 Mês passado', pergunta:'resumo mês passado'},
      {label:'📊 Esse ano', pergunta:'resumo esse ano'}
    ]);
    return true;
  }

  // "criar" / "adicionar" (sem dizer o quê)
  if(/^(criar|adicionar|nova|novo|adiciona|cria)$/.test(c)){
    _localReplyComChips('O que você quer criar?', [
      {label:'✓ Uma tarefa', pergunta:'cria uma tarefa'},
      {label:'📝 Uma nota', pergunta:'cria uma nota'},
      {label:'📅 Um evento', pergunta:'cria um evento'}
    ]);
    return true;
  }

  return false;
}
