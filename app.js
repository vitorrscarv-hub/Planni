var firebaseConfig = {
  apiKey: "AIzaSyDskCXYYTAIvzldZNOXP4l4PpKuIdBF3_4",
  authDomain: "smart-life-finance.firebaseapp.com",
  projectId: "smart-life-finance",
  storageBucket: "smart-life-finance.firebasestorage.app",
  messagingSenderId: "917839010005",
  appId: "1:917839010005:web:2822bb59376d5486462a5c"
};
var db, auth;
try {
  firebase.initializeApp(firebaseConfig);
  db   = firebase.firestore();
  auth = firebase.auth();
} catch(e) {
  console.error('Firebase init falhou:', e);
}

// Pega o ID Token do usuário logado, pra autenticar chamadas às Cloudflare
// Functions (/api/chat, /api/analisar). Sem isso, esses endpoints recusam
// a requisição (401).
async function _getAuthHeader(forcarRenovacao){
  try{
    if(!auth) return {};
    var user = auth.currentUser;
    if(!user){
      // O Firebase ainda pode estar restaurando a sessão (acontece logo
      // após abrir o app). Espera esse processo terminar antes de desistir,
      // em vez de mandar a requisição sem token e tomar 401 à toa.
      user = await new Promise(function(resolve){
        var unsub = auth.onAuthStateChanged(function(u){ unsub(); resolve(u); });
      });
    }
    if(!user) return {};
    // getIdToken() usa o token em cache e o próprio SDK renova quando expira.
    // NÃO forçar renovação em toda chamada: getIdToken(true) faz uma requisição
    // de rede extra ao Google a cada mensagem, que é limitada por quota e falha
    // de forma intermitente — quando falhava, a chamada seguia SEM o header
    // Authorization e o servidor respondia 401 mesmo com o usuário logado.
    // A renovação forçada só é usada no retry após um 401 (ver _fetchAutenticado).
    var token;
    try{
      token = await user.getIdToken(!!forcarRenovacao);
    }catch(e){
      // Renovação forçada falhou (rede/quota): tenta o token em cache,
      // que ainda pode estar válido, antes de desistir.
      token = await user.getIdToken(false);
    }
    return { 'Authorization': 'Bearer ' + token };
  }catch(e){
    console.warn('Não foi possível obter o ID token:', e);
    return {};
  }
}

// POST autenticado para as Functions (/api/chat, /api/analisar, /api/extrato).
// Se o servidor responder 401 (ex: token em cache que acabou de expirar),
// renova o token à força e repete a requisição UMA vez antes de desistir.
async function _fetchAutenticado(url, bodyStr){
  var headers = Object.assign({'Content-Type':'application/json'}, await _getAuthHeader());
  var resp = await fetch(url, { method:'POST', headers: headers, body: bodyStr });
  if(resp.status === 401){
    headers = Object.assign({'Content-Type':'application/json'}, await _getAuthHeader(true));
    resp = await fetch(url, { method:'POST', headers: headers, body: bodyStr });
  }
  return resp;
}
// ═══════════════════════════════════════
// CONSTANTS & STATE
// ═══════════════════════════════════════
// Retorna o primeiro nome do usuário logado (ou 'Usuário' como fallback seguro)
function getUserFirstName(){
  try{
    if(typeof currentUser !== 'undefined' && currentUser && currentUser.name){
      var first = String(currentUser.name).trim().split(/\s+/)[0];
      if(first) return first;
    }
  }catch(e){}
  return 'Usuário';
}
const BANKS = ['Nubank','Itaú','Bradesco','Santander','Banco do Brasil','Caixa Econômica','Inter','C6 Bank','BTG Pactual','XP Investimentos','Rico','Clear','Avenue','Sicoob','Sicredi','Safra','Modalmais','Órama','Kinvo','Picpay','Next','Neon','Mercado Pago','PagBank','BS2'];
const CDI_ATUAL = 0.1065; // 10.65% a.a. referência
const IPCA_ATUAL = 0.0452; // 4.52% a.a. referência
const SELIC_ATUAL = 0.1075; // 10.75% a.a.

let state = {
  events:[],transactions:[],notes:[],tasks:[],bills:[],
  investments:[],goals:[],customCats:[],noteFolders:[],
  viewMonth: new Date().toISOString().slice(0,7)
};
let currentInvTab = 'fixa';
let quotesCache = {};
let editingNoteId = null;
let recognition = null;
let isListening = false;

// Returns the localStorage key specific to the current user
function _userStorageKey(){
  if(currentUser && currentUser.uid){
    return 'claudio_v3_' + currentUser.uid;
  }
  return null; // no generic key — prevents cross-user leak
}

// One-time cleanup: remove the old shared key that caused cross-user data leak
try{ localStorage.removeItem('claudio_v3'); }catch(e){}

// Empty state template
function _emptyState(){
  return {
    events:[], transactions:[], notes:[], tasks:[], bills:[],
    investments:[], goals:[], customCats:[], noteFolders:[],
    viewMonth:new Date().toISOString().slice(0,7)
  };
}

// ── SAVE: Firestore + per-user localStorage ──
function save(){
  if(!currentUser || !currentUser.uid) return; // never save without a user
  var key = _userStorageKey();
  try{ if(key) localStorage.setItem(key, JSON.stringify(state)); }catch(e){}
  var docRef = db.collection('users').doc(currentUser.uid).collection('data').doc('state');
  docRef.set({
    events:      state.events      || [],
    transactions:state.transactions|| [],
    notes:       state.notes       || [],
    tasks:       state.tasks       || [],
    bills:       state.bills       || [],
    investments: state.investments || [],
    goals:       state.goals       || [],
    customCats:  state.customCats  || [],
    noteFolders: state.noteFolders || [],
    updatedAt:   firebase.firestore.FieldValue.serverTimestamp()
  }).catch(function(e){ console.warn('Firestore save error:', e); });
}

// ── LOAD: only from the current user's own key ──
function load(){
  var key = _userStorageKey();
  if(!key){
    // No logged user yet — start clean, never load shared data
    state = _emptyState();
    return;
  }
  try{
    var d=localStorage.getItem(key);
    if(d) state=Object.assign(_emptyState(), JSON.parse(d));
    else state=_emptyState();
  }catch(e){ state=_emptyState(); }
}

// ── LOAD FROM FIRESTORE (authoritative source after login) ──
function loadFromFirestore(){
  if(!currentUser||!currentUser.uid) return;
  var uid = currentUser.uid;
  var docRef=db.collection('users').doc(uid).collection('data').doc('state');
  docRef.get().then(function(doc){
    // Guard: make sure user didn't change while loading
    if(!currentUser || currentUser.uid !== uid) return;
    if(doc.exists){
      var d=doc.data();
      state = Object.assign(_emptyState(), {
        events:      d.events      ||[],
        transactions:d.transactions||[],
        notes:       d.notes       ||[],
        tasks:       d.tasks       ||[],
        bills:       d.bills       ||[],
        investments: d.investments ||[],
        goals:       d.goals       ||[],
        customCats:  d.customCats  ||[],
        noteFolders: d.noteFolders ||[],
        viewMonth:   state.viewMonth
      });
    } else {
      // New user with no cloud data — ensure a clean slate
      state = _emptyState();
    }
    // Update this user's own localStorage
    try{ localStorage.setItem(_userStorageKey(), JSON.stringify(state)); }catch(e){}
    // Re-render everything
    updateHome(); renderFinance(); renderGoals();
    renderBillsSummary(); renderBills();
    renderNotes(); renderTasks(); renderInvest();
    try{ renderEvents(); }catch(e){}
  }).catch(function(e){ console.warn('Firestore load error:',e); });
}

// ── REALTIME LISTENER (keeps data in sync across devices) ──
var _firestoreUnsubscribe = null;
function startRealtimeSync(){
  if(!currentUser||!currentUser.uid) return;
  if(_firestoreUnsubscribe) _firestoreUnsubscribe();
  var uid = currentUser.uid;
  var docRef=db.collection('users').doc(uid).collection('data').doc('state');
  _firestoreUnsubscribe=docRef.onSnapshot(function(doc){
    // Guard: ignore if user changed
    if(!currentUser || currentUser.uid !== uid) return;
    if(doc.exists&&doc.metadata.hasPendingWrites===false){
      var d=doc.data();
      state=Object.assign(_emptyState(),{
        events:      d.events      ||[],
        transactions:d.transactions||[],
        notes:       d.notes       ||[],
        tasks:       d.tasks       ||[],
        bills:       d.bills       ||[],
        investments: d.investments ||[],
        goals:       d.goals       ||[],
        customCats:  d.customCats  ||[],
        noteFolders: d.noteFolders ||[],
        viewMonth:   state.viewMonth
      });
      try{ localStorage.setItem(_userStorageKey(),JSON.stringify(state)); }catch(e){}
      // Isolamento: se esta conta não pertence a nenhum grupo válido, remove eventos de grupo herdados
      _limparEventosDeGrupoOrfaos();
      updateHome();
    }
  },function(e){ console.warn('Realtime sync error:',e); });
}

