// No long-lived secret belongs in this widget. tokenUrl is your authenticated backend.
export function mountAssistant({host,tokenUrl,title='Assistant Lumen'}) {
  const root=document.createElement('div');document.body.append(root);
  const shadow=root.attachShadow({mode:'open'});
  shadow.innerHTML='<style>:host{position:fixed;right:24px;bottom:24px;z-index:2147483000;font:14px system-ui}button{cursor:pointer}button,input{font:inherit;border:1px solid #ddd;border-radius:12px;padding:10px}button{background:#7660dd;color:white}section{width:min(350px,90vw);height:430px;display:flex;flex-direction:column;background:white;color:#222;border:1px solid #ddd;border-radius:18px;box-shadow:0 12px 50px #0003;overflow:hidden}header{padding:16px;background:#7660dd;color:white;display:flex;justify-content:space-between}main{flex:1;overflow:auto;padding:14px}p{white-space:pre-wrap;overflow-wrap:anywhere;padding:10px;background:#f3f1fa;border-radius:12px}form{display:flex;padding:10px;gap:6px}input{min-width:0;flex:1}[hidden]{display:none}</style><button id="toggle" aria-expanded="false">💬 Assistant</button><section hidden><header><strong></strong><button id="close" aria-label="Fermer">×</button></header><main aria-live="polite"></main><form><input required maxlength="4000" aria-label="Message" placeholder="Votre message…"><button>Envoyer</button></form></section>';
  shadow.querySelector('strong').textContent=title;
  const panel=shadow.querySelector('section'),toggle=shadow.querySelector('#toggle'),input=shadow.querySelector('input'),submit=shadow.querySelector('form button');
  toggle.onclick=()=>{panel.hidden=false;toggle.hidden=true;toggle.setAttribute('aria-expanded','true');input.focus();};
  shadow.querySelector('#close').onclick=()=>{panel.hidden=true;toggle.hidden=false;toggle.setAttribute('aria-expanded','false');toggle.focus();};
  let session=null;
  const line=text=>{const p=document.createElement('p');p.textContent=text;shadow.querySelector('main').append(p);p.scrollIntoView({block:'nearest'});};
  shadow.querySelector('form').onsubmit=async e=>{
    e.preventDefault();const message=input.value.trim();if(!message||submit.disabled)return;submit.disabled=true;input.value='';line(message);
    try {
      if(!session||session.expiresAt<=Date.now()){
        const r=await fetch(tokenUrl,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:'{}'});
        if(!r.ok)throw new Error('Impossible d’ouvrir une session.');session=await r.json();
        if(!session.token||!session.expiresAt)throw new Error('Session invalide.');
      }
      const r=await fetch(`${host.replace(/\/$/,'')}/chat`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${session.token}`},body:JSON.stringify({message})});
      const data=await r.json();if(!r.ok){if(r.status===401)session=null;throw new Error(data.error||'Assistant indisponible.');}line(data.response);
    }catch(err){line(err.message);}finally{submit.disabled=false;input.focus();}
  };
  return {destroy:()=>root.remove()};
}
