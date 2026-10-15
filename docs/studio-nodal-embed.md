# Assistant Nodal

Node.js 22+ ; aucune dépendance npm. Le workflow exporté est un instantané. Réexportez après modification.

1. Copiez .env.example vers .env. Générez EMBED_SECRET avec : node -e "console.log(require('crypto').randomBytes(32).toString('hex'))". Ne commitez jamais .env.
2. Renseignez MODEL_NAME, MODEL_API_URL, MODEL_API_KEY ou DEFAULT_BACKEND=local et LOCAL_MODEL. Les blocs proposent aussi Ollama (OLLAMA_URL, OLLAMA_MODEL) et Apple Foundation Models (APPLEFM_API_URL, APPLEFM_MODEL) sur un Mac compatible. Pour Apple FM, la passerelle Lumen doit être disponible et démarrée sur le Mac hôte. DEFAULT_BACKEND accepte aussi ollama et applefm. Les URLs et clés sont exclusivement des variables serveur.
3. Renseignez ALLOWED_ORIGINS avec les origines HTTPS exactes de vos sites, séparées par des virgules.
4. npm start. Publiez derrière un reverse proxy HTTPS vers 127.0.0.1:8787. Limitez aussi le débit au niveau du proxy.
5. Créez /api/assistant-session sur VOTRE backend. Authentifiez vos utilisateurs, vérifiez la provenance/CSRF et appliquez votre quota utilisateur avant de créer une session. Cet endpoint doit appeler POST https://assistant.example.com/session avec Authorization: Bearer EMBED_SECRET et JSON {"origin":"https://www.example.com"}, puis renvoyer la réponse JSON au widget. EMBED_SECRET ne doit jamais être envoyé au navigateur. Les contrôles d’origine seuls ne sont pas une authentification.
6. Collez embed.html sur votre site. Autorisez https://assistant.example.com dans votre CSP script-src et connect-src. Le widget affiche les réponses comme texte, sans HTML exécutable.

Exemple dans votre route backend (après authentification et quota, avec une origine configurée côté serveur, jamais extraite du body utilisateur) :

const upstream = await fetch(process.env.ASSISTANT_URL + '/session', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.EMBED_SECRET },
  body: JSON.stringify({ origin: process.env.SITE_ORIGIN })
});
if (!upstream.ok) throw new Error('Session indisponible');
const session = await upstream.json(); // renvoyer avec Cache-Control: no-store

## Fluxo
Le serveur appelle le bridge Robot de Lumen : activez-le dans Lumen et renseignez LUMEN_URL et LUMEN_DEVICE_TOKEN côté serveur. Lumen doit rester accessible. Seuls les noms de workflows présents dans cet export sont appelables ; choisissez des workflows adaptés aux permissions des visiteurs. Aucune clé du bridge n’est embarquée dans le widget.

## Sessions et budget
Sessions isolées, expirant après 15 minutes ; 30 requêtes ; 4 exécutions simultanées globalement et 1 par session ; maximum 1000 sessions ; 4000 caractères par message ; 8 tours d’outils maximum. Le budget de 100000 réserve conservativement les octets du contexte + outils et le maximum de sortie avant chaque appel : ce compteur est un plafond de sécurité, pas la facturation exacte du fournisseur. Les échecs consomment la réservation. Le modèle reçoit max_tokens au plus 8192.
Révocation : POST /sessions/revoke, Authorization Bearer EMBED_SECRET, body {"sessionId":"..."}. Un redémarrage révoque toutes les sessions et efface les historiques. Pour plusieurs processus, prévoyez un stockage partagé et des quotas persistants.

## Blocs Lumen : mémoire, données et outils

29 blocs réutilisent les services configurés dans Lumen. Ils fournissent une sortie données JSON, une sortie texte (contexte du modèle) et une sortie outil. Activez **Mode outil** pour relier cette dernière à l’agent : le bloc ne réalise alors aucune action avant un appel du modèle. Une collection d’outils permet de regrouper plusieurs blocs (8 outils maximum par agent).

Les champs clé, base, table, appareil et projet renseignés dans le bloc restent fixes pendant un appel d’outil. Le modèle fournit les autres arguments. Les écritures sont des effets réels ; les blocs concernés portent la mention « écriture » et ne sont pas mis en cache. Les données retrouvées se branchent sur l’entrée contexte de l’agent.

Les bases sont les tables de Lumen : le catalogue expose leurs schémas, SELECT est en lecture seule, les insertions/modifications utilisent les identifiants de table et de colonne du catalogue et un objet JSON. Aucun connecteur PostgreSQL/MySQL arbitraire n’est ajouté.

Les assistants exportés utilisent `/device/nodal` sur le pont authentifié Lumen, avec `LUMEN_URL` et `LUMEN_DEVICE_TOKEN` gardés uniquement sur le serveur. Lumen doit être démarré et déverrouillé. Les services météo/web/domotique conservent leur configuration et leurs secrets dans Lumen. Par défaut les écritures sont refusées dans l’embed ; ajoutez `LUMEN_ALLOW_WRITES=true` uniquement pour un workflow prévu pour modifier vos données ou commander vos appareils. Le navigateur ne peut sélectionner ni une action ni un bloc : seuls ceux du graphe exporté s’exécutent.

Modèles disponibles : assistant avec mémoire, assistant documentaire RAG, météo & web, SQL en lecture. Inspiration : [outils Langflow](https://docs.langflow.org/agents) et [mémoire Flowise](https://docs.flowiseai.com/integrations/langchain/memory).