// ═══════════════════════════════════════
// UTILS
// ═══════════════════════════════════════
function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,7); }
function today(){ return new Date().toISOString().slice(0,10); }
function fm(n){ return Number(n).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function fm0(n){ return Number(n).toLocaleString('pt-BR',{minimumFractionDigits:0,maximumFractionDigits:0}); }
function fmtDate(d){
  if(!d) return '';
  const [y,m,dd]=d.split('-');
  return `${dd}/${m}/${y}`;
}
function toast(msg){
  const el=document.getElementById('toast');
  el.textContent=msg; el.classList.add('show');
  setTimeout(()=>el.classList.remove('show'),2600);
}

// ═══════════════════════════════════════
// CLOCK
// ═══════════════════════════════════════
function updateClock(){
  const n=new Date();
  document.getElementById('clock-display').textContent=String(n.getHours()).padStart(2,'0')+':'+String(n.getMinutes()).padStart(2,'0');
  const dias=['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  const meses=['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  document.getElementById('date-display').textContent=`${dias[n.getDay()]}, ${n.getDate()} ${meses[n.getMonth()]}`;
}

// ═══════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════
// showScreen and navTo defined below in Etapa 1 section


// ═══════════════════════════════════════
// CATEGORIES
// ═══════════════════════════════════════
const DEFAULT_CATS = {
  alimentacao:{icon:'🍽',label:'Alimentação',color:'#f59e0b',type:'out'},
  transporte:{icon:'🚗',label:'Transporte',color:'#3b82f6',type:'out'},
  moradia:{icon:'🏠',label:'Moradia',color:'#8b5cf6',type:'out'},
  saude:{icon:'💊',label:'Saúde',color:'#10b981',type:'out'},
  lazer:{icon:'🎭',label:'Lazer',color:'#ef4444',type:'out'},
  educacao:{icon:'📚',label:'Educação',color:'#06b6d4',type:'out'},
  vestuario:{icon:'👔',label:'Vestuário',color:'#f97316',type:'out'},
  servicos:{icon:'📱',label:'Serviços',color:'#6366f1',type:'out'},
  pix:{icon:'⚡',label:'Pix/TED',color:'#84cc16',type:'out'},
  mercado:{icon:'🛒',label:'Mercado',color:'#eab308',type:'out'},
  combustivel:{icon:'⛽',label:'Combustível',color:'#64748b',type:'out'},
  energia:{icon:'💡',label:'Energia',color:'#facc15',type:'out'},
  agua:{icon:'💧',label:'Água',color:'#38bdf8',type:'out'},
  internet:{icon:'📶',label:'Internet',color:'#4f46e5',type:'out'},
  salario:{icon:'💼',label:'Salário',color:'#18a058',type:'in'},
  freelance:{icon:'💻',label:'Freelance',color:'#0ea5e9',type:'in'},
  investimento:{icon:'📈',label:'Rendimento',color:'#22c55e',type:'in'},
  bonus:{icon:'🎁',label:'Bônus',color:'#a855f7',type:'in'},
  outros:{icon:'◈',label:'Outros',color:'#94a3b8',type:'out'},
};

function getCatInfo(id){
  if(DEFAULT_CATS[id]) return DEFAULT_CATS[id];
  const c=(state.customCats||[]).find(c=>c.id===id);
  if(c) return {icon:c.icon,label:c.name,color:c.color,type:c.type};
  return {icon:'◈',label:'Outros',color:'#94a3b8',type:'out'};
}

function allCats(type){
  const def=Object.entries(DEFAULT_CATS).filter(([,v])=>!type||v.type===type).map(([k,v])=>({id:k,...v,isDefault:true}));
  const cust=(state.customCats||[]).filter(c=>!type||c.type===type).map(c=>({...c,isDefault:false}));
  return [...def,...cust];
}

function populateCatSelect(selId, type){
  const sel=document.getElementById(selId); if(!sel) return;
  const prev=sel.value;
  const cats=allCats(type||'out');
  sel.innerHTML=cats.map(c=>`<option value="${c.id}">${c.icon} ${c.label}</option>`).join('');
  if(prev&&[...sel.options].some(o=>o.value===prev)) sel.value=prev;
}

let catModalType='out';
function openCatModal(type){
  catModalType=type||'out';
  document.getElementById('cm-type').value=catModalType;
  document.getElementById('cat-modal-title').textContent=catModalType==='out'?'Nova Categoria de Despesa':'Nova Categoria de Receita';
  document.getElementById('cm-existing-title').textContent=catModalType==='out'?'Categorias de Despesa':'Categorias de Receita';
  renderCatModalList();
  document.getElementById('cat-modal').classList.add('show');
}
function closeCatModal(){ document.getElementById('cat-modal').classList.remove('show'); }

function saveCatModal(){
  const icon=(document.getElementById('cm-icon').value.trim()||'🏷').slice(0,2);
  const name=document.getElementById('cm-name').value.trim();
  const color=document.getElementById('cm-color').value;
  const type=document.getElementById('cm-type').value;
  if(!name){ toast('Digite o nome'); return; }
  state.customCats.push({id:'cat_'+uid(),icon,name,color,type});
  save();
  document.getElementById('cm-icon').value='';
  document.getElementById('cm-name').value='';
  populateCatSelect('tx-cat', document.getElementById('tx-type').value);
  renderCatModalList();
  toast('✓ Categoria criada!');
}

function deleteCatModal(id){
  const inUse=state.transactions.some(t=>t.cat===id);
  if(inUse){ toast('⚠ Em uso por transações'); return; }
  state.customCats=state.customCats.filter(c=>c.id!==id);
  save(); renderCatModalList(); populateCatSelect('tx-cat', document.getElementById('tx-type').value);
  toast('Removida');
}

function renderCatModalList(){
  const type=document.getElementById('cm-type').value;
  const cust=(state.customCats||[]).filter(c=>c.type===type);
  const def=Object.entries(DEFAULT_CATS).filter(([,v])=>v.type===type);
  const el=document.getElementById('cm-existing-list');
  let html='';
  cust.forEach(c=>{ html+=`<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1.5px solid var(--border)"><span style="width:28px;height:28px;border-radius:8px;background:${c.color}20;display:flex;align-items:center;justify-content:center">${c.icon}</span><span style="flex:1;font-size:13px;font-weight:700;color:var(--ink)">${c.name}</span><button onclick="deleteCatModal('${c.id}')" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:13px;padding:4px">✕</button></div>`; });
  def.forEach(([k,v])=>{ html+=`<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1.5px solid var(--border);opacity:.6"><span style="width:28px;height:28px;border-radius:8px;background:${v.color}20;display:flex;align-items:center;justify-content:center">${v.icon}</span><span style="flex:1;font-size:13px;font-weight:600;color:var(--ink2)">${v.label}</span><span style="font-size:10px;color:var(--ink4)">🔒</span></div>`; });
  el.innerHTML=html||'<div class="empty" style="padding:16px 0">Nenhuma</div>';
}

// ═══════════════════════════════════════
// HOME
// ═══════════════════════════════════════
function updateHome(){
  const td=today();
  const todayEvts=state.events.filter(e=>e.date===td).sort((a,b)=>a.time.localeCompare(b.time));
  const pendTasks=state.tasks.filter(t=>!t.done);
  const pendBills=state.bills.filter(b=>!b.paid);
  const bal=calcBalance(state.viewMonth);
  const h=new Date().getHours();
  const sal=h<12?'Bom dia':h<18?'Boa tarde':'Boa noite';

  document.getElementById('h-events').textContent=todayEvts.length;
  document.getElementById('h-tasks').textContent=pendTasks.length;
  document.getElementById('h-bills').textContent=pendBills.length;
  const bEl=document.getElementById('h-balance');
  bEl.textContent='R$'+fm0(Math.abs(bal));
  bEl.style.color=bal>=0?'var(--green)':'var(--red)';

  const {totalCurrent,totalInvested}=calcInvTotals();
  const invRes=totalCurrent-totalInvested;
  document.getElementById('h-inv').textContent='R$'+fm0(totalCurrent);
  const irEl=document.getElementById('h-inv-res');
  irEl.textContent=(invRes>=0?'+':'-')+'R$'+fm0(Math.abs(invRes));
  irEl.style.color=invRes>=0?'var(--green)':'var(--red)';

  // Briefing — usa o primeiro nome do usuário logado
  let msg=`<strong>${sal}, ${getUserFirstName()}!</strong> `;
  if(!todayEvts.length) msg+=`Você não tem eventos hoje. `;
  else msg+=`Hoje você tem <strong>${todayEvts.length} evento${todayEvts.length>1?'s':''}</strong>: ${todayEvts.slice(0,2).map(e=>`<strong>${e.time}</strong> ${e.title}`).join(', ')}. `;
  if(pendTasks.length) msg+=`<strong>${pendTasks.length} tarefa${pendTasks.length>1?'s':''}</strong> pendente${pendTasks.length>1?'s':''}. `;
  if(bal<0) msg+=`⚠️ Saldo <strong style="color:#ff9999">negativo R$${fm(Math.abs(bal))}</strong>. `;
  else msg+=`Saldo do mês: <strong>R$${fm(bal)}</strong>. `;
  if(pendBills.length){ const tb=pendBills.reduce((s,b)=>s+b.value,0); msg+=`<strong>${pendBills.length} conta${pendBills.length>1?'s':''}</strong> a pagar (R$${fm(tb)}). `; }
  if(state.investments&&state.investments.length){ msg+=`Carteira: <strong>R$${fm(totalCurrent)}</strong> `; msg+=invRes>=0?`<strong style="color:#5cf09a">(+R$${fm(invRes)})</strong>.`:`<strong style="color:#ff7b7b">(-R$${fm(Math.abs(invRes))})</strong>.`; }
  document.getElementById('briefing-text').innerHTML=msg;

  // Weekly summary
  buildWeeklySummary();

  // Insights carousel
  try{ renderHomeInsights(); }catch(e){}

  // Agenda list
  const agEl=document.getElementById('h-agenda');
  agEl.innerHTML=todayEvts.length?todayEvts.map(e=>`<div class="event-item"><div class="event-time">${e.time}</div><div class="event-dot" style="background:${e.color}"></div><div class="event-info"><div class="event-title">${e.title}</div></div></div>`).join(''):'<div class="empty"><div class="empty-icon">📅</div>Nenhum evento hoje</div>';

  // Tasks list
  const tEl=document.getElementById('h-tasks-list');
  tEl.innerHTML=pendTasks.length?pendTasks.slice(0,4).map(t=>{var q=_taskQuadrant(t);var ql={q1:'FAZER',q2:'AGENDAR',q3:'DELEGAR',q4:'ELIMINAR'}[q];return `<div class="task-item"><div class="task-check" onclick="quickDoneTask('${t.id}')"></div><div class="task-text">${t.text}</div><span class="task-prio ${q}">${ql}</span></div>`;}).join(''):'<div class="empty"><div class="empty-icon">✅</div>Tudo em dia!</div>';
}

function quickDoneTask(id){
  const t=state.tasks.find(t=>t.id===id);
  if(t){ t.done=true; save(); updateHome(); toast('✓ Concluída!'); }
}

function buildWeeklySummary(){
  const box=document.getElementById('week-summary-box');
  const now=new Date();
  const dayOfWeek=now.getDay();
  const startOfWeek=new Date(now); startOfWeek.setDate(now.getDate()-dayOfWeek);
  const startStr=startOfWeek.toISOString().slice(0,10);
  const prevStart=new Date(startOfWeek); prevStart.setDate(prevStart.getDate()-7);
  const prevStartStr=prevStart.toISOString().slice(0,10);
  const prevEnd=new Date(startOfWeek); prevEnd.setDate(prevEnd.getDate()-1);
  const prevEndStr=prevEnd.toISOString().slice(0,10);

  const thisWeek=state.transactions.filter(t=>t.type==='out'&&t.date>=startStr&&t.date<=today()).reduce((s,t)=>s+t.val,0);
  const lastWeek=state.transactions.filter(t=>t.type==='out'&&t.date>=prevStartStr&&t.date<=prevEndStr).reduce((s,t)=>s+t.val,0);
  if(!thisWeek&&!lastWeek){ box.style.display='none'; return; }
  box.style.display='block';
  const diff=thisWeek-lastWeek;
  const diffPct=lastWeek>0?((diff/lastWeek)*100).toFixed(0):0;
  const color=diff<=0?'var(--green)':'var(--red)';
  box.innerHTML=`<div class="week-summary-title">📊 Resumo da Semana</div>
    <div class="week-row"><div class="week-row-label">Esta semana</div><div class="week-row-val" style="color:var(--red)">R$ ${fm(thisWeek)}</div></div>
    <div class="week-row"><div class="week-row-label">Semana passada</div><div class="week-row-val">R$ ${fm(lastWeek)}</div></div>
    <div class="week-row"><div class="week-row-label">Variação</div><div class="week-row-val" style="color:${color}">${diff<=0?'↓':' ↑'} R$ ${fm(Math.abs(diff))} (${Math.abs(diffPct)}%)</div></div>`;
}

// ═══════════════════════════════════════
// FINANCE
// ═══════════════════════════════════════
function changeMonth(dir){
  const [y,m]=state.viewMonth.split('-').map(Number);
  const d=new Date(y,m-1+dir,1);
  state.viewMonth=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
  save(); renderMonthLabel(); renderFinance();
}

function renderMonthLabel(){
  const [y,m]=state.viewMonth.split('-');
  const meses=['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  document.getElementById('month-label').textContent=`${meses[parseInt(m)-1]} ${y}`;
}

function calcBalance(month){
  return state.transactions.filter(t=>!month||t.date.startsWith(month)).reduce((s,t)=>s+(t.type==='in'?t.val:-t.val),0);
}

function updateParcelaPreview(){
  var n=parseInt(document.getElementById('tx-parcelas').value)||1;
  var val=parseFloat(document.getElementById('tx-value').value)||0;
  var info=document.getElementById('tx-parcela-info');
  if(!info) return;
  if(n>1&&val>0){
    info.textContent=n+'x de R$ '+fm(val/n);
  } else {
    info.textContent='';
  }
}

function addTransaction(){
  const desc=document.getElementById('tx-desc').value.trim();
  const val=parseFloat(document.getElementById('tx-value').value);
  const type=document.getElementById('tx-type').value;
  const cat=document.getElementById('tx-cat').value;
  const date=document.getElementById('tx-date').value||today();
  const recur=document.getElementById('tx-recur').value==='1';
  const parcelas=parseInt((document.getElementById('tx-parcelas')||{value:1}).value)||1;
  if(!desc||isNaN(val)||val<=0){ toast('Preencha descrição e valor'); return; }

  if(parcelas>1){
    // Parcelamento: cria N transações, uma por mês
    var valParcela=Math.round((val/parcelas)*100)/100;
    var baseDate=new Date(date+'T12:00:00');
    var groupId=uid();
    for(var i=0;i<parcelas;i++){
      var d=new Date(baseDate);
      d.setMonth(d.getMonth()+i);
      var dStr=d.toISOString().slice(0,10);
      state.transactions.unshift({
        id:uid(),
        desc:desc+' ('+(i+1)+'/'+parcelas+')',
        val:valParcela,
        type:type,cat:cat,date:dStr,recur:false,
        parcelaGroup:groupId,parcelaNum:i+1,parcelaTotal:parcelas
      });
    }
    toast('\u2713 '+parcelas+'x de R$ '+fm(valParcela)+' registradas!');
  } else {
    state.transactions.unshift({id:uid(),desc,val,type,cat,date,recur});
    toast('\u2713 Registrado!');
  }

  save(); renderFinance(); updateHome();
  document.getElementById('tx-desc').value='';
  document.getElementById('tx-value').value='';
  var ps=document.getElementById('tx-parcelas'); if(ps) ps.value='1';
  var pi=document.getElementById('tx-parcela-info'); if(pi) pi.textContent='';
  // Close form after adding
  var fw=document.getElementById('tx-form-wrap');
  var fb=document.getElementById('tx-form-toggle-btn');
  if(fw) fw.style.display='none';
  if(fb) fb.textContent='+ Nova Movimenta\u00e7\u00e3o';
}

function delTx(id){ state.transactions=state.transactions.filter(t=>t.id!==id); save(); renderFinance(); updateHome(); toast('Removido'); }

function renderFinance(){
  const month=state.viewMonth;
  var searchTerm=((document.getElementById('tx-search')||{value:''}).value||'').toLowerCase().trim();
  let txMonth=state.transactions.filter(t=>t.date.startsWith(month));
  if(searchTerm){
    txMonth=txMonth.filter(function(t){
      return (t.desc||'').toLowerCase().includes(searchTerm)
        || (t.cat||'').toLowerCase().includes(searchTerm)
        || String(t.val).includes(searchTerm);
    });
  }
  const bal=calcBalance(month);
  const hw=document.getElementById('balance-hero-wrap');
  hw.innerHTML=`<div class="balance-hero ${bal<0?'neg':'pos'}" style="margin-bottom:14px"><div class="balance-label">Saldo — ${document.getElementById('month-label').textContent||month}</div><div class="balance-value">${bal<0?'−':''}R$ ${fm(Math.abs(bal))}</div><div class="balance-sub">${txMonth.length} movimentações</div></div>`;

  const totalIn=txMonth.filter(t=>t.type==='in').reduce((s,t)=>s+t.val,0);
  const totalOut=txMonth.filter(t=>t.type==='out').reduce((s,t)=>s+t.val,0);
  document.getElementById('total-in').textContent='R$ '+fm(totalIn);
  document.getElementById('total-out').textContent='R$ '+fm(totalOut);

  // PIE CHART SVG
  renderPieChart(txMonth.filter(t=>t.type==='out'));

  // BAR CHART
  const cats={};
  txMonth.filter(t=>t.type==='out').forEach(t=>{ cats[t.cat]=(cats[t.cat]||0)+t.val; });
  const sorted=Object.entries(cats).sort((a,b)=>b[1]-a[1]).slice(0,6);
  const max=(sorted[0]&&sorted[0][1])||1;
  const chartEl=document.getElementById('cat-chart');
  chartEl.innerHTML=sorted.length?sorted.map(([cat,val])=>{ const ci=getCatInfo(cat); return `<div class="bar-row"><div class="bar-label">${ci.icon} ${ci.label}</div><div class="bar-track"><div class="bar-fill" style="width:${(val/max*100).toFixed(0)}%;background:${ci.color}"></div></div><div class="bar-val">R$${fm(val)}</div></div>`; }).join(''):'<div class="empty" style="padding:16px 0">Sem despesas</div>';

  // TX LIST — grouped by day with daily balance
  const listEl=document.getElementById('tx-list');
  if(!txMonth.length){ listEl.innerHTML='<div class="empty"><div class="empty-icon">💳</div>Nenhuma movimentação neste mês</div>'; return; }
  // Sort newest first, then group by date
  const sortedTx=txMonth.slice().sort(function(a,b){ return a.date<b.date?1:(a.date>b.date?-1:0); });
  const byDay={};
  const dayOrder=[];
  sortedTx.forEach(function(t){
    if(!byDay[t.date]){ byDay[t.date]=[]; dayOrder.push(t.date); }
    byDay[t.date].push(t);
  });
  const weekdays=['domingo','segunda','terça','quarta','quinta','sexta','sábado'];
  let html='';
  dayOrder.forEach(function(day){
    const dayTx=byDay[day];
    const dIn=dayTx.filter(function(t){return t.type==='in';}).reduce(function(s,t){return s+t.val;},0);
    const dOut=dayTx.filter(function(t){return t.type==='out';}).reduce(function(s,t){return s+t.val;},0);
    const dNet=dIn-dOut;
    const dt=new Date(day+'T00:00:00');
    const wd=weekdays[dt.getDay()];
    const dayLabel=dt.getDate().toString().padStart(2,'0')+'/'+(dt.getMonth()+1).toString().padStart(2,'0');
    html+='<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 4px 6px;border-bottom:1.5px solid var(--border);margin-top:4px">'
      +'<div style="font-size:12px;font-weight:800;color:var(--ink)">'+dayLabel+' <span style="font-weight:600;color:var(--ink3);text-transform:capitalize">· '+wd+'</span></div>'
      +'<div style="font-size:12px;font-weight:800;color:'+(dNet<0?'var(--red,#e0422d)':'var(--green,#18a058)')+'">'+(dNet<0?'−':'+')+'R$'+fm(Math.abs(dNet))+'</div>'
      +'</div>';
    html+=dayTx.map(function(t){ const ci=getCatInfo(t.cat); return '<div class="tx-item"><div class="tx-icon" style="background:'+ci.color+'20">'+ci.icon+'</div><div class="tx-info"><div class="tx-name">'+t.desc+(t.recur?'<span class="recur-badge">↻ MENSAL</span>':'')+'</div><div class="tx-cat">'+ci.label+'</div></div><div class="tx-amount '+(t.type==='in'?'pos':'neg')+'">'+(t.type==='in'?'+':'−')+'R$'+fm(t.val)+'</div><span class="tx-del" onclick="delTx(\''+t.id+'\')">✕</span></div>'; }).join('');
  });
  listEl.innerHTML=html;
}

function renderPieChart(txOuts){
  const container=document.getElementById('pie-container');
  const cats={};
  txOuts.forEach(t=>{ cats[t.cat]=(cats[t.cat]||0)+t.val; });
  const entries=Object.entries(cats).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const total=entries.reduce((s,[,v])=>s+v,0);
  if(!total){ container.innerHTML='<div class="empty" style="padding:12px 0">Sem dados</div>'; return; }
  const size=120; const r=50; const cx=60; const cy=60;
  let startAngle=-Math.PI/2; let slices=''; let legends='';
  entries.forEach(([cat,val])=>{
    const ci=getCatInfo(cat);
    const angle=(val/total)*2*Math.PI;
    const x1=cx+r*Math.cos(startAngle); const y1=cy+r*Math.sin(startAngle);
    const x2=cx+r*Math.cos(startAngle+angle); const y2=cy+r*Math.sin(startAngle+angle);
    const large=angle>Math.PI?1:0;
    slices+=`<path d="M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large},1 ${x2},${y2} Z" fill="${ci.color}" opacity="0.85"/>`;
    legends+=`<div class="pie-legend-item"><div class="pie-dot" style="background:${ci.color}"></div>${ci.icon} ${ci.label} <span style="margin-left:auto;font-weight:800;color:var(--ink)">R$${fm0(val)}</span></div>`;
    startAngle+=angle;
  });
  container.innerHTML=`<div class="pie-wrap"><svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="flex-shrink:0">${slices}<circle cx="${cx}" cy="${cy}" r="22" fill="white"/><text x="${cx}" y="${cy+4}" text-anchor="middle" font-size="9" font-weight="800" fill="#3a5070">R$${fm0(total)}</text></svg><div class="pie-legend">${legends}</div></div>`;
}

// ═══════════════════════════════════════
// RECURRING TRANSACTIONS — ENHANCED
// ═══════════════════════════════════════
const EMOJI_LIST = ['🏠','🚗','💊','🍽','🛒','📱','💡','💧','📶','📚','👔','🎭','⚡','💼','💻','🎁','✈️','🏋️','🐾','🌱','🎵','📷','🎮','⚽','🏊','🎨','🍕','☕','🍺','🛍️','💈','🏦','🏢','🏪','🏥','🏫','⛽','🚌','🚁','🛳️','🚂','🎪','🎬','🎯','🎲','♟️','💰','💳','🪙','📊','📈','📉','🏆','🎖️','🥇','🌟','⭐','🔥','💎','👑','🎀','🔑','🔒','🛡️','⚙️','🔧','🔨','🪛','📦','🗂️','📋','📌','📍','🖊️','✏️','📝','❤️','💙','💚','💛','🧡','💜','🖤','🤍','💗','💓','😊','🙏','👏','💪','🤝','🌈','🌙','☀️','⛅','🌊','🌺','🌸','🍀','🌴','🦋','🐶','🐱','🐠','🦜','🌻'];
let emojiTargetId = null;

function openEmojiPicker(targetId){ emojiTargetId=targetId; renderEmojiGrid(''); document.getElementById('emoji-search-input').value=''; document.getElementById('emoji-picker-modal').classList.add('show'); }
function closeEmojiPicker(){ document.getElementById('emoji-picker-modal').classList.remove('show'); emojiTargetId=null; }
function selectEmoji(emoji){ if(!emojiTargetId) return; document.getElementById(emojiTargetId).value=emoji; const btn=document.getElementById(emojiTargetId+'-btn'); if(btn) btn.textContent=emoji; closeEmojiPicker(); }
function filterEmojis(q){ renderEmojiGrid(q); }
function renderEmojiGrid(q){ const grid=document.getElementById('emoji-grid'); const list=q?EMOJI_LIST.filter(e=>e.includes(q)):EMOJI_LIST; grid.innerHTML=list.map(e=>`<button class="emoji-btn" onclick="selectEmoji('${e}')">${e}</button>`).join(''); }

function getWeekKey(date){ const d=new Date(date); d.setHours(0,0,0,0); d.setDate(d.getDate()-d.getDay()); return d.toISOString().slice(0,10); }

function applyRecurring(){
  const now=new Date();
  const thisMonth=now.toISOString().slice(0,7);
  const thisWeek=getWeekKey(now);
  const thisYear=now.getFullYear().toString();
  const half=now.getDate()<=15?'a':'b';

  state.transactions.filter(t=>t.recur&&t.recur!=='0').forEach(t=>{
    if(t.recur==='mensal'||t.recur===true||t.recur==='1'){
      const already=state.transactions.some(tx=>tx.desc===t.desc&&tx.date.startsWith(thisMonth)&&tx.id!==t.id&&tx.autoGenerated);
      if(!already&&!t.date.startsWith(thisMonth)){
        const day=t.date.slice(8)||'01';
        state.transactions.unshift({id:uid(),desc:t.desc,val:t.val,type:t.type,cat:t.cat,date:thisMonth+'-'+day,recur:'mensal',autoGenerated:true});
      }
    } else if(t.recur==='quinzenal'){
      const key=thisMonth+'-'+half;
      const already=state.transactions.some(tx=>tx.desc===t.desc&&tx.autoGenerated&&tx.recurKey===key);
      if(!already) state.transactions.unshift({id:uid(),desc:t.desc,val:t.val,type:t.type,cat:t.cat,date:today(),recur:'quinzenal',autoGenerated:true,recurKey:key});
    } else if(t.recur==='semanal'){
      const already=state.transactions.some(tx=>tx.desc===t.desc&&tx.autoGenerated&&tx.recurKey===thisWeek);
      if(!already) state.transactions.unshift({id:uid(),desc:t.desc,val:t.val,type:t.type,cat:t.cat,date:today(),recur:'semanal',autoGenerated:true,recurKey:thisWeek});
    } else if(t.recur==='anual'){
      const already=state.transactions.some(tx=>tx.desc===t.desc&&tx.date.startsWith(thisYear)&&tx.id!==t.id&&tx.autoGenerated);
      if(!already&&!t.date.startsWith(thisYear)) state.transactions.unshift({id:uid(),desc:t.desc,val:t.val,type:t.type,cat:t.cat,date:today(),recur:'anual',autoGenerated:true});
    }
  });
  save();
}

function updateRecurPreview(){
  const recur=document.getElementById('tx-recur')?document.getElementById('tx-recur').value:undefined;
  const prev=document.getElementById('tx-recur-preview');
  const type=document.getElementById('tx-type')?document.getElementById('tx-type').value:undefined;
  if(!prev) return;
  if(!recur||recur==='0'){ prev.style.display='none'; return; }
  const labels={mensal:'📅 Lançado todo mês automaticamente',quinzenal:'📅 Lançado a cada 15 dias',semanal:'📅 Lançado toda semana',anual:'📅 Lançado uma vez por ano'};
  prev.style.display='block';
  prev.innerHTML=labels[recur]+(type==='in'?' como <strong>receita</strong>':' como <strong>despesa</strong>');
}

// ═══════════════════════════════════════
// OVERDUE ALERTS
// ═══════════════════════════════════════
function checkOverdueAlerts(){
  const td=today();
  let count=0, total=0;
  (state.bills||[]).forEach(b=>{
    if(b.kind==='avulsa'&&!b.paid&&b.due&&b.due<td){ if(b.status!=='atrasada'){ b.status='atrasada'; } count++; total+=b.value||0; }
    if(b.kind==='financ'&&b.status!=='quitado'&&b.due&&b.due<td){ if(b.status==='emdia') b.status='atrasado'; count++; total+=b.parcel||0; }
    if(b.kind==='fixa'&&b.active&&b.day){
      const nowDay=new Date().getDate();
      if(b.day<nowDay){ const m=new Date().toISOString().slice(0,7); const paid=state.transactions.some(tx=>tx.desc===b.name&&tx.date.startsWith(m)&&tx.type==='out'); if(!paid){ count++; total+=b.value||0; } }
    }
  });
  if(count>0){ save(); try{ renderBillsSummary(); }catch(e){} }
  if(count>0){
    const el=document.getElementById('toast');
    if(el){ el.textContent='⚠️ '+count+' conta'+( count>1?'s':'')+' em atraso · R$'+fm(total); el.style.background='var(--red)'; el.classList.add('show'); setTimeout(()=>{ el.classList.remove('show'); el.style.background=''; },4000); }
  }
}

// ═══════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════
function openExport(){ document.getElementById('export-modal').classList.add('show'); }
function closeExport(){ document.getElementById('export-modal').classList.remove('show'); }

function doExport(){
  const period=document.getElementById('exp-period').value;
  const format=document.getElementById('exp-format').value;
  const now=new Date();
  let txs=state.transactions;
  if(period==='month') txs=txs.filter(t=>t.date.startsWith(now.toISOString().slice(0,7)));
  else if(period==='3months'){ const d3=new Date(now); d3.setMonth(d3.getMonth()-3); txs=txs.filter(t=>t.date>=d3.toISOString().slice(0,10)); }
  else if(period==='year') txs=txs.filter(t=>t.date.startsWith(now.getFullYear().toString()));

  let content='',filename='';
  if(format==='csv'){
    content='Data,Descrição,Tipo,Categoria,Valor\n';
    txs.forEach(t=>{ const ci=getCatInfo(t.cat); content+=`${t.date},"${t.desc}",${t.type==='in'?'Entrada':'Saída'},"${ci.label}","R$ ${fm(t.val)}"\n`; });
    filename='extrato-planni.csv';
  } else {
    content=`EXTRATO PLANNI — ${now.toLocaleDateString('pt-BR')}\n${'='.repeat(50)}\n`;
    txs.forEach(t=>{ const ci=getCatInfo(t.cat); content+=`${t.date} | ${t.type==='in'?'+':'-'} R$ ${fm(t.val)} | ${t.desc} | ${ci.label}\n`; });
    content+=`${'='.repeat(50)}\nTotal Entradas: R$ ${fm(txs.filter(t=>t.type==='in').reduce((s,t)=>s+t.val,0))}\nTotal Saídas:   R$ ${fm(txs.filter(t=>t.type==='out').reduce((s,t)=>s+t.val,0))}`;
    filename='extrato-planni.txt';
  }
  const blob=new Blob([content],{type:format==='csv'?'text/csv':'text/plain'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=filename; a.click();
  URL.revokeObjectURL(url);
  closeExport(); toast('✓ Extrato exportado!');
}

// ═══════════════════════════════════════
// GOALS
// ═══════════════════════════════════════
// ── Goal form helpers ──
var _goalEtapas = [];

function isFinancialGoalCat(cat){
  return cat==='financeira'||cat==='patrimonial';
}

function onGoalCatChange(){
  var cat=document.getElementById('goal-cat').value;
  var fin=document.getElementById('goal-fields-financial');
  var nfin=document.getElementById('goal-fields-nonfinancial');
  if(isFinancialGoalCat(cat)){
    if(fin) fin.style.display='block';
    if(nfin) nfin.style.display='none';
  } else {
    if(fin) fin.style.display='none';
    if(nfin) nfin.style.display='block';
  }
}

function addGoalEtapa(){
  var inp=document.getElementById('goal-etapa-input');
  var txt=(inp&&inp.value.trim())||'';
  if(!txt){toast('Digite a etapa');return;}
  _goalEtapas.push({label:txt,done:false});
  inp.value='';
  renderGoalEtapasList();
}

function removeGoalEtapa(idx){
  _goalEtapas.splice(idx,1);
  renderGoalEtapasList();
}

function renderGoalEtapasList(){
  var el=document.getElementById('goal-etapas-list');
  if(!el) return;
  if(!_goalEtapas.length){el.innerHTML='';return;}
  el.innerHTML=_goalEtapas.map(function(e,i){
    return '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">'
      +'<span style="font-size:11px;color:var(--sky);font-weight:700">'+( i+1)+'.</span>'
      +'<span style="flex:1;font-size:12px;color:var(--ink2)">'+e.label+'</span>'
      +'<span style="cursor:pointer;color:var(--ink3);font-size:16px" data-idx="'+i+'" onclick="removeGoalEtapa(this.dataset.idx)">&times;</span>'
      +'</div>';
  }).join('');
}

function addGoal(){
  var name=document.getElementById('goal-name').value.trim();
  var cat=document.getElementById('goal-cat').value;
  var prazo=document.getElementById('goal-prazo').value;
  var deadline=document.getElementById('goal-deadline').value;
  if(!name){toast('Informe o nome da meta');return;}

  var goalObj={id:uid(),name:name,cat:cat,prazo:prazo,deadline:deadline,createdAt:new Date().toISOString()};

  if(isFinancialGoalCat(cat)){
    var target=parseFloat(document.getElementById('goal-target').value)||0;
    var current=parseFloat(document.getElementById('goal-current').value)||0;
    if(target<=0){toast('Informe o valor da meta');return;}
    goalObj.type='financial';
    goalObj.target=target;
    goalObj.current=Math.min(current,target);
    goalObj.marcos=(GOAL_MARCOS_DEF[cat]||GOAL_MARCOS_DEF.patrimonial).map(function(lbl){return{label:lbl,done:false};});
  } else {
    var pct=parseInt((document.getElementById('goal-pct-input')||{value:0}).value)||0;
    var desc=(document.getElementById('goal-desc')||{value:''}).value.trim();
    goalObj.type='nonfinancial';
    goalObj.pct=pct;
    goalObj.desc=desc;
    goalObj.etapas=_goalEtapas.length ? _goalEtapas.slice() : (GOAL_MARCOS_DEF[cat]||GOAL_MARCOS_DEF.pessoal).map(function(lbl){return{label:lbl,done:false};});
    goalObj.target=100; // virtual target for % progress
    goalObj.current=pct;
  }

  state.goals.push(goalObj);
  save(); renderGoals(); updateHome();

  // Reset form
  document.getElementById('goal-name').value='';
  var tf=document.getElementById('goal-target'); if(tf) tf.value='';
  var cf=document.getElementById('goal-current'); if(cf) cf.value='';
  var df=document.getElementById('goal-desc'); if(df) df.value='';
  var pf=document.getElementById('goal-pct-input'); if(pf) pf.value=0;
  var pv=document.getElementById('goal-pct-val'); if(pv) pv.textContent='0%';
  var ei=document.getElementById('goal-etapa-input'); if(ei) ei.value='';
  document.getElementById('goal-deadline').value='';
  _goalEtapas=[];
  renderGoalEtapasList();
  toast('\u2713 Meta "'+name+'" criada!');
}

function addToGoal(id,amount){
  const g=state.goals.find(g=>g.id===id);
  if(g){ g.current=Math.min(g.target,g.current+amount); save(); renderGoals(); toast(`+R$${fm(amount)} adicionado!`); }
}

function delGoal(id){ state.goals=state.goals.filter(function(g){return g.id!==id;}); save(); renderGoals(); updateHome(); toast('Meta removida'); }

// ── GOALS PREMIUM vars ──
var _goalFilter='all';
var _goalFormOpen=true;
var GOAL_CATS={
  financeira:{l:'Financeira',i:'\u{1F4B0}',c:'#2d3494',b:'rgba(45,52,148,.1)'},
  patrimonial:{l:'Patrimonial',i:'\u{1F3E0}',c:'#18a058',b:'rgba(24,160,88,.1)'},
  profissional:{l:'Profissional',i:'\u{1F4BC}',c:'#e07d2d',b:'rgba(224,125,45,.1)'},
  pessoal:{l:'Pessoal',i:'\u2B50',c:'#8b5cf6',b:'rgba(139,92,246,.1)'}
};
var PRAZO_CATS={
  curto:{l:'Curto prazo',c:'#18a058',b:'rgba(24,160,88,.12)'},
  medio:{l:'Medio prazo',c:'#e07d2d',b:'rgba(224,125,45,.12)'},
  longo:{l:'Longo prazo',c:'#2d3494',b:'rgba(45,52,148,.12)'}
};
var GOAL_MARCOS_DEF={
  financeira:['Definir orcamento','Primeira poupanca','50% alcancado','Meta batida!'],
  patrimonial:['Pesquisa de mercado','Entrada reservada','Financiamento aprovado','Assinatura/Compra'],
  profissional:['Planejamento','Primeiro passo','Meio caminho','Objetivo alcancado!'],
  pessoal:['Compromisso feito','Inicio da jornada','Meio caminho','Conquista realizada!']
};

function toggleGoalForm(){
  _goalFormOpen=!_goalFormOpen;
  var b=document.getElementById('goal-form-body');
  var t=document.getElementById('goal-form-toggle');
  if(b) b.style.display=_goalFormOpen?'block':'none';
  if(t) t.innerHTML=_goalFormOpen?'&minus;':'+';
}

function filterGoals(cat){
  _goalFilter=cat;
  document.querySelectorAll('.goal-cat-btn').forEach(function(b){b.classList.remove('active');});
  var btn=document.getElementById('gcat-'+cat);
  if(btn) btn.classList.add('active');
  renderGoals();
}

function toggleMarco(goalId,idx){
  var g=state.goals.find(function(x){return x.id===goalId;});
  if(g&&g.marcos) g.marcos[parseInt(idx)].done=!g.marcos[parseInt(idx)].done;
  save(); renderGoals();
}
function toggleEtapa(goalId,idx){
  var g=state.goals.find(function(x){return x.id===goalId;});
  if(!g) return;
  var arr=g.etapas||g.marcos;
  if(arr) arr[parseInt(idx)].done=!arr[parseInt(idx)].done;
  // Auto-update pct based on completed etapas
  if(arr&&arr.length){
    var doneCnt=arr.filter(function(e){return e.done;}).length;
    g.pct=Math.round((doneCnt/arr.length)*100);
    g.current=g.pct;
  }
  save(); renderGoals();
}

function updateGoalPct(goalId,val){
  var g=state.goals.find(function(x){return x.id===goalId;});
  if(!g) return;
  g.pct=parseInt(val)||0;
  g.current=g.pct;
  save(); renderGoals(); updateHome();
}


function updateGoalInsight(goals){
  var textEl=document.getElementById('goal-insight-text');
  var subEl=document.getElementById('goal-insight-sub');
  if(!textEl) return;
  var active=(goals||[]).filter(function(g){return g.current<g.target;});
  if(!goals||!goals.length){
    textEl.textContent='Crie sua primeira meta e acompanhe seu progresso aqui.';
    if(subEl) subEl.textContent=''; return;
  }
  if(!active.length){
    textEl.textContent='\u{1F3C6} Parabens! Voce concluiu todas as suas metas!';
    if(subEl) subEl.textContent='Crie novas metas para continuar crescendo.'; return;
  }
  var top=active.sort(function(a,b){return(b.current/b.target)-(a.current/a.target);})[0];
  var pct=Math.min(100,(top.current/top.target)*100).toFixed(0);
  var remaining=top.target-top.current;
  var day=new Date().getDate();
  var msgs=[
    'Sua meta <b>'+top.name+'</b> esta em <b>'+pct+'%</b> \u2014 voce esta chegando la! \u{1F680}',
    'Continue! Faltam <b>R$ '+fm(remaining)+'</b> para conquistar <b>'+top.name+'</b>.',
    '<b>'+pct+'%</b> da meta <b>'+top.name+'</b> conquistados. Cada passo conta! \u{1F4AA}',
    'Voce ja guardou <b>R$ '+fm(top.current)+'</b> para <b>'+top.name+'</b>. Continue focado! \u{1F3AF}'
  ];
  textEl.innerHTML=msgs[day%msgs.length];
  if(subEl){
    var ci=GOAL_CATS[top.cat]||GOAL_CATS.pessoal;
    var pi=PRAZO_CATS[top.prazo]||PRAZO_CATS.medio;
    subEl.textContent=ci.i+' '+ci.l+' \u00B7 '+pi.l;
  }
}

function renderGoals(){
  var el=document.getElementById('goals-list');
  if(!el) return;
  var goals=state.goals||[];
  var today=new Date();today.setHours(0,0,0,0);
  var done=goals.filter(function(g){return g.current>=g.target;}).length;
  var late=goals.filter(function(g){return g.deadline&&new Date(g.deadline)<today&&g.current<g.target;}).length;
  var prog=goals.filter(function(g){return g.current<g.target;}).length;
  var gp=document.getElementById('gd-progress');if(gp)gp.textContent=prog;
  var gd=document.getElementById('gd-done');if(gd)gd.textContent=done;
  var gl=document.getElementById('gd-late');if(gl)gl.textContent=late;
  updateGoalInsight(goals);
  var filtered=_goalFilter==='all'?goals:goals.filter(function(g){return g.cat===_goalFilter;});
  if(!filtered.length){
    el.innerHTML='<div class="empty"><div class="empty-icon">\u{1F3AF}</div>'+(goals.length?'Nenhuma meta nesta categoria':'Nenhuma meta criada')+'</div>';
    return;
  }
  var rows=filtered.map(function(g){
    var isFinancial=g.type==='financial'||(g.type===undefined&&(g.cat==='financeira'||g.cat==='patrimonial'));
    var pct=isFinancial?Math.min(100,(g.current/g.target)*100):Math.min(100,(g.pct||g.current||0));
    var isDone=pct>=100;
    var ci=GOAL_CATS[g.cat]||GOAL_CATS.pessoal;
    var pi=PRAZO_CATS[g.prazo]||PRAZO_CATS.medio;
    var isLate=g.deadline&&new Date(g.deadline)<today&&!isDone;
    var cardCls='goal-card-new'+(isDone?' done':isLate?' late':'');
    // Steps
    var stepsData=isFinancial?(g.marcos||[]):(g.etapas||g.marcos||[]);
    var stepsHtml='';
    if(stepsData.length){
      var fnName=isFinancial?'toggleMarco':'toggleEtapa';
      var stepRows=stepsData.map(function(s,i){
        var dc=s.done?' done':'';
        var ss=s.done?'text-decoration:line-through;color:var(--ink3)':'';
        return '<div class="goal-marco-row">'
          +'<div class="goal-marco-dot'+dc+'" data-gid="'+g.id+'" data-idx="'+i+'" onclick="'+fnName+'(this.dataset.gid,this.dataset.idx)">'+(s.done?'\u2713':'')+'</div>'
          +'<span style="'+ss+'">'+s.label+'</span>'
          +'</div>';
      }).join('');
      stepsHtml='<div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--border)">'
        +'<div style="font-size:9px;font-weight:800;color:var(--ink3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">'+(isFinancial?'Marcos':'Etapas')+'</div>'
        +stepRows+'</div>';
    }
    // Progress info
    var progressInfo='';
    if(isFinancial){
      progressInfo='<div style="display:flex;justify-content:space-between;margin-bottom:4px">'
        +'<span style="font-size:12px;font-weight:700;color:var(--ink2)">R$ '+fm(g.current)+' <span style="color:var(--ink3);font-weight:500">/ R$ '+fm(g.target)+'</span></span>'
        +'<span style="font-size:13px;font-weight:900;color:#2d3494">'+pct.toFixed(1)+'%</span>'
        +'</div>';
    } else {
      progressInfo=(g.desc?'<div style="font-size:12px;color:var(--ink2);margin-bottom:8px;font-style:italic">'+g.desc+'</div>':'')
        +'<div style="display:flex;justify-content:space-between;margin-bottom:4px">'
        +'<span style="font-size:12px;font-weight:700;color:var(--ink2)">Progresso</span>'
        +'<span style="font-size:13px;font-weight:900;color:#2d3494">'+pct.toFixed(0)+'%</span>'
        +'</div>';
    }
    // Action
    var actionBtn='';
    if(!isDone){
      if(isFinancial){
        actionBtn='<button class="btn btn-ghost" style="margin-top:10px;padding:8px;font-size:11px" data-gid="'+g.id+'" onclick="addToGoalPrompt(this.dataset.gid)">+ Adicionar valor</button>';
      } else {
        actionBtn='<div style="margin-top:10px;display:flex;align-items:center;gap:8px">'
          +'<input type="range" min="0" max="100" value="'+Math.round(pct)+'" style="flex:1;cursor:pointer" data-gid="'+g.id+'" oninput="updateGoalPct(this.dataset.gid,this.value)">'
          +'<span style="font-size:12px;font-weight:800;color:#2d3494;min-width:36px">'+Math.round(pct)+'%</span>'
          +'</div>';
      }
    }
    return '<div class="'+cardCls+'">'
      +'<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">'
        +'<div style="display:flex;align-items:center;gap:8px">'
          +'<div style="width:36px;height:36px;border-radius:10px;background:'+ci.b+';display:flex;align-items:center;justify-content:center;font-size:18px">'+ci.i+'</div>'
          +'<div><div style="font-size:14px;font-weight:900;color:var(--ink)">'+g.name+'</div>'
          +'<div style="font-size:10px;font-weight:700;color:var(--ink3);text-transform:uppercase;letter-spacing:.05em">'+ci.l+'</div></div>'
        +'</div>'
        +'<span style="cursor:pointer;color:var(--ink3);font-size:20px;padding:0 4px" data-gid="'+g.id+'" onclick="delGoal(this.dataset.gid)">&times;</span>'
      +'</div>'
      +progressInfo
      +'<div class="goal-prog-bar"><div class="goal-prog-fill'+(isDone?' done':'')+'" style="width:'+pct+'%"></div></div>'
      +'<div style="display:flex;align-items:center;justify-content:space-between">'
        +(isDone?'<span style="font-size:12px;font-weight:800;color:var(--green)">\u2705 Conclu\u00edda!</span>':'<span style="font-size:11px;font-weight:600;color:var(--ink3)">'+(isFinancial?'Faltam R$ '+fm(g.target-g.current):Math.round(pct)+'% conclu\u00eddo')+'</span>')
        +'<span class="goal-prazo-tag" style="background:'+pi.b+';color:'+pi.c+'">'+pi.l+'</span>'
      +'</div>'
      +(g.deadline?'<div style="font-size:10px;color:'+(isLate?'var(--red)':'var(--ink3)')+';margin-top:4px;font-weight:600">'+(isLate?'\u26A0 Atrasada \u2014 ':'Prazo: ')+fmtDate(g.deadline)+'</div>':'')
      +actionBtn
      +stepsHtml
      +'</div>';
  }).join('');
  el.innerHTML=rows;
}

function addToGoalPrompt(id){
  const val=parseFloat(prompt('Quanto deseja adicionar? (R$)'));
  if(!isNaN(val)&&val>0) addToGoal(id,val);
}

// ═══════════════════════════════════════
// INVESTMENTS — FULL
// ═══════════════════════════════════════
function switchInvTab(tab){
  currentInvTab=tab;
  ['fixa','variavel','cripto'].forEach(t=>{
    document.getElementById('itab-'+t).classList.toggle('active',t===tab);
    document.getElementById('form-'+t).style.display=t===tab?'block':'none';
  });
  const labels={fixa:'Renda Fixa',variavel:'Ações B3',cripto:'Criptomoedas'};
  document.getElementById('inv-list-title').textContent=labels[tab];
  renderInvest();
}

function addInvFixa(){
  const name=document.getElementById('fi-name').value.trim();
  const type=document.getElementById('fi-type').value;
  const index=document.getElementById('fi-index').value;
  const value=parseFloat(document.getElementById('fi-value').value);
  const rate=parseFloat(document.getElementById('fi-rate').value);
  const start=document.getElementById('fi-start').value;
  const end=document.getElementById('fi-end').value;
  const risk=parseInt(document.getElementById('fi-risk').value);
  if(!name||isNaN(value)||value<=0||isNaN(rate)||!start){ toast('Preencha todos os campos'); return; }
  state.investments.push({id:uid(),kind:'fixa',name,type,index,value,rate,start,end,risk,createdAt:today()});
  save(); renderInvest(); updateInvHero(); updateHome();
  ['fi-name','fi-value','fi-rate'].forEach(id=>document.getElementById(id).value='');
  toast('✓ Investimento adicionado!');
}

function addInvVariavel(){
  const ticker=document.getElementById('va-ticker').value.trim().toUpperCase();
  const qty=parseFloat(document.getElementById('va-qty').value);
  const avgPrice=parseFloat(document.getElementById('va-avgprice').value);
  const risk=parseInt(document.getElementById('va-risk').value);
  if(!ticker||isNaN(qty)||qty<=0||isNaN(avgPrice)||avgPrice<=0){ toast('Preencha todos os campos'); return; }
  const inv={id:uid(),kind:'variavel',ticker,qty,avgPrice,currentPrice:avgPrice,risk,createdAt:today()};
  state.investments.push(inv);
  save(); renderInvest(); updateInvHero(); updateHome();
  ['va-ticker','va-qty','va-avgprice'].forEach(id=>document.getElementById(id).value='');
  toast('✓ Ação adicionada!');
  fetchQuote(inv);
}

function addInvCripto(){
  const ticker=document.getElementById('cr-ticker').value.trim().toUpperCase();
  const qty=parseFloat(document.getElementById('cr-qty').value);
  const avgPrice=parseFloat(document.getElementById('cr-avgprice').value);
  const risk=parseInt(document.getElementById('cr-risk').value);
  if(!ticker||isNaN(qty)||qty<=0||isNaN(avgPrice)||avgPrice<=0){ toast('Preencha todos os campos'); return; }
  const inv={id:uid(),kind:'cripto',ticker,qty,avgPrice,currentPrice:avgPrice,risk,createdAt:today()};
  state.investments.push(inv);
  save(); renderInvest(); updateInvHero(); updateHome();
  ['cr-ticker','cr-qty','cr-avgprice'].forEach(id=>document.getElementById(id).value='');
  toast('✓ Cripto adicionada!');
  fetchQuote(inv);
}

function delInv(id){ state.investments=state.investments.filter(i=>i.id!==id); save(); renderInvest(); updateInvHero(); updateHome(); toast('Removido'); }

// ── RENTABILIDADE — REGRAS BACEN/CVM ──
// CDI atual (meta Selic): 10.65% a.a. = 0.1065
// IPCA acumulado 12m: 4.52% a.a.
// Selic: 10.75% a.a.
// Base de cálculo: 252 dias úteis (convenção brasileira)
// Juros compostos diários sobre dias CORRIDOS (simplificado para uso pessoal)
// IOF: tabela regressiva dias 1-29, isento dia 30+
// IR: regressivo 22.5% (0-180d), 20% (181-360d), 17.5% (361-720d), 15% (720d+)
// LCI/LCA/CRI/CRA/Poupança: isentos de IR e IOF para PF

function calcFixaReturn(inv){
  const startDate = new Date(inv.start + 'T00:00:00');
  const todayDate = new Date();
  const endDate   = inv.end ? new Date(inv.end + 'T00:00:00') : null;

  // Dias corridos decorridos desde a aplicação
  const diasDecorridos = Math.max(1, Math.floor((todayDate - startDate) / 86400000));
  const diasTotais = endDate ? Math.max(1, Math.floor((endDate - startDate) / 86400000)) : diasDecorridos;

  // ── TAXA ANUAL EFETIVA ──
  // O usuário informa:
  //   CDI      → percentual do CDI. Ex: 110 = 110% do CDI = 110/100 × 10.65% = 11.715% a.a.
  //   IPCA+    → spread sobre o IPCA. Ex: 6 = IPCA + 6% = 4.52 + 6 = 10.52% a.a.
  //   Prefixado→ taxa direta. Ex: 12.5 = 12.5% a.a.
  //   Selic    → percentual da Selic. Ex: 100 = 100% Selic = 10.75% a.a.
  let taxaAnual;
  const rate = inv.rate; // valor como digitado pelo usuário
  if (inv.index === 'CDI')       taxaAnual = (rate / 100) * _CDI_DYN;
  else if (inv.index === 'IPCA+') taxaAnual = IPCA_ATUAL + (rate / 100);
  else if (inv.index === 'Selic') taxaAnual = (rate / 100) * _SELIC_DYN;
  else                            taxaAnual = rate / 100; // Prefixado: direto

  // ── JUROS COMPOSTOS DIÁRIOS ──
  // diasDecorridos/diasTotais são dias CORRIDOS (calendário),
  // então o fator diário usa base 365 para consistência.
  // (Base 252 com dias corridos super-estima o rendimento ~7%.)
  const fatorDiario = Math.pow(1 + taxaAnual, 1 / 365);

  // Valor bruto acumulado até hoje
  const valorBrutoAtual     = inv.value * Math.pow(fatorDiario, diasDecorridos);
  // Valor bruto projetado no vencimento
  const valorBrutoVencimento = inv.value * Math.pow(fatorDiario, diasTotais);

  const rendimentoBruto      = valorBrutoAtual - inv.value;
  const rendimentoBrutoVenc  = valorBrutoVencimento - inv.value;

  // Rendimento do dia (diferença entre hoje e ontem)
  const rendHoje = valorBrutoAtual - inv.value * Math.pow(fatorDiario, diasDecorridos - 1);

  // ── PRODUTOS ISENTOS ──
  const isIsento = ['LCI','LCA','CRI','CRA','Poupança'].includes(inv.type);

  // ── IOF — Tabela regressiva IN SRF 1.585/2015 ──
  // Dias 1-29: alíquota regressiva. Dia 30+: isento.
  // LCI/LCA/CRI/CRA/Poupança também isentos de IOF.
  const tabIOF = [0,96,91,86,81,74,70,65,62,58,55,51,48,44,41,38,35,32,28,25,22,19,16,13,10,8,6,4,2,1,0];
  let iof = 0;
  if (!isIsento && diasDecorridos < 30) {
    const aliqIOF = (tabIOF[diasDecorridos] || 0) / 100;
    iof = rendimentoBruto * aliqIOF;
  }

  // Rendimento após IOF
  const rendLiqIOF = rendimentoBruto - iof;

  // ── IR — Tabela regressiva Lei 11.033/2004 ──
  // Aplica sobre rendimento LÍQUIDO de IOF
  // Isentos: LCI, LCA, CRI, CRA, Poupança
  let aliqIR;
  if      (diasDecorridos <= 180) aliqIR = 0.225;
  else if (diasDecorridos <= 360) aliqIR = 0.200;
  else if (diasDecorridos <= 720) aliqIR = 0.175;
  else                             aliqIR = 0.150;

  const ir = isIsento ? 0 : Math.max(0, rendLiqIOF * aliqIR);

  // ── VALORES FINAIS ──
  const valorLiquido = inv.value + rendLiqIOF - ir;
  const rendLiquido  = valorLiquido - inv.value;

  // ── PROJEÇÃO NO VENCIMENTO ──
  // IR no vencimento: prazo total determina a alíquota
  let aliqIRVenc;
  if      (diasTotais <= 180) aliqIRVenc = 0.225;
  else if (diasTotais <= 360) aliqIRVenc = 0.200;
  else if (diasTotais <= 720) aliqIRVenc = 0.175;
  else                         aliqIRVenc = 0.150;

  const irVenc = isIsento ? 0 : rendimentoBrutoVenc * aliqIRVenc;
  const projecaoVencLiq = inv.value + rendimentoBrutoVenc - irVenc;

  // ── RENTABILIDADE ACUMULADA ──
  const rentAcumuladaPct = ((valorBrutoAtual / inv.value) - 1) * 100;
  const rentLiqPct       = ((valorLiquido   / inv.value) - 1) * 100;

  // ── LABEL DA TAXA PARA EXIBIÇÃO ──
  let taxaLabel;
  if      (inv.index === 'CDI')    taxaLabel = `${rate}% do CDI (= ${(taxaAnual*100).toFixed(2)}% a.a.)`;
  else if (inv.index === 'IPCA+')  taxaLabel = `IPCA + ${rate}% (= ${(taxaAnual*100).toFixed(2)}% a.a.)`;
  else if (inv.index === 'Selic')  taxaLabel = `${rate}% da Selic (= ${(taxaAnual*100).toFixed(2)}% a.a.)`;
  else                              taxaLabel = `${rate}% a.a. (Prefixado)`;

  return {
    valorBrutoAtual, valorLiquido,
    rendimentoBruto, rendLiquido, rendHoje,
    iof, ir, aliqIR: isIsento ? 0 : aliqIR,
    isIsento, diasDecorridos, diasTotais,
    projecaoVencLiq, valorBrutoVencimento,
    taxaAnualEfetiva: taxaAnual * 100,
    taxaLabel, rentAcumuladaPct, rentLiqPct,
    fatorDiario,
    isPosFixado: (inv.index === 'CDI' || inv.index === 'Selic')
  };
}

function calcVariavelReturn(inv){
  const invested=inv.qty*inv.avgPrice;
  const current=inv.qty*(inv.currentPrice||inv.avgPrice);
  return {invested,current,gain:current-invested,gainPct:invested>0?((current/invested)-1)*100:0};
}

function calcInvTotals(){
  let totalInvested=0,totalCurrent=0,fixaTotal=0,acoesTotal=0,criptoTotal=0;
  (state.investments||[]).forEach(inv=>{
    if(inv.kind==='fixa'){
      const r=calcFixaReturn(inv);
      totalInvested+=inv.value; totalCurrent+=r.valorLiquido; fixaTotal+=r.valorLiquido;
    } else {
      const r=calcVariavelReturn(inv);
      totalInvested+=r.invested; totalCurrent+=r.current;
      if(inv.kind==='variavel') acoesTotal+=r.current;
      else criptoTotal+=r.current;
    }
  });
  return {totalInvested,totalCurrent,fixaTotal,acoesTotal,criptoTotal};
}

function updateInvHero(){
  const {totalInvested,totalCurrent,fixaTotal,acoesTotal,criptoTotal}=calcInvTotals();
  const result=totalCurrent-totalInvested;
  const pct=totalInvested>0?((result/totalInvested)*100).toFixed(2):'0.00';
  const s=result>=0?'+':'−';
  document.getElementById('inv-total').textContent='R$ '+fm(totalCurrent);
  document.getElementById('inv-invested').textContent='R$ '+fm(totalInvested);
  const rEl=document.getElementById('inv-result-hero');
  rEl.textContent=`Resultado líq: ${s}R$ ${fm(Math.abs(result))} (${s}${Math.abs(pct)}%)`;
  rEl.className=result>=0?'inv-hero-gain':'inv-hero-loss';
  document.getElementById('inv-renda-fixa-total').textContent='R$'+fm0(fixaTotal);
  document.getElementById('inv-acoes-total').textContent='R$'+fm0(acoesTotal);
  document.getElementById('inv-cripto-total').textContent='R$'+fm0(criptoTotal);
}

function riskDots(level,max=5){
  const colors={1:'fill-low',2:'fill-low',3:'fill-med',4:'fill-high',5:'fill-high'};
  var _dots=''; for(var _i=0;_i<max;_i++){_dots+='<div class="risk-dot '+((_i<level)?colors[level]:'')+'"></div>';} return _dots;
}
function riskLabel(l){ return ['','🟢 Baixo','🟡 Médio-Baixo','🟠 Médio','🔴 Alto','🔴 Muito Alto'][l]||''; }

function renderInvest(){
  updateInvHero();
  const tab=currentInvTab;
  const items=(state.investments||[]).filter(i=>i.kind===tab);
  const el=document.getElementById('inv-list');
  if(!items.length){ el.innerHTML='<div class="empty"><div class="empty-icon">📈</div>Nenhum investimento nesta categoria</div>'; return; }

  el.innerHTML=items.map(inv=>{
    if(inv.kind==='fixa'){
      const r=calcFixaReturn(inv);
      const pos=r.rendLiquido>=0;
      const diasRestantes=inv.end?Math.max(0,Math.floor((new Date(inv.end+'T00:00:00')-new Date())/86400000)):null;
      return `<div class="inv-item">
        <div class="inv-item-header">
          <div class="inv-item-icon" style="background:#eaf3ff">🏦</div>
          <div><div class="inv-item-name">${inv.name}</div><div class="inv-item-type">${inv.type} · ${r.taxaLabel}</div></div>
          <span class="inv-item-del" onclick="delInv('${inv.id}')">✕</span>
        </div>
        <div class="inv-grid">
          <div class="inv-cell"><div class="inv-cell-label">Aplicado</div><div class="inv-cell-val">R$ ${fm(inv.value)}</div></div>
          <div class="inv-cell"><div class="inv-cell-label">Bruto Atual</div><div class="inv-cell-val">R$ ${fm(r.valorBrutoAtual)}</div></div>
          <div class="inv-cell"><div class="inv-cell-label">Líquido Hoje</div><div class="inv-cell-val ${pos?'green':'red'}">R$ ${fm(r.valorLiquido)}</div></div>
          <div class="inv-cell"><div class="inv-cell-label">Rend. Líquido</div><div class="inv-cell-val ${pos?'green':'red'}">${pos?'+':'−'}R$ ${fm(Math.abs(r.rendLiquido))}</div></div>
          <div class="inv-cell"><div class="inv-cell-label">Ganho Hoje</div><div class="inv-cell-val green">+R$ ${fm(r.rendHoje)}</div></div>
          <div class="inv-cell"><div class="inv-cell-label">Rent. Bruta</div><div class="inv-cell-val green">+${r.rentAcumuladaPct.toFixed(2)}%</div></div>
          <div class="inv-cell"><div class="inv-cell-label">Rent. Líquida</div><div class="inv-cell-val ${pos?'green':'red'}">${r.rentLiqPct>=0?'+':''}${r.rentLiqPct.toFixed(2)}%</div></div>
          <div class="inv-cell"><div class="inv-cell-label">${diasRestantes!==null?diasRestantes+' dias p/ vencer':'Dias decorridos'}</div><div class="inv-cell-val" style="font-size:12px">${diasRestantes!==null?`Vence ${fmtDate(inv.end)}`:`${r.diasDecorridos}d`}</div></div>
        </div>
        <div class="tax-section">
          <div class="tax-title">📊 Impostos & Taxas</div>
          <div class="tax-row"><div class="tax-row-label">Taxa Contratada</div><div class="tax-row-val">${inv.rate}% ${inv.index}</div></div>
          <div class="tax-row"><div class="tax-row-label">Taxa Efetiva a.a.</div><div class="tax-row-val">${r.taxaAnualEfetiva.toFixed(4)}%</div></div>
          <div class="tax-row"><div class="tax-row-label">Fator Diário</div><div class="tax-row-val">${((r.fatorDiario-1)*100).toFixed(6)}%</div></div>
          <div class="tax-divider"></div>
          <div class="tax-row"><div class="tax-row-label">IOF ${r.diasDecorridos<30?'(dia '+r.diasDecorridos+' — '+Math.round((([0,96,91,86,81,74,70,65,62,58,55,51,48,44,41,38,35,32,28,25,22,19,16,13,10,8,6,4,2,1,0][r.diasDecorridos]||0)))+'%)':'(isento após 30d)'}</div><div class="tax-row-val red">${r.iof>0?'−R$ '+fm(r.iof):r.isIsento?'Isento ('+inv.type+')':'Isento'}</div></div>
          <div class="tax-row"><div class="tax-row-label">IR ${r.isIsento?'('+inv.type+' — Isento PF)':'('+r.diasDecorridos+'d → '+(r.aliqIR*100).toFixed(1)+'%)'}</div><div class="tax-row-val red">${r.ir>0?'−R$ '+fm(r.ir):r.isIsento?'Isento':'−R$ 0,00'}</div></div>
          <div class="tax-divider"></div>
          <div class="tax-row"><div class="tax-row-label" style="font-weight:800;color:var(--ink)">Valor Líquido Final</div><div class="tax-row-val green">R$ ${fm(r.valorLiquido)}</div></div>
          ${inv.end?`<div class="tax-row"><div class="tax-row-label">Projeção no Vencimento</div><div class="tax-row-val green">R$ ${fm(r.projecaoVencLiq)}</div></div>${r.isPosFixado?`<div style="font-size:10px;color:var(--orange);margin-top:6px;line-height:1.4">⚠️ Estimativa baseada na taxa atual. Por ser pós-fixado, o valor final varia conforme ${inv.index} futuro.</div>`:''}`:''}
        </div>
        <div class="risk-bar"><div class="risk-label">Risco:</div><div class="risk-dots">${riskDots(inv.risk)}</div><span style="font-size:11px;font-weight:700;color:var(--ink2);margin-left:6px">${riskLabel(inv.risk)}</span></div>
      </div>`;
    } else {
      const r=calcVariavelReturn(inv);
      const pos=r.gain>=0;
      const isCripto=inv.kind==='cripto';
      const lastUpd=(quotesCache[inv.ticker]?quotesCache[inv.ticker].time:null)||null;
      return `<div class="inv-item">
        <div class="inv-item-header">
          <div class="inv-item-icon" style="background:${isCripto?'#fff8e0':'#eaf3ff'}">${isCripto?'🪙':'📊'}</div>
          <div><div class="inv-item-name">${inv.ticker}</div><div class="inv-item-type">${isCripto?'Criptomoeda':'Ação B3'} · ${inv.qty} ${isCripto?'unid.':'cotas'}</div></div>
          <span class="inv-item-del" onclick="delInv('${inv.id}')">✕</span>
        </div>
        <div class="inv-grid">
          <div class="inv-cell"><div class="inv-cell-label">Preço Médio</div><div class="inv-cell-val">R$ ${fm(inv.avgPrice)}</div></div>
          <div class="inv-cell"><div class="inv-cell-label">Cotação Atual</div><div class="inv-cell-val ${pos?'green':'red'}">R$ ${fm(inv.currentPrice||inv.avgPrice)}</div></div>
          <div class="inv-cell"><div class="inv-cell-label">Total Investido</div><div class="inv-cell-val">R$ ${fm(r.invested)}</div></div>
          <div class="inv-cell"><div class="inv-cell-label">Valor Atual</div><div class="inv-cell-val ${pos?'green':'red'}">R$ ${fm(r.current)}</div></div>
          <div class="inv-cell"><div class="inv-cell-label">Resultado</div><div class="inv-cell-val ${pos?'green':'red'}">${pos?'+':'−'}R$ ${fm(Math.abs(r.gain))}</div></div>
          <div class="inv-cell"><div class="inv-cell-label">Rentabilidade</div><div class="inv-cell-val ${pos?'green':'red'}">${pos?'+':''}${r.gainPct.toFixed(2)}%</div></div>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px;flex-wrap:wrap">
          <div class="risk-bar" style="margin:0"><div class="risk-label">Risco:</div><div class="risk-dots">${riskDots(inv.risk)}</div><span style="font-size:11px;font-weight:700;color:var(--ink2);margin-left:6px">${riskLabel(inv.risk)}</span></div>
          <button class="btn btn-ghost" style="padding:6px 14px;font-size:10px;width:auto" onclick="fetchQuoteSingle('${inv.id}')">↻ Atualizar</button>
        </div>
        ${lastUpd?`<div class="quote-upd">Última cotação: ${lastUpd}</div>`:''}
      </div>`;
    }
  }).join('');
}

// ── QUOTES ──
async function fetchQuote(inv){
  try{
    if(inv.kind==='variavel'){
      const r=await fetch(`https://brapi.dev/api/quote/${inv.ticker}?token=demo`);
      if(!r.ok) throw new Error();
      const d=await r.json();
      const price=(d&&d.results&&d.results[0])?d.results[0].regularMarketPrice:undefined;
      if(price){ inv.currentPrice=price; quotesCache[inv.ticker]={price,time:new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}; save(); renderInvest(); updateInvHero(); updateHome(); }
    } else if(inv.kind==='cripto'){
      const idMap={BTC:'bitcoin',ETH:'ethereum',SOL:'solana',BNB:'binancecoin',ADA:'cardano',XRP:'ripple',MATIC:'matic-network',DOT:'polkadot',DOGE:'dogecoin',AVAX:'avalanche-2',LINK:'chainlink',LTC:'litecoin',USDT:'tether',USDC:'usd-coin'};
      const cgId=idMap[inv.ticker]||inv.ticker.toLowerCase();
      const r=await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${cgId}&vs_currencies=brl`);
      if(!r.ok) throw new Error();
      const d=await r.json();
      const price=(d&&d[cgId])?d[cgId].brl:undefined;
      if(price){ inv.currentPrice=price; quotesCache[inv.ticker]={price,time:new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}; save(); renderInvest(); updateInvHero(); updateHome(); }
    }
  }catch(e){ console.warn('Cotação indisponível',inv.ticker); }
}

async function fetchQuoteSingle(id){ const inv=state.investments.find(i=>i.id===id); if(inv){ toast('Buscando cotação...'); await fetchQuote(inv); } }
async function fetchAllQuotes(){ for(const inv of (state.investments||[]).filter(i=>i.kind!=='fixa')) await fetchQuote(inv); }

// ═══════════════════════════════════════
// AGENDA / ALARM
// ═══════════════════════════════════════
function addEvent(){
 try{
  var tEl=document.getElementById('evt-title');
  var dEl=document.getElementById('evt-date');
  var hEl=document.getElementById('evt-time');
  if(!tEl||!dEl||!hEl){ toast('Erro: formulário não encontrado'); return; }
  var title=tEl.value.trim();
  var date=dEl.value;
  var time=hEl.value;
  var remind=parseInt((document.getElementById('evt-remind')||{value:0}).value)||0;
  var color=(document.getElementById('evt-color')||{value:'#2d7dd2'}).value;
  if(!title){ toast('Preencha o título'); return; }
  if(!date){ toast('Preencha a data'); return; }
  if(!time){ toast('Preencha o horário'); return; }
  state.events.push({id:uid(),title:title,date:date,time:time,color:color,remind:remind});
  save(); updateHome();
  tEl.value='';
  if(_agendaView==='calendar'){
    renderCalendar();
    if(_calSelectedDay===date) calSelectDay(date);
  } else {
    renderEvents();
  }
  toast('\u2713 Evento adicionado!');
  try{ syncEventsToGroup(); }catch(e){}
 }catch(err){ toast('Erro ao adicionar: '+err.message); }
}


function calAddEventOnDay(){
  // Open the quick event modal with the selected day pre-filled
  if(_calSelectedDay){
    openEventModal(_calSelectedDay);
  } else {
    // Scroll to the manual form
    var form = document.getElementById('add-event-form');
    if(form) form.scrollIntoView({behavior:'smooth', block:'start'});
  }
}
function renderEvents(){
  // Also refresh calendar if it's active
  if(_agendaView === 'calendar'){ try{ renderCalendar(); }catch(e){} return; }
  const el=document.getElementById('events-list');
  if(!el) return;
  const s=[...state.events].sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time));
  if(!s.length){ el.innerHTML='<div class="empty"><div class="empty-icon">📅</div>Nenhum evento</div>'; return; }
  el.innerHTML=s.map(e=>`<div class="event-item"><div class="event-time">${e.time}</div><div class="event-dot" style="background:${e.color}"></div><div class="event-info"><div class="event-title">${e.title}</div><div class="event-desc">${fmtDate(e.date)}${e.remind>0?' · ⏰ '+e.remind+'min':''}</div></div><span class="event-del" onclick="delEvent('${e.id}')">✕</span></div>`).join('');
}

function delEvent(id){ state.events=state.events.filter(e=>e.id!==id); save(); renderEvents(); updateHome(); toast('Evento removido'); }

function checkAlarms(){
  const now=new Date(), td=today(), cur=now.getHours()*60+now.getMinutes();
  state.events.forEach(e=>{
    if(e.date!==td) return;
    const [hh,mm]=e.time.split(':').map(Number), evMin=hh*60+mm;
    if(e.remind>0&&evMin-cur===e.remind&&!e._alerted){ e._alerted=true; save(); triggerAlarm(e.time,`${e.title} — em ${e.remind} min`); }
    if(evMin===cur&&!e._fired){ e._fired=true; save(); triggerAlarm(e.time,e.title); }
  });
}

function triggerAlarm(time,title){
  document.getElementById('alarm-time').textContent=time;
  document.getElementById('alarm-title-el').textContent=title;
  document.getElementById('alarm-overlay').classList.add('show');
  try{
    const ctx=new(window.AudioContext||window.webkitAudioContext)();
    [[880,0,.12],[1100,.15,.12],[880,.30,.12],[1100,.45,.12],[1320,.60,.25]].forEach(([f,s,d])=>{
      const o=ctx.createOscillator(),g=ctx.createGain();
      o.connect(g);g.connect(ctx.destination);o.frequency.value=f;o.type='sine';
      g.gain.setValueAtTime(.35,ctx.currentTime+s);g.gain.exponentialRampToValueAtTime(.001,ctx.currentTime+s+d);
      o.start(ctx.currentTime+s);o.stop(ctx.currentTime+s+d+.01);
    });
  }catch(e){}
  let f=0;const fl=setInterval(()=>{ document.body.style.background=f%2===0?'#ffe0e0':'var(--bg)';if(++f>=8){clearInterval(fl);document.body.style.background='';} },250);
}

function dismissAlarm(){ document.getElementById('alarm-overlay').classList.remove('show'); }

// ═══════════════════════════════════════
// INDEXADORES — API Banco Central
// ═══════════════════════════════════════
let indexadores = { cdi:null, selic:null, ipca:null, igpm:null, lastFetch:null };
let _CDI_DYN   = CDI_ATUAL;
let _SELIC_DYN = SELIC_ATUAL;

async function fetchIndexadores(){
  try {
    // Séries SGS Banco Central — corretas e atualizadas:
    // 12    = CDI Over diário (% a.d.) — mais preciso, anualiza-se via 252 d.u.
    // 432   = Selic Meta (% a.a.) — definida pelo COPOM
    // 13522 = IPCA acumulado 12 meses (% a.a.)
    // 189   = IGP-M acumulado 12 meses (% a.a.)
    var reqs = [
      fetch('https://api.bcb.gov.br/dados/serie/bcdata.sgs.12/dados/ultimos/1?formato=json'),
      fetch('https://api.bcb.gov.br/dados/serie/bcdata.sgs.432/dados/ultimos/1?formato=json'),
      fetch('https://api.bcb.gov.br/dados/serie/bcdata.sgs.13522/dados/ultimos/1?formato=json'),
      fetch('https://api.bcb.gov.br/dados/serie/bcdata.sgs.189/dados/ultimos/1?formato=json')
    ];
    var responses = await Promise.all(reqs);
    var data = await Promise.all(responses.map(function(r){ return r.json(); }));
    var dCDI = data[0], dSelic = data[1], dIPCA = data[2], dIGPM = data[3];

    // CDI Over diário → anualizar: (1 + taxa_diaria/100)^252 - 1
    var cdiDiario = parseFloat((dCDI[0] ? dCDI[0].valor : 0) || 0);
    var cdiAnual = (Math.pow(1 + cdiDiario/100, 252) - 1) * 100;

    indexadores.cdi   = cdiAnual.toFixed(2);
    indexadores.selic = parseFloat((dSelic[0] ? dSelic[0].valor : 0) || 0).toFixed(2);
    indexadores.ipca  = parseFloat((dIPCA[0]  ? dIPCA[0].valor  : 0) || 0).toFixed(2);
    indexadores.igpm  = parseFloat((dIGPM[0]  ? dIGPM[0].valor  : 0) || 0).toFixed(2);
    indexadores.lastFetch = new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});

    // Fetch PTAX separately and store
    fetchPTAXForInvest();

    // Atualiza variáveis dinâmicas para cálculo de rentabilidade
    _CDI_DYN   = cdiAnual / 100 || CDI_ATUAL;
    _SELIC_DYN = parseFloat(indexadores.selic) / 100 || SELIC_ATUAL;

    renderIndexadores();
    renderInvest();
    toast('✓ Indexadores atualizados — Banco Central!');
  } catch(e) {
    console.warn('API BCB indisponível, usando valores de referência.');
    renderIndexadores();
  }
}

function renderIndexadores(){
  var el = document.getElementById('inv-indexadores');
  if(!el) return;
  var cdi   = indexadores.cdi   || (CDI_ATUAL*100).toFixed(2);
  var selic = indexadores.selic || (SELIC_ATUAL*100).toFixed(2);
  var ipca  = indexadores.ipca  || (IPCA_ATUAL*100).toFixed(2);
  var ptax  = indexadores.ptax  || '—';
  var upd   = indexadores.lastFetch || 'referência BCB';
  el.innerHTML = '<div class="idx-panel">'
    + '<div class="idx-title">📊 Indexadores de Mercado <button class="idx-refresh" onclick="fetchIndexadores()">↻ Atualizar</button></div>'
    + '<div class="idx-grid" style="grid-template-columns:repeat(4,1fr)">'
    + '<div class="idx-box"><div class="idx-name">CDI</div><div class="idx-val">'+cdi+'%</div><div class="idx-period">a.a.</div></div>'
    + '<div class="idx-box"><div class="idx-name">SELIC</div><div class="idx-val">'+selic+'%</div><div class="idx-period">meta</div></div>'
    + '<div class="idx-box"><div class="idx-name">IPCA</div><div class="idx-val">'+ipca+'%</div><div class="idx-period">12m</div></div>'
    + '<div class="idx-box"><div class="idx-name">USD</div><div class="idx-val">'+(ptax==='—'?'—':'R$'+ptax)+'</div><div class="idx-period">PTAX</div></div>'
    + '</div>'
    + '<div style="font-size:9px;color:rgba(255,255,255,.4);margin-top:8px;text-align:right">Fonte: Banco Central do Brasil · '+upd+'</div>'
    + '</div>';
}

// ═══════════════════════════════════════
// BILLS — ENHANCED
// ═══════════════════════════════════════
let currentBillTab = 'avulsa';

function switchBillTab(tab){
  currentBillTab = tab;
  ['avulsa','fixa','financ'].forEach(t=>{
    document.getElementById('btab-'+t).classList.toggle('active', t===tab);
    document.getElementById('bform-'+t).style.display = t===tab?'block':'none';
  });
  const labels = {avulsa:'Contas Avulsas Pendentes', fixa:'Contas Fixas / Recorrentes', financ:'Financiamentos & Empréstimos'};
  document.getElementById('bills-list-title').textContent = labels[tab];
  renderBills();
}
function switchReportTab(tab){
  var panels={relatorios:'rpanel-relatorios',dashboard:'rpanel-dashboard'};
  var btns={relatorios:'rtab-relatorios',dashboard:'rtab-dashboard'};
  Object.keys(panels).forEach(function(k){
    var p=document.getElementById(panels[k]);
    var b=document.getElementById(btns[k]);
    if(p) p.style.display=k===tab?'block':'none';
    if(b){ if(k===tab){b.classList.add('active');}else{b.classList.remove('active');} }
  });
  if(tab==='dashboard') renderDashboard();
}
function switchFinanceTab(tab){
  var panels={extrato:'finpanel-extrato',analise:'finpanel-analise',contas:'finpanel-contas'};
  var btns={extrato:'fintab-extrato',analise:'fintab-analise',contas:'fintab-contas'};
  Object.keys(panels).forEach(function(k){
    var p=document.getElementById(panels[k]);
    var b=document.getElementById(btns[k]);
    if(p) p.style.display=k===tab?'block':'none';
    if(b){ if(k===tab){b.classList.add('active');}else{b.classList.remove('active');} }
  });
  if(tab==='contas'){ try{ renderBills(); }catch(e){} }
  if(tab==='analise'){ try{ renderFinance(); }catch(e){} }
}

function toggleTxForm(){
  var w=document.getElementById('tx-form-wrap');
  var b=document.getElementById('tx-form-toggle-btn');
  if(!w) return;
  var isOpen=w.style.display!=='none';
  w.style.display=isOpen?'none':'block';
  if(b) b.textContent=isOpen?'+ Nova Movimenta\u00e7\u00e3o':'\u2212 Fechar formul\u00e1rio';
  if(!isOpen){
    setTimeout(function(){
      var d=document.getElementById('tx-desc');
      if(d) d.focus();
    },150);
  }
}



// ── ADD AVULSA ──
function addBillAvulsa(){
  const name   = document.getElementById('ba-name').value.trim();
  const value  = parseFloat(document.getElementById('ba-value').value);
  const due    = document.getElementById('ba-due').value;
  const cat    = document.getElementById('ba-cat').value;
  const status = document.getElementById('ba-status').value;
  if(!name||isNaN(value)||value<=0){ toast('Preencha nome e valor'); return; }
  state.bills.unshift({id:uid(), kind:'avulsa', name, value, due, cat, status, paid:false, createdAt:today()});
  save(); renderBills(); renderBillsSummary(); updateHome();
  document.getElementById('ba-name').value=''; document.getElementById('ba-value').value='';
  toast('✓ Conta adicionada!');
}

// ── ADD FIXA ──
function addBillFixa(){
  const name  = document.getElementById('bf-name').value.trim();
  const value = parseFloat(document.getElementById('bf-value').value);
  const day   = parseInt(document.getElementById('bf-day').value)||1;
  const cat   = document.getElementById('bf-cat').value;
  const recur = document.getElementById('bf-recur').value;
  if(!name||isNaN(value)||value<=0){ toast('Preencha nome e valor'); return; }
  state.bills.unshift({id:uid(), kind:'fixa', name, value, day, cat, recur, active:true, createdAt:today()});
  save(); renderBills(); renderBillsSummary(); updateHome();
  document.getElementById('bf-name').value=''; document.getElementById('bf-value').value='';
  toast('✓ Conta fixa adicionada!');
}

// ── ADD FINANCIAMENTO ──
function addBillFinanc(){
  const icon      = document.getElementById('bf2-icon').value.trim()||'🏠';
  const name      = document.getElementById('bf2-name').value.trim();
  const type      = document.getElementById('bf2-type').value;
  const total     = parseFloat(document.getElementById('bf2-total').value);
  const paid      = parseFloat(document.getElementById('bf2-paid').value)||0;
  const parcel    = parseFloat(document.getElementById('bf2-parcel').value);
  const remaining = parseInt(document.getElementById('bf2-remaining').value)||0;
  const rate      = parseFloat(document.getElementById('bf2-rate').value)||0;
  const due       = document.getElementById('bf2-due').value;
  const status    = document.getElementById('bf2-status').value;
  const obs       = document.getElementById('bf2-obs').value.trim();
  if(!name||isNaN(total)||total<=0){ toast('Preencha nome e valor total'); return; }
  state.bills.unshift({id:uid(), kind:'financ', icon, name, type, total, paid, parcel, remaining, rate, due, status, obs, createdAt:today()});
  save(); renderBills(); renderBillsSummary(); updateHome();
  ['bf2-name','bf2-total','bf2-paid','bf2-parcel','bf2-remaining','bf2-rate','bf2-obs'].forEach(id=>{ document.getElementById(id).value=''; });
  toast('✓ Financiamento adicionado!');
}

// ── PAY BILL ──
function payBill(id){
  const b=state.bills.find(b=>b.id===id);
  if(!b) return;
  if(b.kind==='financ'){
    b.paid = (b.paid||0) + (b.parcel||0);
    b.remaining = Math.max(0,(b.remaining||0)-1);
    if(b.remaining===0) b.status='quitado';
    state.transactions.unshift({id:uid(),desc:'Parcela — '+b.name,val:b.parcel||0,type:'out',cat:'moradia',date:today()});
  } else {
    b.paid=true;
    state.transactions.unshift({id:uid(),desc:b.name,val:b.value,type:'out',cat:b.cat||'outros',date:today()});
  }
  save(); renderBills(); renderBillsSummary(); renderFinance(); updateHome();
  toast('✓ Pagamento registrado no extrato!');
}

function toggleBillFixa(id){
  const b=state.bills.find(b=>b.id===id);
  if(b){ b.active=!b.active; save(); renderBills(); toast(b.active?'Conta ativada':'Conta pausada'); }
}

function updateBillStatus(id,status){
  const b=state.bills.find(b=>b.id===id);
  if(b){ b.status=status; save(); renderBills(); renderBillsSummary(); toast('Status atualizado'); }
}

function delBill(id){ state.bills=state.bills.filter(b=>b.id!==id); save(); renderBills(); renderBillsSummary(); updateHome(); toast('Removida'); }

// ── SUMMARY ──
function renderBillsSummary(){
  const el=document.getElementById('bills-summary-wrap'); if(!el) return;
  const avulsas   = (state.bills||[]).filter(b=>b.kind==='avulsa'&&!b.paid);
  const fixas     = (state.bills||[]).filter(b=>b.kind==='fixa'&&b.active);
  const financs   = (state.bills||[]).filter(b=>b.kind==='financ'&&b.status!=='quitado');
  const atrasadas = [...avulsas.filter(b=>b.status==='atrasada'||( b.due&&b.due<today())), ...financs.filter(b=>b.status==='atrasado')];
  const totalAvulsa  = avulsas.reduce((s,b)=>s+b.value,0);
  const totalFixa    = fixas.reduce((s,b)=>s+b.value,0);
  const totalFinanc  = financs.reduce((s,b)=>s+(b.parcel||0),0);
  const totalAtraso  = atrasadas.reduce((s,b)=>s+(b.value||b.parcel||0),0);
  const hasAtraso    = atrasadas.length>0;
  el.innerHTML=`
    <div class="bills-summary ${hasAtraso?'danger':'ok'}">
      <div class="bs-title">${hasAtraso?'⚠️ Atenção — Contas em Atraso':'✅ Situação das Contas'}</div>
      <div class="bs-grid">
        <div class="bs-box"><div class="bs-val orange">R$${fm0(totalAvulsa)}</div><div class="bs-label">Avulsas</div></div>
        <div class="bs-box"><div class="bs-val" style="color:var(--sky)">R$${fm0(totalFixa)}</div><div class="bs-label">Fixas/mês</div></div>
        <div class="bs-box"><div class="bs-val" style="color:#8b5cf6">R$${fm0(totalFinanc)}</div><div class="bs-label">Parcelas</div></div>
      </div>
      ${hasAtraso?`<div style="margin-top:10px;padding:10px;background:rgba(224,66,45,.1);border-radius:var(--r);text-align:center"><span style="font-size:12px;font-weight:800;color:var(--red)">⚠️ ${atrasadas.length} conta${atrasadas.length>1?'s':''} em atraso · R$ ${fm(totalAtraso)}</span></div>`:''}
    </div>`;
}

// ── RENDER BILLS ──
const statusLabels = {
  emdia:'✅ Em Dia', atrasado:'🔴 Atrasado', negociacao:'🔵 Em Negociação',
  resolver:'⚠️ Falta Resolver', renegociado:'🟣 Renegociado', quitado:'🏆 Quitado',
  pendente:'🟡 Pendente', atrasada:'🔴 Atrasada'
};

function renderBills(){
  const el=document.getElementById('bills-list');
  const tab=currentBillTab;
  let items=[];
  if(tab==='avulsa')  items=(state.bills||[]).filter(b=>b.kind==='avulsa'&&!b.paid);
  if(tab==='fixa')    items=(state.bills||[]).filter(b=>b.kind==='fixa');
  if(tab==='financ')  items=(state.bills||[]).filter(b=>b.kind==='financ');

  if(!items.length){
    el.innerHTML=`<div class="empty"><div class="empty-icon">${tab==='financ'?'🏦':tab==='fixa'?'🔄':'✅'}</div>${tab==='financ'?'Nenhum financiamento':tab==='fixa'?'Nenhuma conta fixa':'Nenhuma conta pendente'}</div>`;
    return;
  }

  el.innerHTML = items.map(b=>{
    const ci=getCatInfo(b.cat||'outros');
    const statusKey = b.status||'pendente';
    const statusClass = 'status-'+(statusKey==='atrasada'?'atrasado':statusKey);
    const isOverdue = b.due&&b.due<today()&&b.status!=='quitado';

    if(b.kind==='avulsa'){
      return `<div class="bill-card ${isOverdue||b.status==='atrasada'?'atrasada':b.status==='negociacao'?'negociacao':b.status==='resolver'?'resolver':''}">
        <div class="bill-card-header">
          <div class="bill-card-icon" style="background:${ci.color}20">${ci.icon}</div>
          <div><div class="bill-card-name">${b.name}</div><div class="bill-card-sub">${b.due?'Vence '+fmtDate(b.due):'Sem data'}</div></div>
          <span class="bill-card-del" onclick="delBill('${b.id}')">✕</span>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <span class="bill-status-badge ${statusClass}">${statusLabels[statusKey]||statusKey}</span>
          <div style="font-size:18px;font-weight:900;color:var(--red);font-family:var(--font-mono)">R$ ${fm(b.value)}</div>
        </div>
        <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">
          <button class="btn btn-green" style="padding:8px 14px;font-size:10px;flex:1" onclick="payBill('${b.id}')">✓ Pagar</button>
          <select onchange="updateBillStatus('${b.id}',this.value)" style="flex:1;font-size:11px;padding:8px;border-radius:100px">
            <option value="pendente" ${statusKey==='pendente'?'selected':''}>🟡 Pendente</option>
            <option value="atrasada" ${statusKey==='atrasada'?'selected':''}>🔴 Atrasada</option>
            <option value="negociacao" ${statusKey==='negociacao'?'selected':''}>🔵 Negociação</option>
            <option value="resolver" ${statusKey==='resolver'?'selected':''}>⚠️ Falta Resolver</option>
          </select>
        </div>
      </div>`;
    }

    if(b.kind==='fixa'){
      return `<div class="bill-card ${!b.active?'':''}">
        <div class="bill-card-header">
          <div class="bill-card-icon" style="background:${ci.color}20">${ci.icon}</div>
          <div><div class="bill-card-name">${b.name}</div><div class="bill-card-sub">${b.recur} · dia ${b.day}</div></div>
          <span class="bill-card-del" onclick="delBill('${b.id}')">✕</span>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span class="bill-status-badge ${b.active?'status-emdia':'status-resolver'}">${b.active?'✅ Ativa':'⏸ Pausada'}</span>
          <div style="font-size:18px;font-weight:900;color:var(--sky);font-family:var(--font-mono)">R$ ${fm(b.value)}</div>
        </div>
        <div style="display:flex;gap:6px;margin-top:10px">
          <button class="btn btn-ghost" style="padding:8px;font-size:10px;flex:1" onclick="toggleBillFixa('${b.id}')">${b.active?'⏸ Pausar':'▶ Ativar'}</button>
          <button class="btn btn-green" style="padding:8px;font-size:10px;flex:1" onclick="payBill('${b.id}')">✓ Pagar mês</button>
        </div>
      </div>`;
    }

    if(b.kind==='financ'){
      const paidPct = b.total>0 ? Math.min(100,((b.paid||0)/b.total)*100) : 0;
      const restante = b.total-(b.paid||0);
      const typeLabels = {imovel:'🏠 Imóvel',veiculo:'🚗 Veículo',pessoal:'💳 Pessoal',consignado:'📋 Consignado',estudantil:'📚 Estudantil',empresa:'🏢 Empresa',outro:'◈ Outro'};
      return `<div class="bill-card ${b.status==='atrasado'?'atrasada':b.status==='negociacao'?'negociacao':b.status==='resolver'?'resolver':''}">
        <div class="bill-card-header">
          <div class="bill-card-icon" style="background:#eaf3ff;font-size:22px">${b.icon||'🏦'}</div>
          <div><div class="bill-card-name">${b.name}</div><div class="bill-card-sub">${typeLabels[b.type]||b.type}${b.rate?' · '+b.rate+'% a.a.':''}</div></div>
          <span class="bill-card-del" onclick="delBill('${b.id}')">✕</span>
        </div>
        <span class="bill-status-badge status-${b.status==='atrasado'?'atrasado':b.status==='negociacao'?'negociacao':b.status==='resolver'?'resolver':b.status==='renegociado'?'renegociado':b.status==='quitado'?'quitado':'emdia'}">${statusLabels[b.status]||b.status}</span>
        <div class="financ-progress">
          <div class="financ-labels"><span>Pago: R$${fm0(b.paid||0)}</span><span>${paidPct.toFixed(1)}%</span><span>Total: R$${fm0(b.total)}</span></div>
          <div class="progress-bar"><div class="progress-fill" style="width:${paidPct}%${b.status==='quitado'?';background:var(--green)':''}"></div></div>
        </div>
        <div class="financ-grid">
          <div class="financ-cell"><div class="financ-cell-label">Parcela</div><div class="financ-cell-val">R$ ${fm(b.parcel||0)}</div></div>
          <div class="financ-cell"><div class="financ-cell-label">Restam</div><div class="financ-cell-val">${b.remaining||0}x</div></div>
          <div class="financ-cell"><div class="financ-cell-label">Saldo Dev.</div><div class="financ-cell-val" style="color:var(--red)">R$${fm0(restante)}</div></div>
          <div class="financ-cell"><div class="financ-cell-label">Próx. Venc.</div><div class="financ-cell-val" style="font-size:11px">${b.due?fmtDate(b.due):'—'}</div></div>
        </div>
        ${b.obs?`<div class="financ-obs">📝 ${b.obs}</div>`:''}
        <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">
          ${b.status!=='quitado'?`<button class="btn btn-green" style="padding:8px 14px;font-size:10px;flex:1" onclick="payBill('${b.id}')">✓ Pagar Parcela</button>`:''}
          <select onchange="updateBillStatus('${b.id}',this.value)" style="flex:1;font-size:11px;padding:8px;border-radius:100px">
            <option value="emdia"      ${b.status==='emdia'?'selected':''}>✅ Em Dia</option>
            <option value="atrasado"   ${b.status==='atrasado'?'selected':''}>🔴 Atrasado</option>
            <option value="negociacao" ${b.status==='negociacao'?'selected':''}>🔵 Negociação</option>
            <option value="resolver"   ${b.status==='resolver'?'selected':''}>⚠️ Falta Resolver</option>
            <option value="renegociado"${b.status==='renegociado'?'selected':''}>🟣 Renegociado</option>
            <option value="quitado"    ${b.status==='quitado'?'selected':''}>🏆 Quitado</option>
          </select>
        </div>
      </div>`;
    }
    return '';
  }).join('');
}

// ═══════════════════════════════════════
// NOTES
// ═══════════════════════════════════════
function addNote(){
  const title=document.getElementById('note-title-input').value.trim();
  const body=document.getElementById('note-body-input').value.trim();
  if(!title&&!body){ toast('Escreva algo'); return; }
  _ensureFolders();
  var folderId=_currentFolder||'default';
  state.notes.unshift({id:uid(),title:title||'Sem t\u00edtulo',body:body,date:new Date().toISOString(),folderId:folderId});
  save(); renderNotes();
  document.getElementById('note-title-input').value='';
  document.getElementById('note-body-input').value='';
  var fb=document.getElementById('note-form-body');
  var ft=document.getElementById('note-form-toggle');
  if(fb) fb.style.display='none';
  if(ft) ft.textContent='+';
  toast('\u2713 Nota salva!');
}

// ── NOTES with FOLDERS ──
var _currentFolder = null;
var FOLDER_COLORS = ['#2d7dd2','#18a058','#e07d2d','#8b5cf6','#e0422d','#0ea5a5','#d4af37','#64748b'];

function _ensureFolders(){
  if(!Array.isArray(state.noteFolders)) state.noteFolders = [];
  // Guarantee the default "Geral" folder exists, without removing others
  if(!state.noteFolders.some(function(f){return f.id==='default';})){
    state.noteFolders.unshift({id:'default',name:'Geral',color:'#2d7dd2'});
  }
  // Migrate old notes without folder
  (state.notes||[]).forEach(function(n){
    if(!n.folderId) n.folderId='default';
  });
}

function openNewFolderPrompt(){
  var name=prompt('Nome da nova pasta:');
  if(!name||!name.trim()) return;
  _ensureFolders();
  var color=FOLDER_COLORS[state.noteFolders.length % FOLDER_COLORS.length];
  state.noteFolders.push({id:uid(),name:name.trim(),color:color});
  save(); renderNotes();
  toast('\u2713 Pasta "'+name.trim()+'" criada!');
}

function delFolder(folderId){
  if(folderId==='default'){ toast('A pasta Geral n\u00e3o pode ser exclu\u00edda'); return; }
  var notesInFolder=(state.notes||[]).filter(function(n){return n.folderId===folderId;}).length;
  var msg=notesInFolder>0
    ? 'Esta pasta tem '+notesInFolder+' nota(s). Elas ser\u00e3o movidas para Geral. Excluir?'
    : 'Excluir esta pasta?';
  if(!confirm(msg)) return;
  (state.notes||[]).forEach(function(n){ if(n.folderId===folderId) n.folderId='default'; });
  state.noteFolders=state.noteFolders.filter(function(f){return f.id!==folderId;});
  if(_currentFolder===folderId) _currentFolder=null;
  save(); renderNotes();
  toast('Pasta exclu\u00edda');
}

function openFolder(folderId){
  _currentFolder=folderId;
  renderNotes();
}

function closeFolderView(){
  _currentFolder=null;
  renderNotes();
}

function toggleNoteForm(){
  var b=document.getElementById('note-form-body');
  var t=document.getElementById('note-form-toggle');
  if(!b) return;
  var isOpen=b.style.display!=='none';
  b.style.display=isOpen?'none':'block';
  if(t) t.textContent=isOpen?'+':'\u2212';
  if(!isOpen){
    setTimeout(function(){var i=document.getElementById('note-title-input');if(i)i.focus();},150);
  }
}

function renderNotes(){
  _ensureFolders();
  var grid=document.getElementById('notes-folders-grid');
  var folderView=document.getElementById('notes-folder-view');
  var breadcrumb=document.getElementById('notes-breadcrumb');
  var newFolderBtn=document.getElementById('new-folder-btn');
  if(!grid) return;

  if(_currentFolder){
    // Inside a folder
    var folder=state.noteFolders.find(function(f){return f.id===_currentFolder;});
    if(!folder){ _currentFolder=null; renderNotes(); return; }
    grid.style.display='none';
    if(folderView) folderView.style.display='block';
    if(breadcrumb) breadcrumb.textContent=folder.name;
    if(newFolderBtn) newFolderBtn.style.display='none';

    var el=document.getElementById('notes-list');
    if(!el) return;
    var notes=(state.notes||[]).filter(function(n){return n.folderId===_currentFolder;});
    if(!notes.length){
      el.innerHTML='<div class="empty"><div class="empty-icon">\u{1F4DD}</div>Nenhuma nota nesta pasta</div>';
      return;
    }
    el.innerHTML=notes.map(function(n){
      var preview=n.body?n.body.slice(0,80)+(n.body.length>80?'\u2026':''):'';
      return '<div class="note-item" data-nid="'+n.id+'" onclick="openNote(this.dataset.nid)">'
        +'<div class="note-head">'
        +'<div class="note-title-disp">'+n.title+'</div>'
        +'<div style="display:flex;align-items:center;gap:10px">'
        +'<span class="note-copy" data-nid="'+n.id+'" onclick="event.stopPropagation();copyNoteById(this.dataset.nid)" title="Copiar" style="cursor:pointer;color:var(--sky);display:inline-flex">'
        +'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
        +'</span>'
        +'<span class="note-del" data-nid="'+n.id+'" onclick="event.stopPropagation();delNote(this.dataset.nid)">\u2715</span>'
        +'</div>'
        +'</div>'
        +(preview?'<div class="note-preview">'+preview+'</div>':'')
        +'<div class="note-date">'+new Date(n.date).toLocaleDateString('pt-BR')+'</div>'
        +'</div>';
    }).join('');
  } else {
    // Folders grid view
    grid.style.display='grid';
    if(folderView) folderView.style.display='none';
    if(breadcrumb) breadcrumb.textContent='Pastas';
    if(newFolderBtn) newFolderBtn.style.display='block';

    grid.innerHTML=state.noteFolders.map(function(f){
      var count=(state.notes||[]).filter(function(n){return n.folderId===f.id;}).length;
      var delBtn=f.id!=='default'
        ?'<span style="position:absolute;top:8px;right:10px;cursor:pointer;color:var(--ink3);font-size:14px" data-fid="'+f.id+'" onclick="event.stopPropagation();delFolder(this.dataset.fid)">\u2715</span>'
        :'';
      return '<div data-fid="'+f.id+'" onclick="openFolder(this.dataset.fid)" style="position:relative;background:var(--white);border:1.5px solid var(--border);border-radius:16px;padding:16px;cursor:pointer;transition:transform .15s" ontouchstart="this.style.transform=\'scale(.97)\'" ontouchend="this.style.transform=\'\'">'
        +delBtn
        +'<div style="width:42px;height:42px;border-radius:12px;background:'+f.color+'22;display:flex;align-items:center;justify-content:center;margin-bottom:10px">'
        +'<svg width="22" height="22" viewBox="0 0 24 24" fill="'+f.color+'"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>'
        +'</div>'
        +'<div style="font-size:13px;font-weight:800;color:var(--ink)">'+f.name+'</div>'
        +'<div style="font-size:10px;font-weight:600;color:var(--ink3);margin-top:2px">'+count+' nota'+(count!==1?'s':'')+'</div>'
        +'</div>';
    }).join('');
  }
}

function openNote(id){ const n=state.notes.find(n=>n.id===id); if(!n) return; editingNoteId=id; document.getElementById('note-editor-title-field').value=n.title; document.getElementById('note-editor-body-field').value=n.body; document.getElementById('note-editor').classList.add('show'); }
function closeNoteEditor(){ document.getElementById('note-editor').classList.remove('show'); editingNoteId=null; }
function saveNoteEdit(){ const n=state.notes.find(n=>n.id===editingNoteId); if(!n) return; n.title=document.getElementById('note-editor-title-field').value||'Sem título'; n.body=document.getElementById('note-editor-body-field').value; n.date=new Date().toISOString(); save(); renderNotes(); closeNoteEditor(); toast('✓ Atualizada!'); }
function delNote(id){ state.notes=state.notes.filter(n=>n.id!==id); save(); renderNotes(); toast('Nota removida'); }

function copyNoteBody(){
  var t=document.getElementById('note-editor-title-field');
  var b=document.getElementById('note-editor-body-field');
  if(!b) return;
  var txt=((t&&t.value)?t.value+'\n\n':'')+(b.value||'');
  _copyText(txt.trim(), '✓ Nota copiada!');
}
// Copy a note directly from the list (by id)
function copyNoteById(id){
  var n=(state.notes||[]).find(function(x){return x.id===id;});
  if(!n) return;
  var txt=((n.title?n.title+'\n\n':'')+(n.body||'')).trim();
  _copyText(txt, '✓ Nota copiada!');
}
// Apply bullet/number prefixes to selected lines in the editor textarea
function noteListFormat(kind){
  var ta=document.getElementById('note-editor-body-field');
  if(!ta) return;
  var start=ta.selectionStart, end=ta.selectionEnd;
  var val=ta.value;
  // Expand selection to full lines
  var lineStart=val.lastIndexOf('\n',start-1)+1;
  var lineEnd=val.indexOf('\n',end); if(lineEnd===-1) lineEnd=val.length;
  var block=val.slice(lineStart,lineEnd);
  var lines=block.split('\n');
  var num=1;
  var formatted=lines.map(function(ln){
    var clean=ln.replace(/^\s*([•\-]|\d+\.)\s+/,''); // strip existing prefix
    if(clean.trim()==='') return clean;
    if(kind==='bullet') return '• '+clean;
    return (num++)+'. '+clean;
  }).join('\n');
  ta.value=val.slice(0,lineStart)+formatted+val.slice(lineEnd);
  ta.focus();
  ta.setSelectionRange(lineStart, lineStart+formatted.length);
}

// ═══════════════════════════════════════
// TASKS
// ═══════════════════════════════════════
// Eisenhower selection state (defaults: important + urgent)
var _taskSel = { importante:1, urgente:1 };
function segPick(group, val, btn){
  _taskSel[group]=val;
  var wrap=document.getElementById('seg-'+group);
  if(wrap){ wrap.querySelectorAll('button').forEach(function(b){ b.classList.remove('seg-on'); }); }
  btn.classList.add('seg-on');
}
function addTask(){
  const text=document.getElementById('task-input').value.trim();
  if(!text){ toast('Digite a tarefa'); return; }
  // Limite de 10 tarefas ativas no plano gratuito
  if(!isPremium){
    var activeTasks = state.tasks.filter(function(t){ return !t.done; });
    if(activeTasks.length >= PREMIUM_TASK_LIMIT){
      toast('Limite de '+PREMIUM_TASK_LIMIT+' tarefas no plano gratuito.');
      setTimeout(function(){ openPremiumModal(); }, 800);
      return;
    }
  }
  state.tasks.unshift({
    id:uid(), text:text, done:false,
    importante:_taskSel.importante, urgente:_taskSel.urgente
  });
  save(); renderTasks(); updateHome();
  document.getElementById('task-input').value='';
  toast('✓ Tarefa adicionada!');
}
function toggleTask(id){ const t=state.tasks.find(t=>t.id===id); if(t){ t.done=!t.done; save(); renderTasks(); updateHome(); } }
function delTask(id){ state.tasks=state.tasks.filter(t=>t.id!==id); save(); renderTasks(); updateHome(); toast('Tarefa removida'); }

// Map a task to one of the 4 quadrants (with migration for old tasks)
function _taskQuadrant(t){
  var imp = (t.importante!==undefined) ? t.importante : 1;
  var urg = (t.urgente!==undefined) ? t.urgente : 1;
  if(imp && urg) return 'q1';
  if(imp && !urg) return 'q2';
  if(!imp && urg) return 'q3';
  return 'q4';
}
function renderTasks(){
  const el=document.getElementById('eisenhower-grid');
  if(!el) return;
  const quads={
    q1:{title:'Fazer Agora', sub:'Importante · Urgente', cls:'q1', items:[]},
    q2:{title:'Agendar',     sub:'Importante · Não urgente', cls:'q2', items:[]},
    q3:{title:'Delegar',     sub:'Não importante · Urgente', cls:'q3', items:[]},
    q4:{title:'Eliminar',    sub:'Não importante · Não urgente', cls:'q4', items:[]}
  };
  (state.tasks||[]).forEach(function(t){ quads[_taskQuadrant(t)].items.push(t); });
  let html='';
  ['q1','q2','q3','q4'].forEach(function(key){
    const q=quads[key];
    // pending first, done last
    const sorted=q.items.slice().sort(function(a,b){ return (a.done?1:0)-(b.done?1:0); });
    let inner='';
    if(!sorted.length){ inner='<div class="eisen-empty">Vazio</div>'; }
    else { inner=sorted.map(function(t){
      return '<div class="eisen-task">'
        +'<div class="task-check '+(t.done?'done':'')+'" onclick="toggleTask(\''+t.id+'\')">'+(t.done?'✓':'')+'</div>'
        +'<div class="task-text '+(t.done?'done':'')+'" style="flex:1">'+t.text+'</div>'
        +'<span class="task-del" onclick="delTask(\''+t.id+'\')">✕</span>'
        +'</div>';
    }).join(''); }
    html+='<div class="eisen-quad '+q.cls+'">'
      +'<div class="eisen-quad-head">'
        +'<div><div class="eisen-quad-title">'+q.title+'</div><div class="eisen-quad-sub">'+q.sub+'</div></div>'
        +'<div class="eisen-quad-count">'+q.items.length+'</div>'
      +'</div>'+inner+'</div>';
  });
  el.innerHTML=html;
}

// ═══════════════════════════════════════
// VOICE
// ═══════════════════════════════════════
// toggleVoice unified below

function processVoice(cmd){
  const res=document.getElementById('voice-result');
  const saidaM=cmd.match(/(?:gastei|paguei|comprei|passei o cartão|cartão|pix de?|ted de?|transferi|enviei|mandei)\s+(?:r\$\s*)?(\d+(?:[,.]\d{1,2})?)\s*(?:reais?)?\s*(.*)?/);
  if(saidaM){ const val=parseFloat(saidaM[1].replace(',','.')); const descRaw=(saidaM[2]||'').trim()||'Despesa voz'; const cat=/pix|ted|transferi|enviei/.test(cmd)?'pix':detectCat(cmd+' '+descRaw); state.transactions.unshift({id:uid(),desc:descRaw,val,type:'out',cat,date:today()}); save(); renderFinance(); updateHome(); res.textContent=`✓ R$${fm(val)} em ${getCatInfo(cat).label}`; setTimeout(closeVoice,2000); return; }
  const entM=cmd.match(/(?:recebi|salário de?|ganhei)\s+(?:r\$\s*)?(\d+(?:[,.]\d{1,2})?)/);
  if(entM){ const val=parseFloat(entM[1].replace(',','.')); state.transactions.unshift({id:uid(),desc:'Entrada voz',val,type:'in',cat:'salario',date:today()}); save(); renderFinance(); updateHome(); res.textContent=`✓ Entrada R$${fm(val)}`; setTimeout(closeVoice,2000); return; }
  const evtM=cmd.match(/(.+?)\s+(?:amanhã|hoje)\s*(?:às?|as)\s*(\d{1,2})(?::(\d{2}))?/);
  if(evtM){ const title=evtM[1].trim(); const hh=evtM[2].padStart(2,'0'); const mm=(evtM[3]||'00').padStart(2,'0'); const d=new Date(); if(cmd.includes('amanhã')) d.setDate(d.getDate()+1); state.events.push({id:uid(),title,date:d.toISOString().slice(0,10),time:`${hh}:${mm}`,color:'#2d7dd2',remind:15}); save(); renderEvents(); updateHome(); res.textContent=`✓ Evento "${title}" às ${hh}:${mm}`; setTimeout(closeVoice,2000); return; }
  const tarM=cmd.match(/(?:tarefa|lembrar de?|fazer|preciso|anotar tarefa)\s+(.+)/);
  if(tarM){ const text=tarM[1].trim(); state.tasks.unshift({id:uid(),text,done:false,importante:1,urgente:0}); save(); renderTasks(); updateHome(); res.textContent=`✓ Tarefa: "${text}"`; setTimeout(closeVoice,2000); return; }
  const notaM=cmd.match(/(?:anotar|nota)\s+(.+)/);
  if(notaM){ state.notes.unshift({id:uid(),title:'Nota de voz',body:notaM[1].trim(),date:new Date().toISOString()}); save(); renderNotes(); res.textContent='✓ Nota salva'; setTimeout(closeVoice,2000); return; }
  const metaM=cmd.match(/(?:meta|objetivo)\s+(.+?)\s+(?:de?|r\$)?\s*(\d+(?:[,.]\d{1,2})?)/);
  if(metaM){ const name=metaM[1].trim(); const target=parseFloat(metaM[2].replace(',','.')); state.goals.push({id:uid(),emoji:'🎯',name,target,current:0,deadline:''}); save(); renderGoals(); res.textContent=`✓ Meta "${name}" R$${fm(target)}`; setTimeout(closeVoice,2000); return; }
  res.textContent='⚠ Comando não reconhecido';
}

function detectCat(text){
  const map={alimentacao:['mercado','supermercado','comida','restaurante','lanche','ifood','padaria','café','pizza','almoço','jantar'],transporte:['uber','99','taxi','gasolina','combustível','ônibus','estacionamento','pedágio','posto'],moradia:['aluguel','condomínio','iptu'],saude:['remédio','farmácia','médico','hospital','consulta','dentista','academia'],lazer:['cinema','show','bar','festa','viagem','hotel','netflix','spotify'],educacao:['curso','livro','escola','faculdade'],vestuario:['roupa','sapato','camisa','tênis'],servicos:['assinatura','plano','internet','celular'],pix:['pix','ted','transferência','transferi','enviei'],mercado:['extra','carrefour','atacadão']};
  var _mapKeys=Object.keys(map); for(var _mi=0;_mi<_mapKeys.length;_mi++){var _cat=_mapKeys[_mi]; var _kws=map[_cat]; if(_kws.some(function(kw){return text.includes(kw);})) return _cat;}
  return 'outros';
}

// ═══════════════════════════════════════
// BANKS DATALIST + RATE LABEL
// ═══════════════════════════════════════
function populateBankList(){
  const dl=document.getElementById('bank-list');
  if(dl) dl.innerHTML=BANKS.map(b=>`<option value="${b}">`).join('');
}

function updateRateLabel(){
  const idx=document.getElementById('fi-index').value;
  const lbl=document.getElementById('fi-rate-label');
  const inp=document.getElementById('fi-rate');
  if(idx==='CDI'){    lbl.textContent='% do CDI (ex: 110 = 110% CDI)'; inp.placeholder='Ex: 110'; }
  else if(idx==='IPCA+'){ lbl.textContent='Spread sobre IPCA (ex: 6 = IPCA+6%)'; inp.placeholder='Ex: 6'; }
  else if(idx==='Selic'){ lbl.textContent='% da Selic (ex: 100 = 100% Selic)'; inp.placeholder='Ex: 100'; }
  else {               lbl.textContent='Taxa Prefixada % a.a.'; inp.placeholder='Ex: 12.5'; }
  updateRatePreview();
}

function updateRatePreview(){
  const idx=document.getElementById('fi-index').value;
  const rate=parseFloat(document.getElementById('fi-rate').value);
  const prev=document.getElementById('fi-rate-preview');
  if(!prev||isNaN(rate)||rate<=0){ if(prev) prev.style.display='none'; return; }
  let efetiva, aviso='';
  if     (idx==='CDI')   { efetiva=(rate/100)*CDI_ATUAL*100; if(rate<50) aviso=' ⚠️ Taxa muito baixa! Quer dizer '+rate+'% ao ano? Use Prefixado.'; }
  else if(idx==='IPCA+') { efetiva=(IPCA_ATUAL+(rate/100))*100; }
  else if(idx==='Selic') { efetiva=(rate/100)*SELIC_ATUAL*100; }
  else                    { efetiva=rate; }
  prev.style.display='block';
  prev.innerHTML='📊 Taxa efetiva: <strong>'+efetiva.toFixed(4)+'% a.a.</strong> · Fator diário: <strong>'+((Math.pow(1+efetiva/100,1/365)-1)*100).toFixed(6)+'%</strong>'+aviso;
  prev.style.background = aviso ? '#fff3dc' : '#eaf3ff';
  prev.style.color = aviso ? 'var(--orange)' : 'var(--sky)';
}

// ═══════════════════════════════════════════════════════
// AGENDA — Calendar View (estilo Outlook/Gmail)
// ═══════════════════════════════════════════════════════
var _agendaView = 'list'; // 'list' or 'calendar'
var _calYear = new Date().getFullYear();
var _calMonth = new Date().getMonth(); // 0-indexed
var _calSelectedDay = null;

function setAgendaView(view){
  _agendaView = view;
  var calView  = document.getElementById('agenda-calendar');
  var listView = document.getElementById('events-list');
  var calBtn   = document.getElementById('cal-view-btn');
  var listBtn  = document.getElementById('list-view-btn');
  if(view === 'calendar'){
    if(calView)  calView.style.display  = 'block';
    if(listView) listView.style.display = 'none';
    if(calBtn){  calBtn.style.background=  'var(--sky)'; calBtn.style.color='#fff'; calBtn.style.borderColor='var(--sky)'; }
    if(listBtn){ listBtn.style.background= 'var(--bg)';  listBtn.style.color='var(--ink3)'; listBtn.style.borderColor='var(--border)'; }
    renderCalendar();
  } else {
    if(calView)  calView.style.display  = 'none';
    if(listView) listView.style.display = 'block';
    if(calBtn){  calBtn.style.background= 'var(--bg)';  calBtn.style.color='var(--ink3)'; calBtn.style.borderColor='var(--border)'; }
    if(listBtn){ listBtn.style.background='var(--sky)';  listBtn.style.color='#fff'; listBtn.style.borderColor='var(--sky)'; }
    renderEvents();
  }
  localStorage.setItem('claudio_agendaview', view);
}

function renderCalendar(){
  var monthNames = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
    'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  var label = document.getElementById('cal-month-label');
  if(label) label.textContent = monthNames[_calMonth] + ' ' + _calYear;

  var grid = document.getElementById('cal-grid');
  if(!grid) return;

  var firstDay = new Date(_calYear, _calMonth, 1).getDay(); // 0=Sun
  var daysInMonth = new Date(_calYear, _calMonth+1, 0).getDate();
  var daysInPrev  = new Date(_calYear, _calMonth, 0).getDate();
  var today = new Date();
  var todayStr = today.getFullYear()+'-'+String(today.getMonth()+1).padStart(2,'0')+'-'+String(today.getDate()).padStart(2,'0');

  // Build event date map
  var evMap = {};
  (state.events||[]).forEach(function(e){
    if(!evMap[e.date]) evMap[e.date] = [];
    evMap[e.date].push(e);
  });

  var cells = [];
  // Prev month days
  for(var i=0; i<firstDay; i++){
    var d = daysInPrev - firstDay + 1 + i;
    cells.push({day:d, month:'prev', date:null});
  }
  // Current month
  for(var d2=1; d2<=daysInMonth; d2++){
    var dateStr = _calYear+'-'+String(_calMonth+1).padStart(2,'0')+'-'+String(d2).padStart(2,'0');
    cells.push({day:d2, month:'cur', date:dateStr});
  }
  // Next month fill
  var remaining = 42 - cells.length;
  for(var i2=1; i2<=remaining; i2++){
    cells.push({day:i2, month:'next', date:null});
  }

  grid.innerHTML = cells.map(function(c){
    var cls = 'cal-day';
    if(c.month !== 'cur') cls += ' other-month';
    if(c.date === todayStr) cls += ' today';
    if(c.date === _calSelectedDay) cls += ' selected';
    if(c.date && evMap[c.date] && evMap[c.date].length) cls += ' has-events';
    var dots = '';
    if(c.date && evMap[c.date] && evMap[c.date].length){
      // Single dot in the color of the first event
      dots = '<div class="cal-event-dot" style="background:'+evMap[c.date][0].color+'"></div>';
    }
    var onclick = c.date ? 'calSelectDay(\''+c.date+'\')' : '';
    return '<div class="'+cls+'" onclick="'+onclick+'">'
      +'<span class="cal-day-num">'+c.day+'</span>'
      +dots
      +'</div>';
  }).join('');
}

function calSelectDay(dateStr){
  _calSelectedDay = dateStr;
  renderCalendar();
  // Show day panel
  var panel = document.getElementById('cal-day-panel');
  var title = document.getElementById('cal-day-title');
  var evList = document.getElementById('cal-day-events');
  if(!panel||!title||!evList) return;
  panel.style.display = 'block';
  // Format date
  var parts = dateStr.split('-');
  var dt = new Date(parseInt(parts[0]), parseInt(parts[1])-1, parseInt(parts[2]));
  var days = ['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];
  var months = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
  title.textContent = days[dt.getDay()]+', '+parseInt(parts[2])+' de '+months[parseInt(parts[1])-1]+' de '+parts[0];

  var dayEvts = (state.events||[]).filter(function(e){ return e.date === dateStr; })
    .sort(function(a,b){ return a.time.localeCompare(b.time); });

  if(!dayEvts.length){
    evList.innerHTML = '<div style="text-align:center;padding:12px 0">'
      +'<div style="font-size:12px;color:var(--ink3);margin-bottom:10px">Nenhum evento neste dia</div>'
      +'<button onclick="openEventModal(\''+dateStr+'\')" style="background:var(--sky);color:#fff;border:none;border-radius:20px;padding:8px 20px;font-size:12px;font-weight:700;cursor:pointer">+ Adicionar evento</button>'
      +'</div>';
  } else {
    evList.innerHTML = dayEvts.map(function(e){
      return '<div class="cal-day-event-item" style="border-left-color:'+e.color+'">'
        +'<span class="cal-day-event-time">'+e.time+'</span>'
        +'<span class="cal-day-event-title">'+e.title+'</span>'
        +'<span style="font-size:18px;cursor:pointer;color:var(--ink3)" onclick="deleteEvent(\''+e.id+'\')">×</span>'
        +'</div>';
    }).join('');
  }
  // Smooth scroll to panel
  setTimeout(function(){ panel.scrollIntoView({behavior:'smooth',block:'nearest'}); }, 100);
}

function deleteEvent(id){ delEvent(id); if(_calSelectedDay) setTimeout(function(){ calSelectDay(_calSelectedDay); },100); }

// ── Event Quick Modal (opened from calendar day) ──
function openEventModal(dateStr){
  var modal = document.getElementById('event-quick-modal');
  if(!modal){
    // Create modal on first use
    modal = document.createElement('div');
    modal.id = 'event-quick-modal';
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:400;background:rgba(13,31,60,.5);backdrop-filter:blur(8px);display:flex;align-items:flex-end;justify-content:center;padding:16px';
    modal.innerHTML = '<div style="background:var(--white);border-radius:24px 24px 16px 16px;padding:24px 20px;width:100%;max-width:480px;animation:slideUp .28s ease">'
      +'<div id="eqm-date-label" style="font-size:11px;font-weight:800;color:var(--sky);text-transform:uppercase;letter-spacing:.08em;margin-bottom:12px"></div>'
      +'<div style="font-size:16px;font-weight:900;color:var(--ink);margin-bottom:16px">Novo Evento</div>'
      +'<div class="form-group"><label>Título</label><input id="eqm-title" class="form-input" type="text" placeholder="Nome do evento"></div>'
      +'<div class="input-row">'
      +'<div><label>Data</label><input id="eqm-date" class="form-input" type="date"></div>'
      +'<div><label>Horário</label><input id="eqm-time" class="form-input" type="time" value="09:00"></div>'
      +'</div>'
      +'<div class="input-row">'
      +'<div><label>Cor</label><select id="eqm-color" class="form-input"><option value="#2d7dd2">🔵 Azul</option><option value="#18a058">🟢 Verde</option><option value="#e0422d">🔴 Vermelho</option><option value="#e07d1a">🟠 Laranja</option><option value="#8b5cf6">🟣 Roxo</option></select></div>'
      +'<div><label>Lembrete</label><select id="eqm-remind" class="form-input"><option value="0">Sem lembrete</option><option value="15">15 min antes</option><option value="30">30 min</option><option value="60">1 hora</option></select></div>'
      +'</div>'
      +'<div style="display:flex;gap:8px;margin-top:16px">'
      +'<button class="btn" onclick="submitEventModal()" style="flex:2">Adicionar</button>'
      +'<button class="btn btn-ghost" onclick="closeEventModal()" style="flex:1">Cancelar</button>'
      +'</div>'
      +'</div>';
    modal.addEventListener('click', function(e){ if(e.target===modal) closeEventModal(); });
    document.body.appendChild(modal);
  }
  // Pre-fill date
  var dateLabel = document.getElementById('eqm-date-label');
  var dateInput = document.getElementById('eqm-date');
  if(dateStr){
    if(dateInput) dateInput.value = dateStr;
    if(dateLabel){
      var parts = dateStr.split('-');
      var months = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
      dateLabel.textContent = parseInt(parts[2])+' de '+months[parseInt(parts[1])-1]+' de '+parts[0];
    }
  }
  var titleInput = document.getElementById('eqm-title');
  if(titleInput){ titleInput.value=''; setTimeout(function(){ titleInput.focus(); },300); }
  modal.style.display = 'flex';
}

function closeEventModal(){
  var modal = document.getElementById('event-quick-modal');
  if(modal) modal.style.display = 'none';
}

function submitEventModal(){
  var title  = document.getElementById('eqm-title').value.trim();
  var date   = document.getElementById('eqm-date').value;
  var time   = document.getElementById('eqm-time').value;
  var color  = document.getElementById('eqm-color').value;
  var remind = parseInt(document.getElementById('eqm-remind').value)||0;
  if(!title){ toast('Informe o título do evento'); return; }
  if(!date)  { toast('Informe a data'); return; }
  if(!time)  { toast('Informe o horário'); return; }
  state.events.push({id:uid(),title:title,date:date,time:time,color:color,remind:remind});
  save(); renderEvents(); updateHome();
  closeEventModal();
  // Refresh day panel if open
  if(_calSelectedDay === date) calSelectDay(date);
  toast('✓ Evento adicionado!');
}

function calPrevMonth(){
  _calMonth--;
  if(_calMonth < 0){ _calMonth = 11; _calYear--; }
  _calSelectedDay = null;
  var panel = document.getElementById('cal-day-panel');
  if(panel) panel.style.display = 'none';
  renderCalendar();
}

function calNextMonth(){
  _calMonth++;
  if(_calMonth > 11){ _calMonth = 0; _calYear++; }
  _calSelectedDay = null;
  var panel = document.getElementById('cal-day-panel');
  if(panel) panel.style.display = 'none';
  renderCalendar();
}
// ── Chat IA flutuante (substitui o antigo FAB de +/−) ──
function openAIChat(){
  if(!isPremium){ openPremiumModal(); return; }
  var sheet=document.getElementById('ai-chat-sheet');
  if(sheet){ sheet.classList.add('show'); }
  try{ _updateChatBtn(); }catch(e){}
  setTimeout(function(){ var i=document.getElementById('ai-chat-input'); if(i) i.focus(); },250);
}
function closeAIChat(){
  try{ if(_chatRecording) _stopChatVoice(); }catch(e){}
  var sheet=document.getElementById('ai-chat-sheet');
  if(sheet) sheet.classList.remove('show');
}
// Fecha o chat ao tocar fora do painel
document.addEventListener('click', function(e){
  var sheet=document.getElementById('ai-chat-sheet');
  if(sheet && sheet.classList.contains('show') && e.target===sheet) closeAIChat();
});

// Stubs de compatibilidade (antigos FAB/voz não existem mais, mas algumas chamadas legadas podem persistir)
function toggleFAB(){ openAIChat(); }
function openFAB(){ openAIChat(); }
function closeFAB(){}
function openVoiceFromFAB(){}

function closeVoice(){
  try{ stopRecording(); }catch(e){}
  var vm = document.getElementById('voice-modal');
  if(vm) vm.classList.remove('show');
}

// ═══════════════════════════════════════════════════════
// SCREEN TRANSITIONS — iPhone style
// ═══════════════════════════════════════════════════════
var _tabOrder=['home','finance','bills','goals','notes','tasks','reports','dashboard','invest','agenda'];
var _currentScreenName='home';

var _showScreenCore=showScreen;
function showScreen(name,el){
  var prevIdx=_tabOrder.indexOf(_currentScreenName);
  var nextIdx=_tabOrder.indexOf(name);
  var dir=nextIdx>=prevIdx?'right':'left';
  var oldSc=document.getElementById('screen-'+_currentScreenName);
  var newSc=document.getElementById('screen-'+name);
  if(oldSc&&newSc&&_currentScreenName!==name){
    oldSc.classList.remove('active');
    newSc.classList.add('active');
    newSc.classList.add(dir==='right'?'slide-in-right':'slide-in-left');
    setTimeout(function(){newSc.classList.remove('slide-in-right','slide-in-left');},350);
  } else if(newSc){
    newSc.classList.add('active');
  }
  document.querySelectorAll('.tab').forEach(function(t){t.classList.remove('active');});
  if(el) el.classList.add('active');
  _currentScreenName=name;
  if(name==='home') updateHome();
  if(name==='finance'){renderMonthLabel();renderFinance();}
  if(name==='invest'){renderInvest();renderIndexadores();fetchAllQuotes();fetchIndexadores();}
  if(name==='goals') renderGoals();
  if(name==='agenda'){
    // Restore saved view preference
    var savedView = localStorage.getItem('claudio_agendaview') || 'list';
    if(savedView !== _agendaView) setAgendaView(savedView);
    else if(_agendaView === 'calendar') renderCalendar();
    else renderEvents();
    try{ refreshGroupEvents(); renderGroupBar(); renderCameraUsage(); }catch(e){}
  }
  if(name==='bills'){renderBillsSummary();renderBills();}
  if(name==='dashboard') buildDashboard();
  if(name==='reports'){switchReportTab('relatorios');buildAnnualSummary();buildMonthlyEvolution();}
  updateHomeBackBtn(name);
}

async function fetchPTAXForInvest(){
  try{
    for(var i=0;i<5;i++){
      var d=new Date(); d.setDate(d.getDate()-i);
      var mm=String(d.getMonth()+1).padStart(2,'0');
      var dd=String(d.getDate()).padStart(2,'0');
      var url='https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarDia(dataCotacao=@d)?@d=\''+mm+'-'+dd+'-'+d.getFullYear()+'\'&$top=1&$format=json&$select=cotacaoVenda';
      try{
        var r=await fetch(url); var j=await r.json();
        if(j.value&&j.value.length){
          indexadores.ptax = j.value[0].cotacaoVenda.toFixed(4).replace('.',',');
          renderIndexadores();
          return;
        }
      }catch(e2){continue;}
    }
  }catch(e){}
}
async function fetchPTAX(){
  try{
    var badge=document.getElementById('ptax-badge');
    var valEl=document.getElementById('ptax-val');
    var dateEl=document.getElementById('ptax-date');
    // Try up to 5 days back (handle weekends/holidays)
    for(var i=0;i<5;i++){
      var d=new Date();
      d.setDate(d.getDate()-i);
      // BCB format: MM-DD-YYYY
      var mm=String(d.getMonth()+1).padStart(2,'0');
      var dd=String(d.getDate()).padStart(2,'0');
      var yyyy=d.getFullYear();
      var dateStr=mm+'-'+dd+'-'+yyyy;
      var url='https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarDia(dataCotacao=@d)?@d=\''+dateStr+'\'&$top=1&$format=json&$select=cotacaoVenda,dataHoraCotacao';
      try{
        var r=await fetch(url);
        var j=await r.json();
        if(j.value&&j.value.length>0){
          var item=j.value[0];
          if(badge) badge.style.display='flex';
          if(valEl) valEl.textContent='R$ '+item.cotacaoVenda.toFixed(4).replace('.',',');
          if(dateEl){
            var dt=new Date(item.dataHoraCotacao);
            dateEl.textContent=dt.toLocaleDateString('pt-BR');
          }
          return;
        }
      }catch(e2){continue;}
    }
  }catch(e){console.warn('PTAX indisponível');}
}

// ═══════════════════════════════════════════════════════
// TRANSACTION BOTTOM SHEET
// ═══════════════════════════════════════════════════════
function openTxSheet(type){
  var month=state.viewMonth;
  var txs=state.transactions.filter(function(t){return t.date.startsWith(month)&&t.type===type;});
  var title=document.getElementById('txlist-title');
  var total=document.getElementById('txlist-total');
  var body=document.getElementById('txlist-body');
  if(!title||!total||!body) return;
  var sum=txs.reduce(function(s,t){return s+t.val;},0);
  title.textContent=type==='in'?'📥 Entradas do Mês':'📤 Saídas do Mês';
  title.style.color=type==='in'?'var(--green)':'var(--red)';
  total.textContent='Total: R$ '+fm(sum)+' · '+txs.length+' lançamento'+(txs.length!==1?'s':'');
  total.style.color=type==='in'?'var(--green)':'var(--red)';
  var groups={};
  txs.forEach(function(t){var cat=t.cat||'outros';if(!groups[cat])groups[cat]={items:[],total:0};groups[cat].items.push(t);groups[cat].total+=t.val;});
  if(!txs.length){
    body.innerHTML='<div class="empty" style="padding:20px 0"><div class="empty-icon">'+(type==='in'?'📥':'📤')+'</div>Nenhum lançamento</div>';
  } else {
    body.innerHTML=Object.keys(groups).sort(function(a,b){return groups[b].total-groups[a].total;}).map(function(cat){
      var g=groups[cat];var ci=getCatInfo(cat);var id='txg-'+cat;
      return '<div class="txlist-cat-group">'
        +'<div class="txlist-cat-header" onclick="toggleTxGroup(\''+id+'\')">'
        +'<span class="txlist-cat-icon">'+ci.icon+'</span>'
        +'<span class="txlist-cat-name">'+ci.label+'</span>'
        +'<span class="txlist-cat-total" style="color:'+(type==='in'?'var(--green)':'var(--red)')+'">R$'+fm(g.total)+'</span>'
        +'<span class="txlist-cat-arrow" id="arr-'+id+'">▼</span></div>'
        +'<div class="txlist-items" id="'+id+'">'
        +g.items.sort(function(a,b){return b.date.localeCompare(a.date);}).map(function(t){
          return '<div class="txlist-item"><span class="txlist-item-desc">'+t.desc+'</span>'
            +'<span class="txlist-item-date">'+fmtDate(t.date)+'</span>'
            +'<span class="txlist-item-val" style="color:'+(type==='in'?'var(--green)':'var(--red)')+'">R$'+fm(t.val)+'</span></div>';
        }).join('')+'</div></div>';
    }).join('');
  }
  document.getElementById('txlist-sheet').classList.add('show');
}
function closeTxSheet(e){
  if(e&&e.target!==document.getElementById('txlist-sheet')) return;
  document.getElementById('txlist-sheet').classList.remove('show');
}
function toggleTxGroup(id){
  var el=document.getElementById(id);var arr=document.getElementById('arr-'+id);
  if(!el) return;
  el.classList.toggle('open');if(arr) arr.classList.toggle('open');
}

// ═══════════════════════════════════════════════════════
// VOICE — Click to start/stop + improved commands
// ═══════════════════════════════════════════════════════
var _voiceRecording=false;

function toggleRecording(){
  if(_voiceRecording) stopRecording(); else startRecording();
}

function startRecording(){
  var SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){document.getElementById('voice-transcript').textContent='Não suportado neste navegador.';return;}
  _voiceRecording=true;isListening=true;
  var btn=document.getElementById('voice-record-btn');
  var status=document.getElementById('voice-status');
  var transcript=document.getElementById('voice-transcript');
  if(btn){btn.classList.add('recording');}
  var fabMain=document.getElementById('fab-main');if(fabMain) fabMain.classList.add('listening');
  if(status) status.textContent='🔴 Gravando... toque para parar';
  if(transcript) transcript.textContent='Ouvindo...';
  document.getElementById('voice-result').textContent='';
  recognition=new SR();recognition.lang='pt-BR';recognition.continuous=true;recognition.interimResults=true;recognition.maxAlternatives=3;
  recognition.onresult=function(e){
    var interim='',final='';
    for(var i=e.resultIndex;i<e.results.length;i++){
      if(e.results[i].isFinal) final+=e.results[i][0].transcript;
      else interim+=e.results[i][0].transcript;
    }
    if(transcript) transcript.textContent='"'+(final||interim)+'"';
    if(final) processVoice(final.toLowerCase().trim());
  };
  recognition.onerror=function(err){if(err.error==='no-speech') return;stopRecording();};
  recognition.onend=function(){if(_voiceRecording){try{recognition.start();}catch(e){}}};
  try{recognition.start();}catch(e){_voiceRecording=false;}
}

function stopRecording(){
  _voiceRecording=false;isListening=false;
  var btn=document.getElementById('voice-record-btn');
  var status=document.getElementById('voice-status');
  if(btn) btn.classList.remove('recording');
  if(status) status.textContent='Pronto';
  var fabMain=document.getElementById('fab-main');if(fabMain) fabMain.classList.remove('listening');
  try{if(recognition) recognition.stop();}catch(e){}
}

function processVoice(cmd){
  var res=document.getElementById('voice-result');
  var setRes=function(txt,col){if(res){res.textContent=txt;res.style.color=col||'var(--green)';}};
  // NAVIGATION
  var navMap={financas:'finance','finanças':'finance',inicio:'home','início':'home',home:'home',contas:'bills',metas:'goals',notas:'notes',tarefas:'tasks',agenda:'agenda',investimentos:'invest',dashboard:'dashboard','relatórios':'reports',relatorios:'reports',ia:'ai'};
  var navM=cmd.match(/(?:ir para|abrir|mostrar|vai para?|abre)\s+(.+)/);
  if(navM){var sc=navMap[navM[1].trim()];if(sc){navTo(sc);setRes('✓ Abrindo '+navM[1]);stopRecording();setTimeout(closeVoice,1500);return;}}
  // DESPESAS
  var saidaM=cmd.match(/(?:gastei|paguei|comprei|passei|cartão|pix de?|ted de?|transferi|enviei|mandei|debitou|cobrou|saiu)\s+(?:r\$\s*)?(\d+(?:[,.]\d{1,2})?)\s*(?:reais?)?\s*(.*)?/);
  if(saidaM){var val=parseFloat(saidaM[1].replace(',','.'));var descR=(saidaM[2]||'').trim()||'Despesa';var cat=/pix|ted|transferi|enviei/.test(cmd)?'pix':detectCat(cmd+' '+descR);state.transactions.unshift({id:uid(),desc:descR,val:val,type:'out',cat:cat,date:today()});save();renderFinance();updateHome();setRes('✓ R$'+fm(val)+' em '+getCatInfo(cat).label);stopRecording();setTimeout(closeVoice,2000);return;}
  // RECEITAS
  var entM=cmd.match(/(?:recebi|salário de?|ganhei|entrou|depositou|caiu)\s+(?:r\$\s*)?(\d+(?:[,.]\d{1,2})?)/);
  if(entM){var val2=parseFloat(entM[1].replace(',','.'));var desc2=cmd.includes('salário')?'Salário':'Receita';state.transactions.unshift({id:uid(),desc:desc2,val:val2,type:'in',cat:'salario',date:today()});save();renderFinance();updateHome();setRes('✓ Receita R$'+fm(val2));stopRecording();setTimeout(closeVoice,2000);return;}
  // EVENTOS
  var evtM=cmd.match(/(?:reunião|evento|compromisso|consulta|dentista|médico|encontro)\s*(.+?)\s*(?:amanhã|hoje)?\s*(?:às?|as)\s*(\d{1,2})(?::(\d{2}))?/);
  if(evtM){var et=( evtM[1]||'Evento').trim()||'Evento';var hh=evtM[2].padStart(2,'0');var mm=(evtM[3]||'00').padStart(2,'0');var d=new Date();if(cmd.includes('amanhã')) d.setDate(d.getDate()+1);state.events.push({id:uid(),title:et,date:d.toISOString().slice(0,10),time:hh+':'+mm,color:'#2d7dd2',remind:15});save();renderEvents();updateHome();setRes('✓ "'+et+'" às '+hh+':'+mm);stopRecording();setTimeout(closeVoice,2000);return;}
  // TAREFAS
  var tarM=cmd.match(/(?:tarefa|lembrar de?|fazer|preciso|anotar tarefa)\s+(.+)/);
  if(tarM){var txt=tarM[1].trim();state.tasks.unshift({id:uid(),text:txt,done:false,importante:1,urgente:0});save();renderTasks();updateHome();setRes('✓ Tarefa: "'+txt+'"');stopRecording();setTimeout(closeVoice,2000);return;}
  // NOTAS
  var notaM=cmd.match(/(?:anotar|nota|escrever|registrar)\s+(.+)/);
  if(notaM){state.notes.unshift({id:uid(),title:'Nota de voz',body:notaM[1].trim(),date:new Date().toISOString()});save();renderNotes();setRes('✓ Nota salva');stopRecording();setTimeout(closeVoice,2000);return;}
  // METAS
  var metaM=cmd.match(/(?:meta|objetivo|poupar para?)\s+(.+?)\s+(?:de?|r\$)?\s*(\d+(?:[,.]\d{1,2})?)/);
  if(metaM){var mn=metaM[1].trim();var mv=parseFloat(metaM[2].replace(',','.'));state.goals.push({id:uid(),emoji:'🎯',name:mn,target:mv,current:0,deadline:''});save();renderGoals();setRes('✓ Meta "'+mn+'" R$'+fm(mv));stopRecording();setTimeout(closeVoice,2000);return;}
  setRes('⚠ Tente: "Gastei 50 no mercado" ou "Ir para finanças"','var(--orange)');
}

var _quickAddType = 'in';

function openQuickAdd(type){
  _quickAddType = type;
  var label = document.getElementById('quick-add-label');
  var btn   = document.getElementById('quick-submit-btn');
  var catEl = document.getElementById('quick-cat');
  var dateEl= document.getElementById('quick-date');
  if(label){
    label.textContent = type==='in' ? '+ Receita' : '− Despesa';
    label.className = 'quick-add-type-label '+(type==='in'?'income':'expense');
  }
  if(btn){
    btn.style.background = type==='in' ? 'var(--green)' : 'var(--red)';
    btn.textContent = type==='in' ? '✓ Adicionar Receita' : '✓ Adicionar Despesa';
  }
  if(catEl) populateCatSelect('quick-cat', type);
  if(dateEl) dateEl.value = today();
  // Clear fields
  var amt=document.getElementById('quick-amount'); if(amt) amt.value='';
  var desc=document.getElementById('quick-desc'); if(desc) desc.value='';
  document.getElementById('quick-add-modal').classList.add('show');
  setTimeout(function(){ var a=document.getElementById('quick-amount'); if(a) a.focus(); },300);
}

function closeQuickAdd(){
  document.getElementById('quick-add-modal').classList.remove('show');
}

function submitQuickAdd(){
  var val  = parseFloat((document.getElementById('quick-amount')||{value:0}).value);
  var desc = (document.getElementById('quick-desc')||{value:''}).value.trim();
  var cat  = (document.getElementById('quick-cat')||{value:'outros'}).value;
  var date = (document.getElementById('quick-date')||{value:today()}).value || today();
  var recur= (document.getElementById('quick-recur')||{value:'0'}).value;
  if(!val||val<=0){ toast('Informe o valor'); return; }
  if(!desc){ desc = _quickAddType==='in' ? 'Receita' : 'Despesa'; }
  state.transactions.unshift({id:uid(),desc:desc,val:val,type:_quickAddType,cat:cat,date:date,recur:recur,autoGenerated:false});
  save(); renderFinance(); updateHome();
  toast((_quickAddType==='in'?'✓ Receita':'✓ Despesa')+' de R$'+fm(val)+' adicionada!');
  closeQuickAdd();
}

// ═══════════════════════════════════════════════════════
// HOME BACK BUTTON — show/hide based on active screen
// ═══════════════════════════════════════════════════════
function updateHomeBackBtn(screen){
  var btn = document.getElementById('home-back-btn');
  if(!btn) return;
  // Show on all screens except home
  btn.style.display = (screen === 'home') ? 'none' : 'flex';
}

// Patch showScreen to update home-back button and quick-add visibility
var _showScreenBase = showScreen;
// showScreen unified below
// ═══════════════════════════════════════════════════════
var CAMERA_MONTHLY_LIMIT = 20;
var _cameraImageBase64 = null;
var _aiExtractedItems = [];

function getCameraUsage(){
  var month = new Date().toISOString().slice(0,7);
  var key = 'claudio_cam_'+month;
  return parseInt(localStorage.getItem(key)||'0');
}

function incrementCameraUsage(){
  var month = new Date().toISOString().slice(0,7);
  var key = 'claudio_cam_'+month;
  var cur = getCameraUsage();
  localStorage.setItem(key, (cur+1).toString());
}

function renderCameraUsage(){
  var used = getCameraUsage();
  var wrap = document.getElementById('camera-usage-wrap');
  var count = document.getElementById('camera-usage-count');
  var fill = document.getElementById('camera-usage-fill');
  if(wrap) wrap.style.display = 'block';
  if(count) count.textContent = used+'/'+CAMERA_MONTHLY_LIMIT;
  if(fill) fill.style.width = Math.min(100,(used/CAMERA_MONTHLY_LIMIT)*100)+'%';
  if(fill) fill.style.background = used>=CAMERA_MONTHLY_LIMIT?'var(--red)':used>15?'var(--orange)':'var(--sky)';
}

function openCameraCapture(){
  var used = getCameraUsage();
  if(used >= CAMERA_MONTHLY_LIMIT){
    toast('Limite de '+CAMERA_MONTHLY_LIMIT+' fotos/mês atingido. Renova em '+new Date(new Date().getFullYear(),new Date().getMonth()+1,1).toLocaleDateString('pt-BR'));
    return;
  }
  var input = document.getElementById('camera-input');
  if(input) input.click();
}

function handleCameraCapture(input){
  var file = input.files[0];
  if(!file) return;

  var reader = new FileReader();
  reader.onload = function(e){
    var base64 = e.target.result;
    _cameraImageBase64 = base64.split(',')[1]; // remove data:image/... prefix

    // Show preview
    var preview = document.getElementById('camera-preview');
    var previewImg = document.getElementById('camera-preview-img');
    if(preview) preview.style.display = 'block';
    if(previewImg) previewImg.src = base64;

    renderCameraUsage();
    analyzeImageWithAI();
  };
  reader.readAsDataURL(file);
  input.value = '';
}

async function analyzeImageWithAI(){
  // Show loading overlay
  var overlay = document.getElementById('ai-scan-overlay');
  if(overlay) overlay.classList.add('active');

  var results = document.getElementById('ai-results-card');
  if(results) results.style.display = 'none';

  try{
    var response = await _fetchAutenticado('/api/analisar',
      JSON.stringify({ image: _cameraImageBase64 }));

    if(!response.ok){
      throw new Error('API error: '+response.status);
    }

    var data = await response.json();
    if(data.error){ throw new Error(data.error); }
    _aiExtractedItems = data.items || [];

    incrementCameraUsage();
    renderCameraUsage();
    renderAIResults(_aiExtractedItems);

  } catch(err){
    console.error('Camera AI error:', err);
    toast('Não foi possível analisar a imagem. Tente com melhor iluminação.');
    clearCameraCapture();
  } finally {
    var overlay = document.getElementById('ai-scan-overlay');
    if(overlay) overlay.classList.remove('active');
  }
}

function renderAIResults(items){
  var card = document.getElementById('ai-results-card');
  var list = document.getElementById('ai-results-list');
  if(!card||!list) return;

  if(!items||items.length===0){
    list.innerHTML = '<div style="font-size:12px;color:rgba(255,255,255,.6);text-align:center;padding:12px">Nenhum item identificado. Tente com melhor iluminação.</div>';
    card.style.display = 'block';
    return;
  }

  var tagLabels = {agenda:'📅 Agenda',tarefa:'✓ Tarefa',compra:'🛒 Compra',financas:'💰 Finanças'};

  list.innerHTML = items.map(function(item, i){
    var tag = tagLabels[item.tipo] || '◈ Outro';
    var tagClass = 'tag-'+(item.tipo||'tarefa');
    var detail = '';
    if(item.data) detail += ' · '+item.data.split('-').reverse().join('/');
    if(item.hora) detail += ' '+item.hora;
    if(item.valor) detail += ' · R$'+item.valor;

    return '<div class="ai-result-item" id="ai-item-'+i+'">'
      +'<div class="ai-result-check checked" id="ai-check-'+i+'" onclick="toggleAIItem('+i+')" style="cursor:pointer">✓</div>'
      +'<div class="ai-result-text">'
        +item.texto
        +'<span class="ai-result-tag '+tagClass+'">'+tag+'</span>'
        +(detail?'<div style="font-size:10px;color:rgba(255,255,255,.5);margin-top:2px">'+detail+'</div>':'')
      +'</div>'
      +'</div>';
  }).join('');

  card.style.display = 'block';
}

function toggleAIItem(i){
  var check = document.getElementById('ai-check-'+i);
  if(!check) return;
  check.classList.toggle('checked');
  check.textContent = check.classList.contains('checked') ? '✓' : '';
}

function importSelectedAIItems(){
  if(!_aiExtractedItems||!_aiExtractedItems.length){ clearCameraCapture(); return; }

  var imported = {agenda:0, tarefa:0, compra:0, financas:0};
  var remind = parseInt((document.getElementById('evt-remind')||{value:'15'}).value||15);

  _aiExtractedItems.forEach(function(item, i){
    var check = document.getElementById('ai-check-'+i);
    if(!check||!check.classList.contains('checked')) return;

    if(item.tipo === 'agenda'){
      // Create event
      var date = item.data || today();
      var time = item.hora || '09:00';
      if(time.length===5&&time.indexOf(':')===2){
        // Valid time
      } else {
        time = '09:00';
      }
      state.events.push({
        id:uid(), title:item.texto, date:date, time:time,
        color:'#2d7dd2', remind:remind, fromCamera:true
      });
      imported.agenda++;

    } else if(item.tipo === 'tarefa'){
      state.tasks.push({
        id:uid(), text:item.texto, done:false,
        importante:1, urgente:0, date:today(), fromCamera:true
      });
      imported.tarefa++;

    } else if(item.tipo === 'compra'){
      // Add to notes as shopping list item
      state.tasks.push({
        id:uid(), text:'🛒 '+item.texto, done:false,
        importante:0, urgente:0, date:today(), fromCamera:true
      });
      imported.compra++;

    } else if(item.tipo === 'financas'){
      // Add as bill/note
      var val = parseFloat((item.valor||'').replace(',','.').replace(/[^0-9.]/g,''))||0;
      if(val>0){
        state.bills.push({
          id:uid(), kind:'avulsa', name:item.texto,
          value:val, due:item.data||today(), cat:'outros',
          status:'pendente', paid:false, createdAt:today()
        });
      } else {
        state.notes.push({
          id:uid(), title:'💰 '+item.texto, content:'Identificado pela IA via foto',
          date:today(), fromCamera:true
        });
      }
      imported.financas++;
    }
  });

  save();
  renderEvents();
  renderTasks();
  renderNotes();
  renderBills();
  renderBillsSummary();
  updateHome();
  syncEventsToGroup();

  // Build success message
  var msg = '✓ Importado: ';
  var parts = [];
  if(imported.agenda) parts.push(imported.agenda+' evento'+(imported.agenda>1?'s':''));
  if(imported.tarefa+imported.compra) parts.push((imported.tarefa+imported.compra)+' tarefa'+(imported.tarefa+imported.compra>1?'s':''));
  if(imported.financas) parts.push(imported.financas+' conta'+(imported.financas>1?'s':''));
  msg += parts.join(', ');
  toast(msg);

  clearCameraCapture();
  navTo('agenda');
}

function clearCameraCapture(){
  _cameraImageBase64 = null;
  _aiExtractedItems = [];
  var preview = document.getElementById('camera-preview');
  var results = document.getElementById('ai-results-card');
  var overlay = document.getElementById('ai-scan-overlay');
  var previewImg = document.getElementById('camera-preview-img');
  if(preview) preview.style.display = 'none';
  if(results) results.style.display = 'none';
  if(overlay) overlay.classList.remove('active');
  if(previewImg) previewImg.src = '';
}
// Firebase-ready: hoje usa localStorage simulando nuvem
// Para ativar Firebase real: substituir _groupDB por Firestore
// ═══════════════════════════════════════════════════════

// ── Group DB: Firestore (real cloud sync between devices) ──
var _groupDB = {
  save: function(groupId, data){
    db.collection('groups').doc(groupId).set(data).catch(function(e){ console.warn('Group save error:',e); });
    localStorage.setItem('claudio_group_'+groupId, JSON.stringify(data));
  },
  load: function(groupId){
    // Return from localStorage cache (Firestore is async, handled separately)
    var raw=localStorage.getItem('claudio_group_'+groupId);
    return raw?JSON.parse(raw):null;
  },
  loadAsync: function(groupId, callback){
    db.collection('groups').doc(groupId).get().then(function(doc){
      if(doc.exists){
        var data=doc.data();
        localStorage.setItem('claudio_group_'+groupId,JSON.stringify(data));
        callback(data);
      } else { callback(null); }
    }).catch(function(){ callback(_groupDB.load(groupId)); });
  },
  delete: function(groupId){
    db.collection('groups').doc(groupId).delete().catch(function(e){ console.warn(e); });
    localStorage.removeItem('claudio_group_'+groupId);
  },
  listenGroup: function(groupId, callback){
    return db.collection('groups').doc(groupId).onSnapshot(function(doc){
      if(doc.exists){
        var data=doc.data();
        localStorage.setItem('claudio_group_'+groupId,JSON.stringify(data));
        callback(data);
      }
    });
  }
};

function generateGroupCode(){
  var prefix = ['FAM','TIME','GRP','CLU','NET'];
  var p = prefix[Math.floor(Math.random()*prefix.length)];
  var n = Math.floor(1000+Math.random()*9000);
  return p+'-'+n;
}

function getCurrentGroup(){
  var raw = localStorage.getItem('claudio_current_group');
  if(!raw) return null;
  try{
    var g = JSON.parse(raw);
    // Isolamento: o grupo só vale para a conta que o salvou.
    // Se pertence a outro uid (outra conta neste aparelho), ignora e limpa.
    if(g && g._ownerUid && currentUser && currentUser.uid && g._ownerUid !== currentUser.uid){
      _limparDadosGrupoLocal();
      return null;
    }
    return g;
  }catch(e){ return null; }
}

function saveCurrentGroup(group){
  // Marca o dono do grupo (conta atual) para isolar entre contas no mesmo aparelho
  if(group && currentUser && currentUser.uid){ group._ownerUid = currentUser.uid; }
  localStorage.setItem('claudio_current_group', JSON.stringify(group));
}

function openGroupModal(){
  var modal = document.getElementById('group-modal');
  if(modal) modal.style.display = 'flex';
  renderGroupModal();
}

function closeGroupModal(){
  var modal = document.getElementById('group-modal');
  if(modal) modal.style.display = 'none';
}

function renderGroupModal(){
  var group = getCurrentGroup();
  var createSection = document.getElementById('create-group-section');
  var currentInfo  = document.getElementById('current-group-info');
  if(!createSection||!currentInfo) return;

  if(group){
    currentInfo.style.display = 'block';
    createSection.style.display = 'none';
    // Load fresh data from "cloud"
    var data = _groupDB.load(group.id);
    if(data){
      var nm=document.getElementById('modal-group-name');
      var cd=document.getElementById('modal-group-code');
      var ml=document.getElementById('modal-members-list');
      if(nm) nm.textContent = data.name;
      if(cd) cd.textContent = 'Código: '+data.id;
      var pr=document.getElementById('modal-group-pass-row');
      var pv=document.getElementById('modal-group-pass');
      if(pr&&pv){
        if(data.pass){ pr.style.display='block'; pv.textContent=data.pass; }
        else { pr.style.display='none'; }
      }
      if(ml){
        ml.innerHTML = (data.members||[]).map(function(m){
          return '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid rgba(0,0,0,.06)">'
            +'<div style="width:28px;height:28px;border-radius:50%;background:var(--sky);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#fff">'+(m.name||'?')[0].toUpperCase()+'</div>'
            +'<div><div style="font-size:12px;font-weight:700;color:var(--ink)">'+m.name+'</div>'
            +'<div style="font-size:10px;color:var(--ink3)">'+m.email+(m.isAdmin?' · Admin':'')+'</div></div>'
            +'</div>';
        }).join('');
      }
    }
    // Check pending shared events from others
    var pending = getSharedEventsFromGroup();
    var notice = document.getElementById('shared-events-notice');
    if(notice){
      if(pending.length>0){
        notice.style.display='block';
        notice.textContent='📅 '+pending.length+' evento(s) compartilhado(s) no grupo';
      } else {
        notice.style.display='none';
      }
    }
  } else {
    currentInfo.style.display = 'none';
    createSection.style.display = 'block';
  }
}

function createGroup(){
  var name = (document.getElementById('new-group-name')||{value:''}).value.trim();
  var pass = (document.getElementById('new-group-pass')||{value:''}).value.trim();
  if(!name){ toast('Digite o nome do grupo'); return; }
  if(!pass){ toast('Defina uma senha para o grupo'); return; }
  var user = currentUser || {name:'Usuário',email:'local@app'};
  var groupId = generateGroupCode();
  var group = {
    id: groupId,
    name: name,
    pass: pass,
    createdAt: today(),
    members: [{name:user.name, email:user.email, isAdmin:true, joinedAt:today()}],
    events: []
  };
  _groupDB.save(groupId, group);
  saveCurrentGroup({id:groupId, name:name});
  // Sync current events to group
  syncEventsToGroup();
  toast('✓ Grupo "'+name+'" criado!');
  renderGroupModal();
  renderGroupBar();
}

function joinGroup(){
  var code = ((document.getElementById('join-group-code')||{value:''}).value||'').trim().toUpperCase();
  var pass = ((document.getElementById('join-group-pass')||{value:''}).value||'').trim();
  if(!code){ toast('Digite o código do grupo'); return; }
  if(!pass){ toast('Digite a senha do grupo'); return; }
  // Fetch fresh from cloud so the password check is reliable
  _groupDB.loadAsync(code, function(data){
    if(!data){ toast('Grupo não encontrado. Verifique o código.'); return; }
    if((data.pass||'') !== pass){ toast('Senha incorreta.'); return; }
    var user = currentUser || {name:'Usuário',email:'local@app'};
    var already = (data.members||[]).some(function(m){ return m.email===user.email; });
    if(!already){
      data.members.push({name:user.name, email:user.email, isAdmin:false, joinedAt:today()});
      _groupDB.save(code, data);
    }
    saveCurrentGroup({id:code, name:data.name});
    mergeGroupEvents(data.events||[]);
    toast('✓ Você entrou em "'+data.name+'"!');
    renderGroupModal();
    renderGroupBar();
    renderEvents();
    updateHome();
  });
}

function leaveGroup(){
  var group = getCurrentGroup();
  if(!group) return;
  var data = _groupDB.load(group.id);
  var user = currentUser || {email:'local@app'};
  if(data){
    data.members = (data.members||[]).filter(function(m){ return m.email!==user.email; });
    if(data.members.length===0) _groupDB.delete(group.id);
    else _groupDB.save(group.id, data);
  }
  localStorage.removeItem('claudio_current_group');
  toast('Você saiu do grupo');
  closeGroupModal();
  renderGroupBar();
}

function syncEventsToGroup(){
  var group = getCurrentGroup();
  if(!group) return;
  var data = _groupDB.load(group.id);
  if(!data) return;
  var user = currentUser || {name:'Usuário',email:'local@app'};
  // Add user's events to group with author tag
  var myEvents = (state.events||[]).map(function(e){
    return {id:e.id,title:e.title,date:e.date,time:e.time,color:e.color,remind:e.remind,
      authorEmail:user.email,authorName:user.name,shared:true};
  });
  // Merge: keep others' events, replace mine
  var othersEvents = (data.events||[]).filter(function(e){ return e.authorEmail!==user.email; });
  data.events = othersEvents.concat(myEvents);
  _groupDB.save(group.id, data);
}

function mergeGroupEvents(groupEvents){
  var user = currentUser || {email:'local@app'};
  // Add events from others (not already in local state)
  var localIds = (state.events||[]).map(function(e){ return e.id; });
  var newEvents = (groupEvents||[]).filter(function(e){
    return e.authorEmail!==user.email && localIds.indexOf(e.id)===-1;
  });
  newEvents.forEach(function(e){
    state.events.push({id:e.id,title:e.title+' ('+e.authorName+')',
      date:e.date,time:e.time,color:e.color||'#8b5cf6',remind:0,fromGroup:true});
  });
  if(newEvents.length>0) save();
}

// Remove eventos de grupo (fromGroup) do state — usado quando a conta não pertence a grupo algum
function _limparEventosDeGrupoOrfaos(){
  if(!state.events) return;
  var antes = state.events.length;
  // Só mantém eventos que NÃO vieram de grupo (os próprios do usuário)
  var grupo = getCurrentGroup();
  if(!grupo){
    state.events = state.events.filter(function(e){ return !e.fromGroup; });
    if(state.events.length !== antes) save();
  }
}

function getSharedEventsFromGroup(){
  var group = getCurrentGroup();
  if(!group) return [];
  var data = _groupDB.load(group.id);
  if(!data) return [];
  var user = currentUser || {email:'local@app'};
  return (data.events||[]).filter(function(e){ return e.authorEmail!==user.email; });
}

function renderGroupBar(){
  var group = getCurrentGroup();
  var nameEl    = document.getElementById('agenda-group-name');
  var membersEl = document.getElementById('agenda-group-members');
  var iconEl    = document.getElementById('agenda-group-icon');
  if(!nameEl) return;
  if(group){
    var data = _groupDB.load(group.id);
    var count = data ? (data.members||[]).length : 1;
    nameEl.textContent    = group.name;
    membersEl.textContent = count+' membro'+(count>1?'s':'')+' · '+group.id;
    if(iconEl) iconEl.textContent = count>1?'👨‍👩‍👧‍👦':'👤';
  } else {
    nameEl.textContent    = 'Agenda Pessoal';
    membersEl.textContent = 'Toque para criar ou entrar em um grupo';
    if(iconEl) iconEl.textContent = '👤';
  }
}

// addEvent syncs to group internally

function _copyText(txt, okMsg){
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(txt).then(function(){ toast(okMsg); })
      .catch(function(){ _copyFallback(txt, okMsg); });
  } else { _copyFallback(txt, okMsg); }
}
function _copyFallback(txt, okMsg){
  try{
    var ta=document.createElement('textarea');
    ta.value=txt; ta.style.position='fixed'; ta.style.opacity='0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
    toast(okMsg);
  }catch(e){ toast('Não foi possível copiar'); }
}
function copyGroupPass(){
  var group=getCurrentGroup(); if(!group) return;
  var data=_groupDB.load(group.id); if(!data||!data.pass) return;
  _copyText(data.pass, '✓ Senha copiada!');
}
function copyGroupInvite(){
  var group=getCurrentGroup(); if(!group) return;
  var data=_groupDB.load(group.id); if(!data) return;
  var msg='📅 Entre na minha agenda no Planni!\n\nGrupo: '+data.name
    +'\nCódigo: '+data.id
    +(data.pass?('\nSenha: '+data.pass):'')
    +'\n\nApp: https://planni.pages.dev';
  _copyText(msg, '✓ Convite copiado!');
}

// Override delEvent to sync removal
var _delEventOrig = delEvent;
function delEvent(id){
  _delEventOrig(id);
  setTimeout(function(){ syncEventsToGroup(); }, 100);
}

// Refresh group events when opening agenda
function refreshGroupEvents(){
  var group = getCurrentGroup();
  if(!group) return;
  var data = _groupDB.load(group.id);
  if(!data) return;
  mergeGroupEvents(data.events||[]);
  renderGroupBar();
}
var PREMIUM_SCREENS = ['invest','agenda','finance','reports'];
var PREMIUM_TASK_LIMIT = 10; // máx de tarefas ativas no plano gratuito
var isPremium = false;
var _premiumUnsub = null;

function initPremium(){
  // 1. Cache de UI: usa o ultimo valor conhecido so para nao piscar na abertura.
  //    NAO e fonte de verdade — o Firestore sobrescreve assim que responde.
  var saved = localStorage.getItem('claudio_premium');
  isPremium = (saved === 'true');
  applyPremiumState();
  // 2. Fonte da verdade: Firestore (gravado só pelo webhook Hotmart).
  if(typeof currentUser !== 'undefined' && currentUser && currentUser.uid){
    _syncPremiumFromFirebase(currentUser.uid);
  }
}

// Listener em tempo real: quando o webhook Hotmart marca premium no Firestore,
// a UI destrava sozinha, sem reload. O cliente apenas LE este campo.
function _syncPremiumFromFirebase(uid){
  try{
    if(_premiumUnsub){ _premiumUnsub(); _premiumUnsub = null; }
    _premiumUnsub = firebase.firestore().collection('users').doc(uid)
      .onSnapshot(function(doc){
        var data = doc.exists ? doc.data() : null;
        isPremium = !!(data && data.premium); // Firestore e a fonte da verdade
        localStorage.setItem('claudio_premium', isPremium ? 'true' : 'false'); // so cache de UI
        applyPremiumState();
        if(!isPremium) _checkPendingPremium();
      }, function(e){ console.warn('Premium sync:', e); });
  }catch(e){}
}

// Resgate de compra feita ANTES do cadastro: se o usuário não é premium,
// pergunta ao servidor (uma vez por sessão) se o webhook Hotmart deixou um
// premium pendente para o e-mail desta conta. O servidor valida o token,
// ativa em users/{uid} e o listener acima destrava a UI sozinho.
var _pendingPremiumChecked = false;
async function _checkPendingPremium(){
  if(_pendingPremiumChecked) return;
  _pendingPremiumChecked = true;
  try{
    var authHeaders = await _getAuthHeader();
    if(!authHeaders.Authorization) return;
    var resp = await fetch('/api/premium-pendente', {
      method:'POST',
      headers: Object.assign({'Content-Type':'application/json'}, authHeaders),
      body:'{}'
    });
    var data = {};
    try{ data = await resp.json(); }catch(e){}
    if(data && data.activated){
      toast('✦ Premium ativado! Sua compra foi encontrada.');
    }
  }catch(e){ console.warn('Premium pendente:', e); }
}

// O cliente NAO grava premium (isso e feito so pelo webhook Hotmart no servidor).
// Esta funcao agora so ajusta a UI localmente enquanto o Firestore nao responde.
function setPremiumStatus(value){
  isPremium = !!value;
  localStorage.setItem('claudio_premium', isPremium ? 'true' : 'false'); // cache de UI apenas
  applyPremiumState();
}

function applyPremiumState(){
  // Mostra/esconde overlays de lock nas telas premium
  PREMIUM_SCREENS.forEach(function(screen){
    var lock = document.getElementById(screen+'-lock');
    if(lock) lock.style.display = isPremium ? 'none' : 'flex';
  });
  // FAB do chat: visual de bloqueado pra não-premium
  var fab = document.getElementById('fab-main');
  if(fab){
    fab.style.opacity = isPremium ? '1' : '0.6';
    fab.title = isPremium ? '' : 'Recurso Premium';
  }
  // Badge de limite de tarefas
  _applyTaskLimit();
  // Status no perfil
  var profPrem = document.getElementById('profile-premium-status');
  if(profPrem){
    if(isPremium){
      profPrem.innerHTML = '<span class="premium-badge">✦ PREMIUM ATIVO</span>';
    } else {
      profPrem.innerHTML = '<span style="font-size:11px;color:var(--ink3);cursor:pointer;font-weight:700" onclick="openPremiumModal()">Fazer upgrade para Premium →</span>';
    }
  }
}

function _applyTaskLimit(){
  // No plano gratuito, avisa quando o usuário tenta criar mais de 10 tarefas
  // A verificação real acontece em addTask()
}


function openPremiumModal(){ document.getElementById('premium-modal').classList.add('show'); }
function closePremiumModal(){ document.getElementById('premium-modal').classList.remove('show'); }

// A ativação do Premium acontece exclusivamente pela compra na Hotmart.
// O webhook grava o status no Firestore e a UI destrava sozinha (listener).

// ═══════════════════════════════════════
// INIT
// ═══════════════════════════════════════
function init(){
  // Safety net PRIMEIRO — registrado antes de qualquer coisa que possa falhar
  // (ex: Firebase não carregar). Garante que o splash nunca prenda o usuário.
  setTimeout(function(){
    var ap=document.getElementById('app');
    var ls=document.getElementById('login-screen');
    var appVisible = ap && getComputedStyle(ap).display !== 'none';
    var loginVisible = ls && getComputedStyle(ls).display !== 'none';
    if(!appVisible && !loginVisible){
      try{ showLoginScreen(); }catch(e){ try{ hideSplash(); }catch(e2){} }
    } else {
      try{ hideSplash(); }catch(e){}
    }
  }, 5000);

  load();
  // Auth FIRST — decides whether to show login or app
  try{ initAuth(); }catch(e){ console.error('initAuth failed:', e); showLoginScreen(); }



  // Everything else wrapped so one error can't blank the app
  try{
    var t=today();
    var setVal=function(id,v){var el=document.getElementById(id);if(el)el.value=v;};
    setVal('evt-date',t); setVal('tx-date',t); setVal('ba-due',t); setVal('fi-start',t);
    populateCatSelect('tx-cat','out');
    populateBankList();
    renderMonthLabel();
    updateClock();
    setInterval(updateClock,30000);
    setInterval(checkAlarms,60000);
    setInterval(checkOverdueAlerts,300000);
    setInterval(applyRecurring,3600000);
    applyRecurring();
    checkOverdueAlerts();
    initDarkMode();
    initPremium();
    resetInactivity();
    updateHome();
    renderEvents();
    renderFinance();
    renderInvest();
    renderIndexadores();
    renderGoals();
    renderBillsSummary();
    renderBills();
    renderNotes();
    renderTasks();
  }catch(e){ console.error('Init render error:', e); }

  setTimeout(function(){
    try{ buildDashboard(); buildAIBriefing(); buildAnnualSummary(); buildMonthlyEvolution(); renderGroupBar(); }catch(e){ console.warn('Deferred render:', e); }
  },600);
}

// ═══════════════════════════════════════════════════════
// DARK MODE
// ═══════════════════════════════════════════════════════
let darkMode=false;
function initDarkMode(){
  const saved=localStorage.getItem('claudio_dark');
  const prefersDark=window.matchMedia&&window.matchMedia('(prefers-color-scheme:dark)').matches;
  darkMode=saved!==null?saved==='true':prefersDark;
  applyDarkMode();
  try{ window.matchMedia('(prefers-color-scheme:dark)').addEventListener('change',e=>{ if(localStorage.getItem('claudio_dark')===null){ darkMode=e.matches; applyDarkMode(); } }); }catch(e){}
  initFontScale();
}

// ── ACCESSIBILITY — Font size scaling ──
var _fontScale = 0; // 0=normal, 1=grande, 2=maior
function initFontScale(){
  var saved = parseInt(localStorage.getItem('claudio_fontscale')||'0', 10);
  _fontScale = isNaN(saved) ? 0 : saved;
  applyFontScale();
}
function applyFontScale(){
  document.body.classList.remove('font-scale-1','font-scale-2');
  if(_fontScale===1) document.body.classList.add('font-scale-1');
  else if(_fontScale===2) document.body.classList.add('font-scale-2');
  // Update button label if present
  var lbl = document.getElementById('fontscale-label');
  if(lbl) lbl.textContent = ['A','A+','A++'][_fontScale];
}
function cycleFontScale(){
  _fontScale = (_fontScale + 1) % 3;
  localStorage.setItem('claudio_fontscale', _fontScale);
  applyFontScale();
  toast(['Fonte normal','Fonte grande','Fonte maior'][_fontScale]);
}
function applyDarkMode(){
  document.documentElement.setAttribute('data-theme',darkMode?'dark':'light');
  const btn=document.getElementById('dark-toggle');
  if(btn) btn.innerHTML=darkMode
    ?'<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1z"/></svg>'
    :'<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9c0-.46-.04-.92-.1-1.36-.98 1.37-2.58 2.26-4.4 2.26-2.98 0-5.4-2.42-5.4-5.4 0-1.81.89-3.42 2.26-4.4-.44-.06-.9-.1-1.36-.1z"/></svg>';
}
function toggleDark(){ darkMode=!darkMode; localStorage.setItem('claudio_dark',darkMode); applyDarkMode(); toast(darkMode?'🌙 Modo escuro ativado':'☀️ Modo claro ativado'); }

// ═══════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════
let currentUser=null;

// ═══════════════════════════════════════════════════════
// FASE 4 — Constantes e helpers de autenticação
// ═══════════════════════════════════════════════════════
var TERMS_VERSION = '1.0-2026-06';

// Discrete auth status message (neutral color, auto-hides)
function setAuthStatus(msg){
  var el = document.getElementById('auth-status');
  if(!el){
    el = document.createElement('div');
    el.id = 'auth-status';
    el.style.cssText = 'text-align:center;font-size:12px;font-weight:600;color:rgba(255,255,255,.55);margin:8px 0;min-height:16px;transition:opacity .3s';
    var errEl = document.getElementById('login-error');
    if(errEl && errEl.parentNode) errEl.parentNode.insertBefore(el, errEl.nextSibling);
  }
  el.textContent = msg;
  el.style.opacity = msg ? '1' : '0';
}
function clearAuthStatus(){ setAuthStatus(''); }

// Audit log — records security events to Firestore
function logAuditEvent(eventType, details){
  try{
    var entry = {
      event: eventType,
      timestamp: new Date().toISOString(),
      userAgent: navigator.userAgent.slice(0,120),
      details: details || {}
    };
    var uid = (currentUser && currentUser.uid) || (auth.currentUser && auth.currentUser.uid);
    if(uid){
      db.collection('users').doc(uid).collection('audit').add(entry).catch(function(){});
    }
  }catch(e){}
}

// Email verification screen
function showEmailVerificationScreen(email){
  var ls = document.getElementById('login-screen');
  var ap = document.getElementById('app');
  var ev = document.getElementById('email-verify-screen');
  if(ls) ls.style.display='none';
  if(ap) ap.style.display='none';
  if(ev){
    ev.style.display='flex';
    var emailEl = document.getElementById('verify-email-addr');
    if(emailEl) emailEl.textContent = email || (auth.currentUser && auth.currentUser.email) || '';
  }
}

function resendVerificationEmail(){
  if(auth.currentUser){
    auth.currentUser.sendEmailVerification().then(function(){
      toast('✓ E-mail reenviado! Verifique sua caixa de entrada.');
    }).catch(function(e){
      toast(_firebaseAuthError(e.code));
    });
  }
}

function checkEmailVerified(){
  if(auth.currentUser){
    setAuthStatus2('Verificando...');
    auth.currentUser.reload().then(function(){
      if(auth.currentUser.emailVerified){
        logAuditEvent('email_confirmado', {email:auth.currentUser.email});
        // Update Firestore
        db.collection('users').doc(auth.currentUser.uid).update({emailVerified:true}).catch(function(){});
        document.getElementById('email-verify-screen').style.display='none';
        hideLoginScreen();
        updateUserUI();
        try{ navTo('home'); }catch(e){}
        loadFromFirestore(); startRealtimeSync(); initPremium();
        toast('✓ E-mail confirmado! Bem-vindo!');
      } else {
        setAuthStatus2('E-mail ainda não confirmado. Verifique sua caixa de entrada.');
      }
    });
  }
}

function setAuthStatus2(msg){
  var el = document.getElementById('verify-status');
  if(el){ el.textContent = msg; }
}

function backToLoginFromVerify(){
  if(_firestoreUnsubscribe) _firestoreUnsubscribe();
  auth.signOut().then(function(){
    document.getElementById('email-verify-screen').style.display='none';
    showLoginScreen();
  });
}

function initAuth(){
  // Se o Firebase não carregou (ex: offline), cai direto pro login
  if(typeof firebase==='undefined' || !auth){
    showLoginScreen();
    return;
  }
  // STEP 1: Set persistence synchronously before anything else
  auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(function(){});

  // STEP 2: Process Google redirect result BEFORE setting up the observer
  // This is critical on iOS — the redirect result must be consumed first
  // so that onAuthStateChanged fires with the correct user
  auth.getRedirectResult().then(function(result){
    if(result && result.user){
      // Redirect login succeeded — log it
      logAuditEvent('login', {email:result.user.email, method:'google'});
      // onAuthStateChanged will fire automatically after this
    }
  }).catch(function(e){
    if(e.code && e.code !== 'auth/no-current-user' && e.code !== 'auth/null-user'){
      var errEl = document.getElementById('login-error');
      if(errEl) errEl.textContent = _firebaseAuthError(e.code);
      console.warn('Redirect result error:', e.code, e.message);
    }
  });

  // Firebase Auth state observer
  auth.onAuthStateChanged(function(user){
    if(user){
      // Email verification gate (skip for Google/Apple - already verified)
      var isPasswordProvider = user.providerData.some(function(p){ return p.providerId === 'password'; });
      if(isPasswordProvider && !user.emailVerified){
        showEmailVerificationScreen(user.email);
        return;
      }
      currentUser = {
        uid:   user.uid,
        email: user.email,
        name:  user.displayName || user.email.split('@')[0],
        photo: user.photoURL || null
      };
      // CRITICAL: wipe any in-memory data from a previous user before loading
      state = _emptyState();
      // Hide login and any loading screens
      hideLoginScreen();
      var ev=document.getElementById('email-verify-screen'); if(ev) ev.style.display='none';
      var ls=document.getElementById('google-loading'); if(ls) ls.style.display='none';
      updateUserUI();
      load(); // load THIS user's local cache (if any)
      try{ navTo('home'); }catch(e){ try{ updateHome(); }catch(e2){} }
      db.collection('users').doc(user.uid).get().then(function(doc){
        if(doc.exists){
          var p = doc.data();
          currentUser.name      = p.name      || currentUser.name;
          currentUser.phone     = p.phone     || '';
          currentUser.patrimony = p.patrimony || '';
          updateUserUI();
          try{ updateHome(); }catch(e){} // atualiza a saudação com o nome do perfil
        } else {
          // First login (e.g. Google) — create profile doc
          db.collection('users').doc(user.uid).set({
            name: currentUser.name,
            email: currentUser.email,
            phone: '',
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            emailVerified: true,
            provider: 'google',
            consent: { terms:true, privacy:true, marketing:false, consentDate:new Date().toISOString(), termsVersion:TERMS_VERSION }
          }).catch(function(){});
        }
        localStorage.setItem('claudio_user', JSON.stringify(currentUser));
      }).catch(function(e){ console.warn('Profile load:', e); });
      try{ loadFromFirestore(); }catch(e){ console.warn('loadFromFirestore:', e); }
      try{ startRealtimeSync(); }catch(e){ console.warn('startRealtimeSync:', e); }
      try{ initPremium(); }catch(e){ console.warn('initPremium:', e); }
    } else {
      currentUser = null;
      localStorage.removeItem('claudio_user');
      showLoginScreen();
    }
  });
}
function showLoginScreen(){
  try{hideSplash();}catch(e){}
  var ls=document.getElementById('login-screen');
  var ap=document.getElementById('app');
  if(ls) ls.style.display='flex';
  if(ap) ap.style.display='none';
  var fab=document.getElementById('fab-container'); if(fab) fab.style.display='none';
}
function hideLoginScreen(){
  try{hideSplash();}catch(e){}
  var ls=document.getElementById('login-screen');
  var ap=document.getElementById('app');
  if(ls) ls.style.display='none';
  if(ap) ap.style.display='flex';
  var fab=document.getElementById('fab-container'); if(fab) fab.style.display='flex';
}
function updateUserUI(){
  if(!currentUser) return;
  const initials=(currentUser.name||'U').split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
  const av=document.getElementById('user-avatar'); if(av) av.textContent=initials;
  const avL=document.getElementById('profile-avatar-large'); if(avL) avL.textContent=initials;
  const nm=document.getElementById('profile-name'); if(nm) nm.textContent=currentUser.name||'Usuário';
  const em=document.getElementById('profile-email'); if(em) em.textContent=currentUser.email||'';
}
var authMode = 'login';

function toggleAuthMode(){
  authMode=(authMode==='login')?'register':'login';
  var isReg=(authMode==='register');
  document.getElementById('register-fields').style.display=isReg?'block':'none';
  var kc=document.getElementById('keep-connected-row'); if(kc) kc.style.display=isReg?'none':'flex';
  var pc=document.getElementById('login-pass-confirm'); if(pc) pc.style.display=isReg?'block':'none';
  document.getElementById('login-mode-title').textContent=isReg?'Criar sua conta':'Entrar na sua conta';
  document.getElementById('login-submit-btn').textContent=isReg?'Cadastrar':'Entrar';
  document.getElementById('login-toggle-text').textContent=isReg?'Já tem conta? ':'Não tem conta? ';
  document.getElementById('login-toggle-link').textContent=isReg?'Entrar':'Cadastre-se';
  document.getElementById('login-error').textContent='';
  clearAuthStatus();
}

function loginEmail(){
  var email=document.getElementById('login-email').value.trim();
  var pass=document.getElementById('login-pass').value;
  var err=document.getElementById('login-error');
  err.textContent='';
  if(!email||!pass){err.textContent='Preencha e-mail e senha';return;}
  if(pass.length<6){err.textContent='Senha deve ter pelo menos 6 caracteres';return;}

  if(authMode==='register'){
    var name=document.getElementById('reg-name').value.trim();
    var phone=document.getElementById('reg-phone').value.trim();
    var acceptTerms=document.getElementById('reg-terms').checked;
    var acceptPrivacy=document.getElementById('reg-privacy').checked;
    var acceptMarketing=document.getElementById('reg-marketing').checked;
    if(!name){err.textContent='Informe seu nome completo';return;}
    if(!phone){err.textContent='Informe seu celular';return;}
    var passConfirm=document.getElementById('login-pass-confirm').value;
    if(pass !== passConfirm){err.textContent='As senhas não coincidem';return;}
    // Validate Brazilian phone format (10-11 digits)
    var phoneDigits = phone.replace(/\D/g,'');
    if(phoneDigits.length < 10 || phoneDigits.length > 11){
      err.textContent='Celular inválido. Use DDD + número (ex: 11987654321)';return;
    }
    if(!acceptTerms){err.textContent='Você precisa aceitar os Termos de Uso';return;}
    if(!acceptPrivacy){err.textContent='Você precisa aceitar a Política de Privacidade';return;}
    setAuthStatus('Criando conta...');

    var consentTimestamp = new Date().toISOString();
    var _regName = name;

    auth.createUserWithEmailAndPassword(email, pass).then(function(cred){
      var uid = cred.user.uid;
      var p1 = cred.user.updateProfile({displayName: name});
      var p2 = db.collection('users').doc(uid).set({
        name:name, phone:phoneDigits, email:email,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        emailVerified: false,
        consent: {
          terms: true,
          privacy: true,
          marketing: acceptMarketing,
          consentDate: consentTimestamp,
          termsVersion: TERMS_VERSION
        }
      });
      var p3 = cred.user.sendEmailVerification();
      logAuditEvent('cadastro', {email:email});
      return Promise.all([p1, p2, p3]);
    }).then(function(){
      clearAuthStatus();
      showEmailVerificationScreen(email);
    }).catch(function(e){
      setAuthStatus('');
      err.textContent = _firebaseAuthError(e.code);
    });

  } else {
    var keepConnected = document.getElementById('keep-connected') ? document.getElementById('keep-connected').checked : true;
    var persistence = keepConnected ? firebase.auth.Auth.Persistence.LOCAL : firebase.auth.Auth.Persistence.SESSION;
    setAuthStatus('Entrando...');
    auth.setPersistence(persistence).then(function(){
      return auth.signInWithEmailAndPassword(email, pass);
    }).then(function(){
      clearAuthStatus();
      logAuditEvent('login', {email:email, method:'email'});
    }).catch(function(e){
      setAuthStatus('');
      err.textContent = _firebaseAuthError(e.code);
    });
  }
}

function loginGoogle(){
  var gl=document.getElementById('google-loading');
  if(gl) gl.style.display='flex';
  var errEl=document.getElementById('login-error');
  if(errEl) errEl.textContent='';
  var provider = new firebase.auth.GoogleAuthProvider();
  provider.addScope('email');
  provider.addScope('profile');
  provider.setCustomParameters({prompt:'select_account'});
  auth.signInWithPopup(provider)
    .then(function(){
      if(gl) gl.style.display='none';
    })
    .catch(function(e){
      if(gl) gl.style.display='none';
      if(e.code==='auth/popup-blocked'){
        toast('Popup bloqueado. Tentando redirect...');
        auth.signInWithRedirect(provider);
        return;
      }
      if(e.code==='auth/popup-closed-by-user'||e.code==='auth/cancelled-popup-request') return;
      if(errEl) errEl.textContent=_firebaseAuthError(e.code);
      console.warn('Google login:', e.code, e.message);
    });
}

function loginApple(){
  var provider=new firebase.auth.OAuthProvider('apple.com');
  auth.signInWithPopup(provider).catch(function(){
    auth.signInWithRedirect(provider);
  });
}

function resetAccountData(){
  if(!currentUser || !currentUser.uid){ toast('Faça login primeiro'); return; }
  if(!confirm('Tem certeza? Isso vai apagar TODAS as suas transações, contas, metas, investimentos e eventos. Esta ação não pode ser desfeita.')) return;
  state = _emptyState();
  // Clear local
  try{ localStorage.removeItem(_userStorageKey()); }catch(e){}
  // Clear Firestore
  var docRef = db.collection('users').doc(currentUser.uid).collection('data').doc('state');
  docRef.set({
    events:[], transactions:[], notes:[], tasks:[], bills:[],
    investments:[], goals:[], customCats:[],
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  }).then(function(){
    logAuditEvent('reset_dados', {});
    updateHome(); renderFinance(); renderGoals();
    renderBillsSummary(); renderBills(); renderNotes(); renderTasks(); renderInvest();
    try{ renderEvents(); }catch(e){}
    closeProfileModal();
    toast('✓ Dados zerados com sucesso');
  }).catch(function(e){ toast('Erro ao zerar: '+e.message); });
}

// ===== LGPD: Exportar dados e Excluir conta =====

// Baixa um JSON com todos os dados do usuario (portabilidade - LGPD art. 18)
function exportarMeusDados(){
  try{
    var pacote = {
      exportadoEm: new Date().toISOString(),
      app: 'Planni',
      conta: {
        uid: (currentUser && currentUser.uid) || null,
        email: (currentUser && currentUser.email) || null,
        nome: (auth.currentUser && auth.currentUser.displayName) || null
      },
      dados: {
        events: state.events || [],
        transactions: state.transactions || [],
        notes: state.notes || [],
        tasks: state.tasks || [],
        bills: state.bills || [],
        investments: state.investments || [],
        goals: state.goals || [],
        customCats: state.customCats || [],
        noteFolders: state.noteFolders || []
      }
    };
    var content = JSON.stringify(pacote, null, 2);
    var blob = new Blob([content], {type:'application/json'});
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'planni-meus-dados-' + new Date().toISOString().slice(0,10) + '.json';
    a.click();
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
    try{ logAuditEvent('exportar_dados', {}); }catch(e){}
    toast('✓ Seus dados foram exportados');
  }catch(e){ toast('Erro ao exportar: '+e.message); }
}

// Exclui a conta permanentemente, com confirmacao dupla (LGPD art. 18 - eliminacao)
function excluirMinhaConta(){
  var c1 = prompt('⚠️ ATENÇÃO: isto vai apagar PERMANENTEMENTE sua conta e todos os seus dados. Esta ação NÃO pode ser desfeita.\n\nPara confirmar, digite: EXCLUIR');
  if(c1 === null) return; // cancelou
  if(c1.trim().toUpperCase() !== 'EXCLUIR'){ toast('Confirmação incorreta. Conta não excluída.'); return; }
  if(!currentUser || !currentUser.uid){ toast('Você precisa estar logado.'); return; }

  toast('Excluindo sua conta...');
  var uid = currentUser.uid;
  // 1) Apaga os dados no Firestore (state + doc do usuario)
  var p1 = db.collection('users').doc(uid).collection('data').doc('state').delete().catch(function(){});
  Promise.resolve(p1).then(function(){
    return db.collection('users').doc(uid).delete().catch(function(){});
  }).then(function(){
    try{ logAuditEvent('excluir_conta', {}); }catch(e){}
    // 2) Apaga a conta de autenticacao
    return auth.currentUser.delete();
  }).then(function(){
    // 3) Limpa o local e volta ao login
    try{ localStorage.clear(); }catch(e){}
    currentUser = null;
    state = _emptyState();
    try{ closeProfileModal(); }catch(e){}
    showLoginScreen();
    toast('Sua conta foi excluída. Sentiremos sua falta.');
  }).catch(function(e){
    if(e && e.code === 'auth/requires-recent-login'){
      toast('Por segurança, saia e entre novamente antes de excluir a conta.');
    } else {
      toast('Erro ao excluir: ' + (e.message||e));
    }
  });
}

function logout(){
  logAuditEvent('logout', {});
  if(_firestoreUnsubscribe) _firestoreUnsubscribe();
  // Limpa dados de grupo do aparelho para não vazar para a próxima conta neste dispositivo
  _limparDadosGrupoLocal();
  auth.signOut().then(function(){
    currentUser=null;
    state=_emptyState();
    closeProfileModal(); showLoginScreen(); toast('Sessão encerrada');
  });
}

// Remove do localStorage o grupo atual e os caches de grupo (isolamento entre contas no mesmo aparelho)
function _limparDadosGrupoLocal(){
  try{
    localStorage.removeItem('claudio_current_group');
    // remove todos os caches claudio_group_*
    var remover=[];
    for(var i=0;i<localStorage.length;i++){
      var k=localStorage.key(i);
      if(k && k.indexOf('claudio_group_')===0) remover.push(k);
    }
    remover.forEach(function(k){ localStorage.removeItem(k); });
  }catch(e){}
}

function recoverPassword(){
  // Open dedicated, accessible reset screen
  var scr = document.getElementById('forgot-screen');
  var emailInput = document.getElementById('login-email');
  var fgEmail = document.getElementById('forgot-email');
  if(fgEmail && emailInput) fgEmail.value = emailInput.value.trim();
  if(scr) scr.style.display = 'flex';
  document.getElementById('forgot-status').textContent = '';
}

function closeForgotScreen(){
  var scr = document.getElementById('forgot-screen');
  if(scr) scr.style.display = 'none';
}

function submitForgotPassword(){
  var email = document.getElementById('forgot-email').value.trim();
  var status = document.getElementById('forgot-status');
  if(!email){ status.style.color='#ff9b9b'; status.textContent='Digite seu e-mail'; return; }
  if(email.indexOf('@')===-1){ status.style.color='#ff9b9b'; status.textContent='E-mail inválido'; return; }
  status.style.color='rgba(255,255,255,.6)';
  status.textContent='Enviando...';
  auth.sendPasswordResetEmail(email).then(function(){
    logAuditEvent('recuperacao_senha', {email:email});
    status.style.color='#7ee787';
    status.textContent='✓ E-mail enviado! Verifique sua caixa de entrada e spam.';
    setTimeout(closeForgotScreen, 3000);
  }).catch(function(e){
    status.style.color='#ff9b9b';
    status.textContent = _firebaseAuthError(e.code);
  });
}

// ═══════════════════════════════════════════════════════
// LGPD — Termos, Privacidade e Consentimento
// ═══════════════════════════════════════════════════════
var LEGAL_DOCS = {
  terms: {
    title: 'Termos de Uso',
    body: 'TERMOS DE USO — PLANNI\n\n1. ACEITAÇÃO\nAo usar o Planni, você concorda com estes termos.\n\n2. SERVIÇO\nO Planni é um aplicativo de gestão financeira pessoal que permite controlar receitas, despesas, investimentos, metas e compromissos.\n\n3. CONTA DO USUÁRIO\nVocê é responsável por manter a confidencialidade de sua senha e por todas as atividades realizadas em sua conta.\n\n4. USO ADEQUADO\nVocê concorda em usar o aplicativo apenas para fins legais e pessoais.\n\n5. DADOS FINANCEIROS\nOs dados inseridos são de sua responsabilidade. O aplicativo é uma ferramenta de organização, não constituindo aconselhamento financeiro profissional.\n\n6. PLANO PREMIUM\nRecursos premium estão sujeitos a assinatura mensal. O cancelamento pode ser feito a qualquer momento.\n\n7. LIMITAÇÃO DE RESPONSABILIDADE\nO Planni não se responsabiliza por decisões financeiras tomadas com base nas informações do aplicativo.\n\n8. ALTERAÇÕES\nEstes termos podem ser atualizados periodicamente.\n\nÚltima atualização: Junho de 2026'
  },
  privacy: {
    title: 'Política de Privacidade',
    body: 'POLÍTICA DE PRIVACIDADE — PLANNI\n\nEm conformidade com a Lei Geral de Proteção de Dados (LGPD - Lei 13.709/2018).\n\n1. DADOS COLETADOS\nColetamos: nome, e-mail, telefone, faixa de patrimônio e os dados financeiros que você insere voluntariamente.\n\n2. FINALIDADE\nSeus dados são usados para: fornecer o serviço, sincronizar entre dispositivos, melhorar o aplicativo e, mediante seu consentimento, enviar comunicações.\n\n3. ARMAZENAMENTO\nSeus dados são armazenados de forma segura no Google Firebase, com criptografia e regras de acesso restrito. Apenas você acessa seus próprios dados.\n\n4. COMPARTILHAMENTO\nNão vendemos nem compartilhamos seus dados pessoais com terceiros para fins comerciais.\n\n5. SEUS DIREITOS (LGPD)\nVocê pode a qualquer momento: acessar seus dados, corrigi-los, solicitar exclusão, revogar consentimento de marketing e exportar suas informações.\n\n6. CONSENTIMENTO DE MARKETING\nO envio de comunicações promocionais depende de seu consentimento explícito, que pode ser revogado a qualquer momento nas configurações do perfil.\n\n7. RETENÇÃO\nSeus dados são mantidos enquanto sua conta estiver ativa. Após exclusão, são removidos em até 30 dias.\n\n8. CONTATO\nPara exercer seus direitos, entre em contato pelo e-mail de suporte.\n\nÚltima atualização: Junho de 2026'
  }
};

function openLegalDoc(type){
  var doc = LEGAL_DOCS[type];
  if(!doc) return;
  document.getElementById('legal-modal-title').textContent = doc.title;
  document.getElementById('legal-modal-body').textContent = doc.body;
  document.getElementById('legal-modal').style.display = 'flex';
}
function closeLegalDoc(){
  document.getElementById('legal-modal').style.display = 'none';
}

// Revoke / grant marketing consent (called from profile)
function toggleMarketingConsent(){
  if(!currentUser||!currentUser.uid) return;
  db.collection('users').doc(currentUser.uid).get().then(function(doc){
    var current = doc.exists && doc.data().consent ? doc.data().consent.marketing : false;
    var newVal = !current;
    db.collection('users').doc(currentUser.uid).update({
      'consent.marketing': newVal,
      'consent.marketingUpdatedAt': new Date().toISOString()
    }).then(function(){
      toast(newVal ? '✓ Comunicações ativadas' : '✓ Comunicações desativadas');
      renderConsentStatus();
    });
  });
}

function renderConsentStatus(){
  if(!currentUser||!currentUser.uid) return;
  var el = document.getElementById('consent-status');
  if(!el) return;
  db.collection('users').doc(currentUser.uid).get().then(function(doc){
    var marketing = doc.exists && doc.data().consent ? doc.data().consent.marketing : false;
    el.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0">'
      +'<span style="font-size:12px;color:var(--ink2)">Receber comunicações e novidades</span>'
      +'<span style="font-size:11px;font-weight:800;color:'+(marketing?'var(--green)':'var(--ink3)')+';cursor:pointer" onclick="toggleMarketingConsent()">'
      +(marketing?'ATIVADO':'DESATIVADO')+'</span></div>';
  });
}

function _firebaseAuthError(code){
  var msgs={
    'auth/email-already-in-use':'E-mail já cadastrado. Faça login.',
    'auth/user-not-found':'E-mail não encontrado.',
    'auth/wrong-password':'Senha incorreta.',
    'auth/invalid-email':'E-mail inválido.',
    'auth/weak-password':'Senha fraca. Use pelo menos 6 caracteres.',
    'auth/too-many-requests':'Muitas tentativas. Tente mais tarde.',
    'auth/network-request-failed':'Sem conexão. Verifique sua internet.',
    'auth/invalid-credential':'E-mail ou senha incorretos.'
  };
  return msgs[code]||'Erro: '+code;
}
function openProfileModal(){
  updateUserUI();
  renderConsentStatus();
  applyFontScale();
  document.getElementById('profile-modal').classList.add('show');
}
function closeProfileModal(){ document.getElementById('profile-modal').classList.remove('show'); }

// ═══════════════════════════════════════════════════════
// BIOMETRIA
// ═══════════════════════════════════════════════════════
async function loginBiometric(){
  if(!window.PublicKeyCredential){ toast('Biometria não suportada neste dispositivo'); return; }
  try{
    const challenge=new Uint8Array(32); crypto.getRandomValues(challenge);
    const saved=localStorage.getItem('claudio_bio_cred');
    if(!saved){
      const cred=await navigator.credentials.create({publicKey:{
        challenge,rp:{name:'Planni'},
        user:{id:new Uint8Array(16),name:'user',displayName:'Usuário'},
        pubKeyCredParams:[{type:'public-key',alg:-7}],
        authenticatorSelection:{authenticatorAttachment:'platform',userVerification:'required'},
        timeout:60000
      }});
      localStorage.setItem('claudio_bio_cred',cred.id);
      const stored=localStorage.getItem('claudio_user');
      currentUser=stored?JSON.parse(stored):{name:'Usuário',email:'bio@local'};
      if(!currentUser.name) currentUser.name='Usuário';
      localStorage.setItem('claudio_user',JSON.stringify(currentUser));
      hideLoginScreen(); updateUserUI(); toast('✓ Biometria configurada!');
    } else {
      await navigator.credentials.get({publicKey:{challenge,timeout:60000,userVerification:'required'}});
      const stored=localStorage.getItem('claudio_user');
      currentUser=stored?JSON.parse(stored):{name:'Usuário',email:'bio@local'};
      hideLoginScreen(); updateUserUI(); toast('✓ Autenticado!');
    }
  }catch(e){ toast('Biometria não disponível ou cancelada'); }
}

let inactivityTimer;
function resetInactivity(){
  clearTimeout(inactivityTimer);
  inactivityTimer=setTimeout(()=>{ if(currentUser){ logout(); } },5*60*1000);
}
['touchstart','click','keydown'].forEach(ev=>document.addEventListener(ev,resetInactivity,{passive:true}));

// ═══════════════════════════════════════════════════════
// SHOWSCREEN + NAVTO — final versions
// ═══════════════════════════════════════════════════════
// showScreen - see unified version above
function navTo(name){
  // Find the tab whose onclick targets this screen (robust to tab order changes).
  // Screens like 'bills'/'dashboard' may have no tab — showScreen still handles them.
  var tabs=document.querySelectorAll('.tab');
  var tabEl=null;
  tabs.forEach(function(t){
    var oc=t.getAttribute('onclick')||'';
    if(oc.indexOf("showScreen('"+name+"'")!==-1) tabEl=t;
  });
  showScreen(name,tabEl);
  if(tabEl) tabEl.scrollIntoView({behavior:'smooth',block:'nearest',inline:'center'});
}

// ═══════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════
function buildDashboard(){ buildPatrimonyChart(); buildMonthlyCompare(); buildCashflowSummary(); buildPortfolioDonut(); }

function buildPatrimonyChart(){
  const el=document.getElementById('dash-patrimony'); if(!el) return;
  const meses=['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const months=[];
  for(let i=5;i>=0;i--){
    const d=new Date(); d.setMonth(d.getMonth()-i);
    const key=d.toISOString().slice(0,7);
    const txsUpTo=state.transactions.filter(t=>t.date<=key+'-31');
    const bal=Math.max(0,txsUpTo.reduce((s,t)=>s+(t.type==='in'?t.val:-t.val),0));
    const {totalCurrent}=calcInvTotals();
    const invEst=i===0?totalCurrent:totalCurrent*(0.88+i*0.024);
    months.push({label:meses[d.getMonth()],val:bal+Math.max(0,invEst)});
  }
  const maxVal=Math.max(...months.map(m=>m.val),1);
  const w=300,h=100,pad=10;
  const pts=months.map((m,i)=>{ const x=pad+(i/(months.length-1))*(w-pad*2); const y=h-pad-((m.val/maxVal)*(h-pad*2)); return x+','+y; }).join(' ');
  el.innerHTML=`<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:80px">
    <defs><linearGradient id="pg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#2d7dd2" stop-opacity=".25"/><stop offset="100%" stop-color="#2d7dd2" stop-opacity="0"/></linearGradient></defs>
    <polygon points="${pts} ${w-pad},${h} ${pad},${h}" fill="url(#pg)"/>
    <polyline points="${pts}" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    ${months.map((m,i)=>{ const x=pad+(i/(months.length-1))*(w-pad*2); const y=h-pad-((m.val/maxVal)*(h-pad*2)); return `<circle cx="${x}" cy="${y}" r="3" fill="#fff"/>`; }).join('')}
  </svg>
  <div style="display:flex;justify-content:space-between;margin-top:4px">
    ${months.map(m=>`<span style="font-size:9px;font-weight:700;color:rgba(255,255,255,.5)">${m.label}</span>`).join('')}
  </div>`;
}

function buildMonthlyCompare(){
  const el=document.getElementById('dash-compare'); if(!el) return;
  const meses=['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const months=[];
  for(let i=3;i>=0;i--){
    const d=new Date(); d.setMonth(d.getMonth()-i);
    const key=d.toISOString().slice(0,7);
    const txs=state.transactions.filter(t=>t.date.startsWith(key));
    months.push({label:meses[d.getMonth()],inc:txs.filter(t=>t.type==='in').reduce((s,t)=>s+t.val,0),exp:txs.filter(t=>t.type==='out').reduce((s,t)=>s+t.val,0)});
  }
  const maxVal=Math.max(...months.reduce(function(a,m){return a.concat([m.inc,m.exp]);},[]),1);
  el.innerHTML=months.map(m=>{
    const iH=Math.max(4,(m.inc/maxVal*70)).toFixed(0);
    const eH=Math.max(4,(m.exp/maxVal*70)).toFixed(0);
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:3px;flex:1">
      <div style="width:100%;display:flex;flex-direction:column;justify-content:flex-end;gap:2px;height:70px">
        <div style="height:${iH}px;background:var(--green);border-radius:3px 3px 0 0"></div>
        <div style="height:${eH}px;background:var(--red);border-radius:3px 3px 0 0"></div>
      </div>
      <span style="font-size:9px;font-weight:700;color:var(--ink3)">${m.label}</span>
    </div>`;
  }).join('');
}

function buildCashflowSummary(){
  const el=document.getElementById('dash-cashflow'); if(!el) return;
  const month=new Date().toISOString().slice(0,7);
  const txs=state.transactions.filter(t=>t.date.startsWith(month));
  const inc=txs.filter(t=>t.type==='in').reduce((s,t)=>s+t.val,0);
  const exp=txs.filter(t=>t.type==='out').reduce((s,t)=>s+t.val,0);
  const rate=inc>0?Math.min(100,(exp/inc*100)):0;
  el.innerHTML=`<div style="display:flex;gap:8px;margin-bottom:10px">
    <div style="flex:1;background:#e6f9f0;border-radius:var(--r);padding:12px;text-align:center">
      <div style="font-size:18px;font-weight:900;color:var(--green)">R$${fm0(inc)}</div>
      <div style="font-size:9px;font-weight:700;color:var(--green);margin-top:2px;letter-spacing:.08em">RECEITAS</div>
    </div>
    <div style="flex:1;background:#fde8e6;border-radius:var(--r);padding:12px;text-align:center">
      <div style="font-size:18px;font-weight:900;color:var(--red)">R$${fm0(exp)}</div>
      <div style="font-size:9px;font-weight:700;color:var(--red);margin-top:2px;letter-spacing:.08em">DESPESAS</div>
    </div>
  </div>
  <div style="font-size:11px;font-weight:600;color:var(--ink2);margin-bottom:6px">Comprometimento da renda: <strong style="color:${rate>80?'var(--red)':rate>60?'var(--orange)':'var(--green)'}">${rate.toFixed(0)}%</strong></div>
  <div style="height:8px;background:var(--sky-xl);border-radius:4px;overflow:hidden">
    <div style="height:100%;width:${rate}%;background:${rate>80?'var(--red)':rate>60?'var(--orange)':'var(--green)'};border-radius:4px;transition:width .6s ease"></div>
  </div>`;
}

function buildPortfolioDonut(){
  const el=document.getElementById('dash-portfolio'); if(!el) return;
  const {fixaTotal,acoesTotal,criptoTotal,totalCurrent}=calcInvTotals();
  if(totalCurrent===0){ el.innerHTML='<div class="empty"><div class="empty-icon">📊</div>Adicione investimentos para ver a distribuição</div>'; return; }
  const items=[{label:'Renda Fixa',val:fixaTotal,color:'#2d7dd2'},{label:'Ações',val:acoesTotal,color:'#18a058'},{label:'Cripto',val:criptoTotal,color:'#e07d1a'}].filter(i=>i.val>0);
  const size=120,r=44,cx=60,cy=60;
  let startAngle=-Math.PI/2; let slices='';
  items.forEach(item=>{
    const angle=(item.val/totalCurrent)*2*Math.PI;
    const x1=cx+r*Math.cos(startAngle),y1=cy+r*Math.sin(startAngle);
    const x2=cx+r*Math.cos(startAngle+angle),y2=cy+r*Math.sin(startAngle+angle);
    const large=angle>Math.PI?1:0;
    slices+=`<path d="M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large},1 ${x2},${y2} Z" fill="${item.color}" opacity=".85"/>`;
    startAngle+=angle;
  });
  el.innerHTML=`<div style="display:flex;align-items:center;gap:16px">
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="flex-shrink:0">
      ${slices}
      <circle cx="${cx}" cy="${cy}" r="26" fill="var(--white)"/>
      <text x="${cx}" y="${cy+4}" text-anchor="middle" font-size="9" font-weight="800" fill="var(--ink2)">R$${fm0(totalCurrent)}</text>
    </svg>
    <div style="flex:1">${items.map(i=>`<div style="display:flex;justify-content:space-between;margin-bottom:8px"><div style="display:flex;align-items:center;gap:6px"><div style="width:10px;height:10px;border-radius:3px;background:${i.color}"></div><span style="font-size:12px;font-weight:600;color:var(--ink2)">${i.label}</span></div><span style="font-size:12px;font-weight:800;color:var(--ink)">${(i.val/totalCurrent*100).toFixed(1)}%</span></div>`).join('')}</div>
  </div>`;
}

// ═══════════════════════════════════════════════════════
// IA FINANCEIRA
// ═══════════════════════════════════════════════════════
function buildAIBriefing(){
  const el=document.getElementById('ai-briefing'); if(!el) return;
  const insights=generateInsights();
  if(!insights.length){ el.textContent='Adicione transações para receber seu briefing financeiro personalizado.'; return; }
  const top=insights[0];
  el.innerHTML=`<strong>${top.title}:</strong> ${top.text}`;
}

function generateInsights(){
  const insights=[];
  const now=new Date();
  const thisMonth=now.toISOString().slice(0,7);
  const lastMonth=new Date(now.getFullYear(),now.getMonth()-1).toISOString().slice(0,7);
  const txThis=state.transactions.filter(t=>t.date.startsWith(thisMonth));
  const txLast=state.transactions.filter(t=>t.date.startsWith(lastMonth));
  const expThis=txThis.filter(t=>t.type==='out').reduce((s,t)=>s+t.val,0);
  const expLast=txLast.filter(t=>t.type==='out').reduce((s,t)=>s+t.val,0);
  const incThis=txThis.filter(t=>t.type==='in').reduce((s,t)=>s+t.val,0);

  // Gastos vs mês anterior
  if(expLast>0&&expThis>0){
    const diff=((expThis-expLast)/expLast*100).toFixed(1);
    if(Math.abs(diff)>3) insights.push({icon:diff>0?'📈':'📉',title:diff>0?'Gastos aumentaram':'Gastos reduziram',text:`Você gastou ${Math.abs(diff)}% ${diff>0?'mais':'menos'} este mês vs anterior (R$${fm(expThis)} vs R$${fm(expLast)}).`,color:diff>0?'var(--red)':'var(--green)'});
  }

  // Categoria dominante
  const cats={};
  txThis.filter(t=>t.type==='out').forEach(t=>{ cats[t.cat]=(cats[t.cat]||0)+t.val; });
  const topCat=Object.entries(cats).sort((a,b)=>b[1]-a[1])[0];
  if(topCat&&expThis>0){ const ci=getCatInfo(topCat[0]); const pct=(topCat[1]/expThis*100).toFixed(0); insights.push({icon:ci.icon,title:`${ci.label} lidera os gastos`,text:`${pct}% das despesas este mês — R$${fm(topCat[1])} de R$${fm(expThis)}.`,color:'var(--orange)'}); }

  // Reserva de emergência
  if(expThis>0){
    const reserva=expThis*6;
    const {totalCurrent}=calcInvTotals();
    const totalLiquido=Math.max(0,calcBalance(thisMonth))+totalCurrent;
    const meses=(totalLiquido/expThis).toFixed(1);
    insights.push({icon:'🛡️',title:'Reserva de emergência',text:`Ideal: R$${fm(reserva)} (6 meses). Você tem R$${fm(totalLiquido)} — ${meses} meses de cobertura.`,color:parseFloat(meses)>=6?'var(--green)':parseFloat(meses)>=3?'var(--orange)':'var(--red)'});
  }

  // Projeção do mês
  if(incThis>0&&expThis>0){
    const dailyBurn=expThis/now.getDate();
    const daysLeft=new Date(now.getFullYear(),now.getMonth()+1,0).getDate()-now.getDate();
    const projExp=expThis+dailyBurn*daysLeft;
    const projSaldo=incThis-projExp;
    insights.push({icon:projSaldo>0?'🔮':'⚠️',title:'Projeção do mês',text:`Ritmo atual: R$${fm(projExp)} de gastos previstos. Saldo projetado: ${projSaldo>=0?'+':''}R$${fm(projSaldo)}.`,color:projSaldo>0?'var(--sky)':'var(--red)'});
  }

  // Performance investimentos
  const {totalCurrent,totalInvested}=calcInvTotals();
  if(totalInvested>0){
    const result=totalCurrent-totalInvested;
    const pct=((result/totalInvested)*100).toFixed(2);
    insights.push({icon:'📊',title:'Performance da carteira',text:`Resultado líquido: ${pct>=0?'+':''}${pct}% — ${result>=0?'lucro':'perda'} de R$${fm(Math.abs(result))} sobre R$${fm(totalInvested)} investidos.`,color:result>=0?'var(--green)':'var(--red)'});
  }

  // Contas em atraso
  const overdue=(state.bills||[]).filter(b=>(b.kind==='avulsa'&&!b.paid&&b.status==='atrasada')||(b.kind==='financ'&&b.status==='atrasado'));
  if(overdue.length>0){ const total=overdue.reduce((s,b)=>s+(b.value||b.parcel||0),0); insights.push({icon:'🚨',title:`${overdue.length} conta${overdue.length>1?'s':''} em atraso`,text:`Total em atraso: R$${fm(total)}. Regularize para evitar juros.`,color:'var(--red)'}); }

  // Sugestão de economia
  if(expThis>incThis*0.9&&incThis>0) insights.push({icon:'💡',title:'Sugestão de economia',text:`Suas despesas representam ${(expThis/incThis*100).toFixed(0)}% da renda. Tente reduzir ${getCatInfo(topCat&&topCat[0]?topCat[0]:'outros'||'outros').label.toLowerCase()} para equilibrar o orçamento.`,color:'var(--sky)'});

  return insights;
}

function buildAISuggestions(){
  const el=document.getElementById('ai-insights'); if(!el) return;
  buildAIBriefing();
  const insights=generateInsights();
  el.innerHTML=insights.length?insights.map(i=>`
    <div class="ai-insight-item">
      <div style="font-size:22px;flex-shrink:0">${i.icon}</div>
      <div>
        <div style="font-size:12px;font-weight:800;color:${i.color};margin-bottom:3px">${i.title}</div>
        <div style="font-size:12px;font-weight:500;color:var(--ink2);line-height:1.5">${i.text}</div>
      </div>
    </div>`).join(''):'<div class="empty"><div class="empty-icon">🤖</div>Adicione transações para receber análises</div>';
}

// ── Carrossel de insights na Início ──
// Paleta de fundos suaves conforme a cor do insight
function _insightBg(color){
  if(color==='var(--red)')   return {bg:'linear-gradient(135deg,#fde8e6,#fbd5d0)', fg:'#b02010', tx:'#7a2018'};
  if(color==='var(--green)') return {bg:'linear-gradient(135deg,#e6f9f0,#ccf2e0)', fg:'#0e7040', tx:'#0c5a34'};
  if(color==='var(--orange)')return {bg:'linear-gradient(135deg,#fff3dc,#ffe6bf)', fg:'#b9701a', tx:'#8a5414'};
  return {bg:'linear-gradient(135deg,#eaf3ff,#d6e9ff)', fg:'#1a5faa', tx:'#0f3a6b'}; // sky / default
}
function renderHomeInsights(){
  var wrap=document.getElementById('home-insights-wrap');
  var track=document.getElementById('insights-track');
  var dots=document.getElementById('insights-dots');
  if(!wrap||!track) return;
  var insights=[];
  try{ insights=generateInsights(); }catch(e){ insights=[]; }
  if(!insights.length){ wrap.style.display='none'; track.innerHTML=''; if(dots) dots.innerHTML=''; return; }
  wrap.style.display='block';
  track.innerHTML=insights.map(function(i){
    var c=_insightBg(i.color);
    return '<div class="insight-card" style="background:'+c.bg+'">'
      +'<div class="ic-icon">'+i.icon+'</div>'
      +'<div class="ic-title" style="color:'+c.fg+'">'+i.title+'</div>'
      +'<div class="ic-text" style="color:'+c.tx+'">'+i.text+'</div>'
      +'</div>';
  }).join('');
  if(dots){
    dots.innerHTML=insights.map(function(_,idx){ return '<div class="insight-dot'+(idx===0?' on':'')+'"></div>'; }).join('');
  }
  _syncInsightDots();
}
function _syncInsightDots(){
  var track=document.getElementById('insights-track');
  var dots=document.getElementById('insights-dots');
  if(!track||!dots) return;
  var cards=track.children;
  if(!cards.length) return;
  var cardW=cards[0].offsetWidth+10; // width + gap
  var idx=Math.round(track.scrollLeft/cardW);
  var dotEls=dots.children;
  for(var i=0;i<dotEls.length;i++){
    if(i===idx) dotEls[i].classList.add('on'); else dotEls[i].classList.remove('on');
  }
}

// ═══════════════════════════════════════════════════════
// RELATÓRIOS
// ═══════════════════════════════════════════════════════
function buildAnnualSummary(){
  const el=document.getElementById('annual-summary'); if(!el) return;
  const year=new Date().getFullYear().toString();
  const meses=['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const rows=meses.map((m,i)=>{
    const key=year+'-'+String(i+1).padStart(2,'0');
    const txs=state.transactions.filter(t=>t.date.startsWith(key));
    const inc=txs.filter(t=>t.type==='in').reduce((s,t)=>s+t.val,0);
    const exp=txs.filter(t=>t.type==='out').reduce((s,t)=>s+t.val,0);
    const bal=inc-exp;
    if(!inc&&!exp) return '';
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1.5px solid var(--border)">
      <span style="font-size:12px;font-weight:700;color:var(--ink);min-width:32px">${m}</span>
      <span style="font-size:11px;font-weight:700;color:var(--green);font-family:var(--font-mono)">+R$${fm0(inc)}</span>
      <span style="font-size:11px;font-weight:700;color:var(--red);font-family:var(--font-mono)">-R$${fm0(exp)}</span>
      <span style="font-size:11px;font-weight:800;color:${bal>=0?'var(--sky)':'var(--red)'};font-family:var(--font-mono)">${bal>=0?'+':''}R$${fm0(bal)}</span>
    </div>`;
  }).filter(Boolean).join('');
  const totalInc=state.transactions.filter(t=>t.date.startsWith(year)&&t.type==='in').reduce((s,t)=>s+t.val,0);
  const totalExp=state.transactions.filter(t=>t.date.startsWith(year)&&t.type==='out').reduce((s,t)=>s+t.val,0);
  el.innerHTML=`<div style="display:flex;justify-content:space-between;margin-bottom:8px">
    <span style="font-size:10px;font-weight:800;color:var(--ink3);letter-spacing:.08em">MÊS</span>
    <span style="font-size:10px;font-weight:800;color:var(--green);letter-spacing:.08em">RECEITA</span>
    <span style="font-size:10px;font-weight:800;color:var(--red);letter-spacing:.08em">DESPESA</span>
    <span style="font-size:10px;font-weight:800;color:var(--sky);letter-spacing:.08em">SALDO</span>
  </div>
  ${rows||'<div class="empty" style="padding:20px 0">Sem dados para '+year+'</div>'}
  ${rows?`<div style="display:flex;justify-content:space-between;padding:10px 0;border-top:2px solid var(--sky);margin-top:4px">
    <span style="font-size:11px;font-weight:800;color:var(--ink)">TOTAL ${year}</span>
    <span style="font-size:11px;font-weight:900;color:var(--green);font-family:var(--font-mono)">+R$${fm0(totalInc)}</span>
    <span style="font-size:11px;font-weight:900;color:var(--red);font-family:var(--font-mono)">-R$${fm0(totalExp)}</span>
    <span style="font-size:11px;font-weight:900;color:${totalInc-totalExp>=0?'var(--sky)':'var(--red)'};font-family:var(--font-mono)">${totalInc-totalExp>=0?'+':''}R$${fm0(totalInc-totalExp)}</span>
  </div>`:''}`;
}

function buildMonthlyEvolution(){
  const el=document.getElementById('monthly-evolution'); if(!el) return;
  const meses=['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const months=[];
  for(let i=5;i>=0;i--){
    const d=new Date(); d.setMonth(d.getMonth()-i);
    const key=d.toISOString().slice(0,7);
    const txs=state.transactions.filter(t=>t.date.startsWith(key));
    months.push({label:meses[d.getMonth()],bal:txs.reduce((s,t)=>s+(t.type==='in'?t.val:-t.val),0)});
  }
  const maxAbs=Math.max(...months.map(m=>Math.abs(m.bal)),1);
  el.innerHTML=`<div class="dash-section-title" style="margin-top:0">Saldo mensal — últimos 6 meses</div>`+months.map(m=>{
    const w=(Math.abs(m.bal)/maxAbs*100).toFixed(0);
    return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <span style="font-size:11px;font-weight:700;color:var(--ink3);min-width:28px">${m.label}</span>
      <div style="flex:1;height:22px;background:var(--sky-xl);border-radius:6px;overflow:hidden">
        <div style="height:100%;width:${w}%;background:${m.bal>=0?'var(--green)':'var(--red)'};border-radius:6px;transition:width .5s ease;display:flex;align-items:center;justify-content:flex-end;padding-right:6px">
          <span style="font-size:10px;font-weight:800;color:#fff;white-space:nowrap">${m.bal>=0?'+':''}R$${fm0(m.bal)}</span>
        </div>
      </div>
    </div>`;
  }).join('');
}

// ═══════════════════════════════════════════════════════
// IMPORTAÇÃO OFX / CSV
// ═══════════════════════════════════════════════════════
function openImportModal(){ closeProfileModal(); setTimeout(()=>navTo('ai'),200); }

function handleImportFile(input){
  const file=input.files[0]; if(!file) return;
  const ext=file.name.split('.').pop().toLowerCase();
  const reader=new FileReader();
  reader.onload=e=>{
    try{
      let imported=0;
      if(ext==='ofx') imported=parseOFX(e.target.result);
      else if(ext==='csv'||ext==='txt') imported=parseCSV(e.target.result);
      else{ toast('Use OFX ou CSV'); return; }
      save(); renderFinance(); updateHome();
      toast('✓ '+imported+' transações importadas!');
    }catch(err){ toast('Erro: '+err.message); }
  };
  reader.readAsText(file,'utf-8');
  input.value='';
}

function parseOFX(content){
  let count=0;
  const txRegex=/<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi; let match;
  while((match=txRegex.exec(content))!==null){
    const block=match[1];
    const get=tag=>{ const m=block.match(new RegExp('<'+tag+'>([^<\n\r]+)')); return m?m[1].trim():''; };
    const amount=parseFloat(get('TRNAMT').replace(',','.'));
    const dateRaw=get('DTPOSTED').slice(0,8);
    const date=dateRaw.slice(0,4)+'-'+dateRaw.slice(4,6)+'-'+dateRaw.slice(6,8);
    const memo=get('MEMO')||get('NAME')||'Importado OFX';
    if(!isNaN(amount)&&date.length===10){
      state.transactions.push({id:uid(),desc:memo,val:Math.abs(amount),type:amount>=0?'in':'out',cat:detectCat(memo.toLowerCase()),date,imported:true});
      count++;
    }
  }
  return count;
}

function parseCSV(content){
  const lines=content.split('\n').filter(l=>l.trim()); let count=0;
  const sep=lines[0].includes(';')?';':',';
  const header=lines[0].toLowerCase().split(sep).map(h=>h.trim().replace(/"/g,'').replace(/\r/g,''));
  const iDate=header.findIndex(h=>h.includes('data')||h.includes('date'));
  const iDesc=header.findIndex(h=>h.includes('desc')||h.includes('hist')||h.includes('memo')||h.includes('lan'));
  const iVal=header.findIndex(h=>h.includes('valor')||h.includes('value')||h.includes('amount'));
  if(iDate===-1||iVal===-1) throw new Error('Colunas Data/Valor não encontradas');
  lines.slice(1).forEach(line=>{
    const cols=line.split(sep).map(c=>c.trim().replace(/"/g,'').replace(/\r/g,''));
    const dateRaw=cols[iDate]||''; const valRaw=cols[iVal]||'';
    const desc=(cols[iDesc]||'Importado').slice(0,80);
    if(!dateRaw||!valRaw) return;
    let date=dateRaw;
    if(dateRaw.includes('/')){ const parts=dateRaw.split('/'); date=`${parts[2].length===4?parts[2]:'20'+parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`; }
    const val=Math.abs(parseFloat(valRaw.replace(/\./g,'').replace(',','.')));
    if(isNaN(val)||val===0) return;
    const type=parseFloat(cols[iVal].replace(/\./g,'').replace(',','.'))<0?'out':'in';
    state.transactions.push({id:uid(),desc,val,type,cat:detectCat(desc.toLowerCase()),date,imported:true});
    count++;
  });
  return count;
}

// ═══════════════════════════════════════════════════════
// RELATÓRIOS PDF / EXCEL
// ═══════════════════════════════════════════════════════
function generatePDFReport(){
  const month=state.viewMonth;
  const meses=['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const [y,m]=month.split('-');
  const monthLabel=meses[parseInt(m)-1]+' '+y;
  const txs=state.transactions.filter(t=>t.date.startsWith(month));
  const inc=txs.filter(t=>t.type==='in').reduce((s,t)=>s+t.val,0);
  const exp=txs.filter(t=>t.type==='out').reduce((s,t)=>s+t.val,0);
  const bal=inc-exp;
  const {totalCurrent}=calcInvTotals();
  const cats={};
  txs.filter(t=>t.type==='out').forEach(t=>{ cats[t.cat]=(cats[t.cat]||0)+t.val; });
  const catRows=Object.entries(cats).sort((a,b)=>b[1]-a[1]).map(([cat,val])=>{ const ci=getCatInfo(cat); return '<tr><td>'+ci.icon+' '+ci.label+'<\/td><td style="text-align:right;color:#e0422d">R$ '+fm(val)+'<\/td><td style="text-align:right">'+(exp>0?(val/exp*100).toFixed(1):'0')+'%<\/td><\/tr>'; }).join('');
  const txRows=txs.slice(0,60).map(t=>{ const ci=getCatInfo(t.cat); return '<tr><td>'+t.date+'<\/td><td>'+t.desc+'<\/td><td>'+ci.label+'<\/td><td style="text-align:right;color:'+(t.type==='in'?'#18a058':'#e0422d')+'">'+(t.type==='in'?'+':'-')+'R$ '+fm(t.val)+'<\/td><\/tr>'; }).join('');
  const css='body{font-family:Arial,sans-serif;font-size:12px;color:#0d1f3c;margin:0;padding:20px}h1{font-size:22px;color:#2d7dd2;margin-bottom:4px}h2{font-size:14px;color:#3a5070;margin:20px 0 8px;border-bottom:2px solid #d0e2f5;padding-bottom:4px}.header{display:flex;justify-content:space-between;margin-bottom:20px;padding-bottom:12px;border-bottom:2px solid #2d7dd2}.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px}.sum-box{background:#f0f6ff;border-radius:8px;padding:12px;text-align:center}.sum-val{font-size:18px;font-weight:900}.sum-label{font-size:10px;color:#8099b8;margin-top:2px;text-transform:uppercase}table{width:100%;border-collapse:collapse;margin-bottom:16px}th{background:#2d7dd2;color:white;padding:8px;text-align:left;font-size:11px}td{padding:7px 8px;border-bottom:1px solid #d0e2f5;font-size:11px}tr:nth-child(even){background:#f0f6ff}.footer{margin-top:20px;font-size:10px;color:#8099b8;text-align:center}@media print{body{padding:0}.noprint{display:none!important}}';
  const toolbar='<div class="noprint" style="position:sticky;top:0;display:flex;gap:10px;justify-content:space-between;align-items:center;background:#2d7dd2;padding:12px 20px;margin:-20px -20px 20px;flex-wrap:wrap">'
    +'<button onclick="window.close()" style="background:#fff;color:#2d7dd2;border:none;border-radius:100px;padding:9px 18px;font-size:13px;font-weight:800;cursor:pointer">\u2190 Voltar ao Planni<\/button>'
    +'<button onclick="window.print()" style="background:rgba(255,255,255,.2);color:#fff;border:1.5px solid #fff;border-radius:100px;padding:9px 18px;font-size:13px;font-weight:800;cursor:pointer">\ud83d\udda8 Imprimir / Salvar PDF<\/button>'
    +'<\/div>';
  const reportHTML='<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+"<"+"style>"+css+"<\/style><\/head><body>"
    +toolbar
    +'<div class="header"><div><h1>Planni<\/h1><div style="font-size:13px;color:#8099b8">Demonstrativo — '+monthLabel+'<\/div><\/div><div style="font-size:11px;color:#8099b8">Gerado: '+new Date().toLocaleDateString('pt-BR')+'<\/div><\/div>'
    +'<div class="summary">'
    +'<div class="sum-box"><div class="sum-val" style="color:#18a058">R$ '+fm(inc)+'<\/div><div class="sum-label">Receitas<\/div><\/div>'
    +'<div class="sum-box"><div class="sum-val" style="color:#e0422d">R$ '+fm(exp)+'<\/div><div class="sum-label">Despesas<\/div><\/div>'
    +'<div class="sum-box"><div class="sum-val" style="color:'+(bal>=0?'#18a058':'#e0422d')+'">'+(bal>=0?'+':'')+'R$ '+fm(bal)+'<\/div><div class="sum-label">Saldo<\/div><\/div>'
    +'<div class="sum-box"><div class="sum-val" style="color:#2d7dd2">R$ '+fm(totalCurrent)+'<\/div><div class="sum-label">Investimentos<\/div><\/div>'
    +'<\/div>'
    +'<h2>Por Categoria<\/h2><table><thead><tr><th>Categoria<\/th><th style="text-align:right">Valor<\/th><th style="text-align:right">%<\/th><\/tr><\/thead><tbody>'+(catRows||'<tr><td colspan="3">Sem despesas<\/td><\/tr>')+'<\/tbody><\/table>'
    +'<h2>Extrato<\/h2><table><thead><tr><th>Data<\/th><th>Descrição<\/th><th>Categoria<\/th><th style="text-align:right">Valor<\/th><\/tr><\/thead><tbody>'+(txRows||'<tr><td colspan="4">Sem movimentações<\/td><\/tr>')+'<\/tbody><\/table>'
    +'<div class="footer">Planni — Você fala. Ele registra.<\/div>'
    +'<\/body><\/html>';
  const win=window.open('','_blank');
  if(win){ win.document.write(reportHTML); win.document.close(); setTimeout(()=>win.print(),500); }
  else toast('Permita pop-ups para gerar o PDF');
}

function generateExcelReport(){
  const month=state.viewMonth;
  const txs=state.transactions.filter(t=>t.date.startsWith(month));
  let csv='\uFEFFData,Descrição,Tipo,Categoria,Valor,Recorrente\n';
  txs.forEach(t=>{ const ci=getCatInfo(t.cat); csv+=`${t.date},"${t.desc}",${t.type==='in'?'Entrada':'Saída'},"${ci.label}","R$ ${fm(t.val)}","${t.recur&&t.recur!=='0'?t.recur:'Não'}"\n`; });
  const inc=txs.filter(t=>t.type==='in').reduce((s,t)=>s+t.val,0);
  const exp=txs.filter(t=>t.type==='out').reduce((s,t)=>s+t.val,0);
  csv+=`\n"TOTAL RECEITAS","","","","R$ ${fm(inc)}",""\n"TOTAL DESPESAS","","","","R$ ${fm(exp)}",""\n"SALDO","","","","R$ ${fm(inc-exp)}",""\n`;
  const blob=new Blob([csv],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download='planni-'+month+'.csv'; a.click();
  URL.revokeObjectURL(url);
  toast('✓ Exportado para Excel!');
}

// ════════════ AI CHAT AGENT ════════════
var _aiChatHistory = [];

// ═══════════════════════════════════════════════════════
// IMPORTAÇÃO DE EXTRATO VIA CHAT (Camada 1 — anexo + IA categoriza + confirmação)
// O arquivo é lido no navegador, enviado para análise, e NUNCA fica salvo —
// só as transações já estruturadas (depois de confirmadas) entram no Finanças.
// ═══════════════════════════════════════════════════════
function _aiAddBubble(text, cls){
  var box=document.getElementById('ai-chat-messages');
  if(!box) return null;
  var div=document.createElement('div');
  div.className='ai-bubble '+cls;
  div.innerHTML=text;
  box.appendChild(div);
  box.scrollTop=box.scrollHeight;
  return div;
}

var _extratoPendingTx = null; // transações aguardando confirmação do usuário

function openExtratoPicker(){
  if(!isPremium){ openPremiumModal(); return; }
  // Orientação (mostra uma vez por sessão): OFX/CSV é melhor que PDF
  if(!_extratoDicaMostrada){
    _extratoDicaMostrada = true;
    _aiAddBubble('💡 Dica: para importar seu extrato, prefira baixar em <b>OFX</b> ou <b>CSV</b> no app do seu banco (procure por "exportar extrato" ou "extrato para software financeiro"). É instantâneo, funciona offline e mais preciso.<br><br>PDF e foto também funcionam, mas dependem de conexão e podem demorar.','ai-bot');
  }
  var input = document.getElementById('extrato-file-input');
  if(input) input.click();
}
var _extratoDicaMostrada = false;

// Carrega o PDF.js sob demanda (uma vez, fica em cache). Resolve quando pronto.
var _pdfjsLoading = null;
function _ensurePdfJs(){
  if(window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if(_pdfjsLoading) return _pdfjsLoading;
  _pdfjsLoading = new Promise(function(resolve, reject){
    var s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    s.onload = function(){
      try{
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        resolve(window.pdfjsLib);
      }catch(e){ reject(e); }
    };
    s.onerror = function(){ reject(new Error('Falha ao carregar PDF.js')); };
    document.head.appendChild(s);
  });
  return _pdfjsLoading;
}

// Extrai o texto de um PDF no proprio navegador. Retorna string (vazia se for PDF escaneado).
async function _extractPdfText(file, password){
  var lib = await _ensurePdfJs();
  var buf = await file.arrayBuffer();
  var params = { data: buf };
  if(password) params.password = password;
  var pdf = await lib.getDocument(params).promise;
  var fullText = '';
  for(var p=1; p<=pdf.numPages; p++){
    var page = await pdf.getPage(p);
    var content = await page.getTextContent();
    var pageText = content.items.map(function(it){ return it.str; }).join(' ');
    fullText += pageText + '\n';
  }
  return fullText.trim();
}

// Verifica se um erro do PDF.js e de senha (protegido ou senha incorreta)
function _isPdfPasswordError(err){
  if(!err) return false;
  var nome = err.name || '';
  var msg = (err.message || '').toLowerCase();
  return nome === 'PasswordException' || msg.indexOf('password') !== -1;
}

function handleExtratoFile(input){
  var file = input.files[0];
  if(!file) return;
  var ext = file.name.split('.').pop().toLowerCase();
  var maxSizeMb = 8;
  if(file.size > maxSizeMb*1024*1024){
    toast('Arquivo muito grande (máx '+maxSizeMb+'MB)');
    input.value=''; return;
  }

  _aiAddBubble('📎 '+file.name, 'ai-user');
  var proc = _aiAddBubble('<span class="extrato-processing">🔎 Lendo seu extrato e categorizando as transações...</span>', 'ai-bot');

  var isImage = file.type.indexOf('image/') === 0;
  var isPdf = file.type === 'application/pdf' || ext === 'pdf';

  // ===== PDF: tenta extrair texto no navegador (PDF.js) antes de enviar =====
  // Isso evita "Load failed" em PDFs grandes e leva o texto direto ao parser nativo.
  // Se o PDF for protegido por senha (ex: C6 pede 6 primeiros digitos do CPF), pede a senha.
  if(isPdf){
    _processPdf(file, proc, null);
    input.value = '';
    return;
  }

  // ===== Imagem ou texto (CSV/OFX) =====
  var reader = new FileReader();
  reader.onload = function(e){
    var payload = {};
    if(isImage){
      var base64 = String(e.target.result).split(',')[1];
      payload.image = base64;
      payload.mime = file.type || 'image/jpeg';
    } else {
      payload.text = String(e.target.result);
      payload.filename = file.name || '';
    }
    _sendToExtratoAPI(payload, proc);
  };
  reader.onerror = function(){
    if(proc) proc.remove();
    _aiAddBubble('Não consegui ler o arquivo. Tente novamente ou use outro formato (OFX, CSV ou foto do extrato).','ai-bot');
  };

  if(isImage) reader.readAsDataURL(file);
  else reader.readAsText(file, 'utf-8');

  input.value = '';
}

// Fallback: envia o PDF como imagem (para PDFs escaneados, sem texto).
// Avisa se o arquivo for grande demais para o envio base64.
// Processa um PDF: extrai texto (com senha se necessario) e envia.
// Se o PDF for protegido, mostra um campo para o usuario digitar a senha (ex: 6 primeiros do CPF).
function _processPdf(file, proc, password){
  _extractPdfText(file, password).then(function(pdfText){
    if(pdfText && pdfText.length > 30){
      _sendToExtratoAPI({ text: pdfText, filename: file.name || '' }, proc);
    } else {
      _pdfAsImageFallback(file, proc);
    }
  }).catch(function(err){
    if(_isPdfPasswordError(err)){
      // PDF protegido por senha: pede ao usuario
      if(proc) proc.remove();
      var jaErrou = !!password; // se ja tinha senha, ela estava errada
      _askPdfPassword(file, jaErrou);
    } else {
      // Outro erro: tenta como imagem
      _pdfAsImageFallback(file, proc);
    }
  });
}

// Mostra um balao com campo de senha para PDF protegido. Processamento 100% local.
function _askPdfPassword(file, erro){
  var msg = erro
    ? '🔒 Senha incorreta. Esse extrato está protegido — digite novamente (geralmente os 6 primeiros dígitos do seu CPF):'
    : '🔒 Esse extrato está protegido por senha. Digite a senha para abrir (no C6, são os 6 primeiros dígitos do seu CPF). Ela é usada só aqui no seu aparelho e não é enviada a lugar nenhum:';
  var bubble = _aiAddBubble(msg, 'ai-bot');

  // Campo de senha inline dentro do balao
  var wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;gap:8px;margin-top:10px';
  var inp = document.createElement('input');
  inp.type = 'tel';
  inp.inputMode = 'numeric';
  inp.autocomplete = 'off';
  inp.placeholder = 'Senha do extrato';
  inp.style.cssText = 'flex:1;border:1.5px solid #d6e0ea;border-radius:100px;padding:10px 14px;font-size:15px;outline:none;font-family:inherit';
  var btn = document.createElement('button');
  btn.textContent = 'Abrir';
  btn.style.cssText = 'border:none;border-radius:100px;padding:10px 18px;font-weight:800;font-size:14px;color:#fff;background:linear-gradient(160deg,#2d6c97,#1c4a6e);cursor:pointer';

  function submit(){
    var senha = inp.value.trim();
    if(!senha){ inp.focus(); return; }
    wrap.remove();
    var proc2 = _aiAddBubble('<span class="extrato-processing">🔓 Abrindo o extrato protegido...</span>', 'ai-bot');
    _processPdf(file, proc2, senha);
  }
  btn.onclick = submit;
  inp.addEventListener('keydown', function(e){ if(e.key==='Enter') submit(); });

  wrap.appendChild(inp);
  wrap.appendChild(btn);
  if(bubble) bubble.appendChild(wrap);
  setTimeout(function(){ inp.focus(); }, 200);
}

function _pdfAsImageFallback(file, proc){
  if(file.size > 1.2*1024*1024){
    if(proc) proc.remove();
    _aiAddBubble('Esse PDF parece ser uma imagem digitalizada e é grande demais para processar. Tente exportar o extrato do seu banco em CSV ou OFX, ou envie um print de melhor qualidade.','ai-bot');
    return;
  }
  var reader = new FileReader();
  reader.onload = function(e){
    var base64 = String(e.target.result).split(',')[1];
    _sendToExtratoAPI({ image: base64, mime: 'application/pdf' }, proc);
  };
  reader.onerror = function(){
    if(proc) proc.remove();
    _aiAddBubble('Não consegui ler o arquivo. Tente CSV ou OFX.','ai-bot');
  };
  reader.readAsDataURL(file);
}

async function _sendToExtratoAPI(payload, processingBubble){
  try{
    var resp = await _fetchAutenticado('/api/extrato', JSON.stringify(payload));
    if(processingBubble) processingBubble.remove();

    // Le o corpo SEMPRE, mesmo em erro, para aproveitar a mensagem do backend
    var data = {};
    try{ data = await resp.json(); }catch(e){ data = {}; }

    // Servico de IA sobrecarregado (Gemini 503/429) - mensagem clara e amigavel
    if(data && data.overloaded){
      _aiAddBubble('⏳ '+(data.error || 'O serviço de IA está sobrecarregado. Tente novamente em alguns minutos.'),'ai-bot');
      return;
    }
    if(!resp.ok || (data && data.error)){
      _aiAddBubble((data && data.error) ? data.error : 'Tive um problema ao analisar o extrato. Tente novamente em instantes.','ai-bot');
      console.warn('Extrato error:', resp.status, data);
      return;
    }

    var txs = data.transactions || [];
    if(!txs.length){
      _aiAddBubble('Não encontrei transações legíveis nesse arquivo. Pode tentar outro formato ou enviar um extrato mais recente?','ai-bot');
      return;
    }

    _extratoPendingTx = txs;
    _renderExtratoSummary(txs, data.summary);

  }catch(err){
    if(processingBubble) processingBubble.remove();
    _aiAddBubble('Tive um problema ao analisar o extrato. Tente novamente em instantes.','ai-bot');
    console.warn('Extrato error:', err);
  }
}

function _renderExtratoSummary(txs, summary){
  var box = document.getElementById('ai-chat-messages');
  if(!box) return;

  var fm = function(v){ return v.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}); };
  var catLabel = function(c){
    var map = {alimentacao:'🍽️ Alimentação',transporte:'🚗 Transporte',moradia:'🏠 Moradia',saude:'💊 Saúde',lazer:'🎮 Lazer',compras:'🛍️ Compras',educacao:'📚 Educação',servicos:'🔧 Serviços',salario:'💼 Salário',investimentos:'📈 Investimentos',outros:'📦 Outros'};
    return map[c] || c;
  };

  var listHtml = txs.slice(0,30).map(function(t){
    var sign = t.type==='in' ? '+' : '−';
    return '<div class="es-item">'
      +'<span class="es-item-desc">'+ (t.pessoa ? t.desc+' · '+t.pessoa : t.desc) +'</span>'
      +'<span class="es-item-val '+t.type+'">'+sign+'R$'+fm(t.val)+'</span>'
      +'</div>';
  }).join('');

  var div = document.createElement('div');
  div.className = 'extrato-summary';
  div.innerHTML =
    '<div class="es-head">📊 Encontrei '+ (summary?summary.count:txs.length) +' transações</div>'
    +'<div class="es-stats">'
      +'<div class="es-stat in"><div class="es-val">R$'+fm(summary?summary.totalIn:0)+'</div><div class="es-lbl">Receitas</div></div>'
      +'<div class="es-stat out"><div class="es-val">R$'+fm(summary?summary.totalOut:0)+'</div><div class="es-lbl">Despesas</div></div>'
    +'</div>'
    +'<div class="es-list">'+listHtml+'</div>'
    +'<div class="es-actions">'
      +'<button class="es-btn cancel" onclick="_cancelExtratoImport(this)">Cancelar</button>'
      +'<button class="es-btn confirm" onclick="_confirmExtratoImport(this)">✓ Importar tudo</button>'
    +'</div>';
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function _confirmExtratoImport(btn){
  if(!_extratoPendingTx || !_extratoPendingTx.length){ return; }
  var added = 0;
  _extratoPendingTx.forEach(function(t){
    state.transactions.push({
      id: uid(),
      desc: t.pessoa ? (t.desc+' · '+t.pessoa) : t.desc,
      val: t.val,
      type: t.type,
      cat: t.cat,
      date: t.date,
      imported: true
    });
    added++;
  });
  save(); 
  try{ renderFinance(); }catch(e){}
  updateHome();
  _extratoPendingTx = null;

  // Substitui os botões por uma confirmação
  var wrap = btn.closest('.extrato-summary');
  if(wrap){
    var actions = wrap.querySelector('.es-actions');
    if(actions) actions.innerHTML = '<div style="color:var(--green);font-weight:800;font-size:12px;text-align:center;width:100%">✓ '+added+' transações importadas!</div>';
  }
  toast('✓ '+added+' transações adicionadas ao Finanças!');
}

function _cancelExtratoImport(btn){
  _extratoPendingTx = null;
  var wrap = btn.closest('.extrato-summary');
  if(wrap){
    var actions = wrap.querySelector('.es-actions');
    if(actions) actions.innerHTML = '<div style="color:var(--ink3);font-weight:700;font-size:12px;text-align:center;width:100%">Importação cancelada</div>';
  }
}

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

// ── Botão do chat: microfone (vazio) ↔ enviar (com texto), estilo WhatsApp ──
function _updateChatBtn(){
  var input=document.getElementById('ai-chat-input');
  var micIcon=document.getElementById('ai-btn-mic');
  var sendIcon=document.getElementById('ai-btn-send');
  if(!input||!micIcon||!sendIcon) return;
  var hasText=input.value.trim().length>0;
  // Durante a gravação, o botão mostra o microfone (vermelho), não a seta
  if(_chatRecording){ micIcon.style.display='block'; sendIcon.style.display='none'; return; }
  micIcon.style.display=hasText?'none':'block';
  sendIcon.style.display=hasText?'block':'none';
}

// Toque no botão: se tem texto → envia; se vazio → grava/para
function _chatBtnTap(){
  var input=document.getElementById('ai-chat-input');
  var hasText=input && input.value.trim().length>0;
  // Tocar no microfone durante a gravação: para E envia automaticamente (fluxo fluido)
  if(_chatRecording){ _stopChatVoice(true); return; }
  if(hasText){ aiChatSend(); }
  else { _startChatVoice(); }
}

// ── Reconhecimento de voz dedicado ao chat ──
var _chatRecognition=null;
var _chatRecording=false;
var _chatVoicePrefix=''; // texto que ja estava no campo antes de falar
var _chatWriting=false; // true enquanto o reconhecimento escreve no campo

function _startChatVoice(){
  var SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  var input=document.getElementById('ai-chat-input');
  var btn=document.getElementById('ai-chat-send');
  var listening=document.getElementById('ai-chat-listening');
  if(!SR){ toast('Reconhecimento de voz não suportado neste navegador'); return; }
  _chatRecording=true;
  // guarda o que ja estava no campo (texto digitado antes de falar)
  _chatVoicePrefix=(input&&input.value)?input.value.trim()+' ':'';
  if(btn) btn.classList.add('recording');
  if(listening) listening.classList.add('show');
  _updateChatBtn();

  _chatRecognition=new SR();
  _chatRecognition.lang='pt-BR';
  // FALA UNICA: escuta uma frase e para. Consistente entre iOS e Android, sem duplicacao.
  _chatRecognition.continuous=false;
  _chatRecognition.interimResults=true;
  _chatRecognition.maxAlternatives=1;

  _chatRecognition.onresult=function(e){
    // pega o melhor resultado (final se houver, senao o interim mais recente)
    var txt='';
    for(var i=0;i<e.results.length;i++){
      txt += e.results[i][0].transcript;
    }
    if(input){
      _chatWriting=true;
      input.value=(_chatVoicePrefix + txt).replace(/\s{2,}/g,' ').trimStart();
      _chatWriting=false;
    }
  };
  _chatRecognition.onerror=function(err){ if(err.error!=='no-speech') _stopChatVoice(false); };
  // Ao terminar (pausa na fala), encerra e envia se houver texto valido
  _chatRecognition.onend=function(){
    if(_chatRecording){ _stopChatVoice(true); }
  };
  try{ _chatRecognition.start(); }catch(e){ _chatRecording=false; if(btn) btn.classList.remove('recording'); if(listening) listening.classList.remove('show'); _updateChatBtn(); }
}

// Remove trechos/frases repetidas que o Android gera na transcricao continua.
// Ex: "faça um comparativo com uma lci de 97% com uma lci de 97%" -> "...uma lci de 97%"
function _dedupFrase(txt){
  if(!txt) return '';
  var s = ' ' + txt + ' ';
  // remove pontos no meio (o Android insere "." entre reemissoes)
  s = s.replace(/\s*\.\s*/g, ' ');
  // colapsa palavras repetidas imediatas ("faça faça"->"faça")
  s = s.replace(/\b(\w+)(\s+\1\b)+/gi, '$1');
  // colapsa sequencias de 2-8 palavras repetidas, varias passadas
  for(var p=0;p<5;p++){
    s = s.replace(/\b(\w+(?:\s+\w+){1,8}?)(\s+\1\b)+/gi, '$1');
  }
  // colapsa de novo palavras imediatas que sobraram
  s = s.replace(/\b(\w+)(\s+\1\b)+/gi, '$1');
  return s.replace(/\s{2,}/g,' ').trim();
}

// Remove palavras repetidas consecutivas da transcricao ("demais demais"->"demais")
function _limparTranscricao(txt){
  if(!txt) return txt;
  // colapsa repeticoes imediatas da mesma palavra (case-insensitive)
  return txt.replace(/\b(\w+)(\s+\1\b)+/gi, '$1').replace(/\s{2,}/g,' ').trim();
}

// Detecta se a transcricao parece corrompida/incompleta (para pedir revisao)
function _transcricaoSuspeita(txt){
  if(!txt) return true;
  var t = txt.trim().toLowerCase();
  // termina em preposicao/artigo solto (frase cortada): "...com um", "...do", "...de"
  if(/\b(do|da|de|com|um|uma|e|ou|por|pra|para|no|na)$/.test(t)) return true;
  // tinha palavra repetida (sinal de erro de voz)
  if(/\b(\w+)\s+\1\b/i.test(txt)) return true;
  // muito curta para um comando de investimento mas menciona investimento
  var temInvest = /\b(cdb|lci|lca|cri|cra|tesouro|ipca|deb[eê]nture|cdi)\b/i.test(t);
  if(temInvest && t.split(/\s+/).length < 4) return true;
  return false;
}

// autoSend=true: ao parar a gravação, envia a mensagem automaticamente
function _stopChatVoice(autoSend){
  _chatRecording=false;
  var btn=document.getElementById('ai-chat-send');
  var listening=document.getElementById('ai-chat-listening');
  if(btn) btn.classList.remove('recording');
  if(listening) listening.classList.remove('show');
  try{ if(_chatRecognition) _chatRecognition.stop(); }catch(e){}
  _updateChatBtn();
  var input=document.getElementById('ai-chat-input');
  // limpa repeticoes da transcricao
  if(input && input.value){ input.value = _limparTranscricao(input.value); }
  if(autoSend){
    // fala unica: o resultado ja esta no campo, delay curto so por seguranca
    setTimeout(function(){
      if(input && input.value.trim().length>0){
        if(_transcricaoSuspeita(input.value)){
          input.focus();
          if(typeof toast==='function') toast('Confira o texto e toque em enviar');
        } else {
          aiChatSend();
        }
      } else if(input){ input.focus(); }
    }, 400);
  } else if(input){
    input.focus();
  }
}

// Atalho nativo: cria transacao direto do texto, SEM chamar a IA.
// Cobre comandos como "gastei R$150 com combustivel", "recebi 2000 de salario".
// Retorna true se tratou o comando localmente (e nao precisa da IA).
function _palavraParaNumero(txt){
  var u={'zero':0,'um':1,'uma':1,'dois':2,'duas':2,'tres':3,'três':3,'quatro':4,'cinco':5,'seis':6,'sete':7,'oito':8,'nove':9,'dez':10,'onze':11,'doze':12,'treze':13,'quatorze':14,'catorze':14,'quinze':15,'dezesseis':16,'dezessete':17,'dezoito':18,'dezenove':19,'vinte':20,'trinta':30,'quarenta':40,'cinquenta':50,'sessenta':60,'setenta':70,'oitenta':80,'noventa':90,'cem':100,'cento':100,'duzentos':200,'trezentos':300,'quatrocentos':400,'quinhentos':500,'mil':1000};
  var palavras=txt.toLowerCase().split(/\s+e\s+|\s+/);
  var total=0, achou=false;
  palavras.forEach(function(p){
    if(u[p]!==undefined){ 
      if(p==='mil'){ total=(total||1)*1000; } 
      else total+=u[p]; 
      achou=true; 
    }
  });
  return achou ? total : null;
}

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

// Calculadora local: responde perguntas de gasto/saldo SEM IA, somando state.transactions.
// Retorna a string da resposta, ou null se nao for uma pergunta que sabemos calcular.
// Interpreta o período citado na frase e retorna {ini, fim, rotulo} em datas YYYY-MM-DD.
// Cobre: esse mês, mês passado, este ano, ano passado, essa semana, últimos N dias, meses por nome.
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

// Exibe uma resposta local com um pequeno atraso natural (indicador "digitando").
function _localReply(text){
  var typing = _aiAddBubble('digitando...','ai-typing');
  var delay = 1400 + Math.floor(Math.random()*1400); // 1,4s a 2,8s
  setTimeout(function(){
    if(typing) typing.remove();
    _aiAddBubble(text,'ai-bot');
  }, delay);
}

var _ultimaComparacaoChat = null;

// Resposta com botao "Baixar PDF" abaixo do texto (para comparativos)
function _localReplyComPDF(text){
  _ensureJsPDF(); // pre-carrega a lib enquanto o usuario le o resultado
  var typing = _aiAddBubble('digitando...','ai-typing');
  var delay = 1400 + Math.floor(Math.random()*1400);
  setTimeout(function(){
    if(typing) typing.remove();
    var bubble = _aiAddBubble(text,'ai-bot');
    if(bubble){
      var btn = document.createElement('button');
      btn.textContent = '📄 Baixar relatório em PDF';
      btn.style.cssText = 'margin-top:10px;border:none;border-radius:100px;padding:10px 16px;font-weight:800;font-size:13px;color:#fff;background:linear-gradient(160deg,#c9962f,#a87a1e);cursor:pointer;display:block';
      btn.onclick = _gerarPDFchat;
      bubble.appendChild(btn);
    }
  }, delay);
}

// Gera o PDF da ultima comparacao feita no chat (marca Planni, sem nome do assessor)
function _gerarPDFchat(){
  if(!_ultimaComparacaoChat){ toast('Faça uma comparação primeiro.'); return; }
  if(!window.jspdf || !window.jspdf.jsPDF){ toast('Carregando gerador de PDF, tente de novo em 2s.'); _ensureJsPDF(); return; }
  var comp = _ultimaComparacaoChat.comp;
  var anos = _ultimaComparacaoChat.anos;
  var jsPDF = window.jspdf.jsPDF;
  var doc = new jsPDF({ unit:'mm', format:'a4' });
  var W=210, M=16, y=0;
  var PETROL=[28,74,110], BLUE=[45,108,151], GOLD=[201,150,47], GREY=[90,107,124], INK=[26,43,60], SOFT=[220,232,243];

  doc.setFillColor(PETROL[0],PETROL[1],PETROL[2]); doc.rect(0,0,W,32,'F');
  doc.setTextColor(255,255,255);
  doc.setFont('helvetica','bold'); doc.setFontSize(20); doc.text('Planni', M, 16);
  doc.setFont('helvetica','normal'); doc.setFontSize(11);
  doc.text('Análise Comparativa de Investimentos', M, 24);
  doc.setFontSize(8);
  var hoje = new Date().toLocaleDateString('pt-BR');
  doc.text('Emitido em '+hoje, W-M, 16, {align:'right'});
  y = 44;

  var venc = comp.itens[0];
  doc.setFillColor(255,248,232); doc.setDrawColor(GOLD[0],GOLD[1],GOLD[2]);
  doc.roundedRect(M, y, W-2*M, 16, 2,2,'FD');
  doc.setTextColor(120,94,16); doc.setFont('helvetica','bold'); doc.setFontSize(11);
  doc.text('Melhor opção: '+venc.nome, M+4, y+7);
  doc.setFont('helvetica','normal'); doc.setFontSize(9);
  var subVenc = venc.isento
    ? 'Isento de IR · equivale a um CDB de '+_invV(venc.cdbEquivalente)+'% do CDI (gross-up)'
    : 'Tributado · '+_invV(venc.taxaInformada)+'% do CDI';
  doc.text(subVenc, M+4, y+12.5);
  y += 24;

  doc.setTextColor(PETROL[0],PETROL[1],PETROL[2]); doc.setFont('helvetica','bold'); doc.setFontSize(11);
  doc.text('Comparativo (prazo '+anos+' anos)', M, y); y+=6;

  var colX=[M, M+55, M+95, M+135];
  doc.setFillColor(BLUE[0],BLUE[1],BLUE[2]); doc.rect(M, y-4, W-2*M, 7,'F');
  doc.setTextColor(255,255,255); doc.setFont('helvetica','bold'); doc.setFontSize(8.5);
  ['Investimento','Tipo','Taxa','CDB equiv.'].forEach(function(c,i){ doc.text(c, colX[i], y); });
  y+=5;
  doc.setTextColor(INK[0],INK[1],INK[2]); doc.setFontSize(8.5);
  comp.itens.forEach(function(it,idx){
    if(idx%2===0){ doc.setFillColor(238,244,250); doc.rect(M, y-4, W-2*M, 7,'F'); }
    doc.setFont('helvetica', it.vencedor?'bold':'normal');
    doc.text(String(it.nome).substring(0,24), colX[0], y);
    doc.text(it.isento?'Isento':'Tributado', colX[1], y);
    doc.text(_invV(it.taxaInformada)+'%', colX[2], y);
    doc.text(it.isento? _invV(it.cdbEquivalente)+'%' : '—', colX[3], y);
    y+=7;
  });
  y+=6;

  doc.setDrawColor(SOFT[0],SOFT[1],SOFT[2]); doc.line(M,y,W-M,y); y+=6;
  doc.setTextColor(GREY[0],GREY[1],GREY[2]); doc.setFont('helvetica','bold'); doc.setFontSize(9);
  doc.text('Pressupostos', M, y); y+=5;
  doc.setFont('helvetica','normal'); doc.setFontSize(8);
  ['Alíquotas de IR pela tabela regressiva vigente (22,5% a 15% conforme prazo).',
   'Cálculo de equivalência (gross-up) assume manutenção até o vencimento.'].forEach(function(p){
    var l=doc.splitTextToSize('• '+p, W-2*M); doc.text(l, M, y); y+=l.length*4.2;
  });
  y+=4;

  doc.setFillColor(245,248,252); doc.roundedRect(M, y, W-2*M, 20, 2,2,'F');
  doc.setTextColor(GREY[0],GREY[1],GREY[2]); doc.setFont('helvetica','italic'); doc.setFontSize(7.5);
  var disc='Este material tem caráter exclusivamente informativo e educacional e não constitui recomendação de investimento, oferta ou consultoria. Rentabilidade passada não garante resultados futuros. Consulte um profissional certificado antes de decidir.';
  doc.text(doc.splitTextToSize(disc, W-2*M-6), M+3, y+5);

  doc.setTextColor(GREY[0],GREY[1],GREY[2]); doc.setFont('helvetica','normal'); doc.setFontSize(7.5);
  doc.text('Relatório gerado com Planni · planni.pages.dev', M, 287);
  doc.text(hoje, W-M, 287, {align:'right'});

  doc.save('Comparativo_Planni_'+hoje.replace(/\//g,'-')+'.pdf');
}

// Carrega o jsPDF sob demanda (so quando o usuario pede PDF)
function _ensureJsPDF(){
  if(window.jspdf && window.jspdf.jsPDF) return;
  if(document.getElementById('jspdf-lib')) return;
  var s=document.createElement('script');
  s.id='jspdf-lib';
  s.src='https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
  document.head.appendChild(s);
}

// Relatorio consolidado da carteira de renda fixa (usa os investimentos ja cadastrados)
function gerarPDFConsolidado(){
  if(!window.jspdf || !window.jspdf.jsPDF){ toast('Carregando gerador de PDF, tente de novo em 2s.'); _ensureJsPDF(); return; }
  var fixas = (state.investments||[]).filter(function(i){ return i.kind==='fixa'; });
  if(!fixas.length){ toast('Cadastre ao menos um investimento de renda fixa.'); return; }

  var jsPDF = window.jspdf.jsPDF;
  var doc = new jsPDF({ unit:'mm', format:'a4' });
  var W=210, M=16, y=0;
  var PETROL=[28,74,110], BLUE=[45,108,151], GOLD=[201,150,47], GREY=[90,107,124], INK=[26,43,60], SOFT=[220,232,243], GREEN=[22,140,90], RED=[190,60,60];
  var hoje = new Date().toLocaleDateString('pt-BR');

  doc.setFillColor(PETROL[0],PETROL[1],PETROL[2]); doc.rect(0,0,W,32,'F');
  doc.setTextColor(255,255,255);
  doc.setFont('helvetica','bold'); doc.setFontSize(20); doc.text('Planni', M, 16);
  doc.setFont('helvetica','normal'); doc.setFontSize(11);
  doc.text('Relatório Consolidado da Carteira', M, 24);
  doc.setFontSize(8); doc.text('Emitido em '+hoje, W-M, 16, {align:'right'});
  y = 44;

  // totais
  var totInvest=0, totLiq=0, totRend=0;
  fixas.forEach(function(inv){
    var r = calcFixaReturn(inv);
    totInvest += inv.value; totLiq += r.valorLiquido; totRend += r.rendLiquido;
  });
  var pos = totRend>=0;

  doc.setFillColor(238,244,250); doc.roundedRect(M, y, W-2*M, 24, 2,2,'F');
  doc.setTextColor(PETROL[0],PETROL[1],PETROL[2]); doc.setFont('helvetica','bold'); doc.setFontSize(10);
  doc.text('Resumo da carteira (renda fixa)', M+4, y+7);
  doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(INK[0],INK[1],INK[2]);
  doc.text('Total aplicado: R$ '+fm(totInvest), M+4, y+14);
  doc.text('Valor líquido hoje: R$ '+fm(totLiq), M+4, y+20);
  doc.setTextColor(pos?GREEN[0]:RED[0], pos?GREEN[1]:RED[1], pos?GREEN[2]:RED[2]);
  doc.setFont('helvetica','bold');
  doc.text('Resultado líquido: '+(pos?'+':'−')+'R$ '+fm(Math.abs(totRend)), W-M-4, y+20, {align:'right'});
  y += 30;

  // tabela de investimentos
  doc.setTextColor(PETROL[0],PETROL[1],PETROL[2]); doc.setFont('helvetica','bold'); doc.setFontSize(11);
  doc.text('Investimentos', M, y); y+=6;
  var colX=[M, M+62, M+92, M+126, M+160];
  doc.setFillColor(BLUE[0],BLUE[1],BLUE[2]); doc.rect(M, y-4, W-2*M, 7,'F');
  doc.setTextColor(255,255,255); doc.setFont('helvetica','bold'); doc.setFontSize(8);
  ['Investimento','Tipo','Aplicado','Líquido','Rendim.'].forEach(function(c,i){ doc.text(c, colX[i], y); });
  y+=5;
  doc.setFontSize(8);
  fixas.forEach(function(inv,idx){
    var r = calcFixaReturn(inv);
    var p = r.rendLiquido>=0;
    if(idx%2===0){ doc.setFillColor(238,244,250); doc.rect(M, y-4, W-2*M, 7,'F'); }
    doc.setFont('helvetica','normal'); doc.setTextColor(INK[0],INK[1],INK[2]);
    doc.text(String(inv.name).substring(0,28), colX[0], y);
    doc.text(String(inv.type).substring(0,10), colX[1], y);
    doc.text('R$ '+fm(inv.value), colX[2], y);
    doc.text('R$ '+fm(r.valorLiquido), colX[3], y);
    doc.setTextColor(p?GREEN[0]:RED[0], p?GREEN[1]:RED[1], p?GREEN[2]:RED[2]);
    doc.text((p?'+':'−')+fm(Math.abs(r.rendLiquido)), colX[4], y);
    y+=7;
    if(y>260){ doc.addPage(); y=20; }
  });
  y+=6;

  if(y<250){
    doc.setFillColor(245,248,252); doc.roundedRect(M, y, W-2*M, 20, 2,2,'F');
    doc.setTextColor(GREY[0],GREY[1],GREY[2]); doc.setFont('helvetica','italic'); doc.setFontSize(7.5);
    var disc='Este material tem caráter informativo e não constitui recomendação de investimento. Valores líquidos estimados com base nas alíquotas de IR/IOF vigentes e nas taxas informadas no cadastro. Rentabilidade passada não garante resultados futuros.';
    doc.text(doc.splitTextToSize(disc, W-2*M-6), M+3, y+5);
  }
  doc.setTextColor(GREY[0],GREY[1],GREY[2]); doc.setFont('helvetica','normal'); doc.setFontSize(7.5);
  doc.text('Relatório gerado com Planni · planni.pages.dev', M, 287);
  doc.text(hoje, W-M, 287, {align:'right'});
  doc.save('Carteira_Planni_'+hoje.replace(/\//g,'-')+'.pdf');
  toast('✓ Relatório consolidado gerado');
}

// Abre a tela cheia da calculadora
function abrirComparadorInv(){ abrirCalcInv('comparar'); }
function abrirCupomInv(){ abrirCalcInv('cupom'); }

var _calcTabAtual='comparar';
function abrirCalcInv(tab){
  _ensureJsPDF();
  document.getElementById('inv-calc-screen').style.display='flex';
  switchCalcTab(tab||'comparar');
}
function fecharCalcInv(){ document.getElementById('inv-calc-screen').style.display='none'; }

function switchCalcTab(tab){
  _calcTabAtual=tab;
  ['comparar','calcular','lucro','cupom'].forEach(function(t){
    var el=document.getElementById('ctab-'+t);
    if(el) el.classList.toggle('active', t===tab);
  });
  var body=document.getElementById('inv-calc-body');
  if(tab==='comparar') body.innerHTML=_htmlComparar();
  else if(tab==='calcular') body.innerHTML=_htmlCalcular();
  else if(tab==='lucro'){ body.innerHTML=_htmlLucro(); if(!_lucroAtivos.length) _lucroAddAtivo(); _lucroRender(); }
  else if(tab==='cupom') body.innerHTML=_htmlCupom();
}

function _selTipo(id){
  return '<select id="'+id+'" style="flex:1.2">'
    + '<option value="">Tipo —</option>'
    + '<option value="cdb">CDB</option><option value="lci">LCI</option><option value="lca">LCA</option>'
    + '<option value="cri">CRI</option><option value="cra">CRA</option><option value="lc">LC</option>'
    + '<option value="debenture">Debênture</option></select>';
}

function _htmlComparar(){
  var linhas='';
  for(var n=1;n<=4;n++){
    linhas+='<div class="calc-row">'+_selTipo('cmp-tipo'+n)
      +'<input id="cmp-taxa'+n+'" type="number" placeholder="% do CDI" style="flex:1"></div>';
  }
  return '<div class="calc-card">'
    + '<div class="card-title blue">Comparar por equivalência (gross-up)</div>'
    + '<p style="font-size:12px;color:var(--ink2);margin-bottom:14px;line-height:1.5">Informe até 4 investimentos. Isentos (LCI/LCA/CRI/CRA) são convertidos no CDB equivalente para comparação justa.</p>'
    + linhas
    + '<label>Prazo</label>'
    + '<div class="calc-row"><input id="cmp-prazo" type="number" value="2" style="flex:1"><select id="cmp-prazo-un" style="flex:1"><option value="365">anos</option><option value="30">meses</option><option value="1">dias</option></select></div>'
    + '<button class="btn" onclick="_calcularComparadorInv()" style="width:100%;margin-top:6px">Comparar</button>'
    + '</div>'
    + '<div id="cmp-resultado"></div>';
}

function _htmlCalcular(){
  return '<div class="calc-card">'
    + '<div class="card-title blue">Calcular equivalência de um investimento</div>'
    + '<p style="font-size:12px;color:var(--ink2);margin-bottom:14px;line-height:1.5">Veja quanto um investimento isento equivale em CDB (ou vice-versa), descontando o IR do prazo.</p>'
    + '<div class="calc-row">'+_selTipo('cal-tipo')+'<input id="cal-taxa" type="number" placeholder="% do CDI" style="flex:1"></div>'
    + '<label>Prazo</label>'
    + '<div class="calc-row"><input id="cal-prazo" type="number" value="2" style="flex:1"><select id="cal-prazo-un" style="flex:1"><option value="365">anos</option><option value="30">meses</option><option value="1">dias</option></select></div>'
    + '<button class="btn" onclick="_calcularUnicoInv()" style="width:100%;margin-top:6px">Calcular</button>'
    + '</div>'
    + '<div id="cal-resultado"></div>';
}

function _htmlCupom(){
  return '<div class="calc-card">'
    + '<div class="card-title blue">Crédito privado com cupom</div>'
    + '<div style="background:#fff8e6;border:1px solid #e8c860;border-radius:12px;padding:14px;font-size:12px;color:#785e10;line-height:1.5">🎟️ A análise de títulos com cupom (debênture incentivada, CRI, CRA vs Tesouro), com IR por pagamento e periodicidade mensal/semestral/anual, está sendo integrada a esta tela. Por enquanto, use o comparador de equivalência na aba "Comparar".</div>'
    + '</div>';
}

// ===== LUCRO REAL: simulação da carteira do usuário =====
var _lucroAtivos = []; // cada: {tipo, index, taxa, valor, dataAplic, dataVenc}
var _lucroSeq = 0;

function _htmlLucro(){
  return '<div class="calc-card">'
    + '<div class="card-title blue">💰 Lucro real da sua carteira</div>'
    + '<p style="font-size:12px;color:var(--ink2);margin-bottom:4px;line-height:1.5">Adicione seus investimentos de renda fixa. O app calcula quanto cada um vale hoje (líquido, descontando IR/IOF) usando o CDI atual do Banco Central.</p>'
    + '<p style="font-size:11px;color:var(--ink3);margin-bottom:14px">Valores são estimativas com base nas taxas informadas — podem diferir do valor exato da corretora.</p>'
    + '<div id="lucro-lista"></div>'
    + '<button class="btn btn-ghost" onclick="_lucroAddAtivo();_lucroRender()" style="width:100%;margin-top:4px;border-style:dashed">➕ Adicionar investimento</button>'
    + '<button class="btn" onclick="_lucroCalcular()" style="width:100%;margin-top:10px">Calcular minha carteira</button>'
    + '</div>'
    + '<div id="lucro-resultado"></div>';
}

function _lucroAddAtivo(){
  _lucroSeq++;
  _lucroAtivos.push({ id:_lucroSeq, tipo:'CDB', index:'CDI', taxa:'', valor:'', dataAplic:'', dataVenc:'' });
}
function _lucroRemover(id){
  _lucroAtivos = _lucroAtivos.filter(function(a){ return a.id!==id; });
  _lucroRender();
}
function _lucroSync(id,campo,val){
  var a=_lucroAtivos.find(function(x){ return x.id===id; });
  if(a) a[campo]=val;
}

function _lucroRender(){
  var box=document.getElementById('lucro-lista');
  if(!box) return;
  var tipos=['CDB','LCI','LCA','CRI','CRA','Tesouro','Debênture','LC'];
  var indexadores=['CDI','IPCA+','Selic','Prefixado'];
  var html='';
  _lucroAtivos.forEach(function(a,i){
    html+='<div style="background:var(--sky-xl);border-radius:14px;padding:12px;margin-bottom:10px;position:relative">'
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">'
        + '<span style="font-size:11px;font-weight:800;color:var(--sky)">Ativo '+(i+1)+'</span>'
        + (_lucroAtivos.length>1?'<span onclick="_lucroRemover('+a.id+')" style="color:var(--red);cursor:pointer;font-size:16px;font-weight:700">✕</span>':'')
      + '</div>'
      + '<div class="calc-row">'
        + '<select onchange="_lucroSync('+a.id+',\'tipo\',this.value)" style="flex:1">'+tipos.map(function(t){return '<option'+(t===a.tipo?' selected':'')+'>'+t+'</option>';}).join('')+'</select>'
        + '<select onchange="_lucroSync('+a.id+',\'index\',this.value)" style="flex:1">'+indexadores.map(function(x){return '<option'+(x===a.index?' selected':'')+'>'+x+'</option>';}).join('')+'</select>'
      + '</div>'
      + '<div class="calc-row">'
        + '<input type="number" placeholder="Taxa (ex: 110)" value="'+a.taxa+'" oninput="_lucroSync('+a.id+',\'taxa\',this.value)" style="flex:1">'
        + '<input type="number" placeholder="Valor aplicado R$" value="'+a.valor+'" oninput="_lucroSync('+a.id+',\'valor\',this.value)" style="flex:1.2">'
      + '</div>'
      + '<div class="calc-row">'
        + '<div style="flex:1"><label style="font-size:10px">Aplicação</label><input type="date" value="'+a.dataAplic+'" oninput="_lucroSync('+a.id+',\'dataAplic\',this.value)"></div>'
        + '<div style="flex:1"><label style="font-size:10px">Vencimento (opc.)</label><input type="date" value="'+a.dataVenc+'" oninput="_lucroSync('+a.id+',\'dataVenc\',this.value)"></div>'
      + '</div>'
      + '</div>';
  });
  box.innerHTML=html;
}

function _lucroCalcular(){
  var out=document.getElementById('lucro-resultado');
  var validos=_lucroAtivos.filter(function(a){ return a.taxa!=='' && a.valor!=='' && a.dataAplic; });
  if(!validos.length){ out.innerHTML='<div style="color:var(--red);font-size:12px;padding:8px">Preencha ao menos um ativo (taxa, valor e data de aplicação).</div>'; return; }

  var totalAplic=0, totalLiq=0, totalBruto=0, totalIR=0, totalIOF=0, linhas=[];
  var diasMax=0;
  validos.forEach(function(a){
    var inv={ type:a.tipo, index:a.index, rate:parseFloat(a.taxa), value:parseFloat(a.valor), start:a.dataAplic, end:a.dataVenc||null };
    var r=calcFixaReturn(inv);
    totalAplic+=inv.value; totalLiq+=r.valorLiquido;
    totalBruto+=r.rendimentoBruto; totalIR+=r.ir; totalIOF+=r.iof;
    if(r.diasDecorridos>diasMax) diasMax=r.diasDecorridos;
    linhas.push({ nome:a.tipo+' '+_invV(parseFloat(a.taxa))+'% '+a.index, aplic:inv.value, liq:r.valorLiquido,
      rend:r.rendLiquido, bruto:r.rendimentoBruto, ir:r.ir, iof:r.iof, aliqIR:r.aliqIR, isento:r.isIsento, dias:r.diasDecorridos });
  });
  var lucro=totalLiq-totalAplic;
  var pos=lucro>=0;

  // Efeito da inflação (IPCA) sobre o período — rendimento real via Fisher
  var anos=diasMax/365;
  var ipcaPeriodo=Math.pow(1+IPCA_ATUAL, anos)-1;          // inflação acumulada estimada no período
  var inflacaoValor=totalAplic*ipcaPeriodo;                 // quanto a inflação "comeu" em R$ do valor aplicado
  var rentNominalPct=totalAplic>0 ? (lucro/totalAplic) : 0;
  var rentRealPct=(1+rentNominalPct)/(1+ipcaPeriodo)-1;    // rendimento real (Fisher)
  var lucroReal=totalAplic*rentRealPct;                     // lucro em poder de compra

  _lucroUltimo={ linhas:linhas, totalAplic:totalAplic, totalLiq:totalLiq, lucro:lucro,
    totalBruto:totalBruto, totalIR:totalIR, totalIOF:totalIOF,
    ipcaPeriodo:ipcaPeriodo, inflacaoValor:inflacaoValor, rentNominalPct:rentNominalPct, rentRealPct:rentRealPct, lucroReal:lucroReal, anos:anos };

  var html='<div class="calc-card">'
    + '<div style="text-align:center;padding:8px 0 14px">'
      + '<div style="font-size:11px;color:var(--ink3);text-transform:uppercase;letter-spacing:.1em">Valor líquido da carteira hoje</div>'
      + '<div style="font-size:32px;font-weight:900;color:var(--ink)">R$ '+fm(totalLiq)+'</div>'
      + '<div style="font-size:14px;font-weight:700;color:'+(pos?'var(--green)':'var(--red)')+'">'+(pos?'+':'−')+'R$ '+fm(Math.abs(lucro))+' de lucro líquido</div>'
      + '<div style="font-size:11px;color:var(--ink3);margin-top:2px">Aplicado: R$ '+fm(totalAplic)+'</div>'
    + '</div>';
  linhas.forEach(function(l){
    var lp=l.rend>=0;
    html+='<div style="display:flex;justify-content:space-between;padding:8px 0;border-top:1px solid var(--border);font-size:13px">'
      + '<span style="color:var(--ink)">'+l.nome+'</span>'
      + '<span style="font-weight:700;color:var(--ink)">R$ '+fm(l.liq)+' <span style="color:'+(lp?'var(--green)':'var(--red)')+';font-size:11px">('+(lp?'+':'−')+fm(Math.abs(l.rend))+')</span></span>'
    + '</div>';
  });
  html+='</div>';

  // BLOCO DE TRANSPARÊNCIA DO CÁLCULO
  html+='<div class="calc-card">'
    + '<div class="card-title blue">🔎 Entenda seu resultado</div>'
    + _lucroLinhaDet('Rendimento bruto (antes de impostos)', '+R$ '+fm(totalBruto), 'var(--ink)')
    + _lucroLinhaDet('Imposto de Renda descontado', '−R$ '+fm(totalIR), 'var(--red)')
    + (totalIOF>0.005 ? _lucroLinhaDet('IOF descontado (resgate < 30 dias)', '−R$ '+fm(totalIOF), 'var(--red)') : '')
    + _lucroLinhaDet('Rendimento líquido (o que sobrou)', (pos?'+':'−')+'R$ '+fm(Math.abs(lucro)), pos?'var(--green)':'var(--red)', true)
    + '<div style="height:10px"></div>'
    + _lucroLinhaDet('Inflação estimada no período (~'+anos.toFixed(1).replace('.',',')+' anos)', ipcaPeriodo>0?'−'+_invV((ipcaPeriodo*100).toFixed(2))+'%':'—', 'var(--orange)')
    + _lucroLinhaDet('Poder de compra perdido p/ inflação', '−R$ '+fm(inflacaoValor), 'var(--orange)')
    + _lucroLinhaDet('Rendimento REAL (descontada a inflação)', (rentRealPct>=0?'+':'−')+_invV((Math.abs(rentRealPct)*100).toFixed(2))+'%', rentRealPct>=0?'var(--green)':'var(--red)', true)
    + '<p style="font-size:10px;color:var(--ink3);margin-top:10px;line-height:1.4">O rendimento real mostra o ganho acima da inflação — o que de fato aumentou seu poder de compra. Inflação estimada pelo IPCA de referência ('+_invV((IPCA_ATUAL*100).toFixed(2))+'% a.a.).</p>'
    + '</div>';

  html+='<button class="btn" onclick="_gerarPDFLucro()" style="width:100%;background:linear-gradient(160deg,#c9962f,#a87a1e)">📄 Baixar PDF da carteira</button>';
  out.innerHTML=html;
}

function _lucroLinhaDet(label,val,cor,forte){
  return '<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px;'+(forte?'border-top:1px solid var(--border);font-weight:800;padding-top:8px':'')+'">'
    + '<span style="color:var(--ink2)">'+label+'</span>'
    + '<span style="color:'+cor+';font-weight:'+(forte?'800':'600')+'">'+val+'</span>'
    + '</div>';
}

var _lucroUltimo=null;
function _gerarPDFLucro(){
  if(!_lucroUltimo){ toast('Calcule a carteira primeiro.'); return; }
  if(!window.jspdf || !window.jspdf.jsPDF){ toast('Carregando gerador de PDF...'); _ensureJsPDF(); return; }
  var U=_lucroUltimo;
  var jsPDF=window.jspdf.jsPDF;
  var doc=new jsPDF({unit:'mm',format:'a4'});
  var W=210,M=16,y=0;
  var PETROL=[28,74,110],BLUE=[45,108,151],GREY=[90,107,124],INK=[26,43,60],SOFT=[220,232,243],GREEN=[22,140,90],RED=[190,60,60];
  var hoje=new Date().toLocaleDateString('pt-BR');
  doc.setFillColor(PETROL[0],PETROL[1],PETROL[2]); doc.rect(0,0,W,32,'F');
  doc.setTextColor(255,255,255); doc.setFont('helvetica','bold'); doc.setFontSize(20); doc.text('Planni',M,16);
  doc.setFont('helvetica','normal'); doc.setFontSize(11); doc.text('Simulação da Carteira — Lucro Real',M,24);
  doc.setFontSize(8); doc.text('Emitido em '+hoje,W-M,16,{align:'right'});
  y=44;
  var pos=U.lucro>=0;
  doc.setFillColor(238,244,250); doc.roundedRect(M,y,W-2*M,26,2,2,'F');
  doc.setTextColor(GREY[0],GREY[1],GREY[2]); doc.setFont('helvetica','normal'); doc.setFontSize(9);
  doc.text('Valor líquido da carteira hoje',M+4,y+8);
  doc.setTextColor(INK[0],INK[1],INK[2]); doc.setFont('helvetica','bold'); doc.setFontSize(18);
  doc.text('R$ '+fm(U.totalLiq),M+4,y+18);
  doc.setFontSize(9); doc.setTextColor(pos?GREEN[0]:RED[0],pos?GREEN[1]:RED[1],pos?GREEN[2]:RED[2]);
  doc.text((pos?'+':'−')+'R$ '+fm(Math.abs(U.lucro))+' lucro líquido',W-M-4,y+12,{align:'right'});
  doc.setTextColor(GREY[0],GREY[1],GREY[2]); doc.setFont('helvetica','normal'); doc.setFontSize(8);
  doc.text('Aplicado: R$ '+fm(U.totalAplic),W-M-4,y+19,{align:'right'});
  y+=34;
  doc.setTextColor(PETROL[0],PETROL[1],PETROL[2]); doc.setFont('helvetica','bold'); doc.setFontSize(11);
  doc.text('Ativos',M,y); y+=6;
  var colX=[M,M+80,M+120,M+160];
  doc.setFillColor(BLUE[0],BLUE[1],BLUE[2]); doc.rect(M,y-4,W-2*M,7,'F');
  doc.setTextColor(255,255,255); doc.setFont('helvetica','bold'); doc.setFontSize(8);
  ['Ativo','Aplicado','Líquido hoje','Rendim.'].forEach(function(c,i){ doc.text(c,colX[i],y); });
  y+=5;
  doc.setFontSize(8);
  U.linhas.forEach(function(l,idx){
    var lp=l.rend>=0;
    if(idx%2===0){ doc.setFillColor(238,244,250); doc.rect(M,y-4,W-2*M,7,'F'); }
    doc.setFont('helvetica','normal'); doc.setTextColor(INK[0],INK[1],INK[2]);
    doc.text(String(l.nome).substring(0,34),colX[0],y);
    doc.text('R$ '+fm(l.aplic),colX[1],y);
    doc.text('R$ '+fm(l.liq),colX[2],y);
    doc.setTextColor(lp?GREEN[0]:RED[0],lp?GREEN[1]:RED[1],lp?GREEN[2]:RED[2]);
    doc.text((lp?'+':'−')+fm(Math.abs(l.rend)),colX[3],y);
    y+=7;
    if(y>262){ doc.addPage(); y=20; }
  });
  y+=8;

  // Bloco de transparência: IR, IOF e inflação
  if(y>230){ doc.addPage(); y=20; }
  doc.setTextColor(PETROL[0],PETROL[1],PETROL[2]); doc.setFont('helvetica','bold'); doc.setFontSize(11);
  doc.text('Entenda seu resultado',M,y); y+=7;
  function detPDF(label,val,cor,forte){
    doc.setFont('helvetica', forte?'bold':'normal'); doc.setFontSize(forte?9.5:9);
    doc.setTextColor(GREY[0],GREY[1],GREY[2]); doc.text(label,M+2,y);
    doc.setTextColor(cor[0],cor[1],cor[2]); doc.text(val,W-M-2,y,{align:'right'});
    y+=6;
  }
  var posL=U.lucro>=0;
  detPDF('Rendimento bruto (antes de impostos)','+R$ '+fm(U.totalBruto),INK);
  detPDF('Imposto de Renda descontado','-R$ '+fm(U.totalIR),RED);
  if(U.totalIOF>0.005) detPDF('IOF descontado','-R$ '+fm(U.totalIOF),RED);
  detPDF('Rendimento líquido',(posL?'+':'-')+'R$ '+fm(Math.abs(U.lucro)), posL?GREEN:RED, true);
  y+=3;
  detPDF('Inflação estimada no período (~'+U.anos.toFixed(1).replace('.',',')+' anos)', U.ipcaPeriodo>0?'-'+_invV((U.ipcaPeriodo*100).toFixed(2))+'%':'-', [207,132,23]);
  detPDF('Poder de compra perdido p/ inflação','-R$ '+fm(U.inflacaoValor),[207,132,23]);
  detPDF('Rendimento REAL (descontada inflação)',(U.rentRealPct>=0?'+':'-')+_invV((Math.abs(U.rentRealPct)*100).toFixed(2))+'%', U.rentRealPct>=0?GREEN:RED, true);
  y+=6;

  if(y<250){
    doc.setFillColor(245,248,252); doc.roundedRect(M,y,W-2*M,22,2,2,'F');
    doc.setTextColor(GREY[0],GREY[1],GREY[2]); doc.setFont('helvetica','italic'); doc.setFontSize(7.5);
    var disc='Simulação estimada com base nas taxas e datas informadas e no CDI/Selic atuais do Banco Central. Os valores podem diferir do saldo exato da corretora (que considera marcação a mercado e datas precisas). Material informativo, não constitui recomendação de investimento.';
    doc.text(doc.splitTextToSize(disc,W-2*M-6),M+3,y+5);
  }
  doc.setTextColor(GREY[0],GREY[1],GREY[2]); doc.setFont('helvetica','normal'); doc.setFontSize(7.5);
  doc.text('Relatório gerado com Planni · planni.pages.dev',M,287);
  doc.text(hoje,W-M,287,{align:'right'});
  doc.save('Carteira_LucroReal_Planni_'+hoje.replace(/\//g,'-')+'.pdf');
  toast('✓ PDF da carteira gerado');
}


function _calcularComparadorInv(){
  var itens=[];
  var nomes={cdb:'CDB',lci:'LCI',lca:'LCA',cri:'CRI',cra:'CRA',lc:'LC',debenture:'Debênture'};
  var isentos={lci:1,lca:1,cri:1,cra:1};
  for(var n=1;n<=4;n++){
    var tipo=(document.getElementById('cmp-tipo'+n)||{}).value;
    var taxa=parseFloat((document.getElementById('cmp-taxa'+n)||{}).value);
    if(tipo && !isNaN(taxa)){
      itens.push({ tipo:tipo, nome:nomes[tipo]+' '+_invV(taxa)+'%', isento:!!isentos[tipo], taxaCDI:taxa });
    }
  }
  var out=document.getElementById('cmp-resultado');
  if(itens.length<2){ out.innerHTML='<div style="color:var(--red);font-size:12px;padding:8px">Informe pelo menos 2 investimentos (tipo + taxa).</div>'; return; }
  var prazo=parseFloat(document.getElementById('cmp-prazo').value)||2;
  var un=parseFloat(document.getElementById('cmp-prazo-un').value)||365;
  var dias=Math.round(prazo*un);
  itens.forEach(function(it){ it.dias=dias; });
  var comp=compararPorGrossUp(itens);
  if(comp.erro){ out.innerHTML='<div style="color:var(--red);padding:8px">'+comp.erro+'</div>'; return; }
  var html='<div class="calc-card">';
  comp.itens.forEach(function(it,i){
    var medal=it.vencedor?'🏆':(i+1)+'º';
    var equiv=it.isento?' → CDB '+_invV(it.cdbEquivalente)+'%':'';
    html+='<div style="padding:8px 0;font-size:14px;border-bottom:1px solid var(--border);'+(it.vencedor?'font-weight:800;color:var(--sky2)':'color:var(--ink)')+'">'+medal+' '+it.nome+(it.isento?' (isento)':'')+equiv+'</div>';
  });
  html+='<button class="btn" onclick="_gerarPDFchat()" style="width:100%;margin-top:14px;background:linear-gradient(160deg,#c9962f,#a87a1e)">📄 Baixar relatório em PDF</button>';
  html+='</div>';
  out.innerHTML=html;
  _ultimaComparacaoChat={ comp:comp, dias:dias, anos:(dias/365).toFixed(dias%365===0?0:1).replace('.',',') };
}

function _calcularUnicoInv(){
  var tipo=(document.getElementById('cal-tipo')||{}).value;
  var taxa=parseFloat((document.getElementById('cal-taxa')||{}).value);
  var out=document.getElementById('cal-resultado');
  if(!tipo || isNaN(taxa)){ out.innerHTML='<div style="color:var(--red);font-size:12px;padding:8px">Informe o tipo e a taxa.</div>'; return; }
  var isentos={lci:1,lca:1,cri:1,cra:1};
  var nomes={cdb:'CDB',lci:'LCI',lca:'LCA',cri:'CRI',cra:'CRA',lc:'LC',debenture:'Debênture'};
  var prazo=parseFloat(document.getElementById('cal-prazo').value)||2;
  var un=parseFloat(document.getElementById('cal-prazo-un').value)||365;
  var dias=Math.round(prazo*un);
  var html='<div class="calc-card">';
  if(isentos[tipo]){
    var gu=grossUp(taxa,dias);
    html+='<div style="font-size:14px;line-height:1.6;color:var(--ink)"><strong>'+nomes[tipo]+' '+_invV(taxa)+'% (isento)</strong><br>Equivale a um CDB de <strong style="color:var(--sky2)">'+_invV(gu.cdbEquivalente)+'% do CDI</strong> (IR de '+_invV((gu.aliquotaIR*100).toFixed(1))+'% no prazo).<br><span style="color:var(--ink2);font-size:13px">Um CDB só ganha se pagar mais que '+_invV(gu.cdbEquivalente)+'% do CDI.</span></div>';
  } else {
    var gd=grossDown(taxa,dias);
    html+='<div style="font-size:14px;line-height:1.6;color:var(--ink)"><strong>'+nomes[tipo]+' '+_invV(taxa)+'% (tributado)</strong><br>Equivale a um isento (LCI/LCA) de <strong style="color:var(--sky2)">'+_invV(gd.lciEquivalente)+'% do CDI</strong> (IR de '+_invV((gd.aliquotaIR*100).toFixed(1))+'% no prazo).<br><span style="color:var(--ink2);font-size:13px">Uma LCI só ganha se pagar mais que '+_invV(gd.lciEquivalente)+'% do CDI.</span></div>';
  }
  html+='</div>';
  out.innerHTML=html;
}




// Criacao local de tarefa / nota / evento, SEM IA.
// Retorna a string de confirmacao, ou null se nao reconheceu o comando.
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

// ===== CALCULADORA DE INVESTIMENTOS LOCAL (sem IA, preciso e privado) =====
// Detecta pedidos de calculo/comparacao de renda fixa e responde pelo motor investimentos.js.
// Mapa de tipos reconhecidos na frase
var _INV_TIPOS = [
  {re:/\blci\b/i, tipo:'lci', nome:'LCI', isento:true},
  {re:/\blca\b/i, tipo:'lca', nome:'LCA', isento:true},
  {re:/\bcri\b/i, tipo:'cri', nome:'CRI', isento:true},
  {re:/\bcra\b/i, tipo:'cra', nome:'CRA', isento:true},
  {re:/deb[eê]nture\s+incentivada|incentivada/i, tipo:'debenture_incentivada', nome:'Debênture incentivada', isento:true},
  {re:/deb[eê]nture/i, tipo:'debenture', nome:'Debênture', isento:false},
  {re:/tesouro[_\s]*ipca/i, tipo:'tesouro_ipca', nome:'Tesouro IPCA+', isento:false, baseIPCA:true},
  {re:/tesouro[_\s]*(selic|pref)/i, tipo:'tesouro', nome:'Tesouro', isento:false},
  {re:/\bcdb\b/i, tipo:'cdb', nome:'CDB', isento:false},
  {re:/\blc\b|letra\s+de\s+c[aâ]mbio/i, tipo:'lc', nome:'LC', isento:false},
  {re:/\blf\b|letra\s+financeira/i, tipo:'lf', nome:'LF', isento:false}
];

// Extrai prazo em dias da frase ("2 anos", "18 meses", "730 dias")
function _invExtrairPrazoDias(msg){
  var m;
  if((m = msg.match(/(\d+(?:[.,]\d+)?)\s*anos?/i))) return Math.round(parseFloat(m[1].replace(',','.'))*365);
  if((m = msg.match(/(\d+)\s*meses?/i))) return Math.round(parseInt(m[1],10)*30.4);
  if((m = msg.match(/(\d+)\s*dias?/i))) return parseInt(m[1],10);
  return null;
}

// Encontra todos os investimentos citados na frase, com suas taxas (% do CDI)
function _invExtrairItens(msg){
  var itens = [];
  // procura padroes "<tipo> ... <numero>%" ou "<tipo> de <numero>"
  _INV_TIPOS.forEach(function(t){
    var idx = msg.search(t.re);
    while(idx !== -1){
      // procura um numero (taxa) ate ~25 chars depois do tipo
      var trecho = msg.slice(idx, idx+40);
      var mt = trecho.match(/(\d+(?:[.,]\d+)?)\s*%?/);
      if(mt){
        itens.push({ tipo:t.tipo, nome:t.nome, isento:t.isento, taxaCDI:parseFloat(mt[1].replace(',','.')) });
      }
      // evita loop infinito: corta a parte ja vista
      var resto = msg.slice(idx+1);
      var idx2 = resto.search(t.re);
      idx = idx2===-1 ? -1 : idx+1+idx2;
      if(itens.length>6) break;
    }
  });
  return itens;
}

// Normaliza a frase: "por cento"->"%", numeros por extenso comuns, "letra de credito"->LCI
// Dicionario fonetico: como o reconhecimento de voz costuma errar cada termo financeiro.
// Cada entrada: [regex de variacoes, termo correto]. Aplicado antes de interpretar.
var _INV_FONETICO = [
  // LCI - imobiliario
  [/\bl\s*c\s*i\b/gi, 'lci'],
  [/\bels?(?:i|e|ie)\b/gi, 'lci'],            // "elsie", "el ci"
  [/ele\s*c[eê]\s*i/gi, 'lci'],
  [/l[aá]\s*c[ií]/gi, 'lci'],                 // "laci" (sem \b)
  [/letra\s+de\s+cr[eé]dito\s+imobili[aá]ri[ao]/gi, 'lci'],
  [/\bhouse\s*e?\b/gi, 'lci'],                // iOS as vezes vira "house"
  // LCA - agro
  [/\bl\s*c\s*a\b/gi, 'lca'],
  [/ele\s*c[eê]\s*[aá]/gi, 'lca'],
  [/l[aá]\s*c[aá]/gi, 'lca'],                 // "lá cá" (sem \b)
  [/letra\s+de\s+cr[eé]dito\s+do?\s+agro(?:neg[oó]cio)?/gi, 'lca'],
  [/letra\s+de\s+cr[eé]dito\s+agr[ií]cola/gi, 'lca'],
  // CDB
  [/\bc\s*d\s*b\b/gi, 'cdb'],
  [/c[eê]\s*d[eê]\s*b[eê]/gi, 'cdb'],         // "cê dê bê" (sem \b: acentos quebram)
  [/\bcedeb[eê]?\b/gi, 'cdb'],
  [/\bse\s*de\s*be\b/gi, 'cdb'],
  [/certificado\s+de\s+dep[oó]sito(?:\s+banc[aá]rio)?/gi, 'cdb'],
  // CRI - imobiliario
  [/\bc\s*r\s*i\b/gi, 'cri'],
  [/\bcri(?:e|ei)\b/gi, 'cri'],               // "crie", "criei"
  [/\bcri\s+e\b/gi, 'cri'],
  [/\bkr[ií]\b/gi, 'cri'],
  // CRA - agro
  [/\bc\s*r\s*a\b/gi, 'cra'],
  [/\bkr[aá]\b/gi, 'cra'],
  [/\bcr[aá]\b/gi, 'cra'],
  // LC - letra de cambio (cuidado: so depois de LCI/LCA)
  [/letra\s+de\s+c[aâ]mbio/gi, 'lc'],
  // LF - letra financeira
  [/\bl\s*f\b/gi, 'lf'],
  [/letra\s+financeira/gi, 'lf'],
  // Debenture
  [/\bdeb[eê]ntures?\b/gi, 'debenture'],
  [/\bde\s+bento\b/gi, 'debenture'],           // "de bento"
  [/\bdebent[uo]ra\b/gi, 'debenture'],
  // Tesouro
  [/tesouro\s+direto/gi, 'tesouro'],
  [/\bte\s*so[uo]ro\b/gi, 'tesouro'],
  // IPCA
  [/\bipca\b/gi, 'ipca'],
  [/\bi\s*p\s*c\s*a\b/gi, 'ipca'],
  [/\b[ií]\s*pec[aá]\b/gi, 'ipca'],            // "i pecá"
  // Selic
  [/\bselique?\b/gi, 'selic'],
  // CDI
  [/\bc\s*d\s*i\b/gi, 'cdi'],
  [/\bc[eê]\s*d[eê]\s*[ií]\b/gi, 'cdi']
];

function _invNormalizar(msg){
  var s = ' ' + msg.toLowerCase() + ' ';

  // 1) DICIONARIO FONETICO: corrige como a voz erra cada termo
  _INV_FONETICO.forEach(function(par){
    s = s.replace(par[0], ' ' + par[1] + ' ');
  });

  // 2) "incentivada" perto de debenture
  s = s.replace(/deb[eê]nture\s+incentivada|incentivada/gi, 'debenture_incentivada');

  // 3) IPCA+ com numero ("ipca +7", "ipca mais 7", "ipca + 7")
  s = s.replace(/ipca\s*\+\s*(\d+)/gi, 'ipcamais$1');
  s = s.replace(/ipca\s+mais\s+(\d+)/gi, 'ipcamais$1');
  s = s.replace(/tesouro\s+ipcamais/gi, 'tesouro_ipca ').replace(/ipcamais(\d+)/gi, 'tesouro_ipca $1');
  // "tesouro ipca" sem numero tambem vira tesouro_ipca
  s = s.replace(/tesouro\s+ipca\b/gi, 'tesouro_ipca');

  // 4) numeros por extenso frequentes na fala
  var extenso = {
    'cem':'100','cento e dez':'110','cento e quinze':'115','cento e vinte':'120',
    'cento e cinco':'105','cento e trinta':'130','noventa':'90','noventa e cinco':'95',
    'noventa e oito':'98','noventa e dois':'92','noventa e sete':'97','oitenta e cinco':'85',
    'cento e vinte e cinco':'125','cento e dezoito':'118','cento e dezesseis':'116'
  };
  Object.keys(extenso).sort(function(a,b){return b.length-a.length;}).forEach(function(p){
    s = s.replace(new RegExp('\\b'+p+'\\b','g'), extenso[p]);
  });

  // 5) "por cento" -> "%"
  s = s.replace(/\s*por\s*cento\b/g, '%').replace(/\s*porcento\b/g, '%');

  // 6) limpa espacos duplicados gerados pelas substituicoes
  s = s.replace(/\s{2,}/g, ' ');
  return s;
}

// Formata numero com virgula decimal (padrao BR)
function _invV(n){ return String(n).replace('.', ','); }

function _tryLocalInvestimento(msg){
  if(typeof compararPorGrossUp !== 'function') return null; // motor nao carregado
  var norm = _invNormalizar(msg);
  var low = norm;
  // gatilhos de intencao
  var querComparar = /\b(compar[ae]|melhor|qual\s+rende|versus|\bvs\b|ou\s+(?:um|uma|a|o)\b)/i.test(low);
  var querCalcular = /\b(quanto\s+rende|rentabilidade|calcul[ae]|rende\s+quanto|l[ií]quido|gross\s*up|equival)/i.test(low);
  var temInvest = /\b(cdb|lci|lca|cri|cra|tesouro|deb[eê]nture|incentivada)\b/i.test(low);
  if(!temInvest || (!querComparar && !querCalcular)) return null;

  var itens = _invExtrairItens(norm);
  if(!itens.length) return null;
  var dias = _invExtrairPrazoDias(norm) || 730; // default 2 anos
  itens.forEach(function(it){ it.dias = dias; });

  // Detecta mistura de bases incompativeis: IPCA+ (real) vs % do CDI (pos-fixado)
  var temIPCA = itens.some(function(it){ return it.baseIPCA; });
  var temCDI = itens.some(function(it){ return !it.baseIPCA; });
  if(temIPCA && temCDI){
    return '⚖️ Comparar um título IPCA+ (que rende inflação + juros) com um título em % do CDI '
      + 'exige uma premissa de quanto o CDI e o IPCA vão render no futuro — são bases diferentes. '
      + 'Para uma comparação justa, me diga a sua expectativa de CDI e de IPCA para o período, '
      + 'ou compare títulos da mesma base (ex: dois em % do CDI, ou dois IPCA+). '
      + '\n\n💡 Dica para o cliente: títulos IPCA+ protegem da inflação; pós-fixados (% do CDI) acompanham a Selic. '
      + 'A escolha depende do cenário de juros e do objetivo.';
  }

  // COMPARACAO (2+ investimentos)
  if(itens.length >= 2){
    var comp = compararPorGrossUp(itens);
    if(comp.erro) return null;
    var anos = (dias/365).toFixed(dias%365===0?0:1).replace('.',',');
    var txt = '📊 Comparativo (base CDB equivalente, prazo '+anos+' '+(dias===365?'ano':'anos')+'):\n\n';
    comp.itens.forEach(function(it,i){
      var medalha = it.vencedor ? '🏆 ' : (i+1)+'º ';
      var equiv = it.isento ? ' → equivale a CDB '+_invV(it.cdbEquivalente)+'% do CDI' : '';
      txt += medalha + it.nome + ' ' + _invV(it.taxaInformada) + '% do CDI' + (it.isento?' (isento)':'') + equiv + '\n';
    });
    txt += '\n💡 ' + comp.itens[0].nome + ' é a melhor opção pela equivalência fiscal. ' + comp.observacao;
    // guarda para gerar PDF a pedido do usuario (botao no balao)
    _ultimaComparacaoChat = { comp:comp, dias:dias, anos:anos };
    return { texto: txt, pdf:true };
  }

  // CALCULO SIMPLES (1 investimento) - precisa de gross-up/equivalencia
  var it = itens[0];
  if(it.isento){
    var gu = grossUp(it.taxaCDI, dias);
    return '💰 '+it.nome+' '+it.taxaCDI+'% do CDI (isento de IR)\n\n'
      + 'Com a isenção, equivale a um CDB tributado de '+_invV(gu.cdbEquivalente)+'% do CDI '
      + '(alíquota de '+(gu.aliquotaIR*100).toFixed(1).replace('.',',')+'% no prazo). '
      + 'Ou seja: só vale a pena trocar por um CDB se ele pagar mais que '+_invV(gu.cdbEquivalente)+'% do CDI.';
  } else {
    var gd = grossDown(it.taxaCDI, dias);
    return '💰 '+it.nome+' '+it.taxaCDI+'% do CDI (tributado)\n\n'
      + 'Descontando o IR de '+(gd.aliquotaIR*100).toFixed(1).replace('.',',')+'% no prazo, '
      + 'equivale a um isento (LCI/LCA) de '+_invV(gd.lciEquivalente)+'% do CDI. '
      + 'Uma LCI só ganha desse CDB se pagar mais que '+_invV(gd.lciEquivalente)+'% do CDI.';
  }
}

// Chip de sugestão: preenche o campo e envia a pergunta
function _chipPergunta(texto){
  var input=document.getElementById('ai-chat-input');
  if(input){ input.value=texto; _updateChatBtn(); }
  aiChatSend();
}

// Mostra uma resposta do assistente com chips de sub-pergunta clicáveis
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

// Detecta pedidos vagos e oferece sub-perguntas. Retorna true se tratou.
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

// Executes a create-action returned by the agent. Returns a human label or null.
function _aiExecuteAction(a){
  var args=a.args||{};
  try{
    if(a.name==='criar_evento'){
      state.events.push({
        id:uid(), title:args.titulo||'Evento',
        date:args.data, time:args.hora||'09:00',
        color:'#2d7dd2', remind:(args.lembrete_min!==undefined?args.lembrete_min:15)
      });
      if(typeof renderEvents==='function') renderEvents();
      return 'Evento: '+(args.titulo||'')+' ('+args.data+' '+(args.hora||'')+')';
    }
    if(a.name==='criar_tarefa'){
      state.tasks.unshift({
        id:uid(), text:args.texto||'Tarefa', done:false,
        importante:(args.importante===false?0:1),
        urgente:(args.urgente===true?1:0)
      });
      if(typeof renderTasks==='function') renderTasks();
      return 'Tarefa: '+(args.texto||'');
    }
    if(a.name==='criar_transacao'){
      var tp=(args.tipo==='in')?'in':'out';
      state.transactions.unshift({
        id:uid(), desc:args.descricao||'Transação',
        val:Math.abs(args.valor||0), type:tp,
        cat:(tp==='in'?'salario':'outros'), date:args.data||today(), recur:false
      });
      if(typeof renderFinance==='function') renderFinance();
      return (tp==='in'?'Receita':'Despesa')+': '+(args.descricao||'')+' R$'+fm(Math.abs(args.valor||0));
    }
    if(a.name==='criar_nota'){
      _ensureFolders();
      state.notes.unshift({
        id:uid(), title:args.titulo||'Nota', body:args.corpo||'',
        folderId:'default', date:today()
      });
      if(typeof renderNotes==='function') renderNotes();
      return 'Nota: '+(args.titulo||'');
    }
  }catch(e){ return null; }
  return null;
}

init();
