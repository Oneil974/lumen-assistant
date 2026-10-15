// Robot Studio — libellés français des blocs.
//
// Script classique, chargé APRÈS vendor/blockly.min.js et AVANT blocks.js :
// les définitions de blocs (reprises telles quelles de Rpi-Robot-Studio) sont
// en anglais ; on intercepte `defineBlocksWithJsonArray` pour traduire textes,
// infobulles et libellés de listes quand Lumen est en français. Les VALEURS des
// listes (ce que lit le générateur Python) ne sont jamais touchées.
(function () {
  var lang;
  try { lang = localStorage.getItem("lang"); } catch (e) { lang = null; }
  if (!lang) lang = (navigator.language || "fr").toLowerCase().indexOf("en") === 0 ? "en" : "fr";
  window.RS_LANG = lang;
  if (lang === "en") return;

  var FR = {
    "set GPIO pin %1 to %2": "mettre la broche GPIO %1 à %2",
    "Set a GPIO output HIGH or LOW": "Met une sortie GPIO à l'état haut ou bas",
    "HIGH (3.3V)": "HAUT (3,3 V)", "LOW (0V)": "BAS (0 V)",
    "set RGB LED R pin %1 G pin %2 B pin %3 color %4 frequency %5 common %6": "LED RVB broche R %1 V %2 B %3 couleur %4 fréquence %5 commune %6",
    "Drive an RGB LED using PWM": "Pilote une LED RVB en PWM",
    "cathode": "cathode", "anode": "anode",
    "WS2812B pin %1 leds %2 set index %3 color %4 brightness %5": "WS2812B broche %1 LED %2 index %3 couleur %4 luminosité %5",
    "Set the color of a WS2812B LED": "Change la couleur d'une LED WS2812B",
    "WS2812B pin %1 leds %2 fill color %3 brightness %4": "WS2812B broche %1 LED %2 remplir couleur %3 luminosité %4",
    "Fill the entire WS2812B strip with a color": "Remplit tout le ruban WS2812B d'une couleur",
    "read GPIO pin %1 pull %2": "lire la broche GPIO %1 rappel %2",
    "Read the digital state of a GPIO pin": "Lit l'état numérique d'une broche GPIO",
    "none": "aucun", "pull-up": "pull-up", "pull-down": "pull-down",
    "set servo on GPIO %1 angle %2": "servo sur GPIO %1 angle %2",
    "Control a servo": "Pilote un servomoteur",
    "read distance trig %1 echo %2": "lire la distance trig %1 echo %2",
    "Read ultrasonic sensor": "Lit un capteur à ultrasons",
    "HTTP GET %1": "HTTP GET %1", "Perform HTTP GET": "Effectue une requête HTTP GET",
    "HTTPS GET %1": "HTTPS GET %1", "Perform HTTPS GET": "Effectue une requête HTTPS GET",
    "mqtt config host %1 port %2": "MQTT hôte %1 port %2",
    "Configure MQTT broker": "Configure le broker MQTT",
    "mqtt publish topic %1 message %2": "MQTT publier sujet %1 message %2",
    "Publish MQTT message": "Publie un message MQTT",
    "mqtt subscribe topic %1": "MQTT s'abonner au sujet %1",
    "Subscribe to MQTT topic": "S'abonne à un sujet MQTT",
    "parse JSON %1": "lire le JSON %1", "Parse JSON string": "Convertit une chaîne JSON en objet",
    "get key %2 from %1": "clé %2 de %1", "Get value from JSON object": "Lit une valeur d'un objet JSON",
    "set key %2 of %1 to %3": "mettre la clé %2 de %1 à %3", "Set value in JSON object": "Écrit une valeur dans un objet JSON",
    "JSON stringify %1": "JSON en texte %1", "Convert object to JSON string": "Convertit un objet en chaîne JSON",
    "AI request url %1 model %2 prompt %3 stream %4 think %5 store in %6": "requête IA url %1 modèle %2 prompt %3 flux %4 réflexion %5 stocker dans %6",
    "Query Ollama LLM and store the reply": "Interroge un modèle Ollama et stocke la réponse",
    "http wait endpoint %1 field %2 store in %3": "attendre HTTP route %1 champ %2 stocker dans %3",
    "Wait for HTTP request and store field": "Attend une requête HTTP et en stocke un champ",
    "http get request endpoint %1 field %2": "requête HTTP reçue route %1 champ %2",
    "Get next HTTP request if available": "Lit la prochaine requête HTTP reçue, s'il y en a une",
    "memory set storage %1 namespace %2 key %3 value %4": "mémoire écrire fichier %1 espace %2 clé %3 valeur %4",
    "Store a value inside a local SQLite memory file on the robot": "Enregistre une valeur dans un fichier mémoire SQLite local du robot",
    "memory get storage %1 namespace %2 key %3": "mémoire lire fichier %1 espace %2 clé %3",
    "Retrieve a value from the local SQLite memory file": "Lit une valeur du fichier mémoire SQLite local",
    "memory delete storage %1 namespace %2 key %3": "mémoire effacer fichier %1 espace %2 clé %3",
    "Remove a value from the local SQLite memory file": "Supprime une valeur du fichier mémoire SQLite local",
    "device log message url %1 device %2 level %3 message %4": "journal appareil url %1 appareil %2 niveau %3 message %4",
    "Send a text log to the platform": "Envoie une ligne de journal à la plateforme",
    "info": "info", "warning": "avertissement", "error": "erreur",
    "device log metric url %1 device %2 type %3 label %4 value %5 unit %6": "mesure appareil url %1 appareil %2 type %3 libellé %4 valeur %5 unité %6",
    "Send a metric log to the platform": "Envoie une mesure à la plateforme",
    "metric": "mesure", "temperature": "température", "cpu": "cpu", "storage": "stockage",
    "CPU temperature": "température CPU", "Read CPU temperature": "Lit la température du processeur",
    "GPU temperature": "température GPU", "Read GPU temperature": "Lit la température du GPU",
    "CPU usage": "charge CPU", "Get CPU utilisation": "Lit la charge du processeur",
    "RAM usage": "mémoire utilisée", "Get RAM utilisation": "Lit l'occupation de la RAM",
    "I2C write addr %1 reg %2 value %3": "I2C écrire adr %1 reg %2 valeur %3", "Write to I2C device": "Écrit sur un périphérique I2C",
    "I2C read addr %1 reg %2": "I2C lire adr %1 reg %2", "Read from I2C device": "Lit un périphérique I2C",
    "serial send port %1 baud %2 message %3": "série envoyer port %1 débit %2 message %3", "Send data over serial": "Envoie des données sur le port série",
    "serial read line port %1 baud %2": "série lire une ligne port %1 débit %2", "Read line from serial": "Lit une ligne sur le port série",
    "MFRC522 read tag": "MFRC522 lire le badge", "Read UID and payload from an RFID tag": "Lit l'UID et le contenu d'un badge RFID",
    "MFRC522 write text %1": "MFRC522 écrire le texte %1", "Write a short text payload to an RFID tag": "Écrit un court texte sur un badge RFID",
    "DS18B20 %1 temperature": "DS18B20 %1 température", "Read DS18B20 temperature": "Lit la température d'une sonde DS18B20",
    "DHT11 GPIO %1 temperature": "DHT11 GPIO %1 température", "Read DHT11 temperature": "Lit la température d'un DHT11",
    "DHT11 GPIO %1 humidity": "DHT11 GPIO %1 humidité", "Read DHT11 humidity": "Lit l'humidité d'un DHT11",
    "DHT22 GPIO %1 temperature": "DHT22 GPIO %1 température", "Read DHT22 temperature": "Lit la température d'un DHT22",
    "DHT22 GPIO %1 humidity": "DHT22 GPIO %1 humidité", "Read DHT22 humidity": "Lit l'humidité d'un DHT22",
    "PIR motion GPIO %1": "mouvement PIR GPIO %1", "Read PIR sensor": "Lit un détecteur de mouvement PIR",
    "IR receiver GPIO %1 active?": "récepteur IR GPIO %1 actif ?",
    "Read the digital signal from a demodulating IR receiver module": "Lit le signal numérique d'un module récepteur infrarouge",
    "IR send remote %1 command %2 repeat %3": "IR envoyer télécommande %1 commande %2 répéter %3",
    "Send an infrared command defined in your LIRC configuration": "Envoie une commande infrarouge définie dans votre configuration LIRC",
    "encoder steps CLK %1 DT %2": "pas de l'encodeur CLK %1 DT %2", "Read rotary encoder steps": "Lit les pas d'un encodeur rotatif",
    "encoder direction CLK %1 DT %2": "sens de l'encodeur CLK %1 DT %2", "Read rotary encoder direction": "Lit le sens de rotation d'un encodeur",
    "ADS1015 channel %1": "ADS1015 canal %1", "Read ADS1015 channel": "Lit un canal du convertisseur ADS1015",
    "camera capture %1 width %2 height %3": "photo caméra %1 largeur %2 hauteur %3", "Capture photo with Pi camera": "Prend une photo avec la caméra du Pi",
    "record video %1 secs %2 width %3 height %4": "filmer %1 durée %2 s largeur %3 hauteur %4", "Record video with Pi camera": "Filme avec la caméra du Pi",
    "start Hailo YOLO": "démarrer YOLO Hailo", "Launch Hailo object detection": "Lance la détection d'objets sur l'accélérateur Hailo",
    "get Hailo detection": "détection Hailo suivante", "Retrieve next detection result": "Lit le prochain résultat de détection",
    "start websocket server host %1 port %2": "serveur WebSocket hôte %1 port %2", "Start websocket server": "Démarre un serveur WebSocket",
    "websocket server running?": "serveur WebSocket actif ?", "Check if websocket server is running": "Indique si le serveur WebSocket tourne",
    "websocket send %1": "WebSocket envoyer %1", "Send message over websocket": "Envoie un message aux clients WebSocket",
    "websocket client count": "nombre de clients WebSocket", "Number of connected websocket clients": "Nombre de clients WebSocket connectés",
    "wait %1 seconds": "attendre %1 secondes", "Pause execution": "Met le programme en pause",
    "play animation %1": "jouer l'animation %1", "Play a saved animation timeline": "Joue une animation enregistrée",
    "while %1": "tant que %1", "do %1": "faire %1", "While loop": "Boucle « tant que »",
    "loop forever": "répéter indéfiniment", "Infinite loop": "Boucle infinie",
    "setup": "démarrage", "Code executed once at startup": "Code exécuté une fois au démarrage",
    "loop": "boucle", "Main loop executed repeatedly": "Boucle principale, exécutée en continu",
    "function %1": "fonction %1", "Define a reusable function": "Définit une fonction réutilisable",
    "call function": "appeler la fonction", "Call a named function": "Appelle une fonction nommée",
    "ui animation %1 fps %2": "écran animation %1 i/s %2", "Configure UI animation": "Règle l'animation de l'écran",
    "ui start width %1 height %2 color %3": "écran démarrer largeur %1 hauteur %2 couleur %3", "Start UI server": "Démarre le serveur d'affichage",
    "start UI": "démarrer l'écran", "Start UI server with defaults": "Démarre le serveur d'affichage avec les réglages par défaut",
    "ui add text id %1 content %2": "écran ajouter un texte id %1 contenu %2", "Add text element to canvas": "Ajoute un texte à l'écran",
    "ui text %1 content %2": "écran texte %1 contenu %2", "Change text content": "Change le contenu d'un texte",
    "ui add image id %1 src %2 width %3 height %4": "écran ajouter une image id %1 source %2 largeur %3 hauteur %4", "Add image to canvas": "Ajoute une image à l'écran",
    "ui add sprite id %1 frames %2 fps %3 loop %4 width %5 height %6": "écran ajouter un sprite id %1 images %2 i/s %3 boucle %4 largeur %5 hauteur %6", "Add animated sprite to canvas": "Ajoute un sprite animé à l'écran",
    "ui text %1 color %2": "écran texte %1 couleur %2", "Set text color": "Change la couleur d'un texte",
    "ui text %1 size %2": "écran texte %1 taille %2", "Set text size": "Change la taille d'un texte",
    "ui element %1 position x %2 y %3": "écran élément %1 position x %2 y %3", "Set element position": "Place un élément",
    "ui element %1 rotation %2": "écran élément %1 rotation %2", "Set element rotation": "Fait pivoter un élément",
    "ui image %1 source %2": "écran image %1 source %2", "Change image source": "Change la source d'une image",
    "ui sprite %1 frames %2": "écran sprite %1 images %2", "Replace sprite frames": "Remplace les images d'un sprite",
    "ui sprite %1 play": "écran sprite %1 lecture", "Play sprite animation": "Lance l'animation d'un sprite",
    "ui sprite %1 pause": "écran sprite %1 pause", "Pause sprite animation": "Met en pause l'animation d'un sprite",
    "ui sprite %1 set frame %2": "écran sprite %1 image n° %2", "Set sprite frame index": "Affiche une image précise du sprite",
    "ui sprite %1 fps %2": "écran sprite %1 i/s %2", "Set sprite animation FPS": "Règle la vitesse d'un sprite",
    "ui sprite %1 loop %2": "écran sprite %1 boucle %2", "Enable or disable sprite loop": "Active ou coupe la boucle d'un sprite",
    "ui element %1 size w %2 h %3": "écran élément %1 taille l %2 h %3", "Set element size": "Redimensionne un élément",
    "ui element %1 visible %2": "écran élément %1 visible %2", "Show or hide element": "Affiche ou masque un élément",
    "ui get event": "écran évènement suivant", "Get next UI event": "Lit le prochain évènement de l'écran",
    "play audio %1": "jouer le son %1", "Play an audio file": "Joue un fichier audio",
    "pause audio": "mettre le son en pause", "Pause audio playback": "Met la lecture audio en pause",
    "stop audio": "arrêter le son", "Stop audio playback": "Arrête la lecture audio",
    "set volume %1": "volume %1", "Set playback volume (0-100)": "Règle le volume (0-100)",
    "piper config model %1 config %2 use cuda %3": "Piper modèle %1 config %2 CUDA %3", "Configure Piper TTS": "Configure la synthèse vocale Piper",
    "piper say %1": "Piper dire %1", "Speak text using Piper": "Prononce un texte avec Piper",
    "piper cli say %1 model %2 config %3": "Piper (CLI) dire %1 modèle %2 config %3", "Speak text using Piper CLI": "Prononce un texte avec Piper en ligne de commande",
    "ollama start model %1": "Ollama charger le modèle %1", "Load an Ollama model into memory": "Charge un modèle Ollama en mémoire",
    "ollama stop model %1": "Ollama décharger le modèle %1", "Unload an Ollama model from memory": "Décharge un modèle Ollama",
    "ollama running store in %1": "modèles Ollama chargés dans %1", "List models currently in memory": "Liste les modèles chargés en mémoire",
    "ml predict url %1 model %2 sample %3 store in %4": "prédiction ML url %1 modèle %2 donnée %3 stocker dans %4", "Send sample to ML inference API": "Envoie une donnée à une API d'inférence",
    "ml predict image url %1 model %2 image %3 store in %4": "prédiction ML image url %1 modèle %2 image %3 stocker dans %4", "Send base64 image to ML inference API": "Envoie une image (base64) à une API d'inférence",
    "ml predict yolo url %1 model %2 image %3 store in %4": "détection YOLO url %1 modèle %2 image %3 stocker dans %4", "Send image to YOLO detection API": "Envoie une image à une API de détection YOLO",
    "ml local predict model %1 sample %2 store in %3": "prédiction locale modèle %1 donnée %2 stocker dans %3", "Run prediction with a local model": "Prédit avec un modèle présent sur le Pi",
    "ml local predict image model %1 image %2 store in %3": "classification locale modèle %1 image %2 stocker dans %3", "Classify image with a local model": "Classe une image avec un modèle présent sur le Pi",
    "ml local yolo model %1 image %2 store in %3": "YOLO local modèle %1 image %2 stocker dans %3", "Run YOLO detection locally": "Détecte des objets avec YOLO, sur le Pi",
  };

  function tr(s) { return typeof s === "string" && FR[s] ? FR[s] : s; }
  window.RS_TR = tr;

  var define = Blockly.defineBlocksWithJsonArray;
  Blockly.defineBlocksWithJsonArray = function (arr) {
    (arr || []).forEach(function (b) {
      Object.keys(b).forEach(function (k) {
        if (/^message\d+$/.test(k) || k === "tooltip") b[k] = tr(b[k]);
        if (/^args\d+$/.test(k) && Array.isArray(b[k])) {
          b[k].forEach(function (a) {
            if (Array.isArray(a.options)) a.options = a.options.map(function (o) { return [tr(o[0]), o[1]]; });
          });
        }
      });
    });
    return define.call(Blockly, arr);
  };

  var MSG = {
    ADD_COMMENT: "Ajouter un commentaire", CHANGE_VALUE_TITLE: "Changer la valeur :", CLEAN_UP: "Ranger les blocs",
    COLLAPSE_ALL: "Replier les blocs", COLLAPSE_BLOCK: "Replier le bloc", CONTROLS_IF_MSG_ELSE: "sinon",
    CONTROLS_IF_MSG_ELSEIF: "sinon si", CONTROLS_IF_MSG_IF: "si", CONTROLS_IF_MSG_THEN: "faire",
    CONTROLS_REPEAT_INPUT_DO: "faire", CONTROLS_REPEAT_TITLE: "répéter %1 fois",
    CONTROLS_REPEAT_TOOLTIP: "Exécute des instructions plusieurs fois.", DELETE_ALL_BLOCKS: "Supprimer ces %1 blocs ?",
    DELETE_BLOCK: "Supprimer le bloc", DELETE_VARIABLE: "Supprimer la variable « %1 »",
    DELETE_VARIABLE_CONFIRMATION: "Supprimer les %1 utilisations de la variable « %2 » ?", DELETE_X_BLOCKS: "Supprimer %1 blocs",
    DISABLE_BLOCK: "Désactiver le bloc", DUPLICATE_BLOCK: "Dupliquer", DUPLICATE_COMMENT: "Dupliquer le commentaire",
    ENABLE_BLOCK: "Activer le bloc", EXPAND_ALL: "Déplier les blocs", EXPAND_BLOCK: "Déplier le bloc",
    EXTERNAL_INPUTS: "Entrées externes", HELP: "Aide", INLINE_INPUTS: "Entrées en ligne",
    LOGIC_BOOLEAN_FALSE: "faux", LOGIC_BOOLEAN_TRUE: "vrai", LOGIC_BOOLEAN_TOOLTIP: "Renvoie vrai ou faux.",
    LOGIC_COMPARE_TOOLTIP_EQ: "Vrai si les deux valeurs sont égales.", MATH_NUMBER_TOOLTIP: "Un nombre.",
    NEW_VARIABLE: "Créer une variable…", NEW_VARIABLE_TITLE: "Nom de la nouvelle variable :", REDO: "Rétablir",
    REMOVE_COMMENT: "Supprimer le commentaire", RENAME_VARIABLE: "Renommer la variable…",
    RENAME_VARIABLE_TITLE: "Renommer toutes les variables « %1 » en :", TEXT_TEXT_TOOLTIP: "Une lettre, un mot ou une ligne de texte.",
    UNDO: "Annuler", VARIABLES_GET_CREATE_SET: "Créer « mettre %1 »", VARIABLES_SET: "mettre %1 à %2",
    VARIABLES_SET_CREATE_GET: "Créer « lire %1 »", VARIABLE_ALREADY_EXISTS: "Une variable nommée « %1 » existe déjà.",
    WORKSPACE_COMMENT_DEFAULT_TEXT: "Écrivez quelque chose…",
  };
  Object.keys(MSG).forEach(function (k) { Blockly.Msg[k] = MSG[k]; });
})();
