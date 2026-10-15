// Workflows prêts à l'emploi du mode « Nœuds » (menu « Modèles »).
// liens : [indexSource, sortie, indexCible, entrée].

export const TEMPLATES = [
  { title: "Assistant avec mémoire", hint: "Souvenirs pertinents en contexte + outil de mémorisation",
    nodes: [{type:"chat_input",x:0,y:0},{type:"lumen_memory_recall",x:350,y:300},{type:"lumen_memory_remember",x:0,y:300,widgets:{asTool:true}},{type:"ai_agent",x:700,y:0},{type:"chat_output",x:1050,y:0}], links:[[0,0,1,0],[0,0,3,0],[1,1,3,4],[2,2,3,2],[3,0,4,0]] },
  { title: "Assistant documentaire · RAG", hint: "Question → documents indexés → contexte de l’agent",
    nodes: [{type:"chat_input",x:0,y:0},{type:"lumen_search_documents",x:350,y:250},{type:"ai_agent",x:700,y:0},{type:"chat_output",x:1050,y:0}], links:[[0,0,1,0],[0,0,2,0],[1,1,2,4],[2,0,3,0]] },
  { title: "Assistant météo & web", hint: "Deux outils reliés, exécutés à la demande du modèle",
    nodes: [{type:"chat_input",x:0,y:0},{type:"lumen_weather_now",x:0,y:250,widgets:{asTool:true}},{type:"lumen_web_search",x:350,y:300,widgets:{asTool:true}},{type:"ai_agent",x:700,y:0},{type:"chat_output",x:1050,y:0}], links:[[0,0,3,0],[1,2,3,2],[2,2,3,3],[3,0,4,0]] },
  { title: "Assistant SQL · lecture", hint: "Configurer le nom de base ; catalogue + requêtes SELECT",
    nodes: [{type:"chat_input",x:0,y:0},{type:"lumen_tables_schema",x:0,y:250,widgets:{asTool:true}},{type:"lumen_tables_query",x:350,y:300,widgets:{asTool:true}},{type:"ai_agent",x:700,y:0},{type:"chat_output",x:1050,y:0}], links:[[0,0,3,0],[1,2,3,2],[2,2,3,3],[3,0,4,0]] },

  { title: "Assistant embarquable", hint: "Message → agent + modèle → réponse chat",
    nodes: [{ type: "chat_input", x: 0, y: 0 }, { type: "chat_model", x: 0, y: 220 }, { type: "ai_agent", x: 370, y: 0 }, { type: "chat_output", x: 740, y: 0 }], links: [[0,0,2,0],[1,0,2,1],[2,0,3,0]] },
  { title: "Agent avec outil Fluxo", hint: "Choisir un workflow Fluxo puis laisser l’agent l’appeler",
    nodes: [{ type: "chat_input", x: 0, y: 0 }, { type: "fluxo_tool", x: 0, y: 230 }, { type: "ai_agent", x: 370, y: 0 }, { type: "chat_output", x: 740, y: 0 }], links: [[0,0,2,0],[1,0,2,2],[2,0,3,0]] },
  {
    title: "Image simple", hint: "Idée → prompt amélioré → image → aperçu et enregistrement",
    nodes: [
      { type: "text", x: 0, y: 0, widgets: { text: "un renard roux dans une forêt brumeuse au lever du jour" } },
      { type: "prompt_enhance", x: 320, y: 0 },
      { type: "image_gen", x: 640, y: 0 },
      { type: "preview", x: 960, y: 0 },
      { type: "save_image", x: 960, y: 380, widgets: { prefix: "renard" } },
    ],
    links: [[0, 0, 1, 0], [1, 0, 2, 0], [2, 0, 3, 0], [2, 0, 4, 0]],
  },
  {
    title: "Affiche de marque", hint: "Brief → charte + image de fond → affiche composée",
    nodes: [
      { type: "text", x: 0, y: 120, widgets: { text: "café de quartier chaleureux, bois clair et céramique, grande ouverture samedi" }, title: "Brief" },
      { type: "charte", x: 320, y: 0 },
      { type: "prompt_enhance", x: 320, y: 300 },
      { type: "image_gen", x: 640, y: 300, widgets: { width: 768, height: 1024 } },
      { type: "poster", x: 960, y: 60, widgets: { title: "Grande ouverture", subtitle: "Samedi dès 9 h — premier café offert", cta: "Venir nous voir" } },
      { type: "save_image", x: 1280, y: 60, widgets: { prefix: "affiche" } },
    ],
    links: [[0, 0, 1, 0], [0, 0, 2, 0], [2, 0, 3, 0], [3, 0, 4, 0], [1, 0, 4, 1], [4, 0, 5, 0]],
  },
  {
    title: "Planche de 4 variations", hint: "Un prompt, quatre graines, une planche",
    nodes: [
      { type: "text", x: 0, y: 260, widgets: { text: "logo minimaliste d'une montagne, ligne fine, fond clair" }, title: "Prompt" },
      { type: "image_gen", x: 320, y: 0 }, { type: "image_gen", x: 320, y: 360 }, { type: "image_gen", x: 640, y: 0 }, { type: "image_gen", x: 640, y: 360 },
      { type: "img_grid", x: 960, y: 180 },
      { type: "preview", x: 1280, y: 180 },
    ],
    links: [[0, 0, 1, 0], [0, 0, 2, 0], [0, 0, 3, 0], [0, 0, 4, 0], [1, 0, 5, 0], [2, 0, 5, 1], [3, 0, 5, 2], [4, 0, 5, 3], [5, 0, 6, 0]],
    groups: [{ title: "Variations", x: 300, y: -40, w: 660, h: 760, color: "#8b5cf6" }],
  },
  {
    title: "Réinterpréter une image", hint: "Image → prompt (vision) + style → nouvelle image, avant/après",
    nodes: [
      { type: "image_load", x: 0, y: 0 },
      { type: "img2prompt", x: 320, y: 0 },
      { type: "text", x: 320, y: 260, widgets: { text: "style aquarelle japonaise, papier texturé" }, title: "Style" },
      { type: "concat", x: 640, y: 80 },
      { type: "image_gen", x: 960, y: 0 },
      { type: "img_grid", x: 1280, y: 0 },
      { type: "preview", x: 1600, y: 0 },
    ],
    links: [[0, 0, 1, 0], [1, 0, 3, 0], [2, 0, 3, 1], [3, 0, 4, 0], [0, 0, 5, 0], [4, 0, 5, 1], [5, 0, 6, 0]],
  },
  {
    title: "Retouche et légende", hint: "Photo → réglages → vignette → titre incrusté",
    nodes: [
      { type: "image_load", x: 0, y: 0 },
      { type: "img_adjust", x: 320, y: 0, widgets: { contrast: 115, saturate: 125 } },
      { type: "img_vignette", x: 640, y: 0 },
      { type: "img_text", x: 960, y: 0, widgets: { text: "Été 2026" } },
      { type: "preview", x: 1280, y: 0 },
      { type: "save_image", x: 1280, y: 360, widgets: { prefix: "photo-retouchee" } },
    ],
    links: [[0, 0, 1, 0], [1, 0, 2, 0], [2, 0, 3, 0], [3, 0, 4, 0], [3, 0, 5, 0]],
  },
  {
    title: "Jingle et voix", hint: "Sujet → jingle → voix de synthèse + boucle musicale",
    nodes: [
      { type: "text", x: 0, y: 120, widgets: { text: "boulangerie bio du quartier, pain au levain" }, title: "Sujet" },
      { type: "jingle", x: 320, y: 0 },
      { type: "tts", x: 640, y: 0 },
      { type: "music", x: 320, y: 300 },
      { type: "preview", x: 960, y: 0 },
      { type: "preview", x: 640, y: 300 },
      { type: "save_text", x: 640, y: 160, widgets: { name: "jingle" } },
    ],
    links: [[0, 0, 1, 0], [1, 0, 2, 0], [0, 0, 3, 0], [2, 0, 4, 0], [3, 0, 5, 0], [1, 0, 6, 0]],
  },
  {
    title: "Rédaction et traduction", hint: "Brief → texte IA → traduction → fichier",
    nodes: [
      { type: "text", x: 0, y: 0, widgets: { text: "Présente notre atelier de céramique en 3 phrases chaleureuses." }, title: "Brief" },
      { type: "llm_text", x: 320, y: 0 },
      { type: "translate", x: 640, y: 0 },
      { type: "preview", x: 640, y: 260 },
      { type: "save_text", x: 960, y: 0, widgets: { name: "presentation-en" } },
    ],
    links: [[0, 0, 1, 0], [1, 0, 2, 0], [1, 0, 3, 0], [2, 0, 4, 0]],
  },
];
