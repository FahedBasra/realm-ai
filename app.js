/* Realm AI — chat engine, history, agent, code, image, voice */
(function(){
'use strict';
const $=id=>document.getElementById(id);
const KEY='realm_chats_v2',SKEY='realm_settings_v1';
let store={cur:null,chats:[]},settings={name:'Guest'},busy=false,attached=null;
try{store=JSON.parse(localStorage.getItem(KEY))||store}catch(e){}
try{settings=Object.assign(settings,JSON.parse(localStorage.getItem(SKEY)))}catch(e){}
const save=()=>{try{localStorage.setItem(KEY,JSON.stringify(store))}catch(e){}};
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function md(t){
  const blocks=[];
  t=esc(t).replace(/```(\w*)\n?([\s\S]*?)```/g,(m,l,c)=>{blocks.push('<pre><span class="lang">'+(l||'code')+'</span><button class="copycode" onclick="copyCode(this)">Copy</button><code>'+c.replace(/\n$/,'')+'</code></pre>');return '\u0000'+(blocks.length-1)+'\u0000'});
  t=t.replace(/`([^`\n]+)`/g,'<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g,'<b>$1</b>')
   .replace(/^#{1,4} (.+)$/gm,'<h4>$1</h4>')
   .replace(/^(?:[-*] .+(?:\n|$))+/gm,m=>'<ul>'+m.trim().split('\n').map(x=>'<li>'+x.slice(2)+'</li>').join('')+'</ul>')
   .replace(/^(?:\d+\. .+(?:\n|$))+/gm,m=>'<ol>'+m.trim().split('\n').map(x=>'<li>'+x.replace(/^\d+\. /,'')+'</li>').join('')+'</ol>')
   .replace(/\n/g,'<br>').replace(/(<\/(?:h4|ul|ol|pre)>)(?:<br>)+/g,'$1').replace(/(?:<br>)+(<(?:h4|ul|ol|pre))/g,'$1');
  return t.replace(/\u0000(\d+)\u0000/g,(m,i)=>blocks[i]);
}
window.copyCode=b=>{navigator.clipboard?.writeText(b.parentElement.querySelector('code').textContent);b.textContent='Copied';setTimeout(()=>b.textContent='Copy',1400)};
function toast(m){let t=$('toast');if(!t){t=document.createElement('div');t.id='toast';document.body.appendChild(t)}t.textContent=m;t.className='show';clearTimeout(t._h);t._h=setTimeout(()=>t.className='',2600)}
window.toast=toast;

function cur(){let c=store.chats.find(x=>x.id===store.cur);if(!c){c={id:Date.now()+'',title:'New chat',messages:[]};store.chats.unshift(c);store.cur=c.id;save()}return c}
function renderList(){const el=$('chatList');if(!el)return;el.innerHTML=store.chats.filter(c=>c.messages.length).map(c=>'<div class="chat-title'+(c.id===store.cur?' active':'')+'" data-id="'+c.id+'"><span>'+esc(c.title)+'</span><b class="del" data-del="'+c.id+'">✕</b></div>').join('')||'<div class="chat-title" style="opacity:.6">No chats yet</div>'}
function renderChat(){
  const c=cur(),box=$('messages');
  if(!c.messages.length){box.innerHTML='<div class="msg"><div class="avatar">R</div><div class="bubble">Hi, I\'m <b>Realm AI</b>. Ask me anything: write, plan, code, analyze or brainstorm.</div></div>'}
  else box.innerHTML=c.messages.map((m,i)=>m.role==='user'?'<div class="msg me"><div class="bubble">'+esc(m.content).replace(/\n/g,'<br>')+'</div></div>':'<div class="msg"><div class="avatar">R</div><div class="bubble">'+md(m.content)+'<div class="acts"><button onclick="copyMsg('+i+')">Copy</button>'+(i===c.messages.length-1?'<button onclick="regen()">Regenerate</button>':'')+'</div></div></div>').join('');
  const hero=document.querySelector('.chat-hero');if(hero)hero.style.display=c.messages.length?'none':'';box.scrollTop=box.scrollHeight;renderList();
}
window.copyMsg=i=>{navigator.clipboard?.writeText(cur().messages[i].content);toast('Copied to clipboard')};
document.addEventListener('click',e=>{const d=e.target.closest('[data-del]');if(d){store.chats=store.chats.filter(c=>c.id!==d.dataset.del);if(store.cur===d.dataset.del)store.cur=null;save();renderChat();e.stopPropagation();return}const t=e.target.closest('#chatList .chat-title[data-id]');if(t){store.cur=t.dataset.id;save();renderChat()}});

const SYS='You are Realm AI, a helpful, friendly assistant. Reply in English unless the user writes in another language. Be clear and concise.';
async function direct(messages,k){
  const contents=messages.map(m=>({role:m.role==='user'?'user':'model',parts:[{text:m.content}]}));
  while(contents.length&&contents[0].role!=='user')contents.shift();
  const model=localStorage.getItem('realm_gemini_model')||'gemini-2.5-flash-lite';
  const r=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+model+':generateContent',{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':k},body:JSON.stringify({systemInstruction:{parts:[{text:SYS}]},contents})});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error((d.error&&d.error.message)||'Gemini request failed. Check your API key and model name in Settings.');
  return (d.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('')||'I could not generate a reply. Please try again.';
}
async function callAI(messages){
  let r=null,d={};
  try{r=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages})});d=await r.json().catch(()=>({}))}catch(e){r=null}
  if(r&&r.ok)return d.text;
  const noBackend=!r||r.status===404||r.status===405||(r.status===500&&/not configured/i.test(d.error||''));
  const k=localStorage.getItem('realm_gemini_key');
  if(noBackend&&k)return direct(messages,k);
  if(noBackend)throw new Error('The AI backend is not connected yet. To test on your own computer, open Settings and paste your Gemini API key. After you deploy on Cloudflare, it works automatically for everyone.');
  throw new Error(d.error||'Realm AI is temporarily unavailable. Please try again.');
}
async function reveal(el,text,box){const w=text.split(/(\s+)/);let o='';for(let i=0;i<w.length;i++){o+=w[i];if(i%8===0||i===w.length-1){el.innerHTML=md(o);if(box)box.scrollTop=box.scrollHeight;await sleep(12)}}}

async function ask(text,regen){
  if(busy)return;const c=cur();
  if(!regen){c.messages.push({role:'user',content:text});if(c.title==='New chat')c.title=text.slice(0,42)}
  save();renderChat();busy=true;$('send').disabled=true;
  const box=$('messages');box.insertAdjacentHTML('beforeend','<div class="msg" id="live"><div class="avatar">R</div><div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div></div>');box.scrollTop=box.scrollHeight;
  const payload=c.messages.slice(-12).map(m=>({role:m.role,content:m.content}));
  if(attached&&!regen){const l=payload[payload.length-1];l.content='[Attached file: '+attached.name+']\n'+attached.text+'\n\n'+l.content;attached=null;if($('fileList'))$('fileList').innerHTML=''}
  const bub=$('live').querySelector('.bubble');
  try{const reply=await callAI(payload);await reveal(bub,reply,box);c.messages.push({role:'assistant',content:reply});save()}
  catch(e){bub.innerHTML='<b>Something went wrong.</b><br>'+esc(e.message)+'<div class="acts"><button onclick="regen()">Try again</button></div>'}
  busy=false;$('send').disabled=false;
  if(c.messages.length&&c.messages[c.messages.length-1].role==='assistant')renderChat();else renderList();
}
window.sendMsg=async function(){const p=$('prompt'),t=p.value.trim();if(!t||busy)return;p.value='';await ask(t)};
window.regen=function(){const c=cur();if(busy)return;while(c.messages.length&&c.messages[c.messages.length-1].role==='assistant')c.messages.pop();if(c.messages.length)ask(null,true)};
window.clearChat=function(){const c=cur();if(c.messages.length){store.cur=null;cur()}renderChat();$('prompt').value='';$('prompt').focus()};

/* Files: text-based files are read in the browser and sent with your next message */
window.renderFiles=function(files,modal){
  const target=$(modal?'uploadPreview':'fileList');if(!target)return;target.innerHTML='';
  [...files].forEach(f=>{const el=document.createElement('span');el.className='file-pill';el.textContent='▤ '+f.name+' · '+Math.max(1,Math.round(f.size/1024))+' KB';target.appendChild(el)});
  const f=[...files].find(x=>/\.(txt|md|csv|json|js|py|html|css)$/i.test(x.name));
  if(f){const fr=new FileReader();fr.onload=()=>{attached={name:f.name,text:String(fr.result).slice(0,30000)};toast('"'+f.name+'" attached. Ask a question about it in Chat.')};fr.readAsText(f)}
  else if(files.length)toast('Only text-based files can be read right now (.txt, .md, .csv, .json, code).');
};

/* Agent */
window.runAgent=async function(){
  const t=$('agentTask').value.trim(),s=$('agentStatus');if(!t){s.textContent='Describe a goal first.';return}
  s.className='answer';s.innerHTML='<span class="typing"><i></i><i></i><i></i></span> Planning and working…';
  try{const r=await callAI([{role:'user',content:'You are Realm Agent, an autonomous assistant. For the goal below: 1) write a short numbered plan, 2) carry out each step and show the work, 3) finish with a "Result" section with the final deliverable.\n\nGoal: '+t}]);await reveal(s,r)}
  catch(e){s.textContent=e.message}
};
window.runAgentDemo=window.runAgent;

/* Code */
let cmode='Answer this coding request';
window.codeMode=m=>{cmode=m;toast('Mode: '+m)};
window.askCode=async function(){
  const t=$('codePrompt').value.trim(),o=$('codeOut');if(!t){toast('Paste code or describe what you need.');return}
  o.innerHTML='<span class="typing"><i></i><i></i><i></i></span>';
  try{const r=await callAI([{role:'user',content:'You are an expert software engineer. Task: '+cmode+'. Use fenced code blocks and be concise.\n\n'+t}]);await reveal(o,r)}catch(e){o.textContent=e.message}
};

/* Image */
window.genImage=function(){
  const p=$('imgPrompt').value.trim(),o=$('imgOut');if(!p){toast('Describe the image first.');return}
  o.innerHTML='<span class="typing"><i></i><i></i><i></i></span> Creating your image…';
  const img=new Image();img.alt=p;img.onload=()=>{o.innerHTML='';o.appendChild(img);const a=document.createElement('a');a.href=img.src;a.target='_blank';a.textContent='Open full size';a.className='dl';o.appendChild(a)};
  img.onerror=()=>{o.textContent='Image generation is busy right now. Please try again in a moment.'};
  img.src='https://image.pollinations.ai/prompt/'+encodeURIComponent(p)+'?width=1024&height=768&nologo=true&seed='+Math.floor(Math.random()*1e6);
};

/* Voice */
window.startVoice=function(){const R=window.SpeechRecognition||window.webkitSpeechRecognition;if(!R){toast('Voice input is not supported in this browser.');return}const r=new R();r.lang='en-US';r.onresult=e=>{$('prompt').value=e.results[0][0].transcript;$('prompt').focus()};r.onerror=()=>toast('Could not hear you. Please try again.');toast('Listening…');r.start()};


/* Paddle checkout + Contact sales */
let pInit=false;
function paddleReady(){
  if(!window.Paddle||!PADDLE.token)return false;
  if(!pInit){if(PADDLE.env==='sandbox')Paddle.Environment.set('sandbox');
    Paddle.Initialize({token:PADDLE.token,eventCallback:e=>{if(e&&e.name==='checkout.completed')toast('Payment successful! Your plan will be activated shortly.')}});pInit=true}
  return true;
}
window.buyPlan=function(plan){
  const id=PADDLE.prices[plan];
  if(!window.Paddle){toast('Checkout could not load. Please disable ad blockers and try again.');return}
  if(!paddleReady()||!id){console.warn('Paddle is not configured: set PADDLE.token and PADDLE.prices in index.html');toast('Checkout is not available yet. Please try again soon.');return}
  Paddle.Checkout.open({items:[{priceId:id,quantity:1}],customData:{plan},settings:{displayMode:'overlay',theme:'dark',locale:'en'}});
};
window.contactSales=function(){
  let m=$('salesModal');
  if(!m){document.body.insertAdjacentHTML('beforeend','<div class="modal" id="salesModal"><div class="modalbox"><div class="modalhead"><h3>Contact sales</h3><button class="close" onclick="closeModal(\'salesModal\')">×</button></div><p style="color:#73829d;font-size:12px;line-height:1.55">Tell us about your team and needs. We will reply within one business day.</p><div class="stack"><input class="input" id="sName" placeholder="Your name"><input class="input" id="sEmail" type="email" placeholder="Work email"><input class="input" id="sCompany" placeholder="Company (optional)"><textarea class="input" id="sMsg" rows="4" placeholder="How can we help?"></textarea><button class="primary" onclick="sendSales()">Send message</button></div></div></div>');m=$('salesModal')}
  openModal('salesModal');
};
window.sendSales=function(){
  const n=$('sName').value.trim(),e=$('sEmail').value.trim(),c=$('sCompany').value.trim(),t=$('sMsg').value.trim();
  if(!n||!e||!t){toast('Please fill in your name, email and message.');return}
  if(!SALES.email){toast('Sales contact is not available right now. Please try again later.');return}
  location.href='mailto:'+SALES.email+'?subject='+encodeURIComponent('Realm AI Enterprise enquiry')+'&body='+encodeURIComponent('Name: '+n+'\nEmail: '+e+'\nCompany: '+c+'\n\n'+t);
};

/* Settings, login, legal */
function applyName(){const n=settings.name||'Guest';document.querySelectorAll('.profile-name').forEach(x=>x.textContent=n);document.querySelectorAll('.profile .avatar,#loginBtn').forEach(x=>x.textContent=n[0].toUpperCase());const h=$('welcomeH');if(h)h.textContent=n==='Guest'?'Welcome back 👋':'Welcome back, '+n+' 👋';const i=$('settingsView').querySelector('input:not([type=password])');if(i)i.value=n}
window.savePrefs=function(){try{const gk=$('gKey');if(gk){gk.value.trim()?localStorage.setItem('realm_gemini_key',gk.value.trim()):localStorage.removeItem('realm_gemini_key');$('gModel').value.trim()?localStorage.setItem('realm_gemini_model',$('gModel').value.trim()):localStorage.removeItem('realm_gemini_model')}}catch(e){}const i=$('settingsView').querySelector('input:not([type=password])');settings.name=(i.value||'Guest').trim().slice(0,30);try{localStorage.setItem(SKEY,JSON.stringify(settings))}catch(e){}applyName();toast('Preferences saved')};
window.loginSoon=()=>toast('Accounts are launching soon. Your chats are saved on this device.');
const LEGAL={Privacy:'Your chats are stored in your own browser. Messages you send are processed by our AI provider to generate replies. Never share passwords, card numbers or other secrets in chat. We do not store payment card details.',Terms:'Realm AI can make mistakes, so please verify important information and do not rely on it for medical, legal or financial decisions. Paid plans are billed monthly through Paddle, our payment provider, and can be cancelled at any time.'};
window.showInfo=function(k){let m=$('infoModal');if(!m){document.body.insertAdjacentHTML('beforeend','<div class="modal" id="infoModal"><div class="modalbox"><div class="modalhead"><h3 id="infoT"></h3><button class="close" onclick="closeModal(\'infoModal\')">×</button></div><p id="infoB" style="color:#9fb0cc;font-size:13px;line-height:1.6"></p></div></div>');m=$('infoModal')}$('infoT').textContent=k;$('infoB').textContent=LEGAL[k];openModal('infoModal')};

document.addEventListener('DOMContentLoaded',()=>{const st=document.querySelector('#settingsView .stack');if(st)st.insertAdjacentHTML('afterbegin','<label style="font-size:10px;color:#7f8ca5">Gemini API key (for testing on your computer only)<input class="input" id="gKey" type="password" placeholder="Paste key from aistudio.google.com" /></label><label style="font-size:10px;color:#7f8ca5">Gemini model (optional)<input class="input" id="gModel" placeholder="gemini-2.5-flash-lite" /></label>');const gk=$('gKey');if(gk){gk.value=localStorage.getItem('realm_gemini_key')||'';$('gModel').value=localStorage.getItem('realm_gemini_model')||''}applyName();renderChat();const p=$('prompt');p.addEventListener('input',()=>{p.style.height='auto';p.style.height=Math.min(p.scrollHeight,180)+'px'})});
})();
