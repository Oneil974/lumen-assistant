// A failed ES module dependency must not leave an inert screen of buttons.
import('/companion.js').catch(error => {
  console.error('Companion could not start', error);
  document.querySelectorAll('.sheet,.overlay,.drawer,.mx-overlay').forEach(el=>{el.hidden=true;});
  const panel=document.createElement('section');panel.className='pair-overlay';
  const card=document.createElement('div');card.className='pair-card';
  const title=document.createElement('h1');title.textContent='Le compagnon ne peut pas démarrer';
  const text=document.createElement('p');text.textContent='Le chargement de Lumen a été interrompu. Rechargez cette page après avoir vérifié la connexion avec votre ordinateur.';
  const retry=document.createElement('button');retry.className='send-btn';retry.textContent='Recharger';retry.onclick=()=>location.reload();
  card.append(title,text,retry);panel.append(card);document.body.append(panel);
});
