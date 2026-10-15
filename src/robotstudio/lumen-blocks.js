// Robot Studio — blocs « Lumen » : le programme du Pi parle à Lumen.
//
// Script classique, chargé après blocks.js. Chaque bloc appelle une route
// `/device/*` de l'écouteur réseau de Lumen (companion.rs), avec le jeton
// d'appareil. L'adresse et le jeton ne sont PAS écrits dans le code : ils sont
// lus dans `lumen.json`, déposé à côté de project.py au déploiement (ou dans
// les variables d'environnement LUMEN_URL / LUMEN_TOKEN).
(function () {
  var EN = window.RS_LANG === "en";
  var L = function (fr, en) { return EN ? en : fr; };
  var COLOUR = "#7C5CFF";

  var S = function (name) { return { type: "input_value", name: name, check: ["String", "Number"] }; };
  var stmt = function (b) { b.previousStatement = null; b.nextStatement = null; b.colour = COLOUR; b.inputsInline = true; return b; };
  var expr = function (b, out) { b.output = out || "String"; b.colour = COLOUR; b.inputsInline = true; return b; };

  var DEFS = [
    expr({ type: "lumen_connected", message0: L("Lumen joignable ?", "Lumen reachable?"), tooltip: L("Vrai si Lumen répond sur le réseau avec ce jeton.", "True if Lumen answers on the network with this token.") }, "Boolean"),
    stmt({ type: "lumen_notify", message0: L("Lumen : notifier %1 %2", "Lumen: notify %1 %2"), args0: [S("TITLE"), S("BODY")], tooltip: L("Publie un message dans le centre de notifications de Lumen (et la capsule).", "Posts a message to Lumen's notification centre (and the capsule).") }),
    expr({ type: "lumen_ask", message0: L("Lumen : réponse de l'IA à %1", "Lumen: AI answer to %1"), args0: [S("PROMPT")], tooltip: L("Pose une question au modèle actif de Lumen et renvoie sa réponse (texte).", "Asks Lumen's active model a question and returns its answer (text).") }),
    stmt({ type: "lumen_speak", message0: L("Lumen : dire à voix haute %1", "Lumen: say aloud %1"), args0: [S("TEXT")], tooltip: L("L'ordinateur de Lumen prononce le texte avec sa voix de synthèse.", "Lumen's computer speaks the text with its synthetic voice.") }),
    stmt({ type: "lumen_remember", message0: L("Lumen : mémoriser %1", "Lumen: remember %1"), args0: [S("TEXT")], tooltip: L("Ajoute un souvenir à la mémoire de Lumen (source « robot »).", "Adds a memory to Lumen's memory (source “robot”).") }),
    expr({ type: "lumen_recall", message0: L("Lumen : souvenirs sur %1", "Lumen: memories about %1"), args0: [S("QUERY")], tooltip: L("Les souvenirs de Lumen les plus proches de la question, un par ligne.", "Lumen's memories closest to the query, one per line.") }),
    stmt({ type: "lumen_mem_set", message0: L("Lumen : valeur partagée %1 = %2", "Lumen: shared value %1 = %2"), args0: [S("KEY"), { type: "input_value", name: "VALUE" }], tooltip: L("Écrit une valeur partagée (lisible par Fluxo, les agents et les autres robots).", "Writes a shared value (readable by Fluxo, agents and other robots).") }),
    expr({ type: "lumen_mem_get", message0: L("Lumen : valeur partagée %1", "Lumen: shared value %1"), args0: [S("KEY")], tooltip: L("Lit une valeur partagée (vide si elle n'existe pas).", "Reads a shared value (empty if it does not exist).") }, null),
    expr({ type: "lumen_agent", message0: L("Lumen : demander à l'agent %1 : %2", "Lumen: ask agent %1: %2"), args0: [S("AGENT"), S("TASK")], tooltip: L("Confie une demande à un agent de Lumen et renvoie son compte rendu (peut prendre plusieurs minutes).", "Gives a request to a Lumen agent and returns its report (can take several minutes).") }),
    stmt({ type: "lumen_agent_task", message0: L("Lumen : ajouter la tâche %2 à l'agent %1", "Lumen: add task %2 to agent %1"), args0: [S("AGENT"), S("TASK")], tooltip: L("Ajoute une tâche à la liste d'un agent, sans attendre.", "Adds a task to an agent's list, without waiting.") }),
    expr({ type: "lumen_workflow", message0: L("Lumen : résultat du workflow %1 avec %2", "Lumen: result of workflow %1 with %2"), args0: [S("NAME"), S("INPUT")], tooltip: L("Lance un workflow Fluxo par son nom et renvoie sa sortie.", "Runs a Fluxo workflow by name and returns its output.") }),
    stmt({ type: "lumen_inbox", message0: L("Lumen : message dans le Fil %1 %2", "Lumen: message in the Feed %1 %2"), args0: [S("SUBJECT"), S("BODY")], tooltip: L("Dépose un message dans le Fil de Lumen, signé « Robot ».", "Drops a message in Lumen's Feed, signed “Robot”.") }),
    stmt({ type: "lumen_reminder", message0: L("Lumen : rappel %1 dans %2 minutes", "Lumen: reminder %1 in %2 minutes"), args0: [S("TITLE"), { type: "input_value", name: "MIN", check: "Number" }], tooltip: L("Crée un rappel dans l'Agenda de Lumen.", "Creates a reminder in Lumen's Calendar.") }),
    stmt({ type: "lumen_photo", message0: L("Lumen : envoyer la photo %1 légende %2", "Lumen: send photo %1 caption %2"), args0: [S("PATH"), S("CAPTION")], tooltip: L("Envoie un fichier image du Pi (ex. celui du bloc caméra) dans la sandbox choisie dans Robot Studio.", "Sends an image file from the Pi (e.g. from the camera block) to the sandbox chosen in Robot Studio.") }),
    stmt({ type: "lumen_domotique", message0: L("Lumen : domotique %1 action %2 valeur %3", "Lumen: home device %1 action %2 value %3"), args0: [S("DEVICE"), { type: "field_dropdown", name: "ACTION", options: [[L("allumer", "turn on"), "on"], [L("éteindre", "turn off"), "off"], [L("basculer", "toggle"), "toggle"], [L("régler", "set"), "set"]] }, { type: "input_value", name: "VALUE" }], tooltip: L("Pilote un objet de l'app Domotique (nom ou référence). « régler » accepte un dictionnaire, ex. {\"brightness\": 50}.", "Controls a device of the Home automation app (name or reference). “set” accepts a dictionary, e.g. {\"brightness\": 50}.") }),
  ];
  Blockly.defineBlocksWithJsonArray(DEFS);

  var P = Blockly.Python;
  var HELPER = [
    "import json, os, base64, requests",
    "",
    "def _lumen_cfg():",
    "    try:",
    "        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lumen.json')) as f:",
    "            return json.load(f)",
    "    except Exception:",
    "        return {'url': os.environ.get('LUMEN_URL', ''), 'token': os.environ.get('LUMEN_TOKEN', '')}",
    "",
    "_LUMEN = _lumen_cfg()",
    "",
    "def lumen_call(path, payload=None, method='POST', timeout=180):",
    "    \"\"\"Appel d'une route /device/* de Lumen ; renvoie le texte, '' en cas d'échec.\"\"\"",
    "    if not _LUMEN.get('url') or not _LUMEN.get('token'):",
    "        print('Lumen : adresse ou jeton manquant (lumen.json)')",
    "        return ''",
    "    try:",
    "        r = requests.request(method, _LUMEN['url'].rstrip('/') + path, json=payload,",
    "                             headers={'Authorization': 'Bearer ' + _LUMEN['token']}, timeout=timeout)",
    "        if r.status_code >= 400:",
    "            print('Lumen', path, r.status_code, r.text[:200])",
    "            return ''",
    "        return r.text",
    "    except Exception as e:",
    "        print('Lumen injoignable :', e)",
    "        return ''",
    "",
    "def lumen_json(path, payload=None, method='POST'):",
    "    try:",
    "        return json.loads(lumen_call(path, payload, method) or 'null')",
    "    except ValueError:",
    "        return None",
  ].join("\n");

  function use() { P.definitions_["lumen_helper"] = HELPER; }
  function v(block, name, def) { return P.valueToCode(block, name, P.ORDER_NONE) || (def === undefined ? "''" : def); }
  function str(block, name) { return "str(" + v(block, name) + ")"; }

  P["lumen_connected"] = function () { use(); return ["(lumen_call('/device/ping', method='GET', timeout=5) == 'pong')", P.ORDER_RELATIONAL]; };
  P["lumen_notify"] = function (b) { use(); return "lumen_call('/device/notify', {'title': " + str(b, "TITLE") + ", 'body': " + str(b, "BODY") + "})\n"; };
  P["lumen_ask"] = function (b) { use(); return ["lumen_call('/device/ask', {'prompt': " + str(b, "PROMPT") + "})", P.ORDER_FUNCTION_CALL]; };
  P["lumen_speak"] = function (b) { use(); return "lumen_call('/device/speak', {'text': " + str(b, "TEXT") + "})\n"; };
  P["lumen_remember"] = function (b) { use(); return "lumen_call('/device/remember', {'text': " + str(b, "TEXT") + "})\n"; };
  P["lumen_recall"] = function (b) {
    use();
    P.definitions_["lumen_recall_fn"] = [
      "def lumen_recall(query, limit=5):",
      "    items = lumen_json('/device/recall', {'query': query, 'limit': limit}) or []",
      "    return '\\n'.join((i.get('text') or (i.get('item') or {}).get('text') or '') for i in items if isinstance(i, dict))",
    ].join("\n");
    return ["lumen_recall(" + str(b, "QUERY") + ")", P.ORDER_FUNCTION_CALL];
  };
  P["lumen_mem_set"] = function (b) { use(); return "lumen_call('/device/mem/robot/' + " + str(b, "KEY") + ", " + v(b, "VALUE", "None") + ", method='PUT')\n"; };
  P["lumen_mem_get"] = function (b) { use(); return ["((lumen_json('/device/mem/robot/' + " + str(b, "KEY") + ", method='GET') or {}).get('value', ''))", P.ORDER_FUNCTION_CALL]; };
  P["lumen_agent"] = function (b) { use(); return ["lumen_call('/device/agent', {'agent': " + str(b, "AGENT") + ", 'prompt': " + str(b, "TASK") + "}, timeout=1800)", P.ORDER_FUNCTION_CALL]; };
  P["lumen_agent_task"] = function (b) { use(); return "lumen_call('/device/agent/task', {'agent': " + str(b, "AGENT") + ", 'text': " + str(b, "TASK") + "})\n"; };
  P["lumen_workflow"] = function (b) { use(); return ["lumen_call('/device/workflow', {'name': " + str(b, "NAME") + ", 'input': " + str(b, "INPUT") + "}, timeout=900)", P.ORDER_FUNCTION_CALL]; };
  P["lumen_inbox"] = function (b) { use(); return "lumen_call('/device/inbox', {'from': 'Robot', 'subject': " + str(b, "SUBJECT") + ", 'body': " + str(b, "BODY") + "})\n"; };
  P["lumen_reminder"] = function (b) { use(); return "lumen_call('/device/reminder', {'title': " + str(b, "TITLE") + ", 'due_in_ms': int(float(" + v(b, "MIN", "0") + ") * 60000)})\n"; };
  P["lumen_photo"] = function (b) {
    use();
    P.definitions_["lumen_photo_fn"] = [
      "def lumen_photo(path, caption=''):",
      "    try:",
      "        with open(path, 'rb') as f:",
      "            data = base64.b64encode(f.read()).decode('ascii')",
      "    except Exception as e:",
      "        print('Photo illisible :', e)",
      "        return ''",
      "    return lumen_call('/device/photo', {'image_b64': data, 'name': os.path.splitext(os.path.basename(path))[0], 'caption': caption})",
    ].join("\n");
    return "lumen_photo(" + str(b, "PATH") + ", " + str(b, "CAPTION") + ")\n";
  };
  // Les firmwares Domotique comprennent `set` (on, brightness, angle, r/g/b…)
  // et `toggle`. « régler » passe un dictionnaire tel quel, ou {'value': x}.
  P["lumen_domotique"] = function (b) {
    use();
    var action = b.getFieldValue("ACTION");
    var val = v(b, "VALUE", "None");
    var pair = action === "on" ? ["set", "{'on': True}"]
      : action === "off" ? ["set", "{'on': False}"]
      : action === "toggle" ? ["toggle", "{}"]
      : ["set", "(" + val + " if isinstance(" + val + ", dict) else {'value': " + val + "})"];
    return "lumen_call('/device/domotique', {'device': " + str(b, "DEVICE") + ", 'action': '" + pair[0] + "', 'params': " + pair[1] + "})\n";
  };

  DEFS.forEach(function (d) { window.builtinRequirements[d.type] = "requests"; });
  window.LUMEN_BLOCKS = DEFS.map(function (d) { return d.type; });
})();
