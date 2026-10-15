// Shared contracts for desktop execution, tool calling and assistant exports.
const f = (name,label,defaultValue='',type='string') => ({name,label,default:defaultValue,type});
const catalog = [
 ['vault_schema','Structure du coffre','memory','database','Collections, champs et accès IA',[]],
 ['vault_overview','Parcourir le coffre','memory','database','Collections, sources et parcours du coffre',[]],
 ['vault_sources','Parcourir une source','memory','folder','Données connectées des applications et sandboxs',[f('source','Source'),f('query','Recherche'),f('offset','Décalage',0,'number')]],
 ['vault_source_get','Lire une donnée connectée','memory','file-text','Lecture d’une donnée par identifiant exact',[f('id','Identifiant')]],
 ['vault_query','Interroger une collection','memory','database','Recherche et filtre exact dans le coffre personnel',[f('collection','Collection'),f('query','Recherche'),f('filter','Filtre JSON','{}','object'),f('limit','Limite',50,'number'),f('offset','Décalage',0,'number')]],
 ['memory_recall','Retrouver des souvenirs','memory','brain','Recherche dans la mémoire de Lumen',[f('query','Recherche')]],
 ['memory_remember','Mémoriser un souvenir','memory','brain','Enregistre un souvenir durable',[f('text','Souvenir'),f('kind','Type de mémoire','semantic')],true],
 ['vault_get','Lire une valeur mémoire','memory','key-round','Lit une clé du coffre personnel',[f('key','Clé')]],
 ['vault_set','Écrire une valeur mémoire','memory','key-round','Enregistre une valeur dans le coffre',[f('key','Clé'),f('value','Valeur'),f('type','Type','text')],true],
 ['vault_list','Lister les clés mémoire','memory','list','Recherche les clés par préfixe',[f('prefix','Préfixe')]],
 ['vault_append','Ajouter à une liste mémoire','memory','list','Ajoute un élément sans remplacer la liste',[f('key','Clé'),f('item','Élément')],true],
 ['tables_schema','Catalogue des bases','database','database','Schémas des bases de données Lumen',[]],
 ['tables_query','Interroger une base SQL','database','database','Lecture SQL SELECT uniquement',[f('base','Nom de la base'),f('sql','Requête SELECT','SELECT * FROM ma_table LIMIT 20')]],
 ['table_rows','Lire les lignes','database','database','Lit une table par identifiant',[f('table_id','Identifiant de table'),f('limit','Limite',100,'number'),f('offset','Décalage',0,'number')]],
 ['table_row_insert','Insérer une ligne','database','database','Insère un objet avec les identifiants de colonnes',[f('table_id','Identifiant de table'),f('values','Valeurs JSON','{}','object')],true],
 ['table_row_update','Modifier une ligne','database','database','Met à jour une ligne existante',[f('table_id','Identifiant de table'),f('row_id','Identifiant de ligne',1,'number'),f('values','Valeurs JSON','{}','object')],true],
 ['search_documents','Recherche documentaire · RAG','knowledge','search','Recherche dans les documents indexés par Lumen',[f('query','Question')]],
 ['data_search','Rechercher des données Lumen','knowledge','search','Recherche dans les applications et données Lumen',[f('query','Recherche'),f('app','Application (facultatif)')]],
 ['data_get','Lire une donnée Lumen','knowledge','file-text','Récupère une donnée par identifiant',[f('id','Identifiant')]],
 ['data_agenda','Lire l’agenda','lumen','calendar','Consulte les événements',[f('period','Période','semaine')]],
 ['data_tasks','Lire les tâches','lumen','list','Consulte les tâches',[f('status','Statut','all')]],
 ['weather_now','Météo','lumen','cloud','Météo via les services configurés dans Lumen',[f('place','Lieu (vide = lieu configuré)')]],
 ['web_search','Recherche web','lumen','search','Recherche avec le fournisseur web de Lumen',[f('query','Recherche'),f('freshness','Fraîcheur','semaine')]],
 ['web_read_page','Lire une page web','lumen','globe','Extrait le contenu d’une URL HTTP(S)',[f('url','URL')]],
 ['domotique_list_devices','Lister les appareils','home','house','Appareils domotiques enregistrés dans Lumen',[]],
 ['domotique_get_state','État d’un appareil','home','house','Lit l’état d’un appareil enregistré',[f('device','Appareil')]],
 ['domotique_command','Commander un appareil','home','house','Appelle une action sur un appareil enregistré',[f('device','Appareil'),f('action','Action'),f('component','Composant (facultatif)'),f('params','Paramètres JSON','{}','object')],true],
 ['create_reminder','Créer un rappel','lumen','calendar','Ajoute un rappel dans Lumen',[f('title','Titre'),f('note','Note'),f('due_at_iso','Date ISO'),f('recur','Récurrence','none')],true],
 ['kanban_add_card','Créer une carte Kanban','lumen','list','Ajoute une tâche dans un projet',[f('title','Titre'),f('project','Projet'),f('column','Colonne'),f('description','Description')],true],
 ['market_quote','Cours financier','lumen','chart-line','Consulte une cotation',[f('query','Symbole'),f('kind','Type','auto'),f('currency','Devise','EUR')]],
 ['exchange_rate','Conversion de devises','lumen','chart-line','Lit le taux et convertit un montant',[f('from','Depuis','EUR'),f('to','Vers','USD'),f('amount','Montant',1,'number')]],
 ['air_quality','Qualité de l’air','lumen','cloud','Consulte la qualité de l’air',[f('place','Lieu')]],
];
export const LUMEN_ACTIONS = Object.fromEntries(catalog.map(([action,title,cat,icon,description,fields,write=false])=>[action,{action,title,cat,icon,description,fields,write}]));
export function validateActionArgs(action,args) {
 const spec=LUMEN_ACTIONS[action];
 if(!spec || !args || typeof args!=='object' || Array.isArray(args)) throw new Error('Action Lumen non autorisée.');
 for(const [key,value] of Object.entries(args)) {
  const field=spec.fields.find(f=>f.name===key);
  if(!field || (field.type==='object' ? !value || typeof value!=='object' || Array.isArray(value) : typeof value!==field.type)) throw new Error(`Argument invalide : ${key}`);
 }
 if(JSON.stringify(args).length>32000) throw new Error('Arguments trop volumineux.');
 return args;
}
export function lumenTool(spec,w) {
 // Resource identifiers stay fixed; the model supplies only unconfigured fields.
 const fixed={},properties={};
 for(const field of spec.fields) {
  const v=w[field.name];
  if(['collection','key','prefix','table_id','base','device','project','column','kind','type','freshness','recur','component'].includes(field.name) && v!=='' && v!=null) fixed[field.name]=v;
  else properties[field.name]={type:field.type,description:field.label};
 }
 return {kind:'lumen',action:spec.action,name:w.toolName||spec.action,description:spec.description,fixed,parameters:{type:'object',properties,additionalProperties:false}};
}
export async function runLumenTool(tool,args,ctx) {
 if(Object.keys(args||{}).some(k=>!Object.hasOwn(tool.parameters.properties,k))) throw new Error('Arguments d’outil non autorisés.');
 return ctx.lumen(tool.action,validateActionArgs(tool.action,{...args,...tool.fixed}));
}
function fieldWidget(spec,f) {
 const options=spec.action==='memory_remember'&&f.name==='kind'?[['semantic','Fait durable'],['episodic','Épisode'],['procedural','Procédure'],['session','Session']]:spec.action==='vault_set'&&f.name==='type'?[['text','Texte'],['number','Nombre'],['bool','Oui / non'],['date','Date'],['list','Liste'],['dict','Objet JSON']]:f.name==='freshness'?[['jour','Jour'],['semaine','Semaine'],['mois','Mois'],['annee','Année']]:f.name==='recur'?[['none','Aucune'],['daily','Quotidienne'],['weekly','Hebdomadaire'],['monthly','Mensuelle']]:null;
 return {...f,kind:options?'select':f.type==='number'?'number':f.type==='object'||['text','sql','value','description'].includes(f.name)?'textarea':'text',...(options?{options}: {})};
}
export const LUMEN_DEFS=Object.values(LUMEN_ACTIONS).map(spec=>({
 type:`lumen_${spec.action}`,title:spec.title,cat:spec.cat,icon:spec.icon,description:spec.description+(spec.write?' · écriture':''),volatile:true,
 inputs:spec.fields.map(f=>({name:f.name,type:f.type==='number'?'NUMBER':f.type==='object'?'ANY':'TEXT',widget:f.name,optional:true})),
 outputs:[{name:'données',type:'JSON'},{name:'texte',type:'TEXT'},{name:'outil',type:'TOOL'}],
 widgets:[{name:'asTool',label:'Mode outil : exécuter seulement sur appel de l’agent',kind:'toggle',default:false},{name:'toolName',label:'Nom de fonction (facultatif)',kind:'text',default:''},...spec.fields.map(f=>fieldWidget(spec,f))],
 run:async(i,w,ctx)=>{
  const tool=lumenTool(spec,w);
  if(w.asTool) return [null,'',tool];
  const args={};for(const f of spec.fields) {let v=i[f.name]??w[f.name]??f.default;if(f.type==='object'&&typeof v==='string')v=JSON.parse(v);args[f.name]=v;}
  const value=await ctx.lumen(spec.action,validateActionArgs(spec.action,args));
  let data=value;try {if(typeof value==='string')data=JSON.parse(value);}catch{}
  return [data,typeof value==='string'?value:JSON.stringify(value),null];
 }
}));
