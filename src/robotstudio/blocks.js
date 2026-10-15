// Custom Blockly blocks and Python generators for Raspberry Pi
// Map of custom components loaded at runtime
var loadedComponents = {};
var RUN_SH = [
  '#!/bin/bash',
  'cd "$(dirname "$0")"',
  'ENV_DIR="$HOME/rpirobotstudio"',
  'exec > project.log 2>&1',
  'echo "$(date) starting" >&2',
  'if [ -d "$ENV_DIR" ]; then',
  '  source "$ENV_DIR/bin/activate"',
  'else',
  '  echo "$ENV_DIR not found" >&2',
  'fi',
  'exec python project.py'
].join('\n');
var customTypes = ["dht11_temp","dht11_humidity","dht22_temp","dht22_humidity","time_wait","animation_play",'rpi_gpio_write','rpi_rgb_led','ws2812b_set_pixel','ws2812b_fill','rpi_gpio_read','rpi_servo','rpi_ultrasonic','http_get','https_get','mqtt_config','mqtt_publish','mqtt_subscribe','json_parse','json_get','json_set','json_stringify','ai_request','http_wait','http_get_request','memory_set','memory_get','memory_delete','device_log_message','device_log_metric','rpi_cpu_temp','rpi_gpu_temp','rpi_cpu_usage','rpi_ram_usage','i2c_write','i2c_read','serial_send','serial_read','mfrc522_read','mfrc522_write','ds18b20_temp','rpi_motion','ir_receive','ir_send','rpi_encoder_steps','rpi_encoder_direction','ads1015_read','rpi_camera_photo','rpi_camera_video','hailo_yolo_start','hailo_yolo_get','ws_start','ws_running','ws_send','ws_client_count','logic_while','logic_loop','setup_block','loop_block','loop_function','loop_function_call','ui_config','ui_start','ui_launch','ui_add_text','ui_set_text','ui_set_text_color','ui_set_text_size','ui_set_position','ui_set_rotation','ui_add_image','ui_set_image_source','ui_add_sprite','ui_set_sprite_frames','ui_sprite_play','ui_sprite_pause','ui_sprite_set_frame','ui_sprite_set_fps','ui_sprite_set_loop','ui_set_size','ui_set_visible','ui_get_event','play_audio','pause_audio','stop_audio','set_volume','piper_config','piper_speak','piper_cli','ollama_start','ollama_stop','ollama_ps','ml_predict','ml_predict_image','ml_predict_yolo','ml_local_predict','ml_local_predict_image','ml_local_predict_yolo'];
var wsImports = [
  'from websocket_server import WebsocketServer',
  'import threading, logging'
].join('\n');

function toPythonLiteral(value) {
  if (value === null || value === undefined) {
    return 'None';
  }
  if (Array.isArray(value)) {
    return '[' + value.map(toPythonLiteral).join(', ') + ']';
  }
  if (typeof value === 'object') {
    var items = Object.keys(value).map(function(key) {
      return JSON.stringify(key) + ': ' + toPythonLiteral(value[key]);
    });
    return '{' + items.join(', ') + '}';
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    return isFinite(value) ? String(value) : '0';
  }
  if (typeof value === 'boolean') {
    return value ? 'True' : 'False';
  }
  return 'None';
}

function getActiveWorkspace() {
  if (typeof workspace !== 'undefined' && workspace) {
    return workspace;
  }
  if (typeof Blockly !== 'undefined') {
    if (typeof Blockly.getMainWorkspace === 'function') {
      return Blockly.getMainWorkspace();
    }
    if (Blockly.common && typeof Blockly.common.getMainWorkspace === 'function') {
      return Blockly.common.getMainWorkspace();
    }
    if (Blockly.mainWorkspace) {
      return Blockly.mainWorkspace;
    }
  }
  return null;
}

function sanitizeLoopFunctionName(name) {
  var raw = '';
  if (typeof name === 'string') {
    raw = name.trim();
  }
  if (!raw) {
    raw = 'function';
  }
  var cleaned = raw.replace(/[^A-Za-z0-9_]/g, '_');
  if (!/^[A-Za-z_]/.test(cleaned)) {
    cleaned = 'f_' + cleaned;
  }
  return cleaned || 'function';
}

function getLoopFunctionBlocks(ws) {
  var workspaceRef = ws || getActiveWorkspace();
  if (!workspaceRef || typeof workspaceRef.getAllBlocks !== 'function') {
    return [];
  }
  return workspaceRef.getAllBlocks(false).filter(function(block) {
    return block && block.type === 'loop_function';
  });
}

function getLoopFunctionOptions(field) {
  var sourceBlock = null;
  if (field && typeof field.getSourceBlock === 'function') {
    sourceBlock = field.getSourceBlock();
  }
  var workspaceRef = sourceBlock ? sourceBlock.workspace : null;
  var currentValue = field && typeof field.getValue === 'function'
      ? field.getValue()
      : '';
  var options = [];
  getLoopFunctionBlocks(workspaceRef).forEach(function(block) {
    var displayName = (block.getFieldValue && block.getFieldValue('NAME')) || '';
    var safeName = sanitizeLoopFunctionName(displayName);
    var label = displayName && displayName.trim() ? displayName.trim() : safeName;
    if (!options.some(function(opt) { return opt[1] === safeName; })) {
      options.push([label, safeName]);
    }
  });
  options.sort(function(a, b) {
    return a[0].localeCompare(b[0], undefined, {sensitivity: 'base'});
  });
  if (currentValue && !options.some(function(opt) { return opt[1] === currentValue; })) {
    options.push([currentValue, currentValue]);
  }
  if (!options.length) {
    options.push(['(no function)', '']);
  }
  return options;
}

function syncLoopFunctionFieldDisplay(field, options) {
  if (!field) {
    return;
  }
  var opts = Array.isArray(options) ? options : getLoopFunctionOptions(field);
  var currentValue = (typeof field.getValue === 'function') ? field.getValue() : '';
  var match = null;
  if (Array.isArray(opts)) {
    for (var i = 0; i < opts.length; i++) {
      if (opts[i] && opts[i][1] === currentValue) {
        match = opts[i];
        break;
      }
    }
  }
  if (!match && currentValue) {
    match = [currentValue, currentValue];
  }
  if (match) {
    var matchValue = match[1];
    if (typeof field.getValue === 'function' && typeof field.setValue === 'function') {
      if (field.getValue() !== matchValue) {
        field.setValue(matchValue);
      } else if ('selectedOption_' in field) {
        field.selectedOption_ = match;
      }
    } else if ('selectedOption_' in field) {
      field.selectedOption_ = match;
    }
    if (typeof field.setText === 'function') {
      field.setText(match[0]);
      if (typeof field.forceRerender === 'function') {
        field.forceRerender();
      }
    }
  }
}

function updateLoopFunctionCallState(block) {
  if (!block || block.isInFlyout) return;
  var field = block.getField('NAME');
  var options = getLoopFunctionOptions(field);
  var availableValues = Array.isArray(options)
    ? options.map(function(opt) { return opt && opt[1]; }).filter(function(value) { return value; })
    : [];
  var current = block.getFieldValue('NAME');
  var hasFunctions = availableValues.length > 0;
  if (hasFunctions) {
    var pending = block.__pendingLoopFunctionName;
    if (pending && availableValues.indexOf(pending) !== -1) {
      block.setFieldValue(pending, 'NAME');
      current = block.getFieldValue('NAME');
      block.__pendingLoopFunctionName = null;
    }
    if (availableValues.indexOf(current) === -1) {
      var firstValid = availableValues[0];
      block.setFieldValue(firstValid || '', 'NAME');
      current = block.getFieldValue('NAME');
    }
    block.setWarningText(null);
    block.setEnabled(true);
  } else {
    if (current) {
      block.__pendingLoopFunctionName = current;
    }
    block.setWarningText('Add a "function" block to define a reusable function.');
    block.setEnabled(false);
  }
  var stored = block.getFieldValue('NAME');
  block.data = stored ? sanitizeLoopFunctionName(stored) : '';
  if (field) {
    syncLoopFunctionFieldDisplay(field, options);
  }
}

function refreshAllLoopFunctionCalls(workspace) {
  var ws = workspace || getActiveWorkspace();
  if (!ws || typeof ws.getAllBlocks !== 'function') {
    return;
  }
  ws.getAllBlocks(false).forEach(function(block) {
    if (block && block.type === 'loop_function_call') {
      updateLoopFunctionCallState(block);
    }
  });
}

var wsSupport = [
  'ws_server = None',
  'ws_thread = None',
  'ws_messages = []',
  'def _ws_on_message(client, server, msg):',
  '    ws_messages.append(msg)',
  '',
  'def ws_start_server(host="0.0.0.0", port=8765):',
  '    global ws_server, ws_thread',
  '    if ws_server is None:',
  '        ws_server = WebsocketServer(host=host, port=port, loglevel=logging.CRITICAL)',
  '        ws_server.set_fn_message_received(_ws_on_message)',
  '        ws_thread = threading.Thread(target=ws_server.run_forever)',
  '        ws_thread.start()',
  '',
  'def ws_running():',
  '    return ws_server is not None',
  '',
  'def ws_send(msg):',
  '    if ws_server:',
  '        for c in list(ws_server.clients):',
  '            ws_server.send_message(c, msg)',
  '',
  'def ws_client_count():',
  '    return len(ws_server.clients) if ws_server else 0',
  '',
  'def ws_get_message():',
  '    return ws_messages.pop(0) if ws_messages else None'
].join('\n');

var uiImports = [
  'import http.server, socketserver, threading, json',
].join('\n');

var uiSupport = [
  'UI_HTML = """<!DOCTYPE html><html><head><meta charset=\'utf-8\'><style>body{margin:0;display:flex;justify-content:center;align-items:center;height:100vh;background:#333;}#frame{box-sizing:border-box;position:relative;}canvas{display:block;}</style></head><body><div id="frame"><canvas id="canvas" width={width} height={height} style="background:{color};"></canvas></div><script>var canvasColor="{color}";var animate={animate};var fps={fps};var ws=new WebSocket("ws://"+location.hostname+":{ws_port}");var elements={};var canvas=document.getElementById(\'canvas\');function canvasCoords(ev){var r=canvas.getBoundingClientRect();return{x:ev.clientX-r.left,y:ev.clientY-r.top};}function getSpriteFrame(e,now){if(!e.frames||!e.frames.length)return null;if(e.playing){var frameDuration=1000/((e.fps||fps||60));e._lastTick=e._lastTick||now;var delta=now-e._lastTick;if(delta>=frameDuration){var steps=Math.floor(delta/frameDuration);e._lastTick+=steps*frameDuration;e.frame=(e.frame||0)+steps;if(e.loop!==false){e.frame=e.frame%e.frames.length;}else if(e.frame>=e.frames.length){e.frame=e.frames.length-1;e.playing=false;}}}var idx=Math.min(Math.max(e.frame||0,0),e.frames.length-1);e.frame=idx;return e.frames[idx];}function getCachedImage(e,src){if(!src)return null;e._cache=e._cache||{};var img=e._cache[src];if(!img){img=new Image();img.src=src;e._cache[src]=img;img.onload=draw;}return img;}canvas.addEventListener(\'click\',function(ev){var p=canvasCoords(ev),x=p.x,y=p.y;Object.keys(elements).forEach(function(id){var e=elements[id];if(e.type==\'image\'){var w=e.w||(e._img?e._img.width:(e._dom?e._dom.width||e._dom.naturalWidth:0));var h=e.h||(e._img?e._img.height:(e._dom?e._dom.height||e._dom.naturalHeight:0));if(x>=e.x&&x<=e.x+w&&y>=e.y&&y<=e.y+h){ws.send(JSON.stringify({cmd:"event",event:"click",id:id,x:x,y:y}));}}else if(e.type==\'sprite\'){var frameSrc=(e.frames||[])[e.frame||0];var img=e._cache?e._cache[frameSrc]:null;var w=e.w||(img?img.width:0);var h=e.h||(img?img.height:0);if(x>=e.x&&x<=e.x+w&&y>=e.y&&y<=e.y+h){ws.send(JSON.stringify({cmd:"event",event:"click",id:id,x:x,y:y}));}}else if(e.type=="text"){var ctx=canvas.getContext("2d");var w=ctx.measureText(e.text||"").width;var h=e.size||24;if(x>=e.x&&x<=e.x+w&&y>=e.y-h&&y<=e.y){ws.send(JSON.stringify({cmd:"event",event:"click",id:id,x:x,y:y}));}}});});function draw(){var c=document.getElementById("canvas");var ctx=c.getContext("2d");ctx.fillStyle=canvasColor;ctx.fillRect(0,0,c.width,c.height);var now=Date.now();Object.keys(elements).forEach(function(id){var e=elements[id];if(!e.visible)return;ctx.save();ctx.translate(e.x||0,e.y||0);ctx.rotate((e.rot||0)*Math.PI/180);if(e.type=="text"){ctx.fillStyle=e.color||"#fff";ctx.font=(e.size||24)+"px sans-serif";ctx.fillText(e.text||"",0,0);}else if(e.type=="image"){if(e._gif===undefined)e._gif=/\.gif(?:$|\?)/i.test(e.src);if(e._svg===undefined)e._svg=/\.svg(?:$|\?)/i.test(e.src);if(e._gif||e._svg){var d=e._dom;if(!d){d=new Image();d.src=e.src;d.style.position="absolute";d.style.pointerEvents="none";document.getElementById("frame").appendChild(d);e._dom=d;}d.style.left=(e.x||0)+"px";d.style.top=(e.y||0)+"px";d.style.width=(e.w||d.naturalWidth)+"px";d.style.height=(e.h||d.naturalHeight)+"px";d.style.transform="rotate("+(e.rot||0)+"deg)";d.style.display=e.visible?"block":"none";}else{var img=e._img;if(!img){img=new Image();img.src=e.src;e._img=img;img.onload=draw;}if(img.complete && img.naturalWidth)ctx.drawImage(img,0,0,e.w||img.width,e.h||img.height);}}else if(e.type=="sprite"){var src=getSpriteFrame(e,now);var img=getCachedImage(e,src);if(img && img.complete && img.naturalWidth)ctx.drawImage(img,0,0,e.w||img.width,e.h||img.height);}ctx.restore();});}ws.onmessage=function(ev){var m=JSON.parse(ev.data);if(m.cmd=="add_text")elements[m.id]={type:"text",text:m.text||"",x:m.x||0,y:m.y||0,color:m.color||"#fff",size:m.size||24,rot:0,visible:true};else if(m.cmd=="add_image")elements[m.id]={type:"image",src:m.src,x:m.x||0,y:m.y||0,w:m.w||100,h:m.h||100,rot:0,visible:true};else if(m.cmd=="add_sprite")elements[m.id]={type:"sprite",frames:m.frames||[],frame:0,fps:m.fps||12,loop:m.loop!==false,playing:m.playing!==false,x:m.x||0,y:m.y||0,w:m.w||0,h:m.h||0,rot:0,visible:true};else if(m.cmd=="set_text_color"&&elements[m.id])elements[m.id].color=m.color;else if(m.cmd=="set_text_size"&&elements[m.id])elements[m.id].size=m.size;else if(m.cmd=="set_position"&&elements[m.id]){elements[m.id].x=m.x;elements[m.id].y=m.y;}else if(m.cmd=="set_rotation"&&elements[m.id])elements[m.id].rot=m.angle;else if(m.cmd=="set_image_source"&&elements[m.id]){var d=elements[m.id]._dom;if(d&&d.parentNode)d.remove();elements[m.id].src=m.src;delete elements[m.id]._img;delete elements[m.id]._dom;delete elements[m.id]._gif;delete elements[m.id]._svg;}else if(m.cmd=="set_sprite_frames"&&elements[m.id]){elements[m.id].frames=m.frames||[];elements[m.id].frame=0;delete elements[m.id]._cache;}else if(m.cmd=="sprite_play"&&elements[m.id]){elements[m.id].playing=true;}else if(m.cmd=="sprite_pause"&&elements[m.id]){elements[m.id].playing=false;}else if(m.cmd=="sprite_set_frame"&&elements[m.id]){elements[m.id].frame=m.frame||0;elements[m.id].playing=false;}else if(m.cmd=="sprite_set_fps"&&elements[m.id]){elements[m.id].fps=m.fps||12;}else if(m.cmd=="sprite_set_loop"&&elements[m.id]){elements[m.id].loop=m.loop!==false;}else if(m.cmd=="set_size"&&elements[m.id]){elements[m.id].w=m.w;elements[m.id].h=m.h;}else if(m.cmd=="set_visible"&&elements[m.id])elements[m.id].visible=m.visible;else if(m.cmd=="clear"){Object.keys(elements).forEach(function(id){var e=elements[id];var d=e._dom;if(d&&d.parentNode)d.remove();});elements={};canvasColor=m.color||canvasColor;}draw();};draw();if(animate){setInterval(draw,1000/fps);} </script></body></html>"""',
  'ui_server = None',
  'ui_thread = None',
  'ui_queue = []',
  'ui_state = {}',
  'ui_animation = True',
  'ui_fps = 60',
  '',
  'def ui_config(animate=True, fps=60):',
  '    global ui_animation, ui_fps',
  '    ui_animation = animate',
  '    ui_fps = fps',
  '',
  'def _flush_ui_queue():',
  '    global ui_queue',
  '    while ui_queue and ws_client_count() > 0:',
  '        ws_send(json.dumps(ui_queue.pop(0)))',
  '',
  'def _send_ui_state(client):',
  '    for cmds in ui_state.values():',
  '        for m in cmds:',
  '            ws_server.send_message(client, json.dumps(m))',
  '',
  'def ui_start(width=640, height=480, color="#000000", host="0.0.0.0", port=8000, ws_port=8765):',
  '    global ui_server, ui_thread',
  '    page = UI_HTML.replace("{width}", str(width)).replace("{height}", str(height)).replace("{color}", str(color)).replace("{ws_port}", str(ws_port)).replace("{animate}", str(ui_animation).lower()).replace("{fps}", str(ui_fps))',
  '    class Handler(http.server.SimpleHTTPRequestHandler):',
  '        def do_GET(self):',
  '            if self.path == "/":',
  '                self.send_response(200)',
  '                self.send_header("Content-Type","text/html")',
  '                self.end_headers()',
  '                self.wfile.write(page.encode())',
  '            else:',
  '                super().do_GET()',
  '    ui_server = socketserver.TCPServer((host, port), Handler)',
  '    ui_thread = threading.Thread(target=ui_server.serve_forever, daemon=True)',
  '    ui_thread.start()',
  '    ws_start_server(host=host, port=ws_port)',
  '    if ws_server:',
  '        ws_server.set_fn_new_client(lambda c,s: (_flush_ui_queue(), _send_ui_state(c)))',
  '',
  'def ui_send(data):',
  '    if isinstance(data, dict):',
  '        cid = data.get("id")',
  '        if cid is not None:',
  '            if data.get("cmd") in ("add_text","add_image","add_sprite"):',
  '                ui_state[cid] = [data]',
  '            else:',
  '                ui_state.setdefault(cid, []).append(data)',
  '        if data.get("cmd") == "clear":',
  '            ui_state.clear()',
  '    if ws_client_count() > 0:',
  '        ws_send(json.dumps(data))',
  '    else:',
  '        ui_queue.append(data)',
  '',
  'def ui_get_event():',
  '    msg = ws_get_message()',
  '    if msg:',
  '        try:',
  '            data = json.loads(msg)',
  '            if data.get("cmd") == "event":',
  '                return data',
  '        except Exception:',
  '            pass',
  '    return None',
].join('\n');

var audioImports = [
  'import threading, os, tempfile',
  'from io import BytesIO',
  'from playsound import playsound',
  'import requests',
  'import subprocess'
].join('\n');

var audioSupport = [
  'audio_thread = None',
  'audio_temp = None',
  '',
  'def _audio_play(path):',
  '    try:',
  '        playsound(path)',
  '    except Exception as e:',
  "        print(f'Could not play audio file {path}: {e}')",
  '',
  'def play_audio(path):',
  '    global audio_thread, audio_temp',
  '    stop_audio()',
  '    try:',
  '        src = path',
  '        if isinstance(path, str) and path.startswith(("http://", "https://")):',
  '            r = requests.get(path, timeout=10)',
  '            r.raise_for_status()',
  '            ext = os.path.splitext(path)[1] or ".mp3"',
  '            tmp = tempfile.NamedTemporaryFile(delete=False, suffix=ext)',
  '            tmp.write(r.content)',
  '            tmp.close()',
  '            src = tmp.name',
  '            audio_temp = src',
  '        else:',
  '            if not os.path.isabs(path):',
  '                path = os.path.join(os.path.dirname(__file__), path)',
  '            if not os.path.exists(path):',
  '                raise FileNotFoundError(path)',
  '            src = path',
  '            audio_temp = None',
  '        audio_thread = threading.Thread(target=_audio_play, args=(src,))',
  '        audio_thread.daemon = True',
  '        audio_thread.start()',
  '    except Exception as e:',
  "        print(f'Could not load audio file {path}: {e}')",
  '',
  'def pause_audio():',
  '    pass',
  '',
  'def stop_audio():',
  '    global audio_thread, audio_temp',
  '    audio_thread = None',
  '    if audio_temp:',
  '        try:',
  '            os.unlink(audio_temp)',
  '        except Exception:',
  '            pass',
  '        audio_temp = None',
  '',
  'def set_volume(percent):',
  '    try:',
  '        vol = int(percent)',
  '    except Exception:',
  '        return',
  '    vol = max(0, min(100, vol))',
  '    try:',
  '        subprocess.run(["amixer", "sset", "Master", f"{vol}%"], check=True)',
  '    except Exception as e:',
  "        print(f'Could not set volume: {e}')",
].join('\n');

var piperImports = [
  'from piper import PiperVoice, SynthesisConfig'
].join('\n');

var piperSupport = [
  'piper_voice = None',
  '',
  'def piper_config(model_path, config_path=None, use_cuda=False):',
  '    global piper_voice',
  '    piper_voice = PiperVoice.load(model_path, config_path, use_cuda=use_cuda)',
  '',
  'def piper_speak(text):',
  '    global piper_voice',
  '    if piper_voice is None:',
  "        raise RuntimeError('Piper not configured')",
  '    import tempfile, wave, os',
  '    with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as f:',
  '        with wave.open(f.name, "wb") as wf:',
  '            piper_voice.synthesize_wav(text, wf)',
  '    play_audio(f.name)',
  '    try:',
  '        os.unlink(f.name)',
  '    except Exception:',
  '        pass',
].join('\n');
var piperCliSupport = [
  'def piper_cli_speak(text, model_path, config_path):',
  '    import subprocess, tempfile, os',
  '    with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as f:',
  '        cmd = ["piper", "-m", model_path, "-c", config_path, "-f", f.name]',
  '        subprocess.run(cmd, input=text.encode(), check=True)',
  '        subprocess.run(["aplay", f.name], check=True)',
  '    try:',
  '        os.unlink(f.name)',
  '    except Exception:',
  '        pass',
].join('\n');

var cameraImports = [
  'import picamera',
  'import time'
].join('\n');

var cameraSupport = [
  '_camera = None',
  '',
  'def _ensure_camera():',
  '    global _camera',
  '    if _camera is None:',
  '        _camera = picamera.PiCamera()',
  '',
  'def camera_capture(path, w=None, h=None):',
  '    _ensure_camera()',
  '    if w and h:',
  '        _camera.resolution = (int(w), int(h))',
  '    _camera.capture(path)',
  '',
  'def camera_record(path, duration, w=None, h=None, framerate=30):',
  '    _ensure_camera()',
  '    if w and h:',
  '        _camera.resolution = (int(w), int(h))',
  '    _camera.framerate = framerate',
  '    _camera.start_recording(path)',
  '    _camera.wait_recording(duration)',
  '    _camera.stop_recording()'
].join('\n');

var httpServerImports = [
  'import http.server, socketserver, threading, json, time'
].join('\n');

var httpServerSupport = [
  'http_server = None',
  'http_thread = None',
  'http_requests = []',
  'class _HttpHandler(http.server.BaseHTTPRequestHandler):',
  '    def do_POST(self):',
  '        length = int(self.headers.get("Content-Length", 0))',
  '        data = self.rfile.read(length).decode()',
  '        try:',
  '            body = json.loads(data)',
  '        except Exception:',
  '            body = {}',
  '        http_requests.append((self.path, body))',
  '        self.send_response(200)',
  '        self.end_headers()',
  '',
  'def _start_http(host="0.0.0.0", port=8001):',
  '    global http_server, http_thread',
  '    if http_server is None:',
  '        http_server = socketserver.TCPServer((host, port), _HttpHandler)',
  '        http_thread = threading.Thread(target=http_server.serve_forever, daemon=True)',
  '        http_thread.start()',
  '',
  'def _get_field(data, field):',
  '    for part in str(field).split("."):',
  '        if isinstance(data, dict):',
  '            data = data.get(part)',
  '        else:',
  '            try:',
  '                idx = int(part)',
  '                data = data[idx]',
  '            except Exception:',
  '                return None',
  '        if data is None:',
  '            return None',
  '    return data',
  '',
  'def http_get_request(field=None, endpoint="/", host="0.0.0.0", port=8001):',
  '    _start_http(host, port)',
  '    for i, (path, data) in enumerate(list(http_requests)):',
  '        if endpoint is None or path == endpoint:',
  '            http_requests.pop(i)',
  '            if isinstance(data, dict) and field:',
  '                return _get_field(data, field)',
  '            return data',
  '    return None',
  '',
  'def http_wait(field=None, endpoint="/", host="0.0.0.0", port=8001):',
  '    while True:',
  '        data = http_get_request(field, endpoint, host, port)',
  '        if data is not None:',
  '            return data',
  '        time.sleep(0.01)'
].join('\n');

var hailoImports = [
  'import threading',
  'import gi',
  "gi.require_version('Gst', '1.0')",
  'from gi.repository import Gst',
  'import hailo',
  'from hailo_apps.hailo_app_python.apps.detection.detection_pipeline import GStreamerDetectionApp',
  'from hailo_apps.hailo_app_python.core.gstreamer.gstreamer_app import app_callback_class'
].join('\n');

var hailoSupport = [
  'hailo_app = None',
  'hailo_thread = None',
  'hailo_results = []',
  'class _HailoUser(app_callback_class):',
  '    pass',
  'def _hailo_callback(pad, info, user_data):',
  '    buffer = info.get_buffer()',
  '    if buffer is None:',
  '        return Gst.PadProbeReturn.OK',
  '    roi = hailo.get_roi_from_buffer(buffer)',
  '    detections = roi.get_objects_typed(hailo.HAILO_DETECTION)',
  '    hailo_results.append([(d.get_label(), d.get_confidence()) for d in detections])',
  '    return Gst.PadProbeReturn.OK',
  'def hailo_yolo_start():',
  '    global hailo_app, hailo_thread',
  '    user = _HailoUser()',
  '    hailo_app = GStreamerDetectionApp(_hailo_callback, user)',
  '    hailo_thread = threading.Thread(target=hailo_app.run, daemon=True)',
  '    hailo_thread.start()',
  'def hailo_yolo_get():',
  '    return hailo_results.pop(0) if hailo_results else None'
].join('\n');

var builtinRequirements = {
  'http_get': 'requests',
  'https_get': 'requests',
  'mqtt_publish': 'paho-mqtt',
  'mqtt_subscribe': 'paho-mqtt',
  'ai_request': 'requests',
  'device_log_message': 'requests',
  'device_log_metric': 'requests',
  'ws_start': 'websocket-server',
  'ui_start': 'websocket-server',
  'ui_launch': 'websocket-server',
  'ui_config': 'websocket-server',
  'rpi_gpio_write': 'RPi.GPIO',
  'rpi_rgb_led': 'RPi.GPIO',
  'ws2812b_set_pixel': 'rpi_ws281x\nlgpio',
  'ws2812b_fill': 'rpi_ws281x\nlgpio',
  'rpi_gpio_read': 'RPi.GPIO',
  'rpi_servo': 'RPi.GPIO',
  'rpi_ultrasonic': 'RPi.GPIO',
  'rpi_motion': 'RPi.GPIO',
  'rpi_encoder_steps': 'RPi.GPIO',
  'rpi_encoder_direction': 'RPi.GPIO',
  'rpi_cpu_usage': 'psutil',
  'rpi_ram_usage': 'psutil',
  'i2c_write': 'smbus',
  'i2c_read': 'smbus',
  'serial_send': 'pyserial',
  'serial_read': 'pyserial',
  'ads1015_read': 'adafruit-circuitpython-ads1x15',
  'dht11_temp': 'Adafruit_DHT',
  'dht11_humidity': 'Adafruit_DHT',
  'dht22_temp': 'Adafruit_DHT',
  'dht22_humidity': 'Adafruit_DHT',
  'play_audio': 'playsound\nrequests',
  'pause_audio': 'playsound',
  'stop_audio': 'playsound',
  'set_volume': 'playsound',
  'rpi_camera_photo': 'picamera',
  'rpi_camera_video': 'picamera',
  'hailo_yolo_start': 'hailo-apps\nPyGObject\nopencv-python',
  'hailo_yolo_get': 'hailo-apps\nPyGObject\nopencv-python',
  'piper_config': 'piper-tts',
  'piper_speak': 'piper-tts\nplaysound',
  'piper_cli': 'piper-tts',
  'ollama_start': 'requests',
  'ollama_stop': 'requests',
  'ollama_ps': 'requests',
  'ml_predict': 'requests',
  'ml_predict_image': 'requests',
  'ml_predict_yolo': 'requests',
  'ml_local_predict': 'joblib\nnumpy\nonnxruntime\ntransformers\ntensorflow\nkeras\nwebsockets\nPillow\npsutil\ngputil\nultralytics',
  'ml_local_predict_image': 'joblib\nnumpy\nonnxruntime\ntransformers\ntensorflow\nkeras\nwebsockets\nPillow\npsutil\ngputil\nultralytics',
  'ml_local_predict_yolo': 'joblib\nnumpy\nonnxruntime\ntransformers\ntensorflow\nkeras\nwebsockets\nPillow\npsutil\ngputil\nultralytics'
};

// Block definitions
Blockly.defineBlocksWithJsonArray([
  {
    "type": "rpi_gpio_write",
    "message0": "set GPIO pin %1 to %2",
    "args0": [
      {"type": "field_number", "name": "PIN", "value": 17},
      {"type": "field_dropdown", "name": "STATE", "options": [["HIGH (3.3V)", "HIGH"], ["LOW (0V)", "LOW"]]}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#BC3657",
    "tooltip": "Set a GPIO output HIGH or LOW",
    "helpUrl": ""
  },
  {
    "type": "rpi_rgb_led",
    "message0": "set RGB LED R pin %1 G pin %2 B pin %3 color %4 frequency %5 common %6",
    "args0": [
      {"type": "field_number", "name": "R_PIN", "value": 17},
      {"type": "field_number", "name": "G_PIN", "value": 27},
      {"type": "field_number", "name": "B_PIN", "value": 22},
      {"type": "field_colour", "name": "COLOR", "colour": "#ff0000"},
      {"type": "field_number", "name": "FREQ", "value": 100, "min": 1},
      {"type": "field_dropdown", "name": "COMMON", "options": [["cathode", "CATHODE"], ["anode", "ANODE"]]}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#BC3657",
    "tooltip": "Drive an RGB LED using PWM",
    "helpUrl": ""
  },
  {
    "type": "ws2812b_set_pixel",
    "message0": "WS2812B pin %1 leds %2 set index %3 color %4 brightness %5",
    "args0": [
      {"type": "field_number", "name": "PIN", "value": 18},
      {"type": "field_number", "name": "COUNT", "value": 8, "min": 1},
      {"type": "field_number", "name": "INDEX", "value": 0, "min": 0},
      {"type": "field_colour", "name": "COLOR", "colour": "#ff0000"},
      {"type": "field_number", "name": "BRIGHTNESS", "value": 255, "min": 0, "max": 255}
    ],
    "inputsInline": true,
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#BC3657",
    "tooltip": "Set the color of a WS2812B LED",
    "helpUrl": ""
  },
  {
    "type": "ws2812b_fill",
    "message0": "WS2812B pin %1 leds %2 fill color %3 brightness %4",
    "args0": [
      {"type": "field_number", "name": "PIN", "value": 18},
      {"type": "field_number", "name": "COUNT", "value": 8, "min": 1},
      {"type": "field_colour", "name": "COLOR", "colour": "#00ff00"},
      {"type": "field_number", "name": "BRIGHTNESS", "value": 255, "min": 0, "max": 255}
    ],
    "inputsInline": true,
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#BC3657",
    "tooltip": "Fill the entire WS2812B strip with a color",
    "helpUrl": ""
  },
  {
    "type": "rpi_gpio_read",
    "message0": "read GPIO pin %1 pull %2",
    "args0": [
      {"type": "field_number", "name": "PIN", "value": 17},
      {"type": "field_dropdown", "name": "PULL", "options": [["none", "PUD_OFF"], ["pull-up", "PUD_UP"], ["pull-down", "PUD_DOWN"]]}
    ],
    "output": "Boolean",
    "colour": "#BC3657",
    "tooltip": "Read the digital state of a GPIO pin",
    "helpUrl": ""
  },
  {
    "type": "rpi_servo",
    "message0": "set servo on GPIO %1 angle %2",
    "args0": [
      {"type": "field_number", "name": "PIN", "value": 18},
      {"type": "field_angle", "name": "ANGLE", "value": 90}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#BC3657",
    "tooltip": "Control a servo",
    "helpUrl": ""
  },
  {
    "type": "rpi_ultrasonic",
    "message0": "read distance trig %1 echo %2",
    "args0": [
      {"type": "field_number", "name": "TRIG", "value": 23},
      {"type": "field_number", "name": "ECHO", "value": 24}
    ],
    "output": null,
    "colour": "#BC3657",
    "tooltip": "Read ultrasonic sensor",
    "helpUrl": ""
  },
  {
    "type": "http_get",
    "message0": "HTTP GET %1",
    "args0": [
      {"type": "input_value", "name": "URL", "check": "String"}
    ],
    "output": null,
    "colour": "#76CB6F",
    "tooltip": "Perform HTTP GET",
    "helpUrl": ""
  },
  {
    "type": "https_get",
    "message0": "HTTPS GET %1",
    "args0": [
      {"type": "input_value", "name": "URL", "check": "String"}
    ],
    "output": null,
    "colour": "#76CB6F",
    "tooltip": "Perform HTTPS GET",
    "helpUrl": ""
  },
  {
    "type": "mqtt_config",
    "message0": "mqtt config host %1 port %2",
    "args0": [
      {"type": "input_value", "name": "HOST", "check": "String"},
      {"type": "input_value", "name": "PORT", "check": "Number"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#76CB6F",
    "tooltip": "Configure MQTT broker",
    "helpUrl": ""
  },
  {
    "type": "mqtt_publish",
    "message0": "mqtt publish topic %1 message %2",
    "args0": [
      {"type": "input_value", "name": "TOPIC", "check": "String"},
      {"type": "input_value", "name": "MSG", "check": "String"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#76CB6F",
    "tooltip": "Publish MQTT message",
    "helpUrl": ""
  },
  {
    "type": "mqtt_subscribe",
    "message0": "mqtt subscribe topic %1",
    "args0": [
      {"type": "input_value", "name": "TOPIC", "check": "String"}
    ],
    "output": null,
    "colour": "#76CB6F",
    "tooltip": "Subscribe to MQTT topic",
    "helpUrl": ""
  },
  {
    "type": "json_parse",
    "message0": "parse JSON %1",
    "args0": [
      {"type": "input_value", "name": "DATA", "check": "String"}
    ],
    "output": null,
    "colour": 65,
    "tooltip": "Parse JSON string",
    "helpUrl": ""
  },
  {
    "type": "json_get",
    "message0": "get key %2 from %1",
    "args0": [
      {"type": "input_value", "name": "OBJ"},
      {"type": "field_input", "name": "KEY", "text": "key"}
    ],
    "output": null,
    "colour": 65,
    "tooltip": "Get value from JSON object",
    "helpUrl": ""
  },
  {
    "type": "json_set",
    "message0": "set key %2 of %1 to %3",
    "args0": [
      {"type": "input_value", "name": "OBJ"},
      {"type": "field_input", "name": "KEY", "text": "key"},
      {"type": "input_value", "name": "VALUE"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": 65,
    "tooltip": "Set value in JSON object",
    "helpUrl": ""
  },
  {
    "type": "json_stringify",
    "message0": "JSON stringify %1",
    "args0": [
      {"type": "input_value", "name": "OBJ"}
    ],
    "output": "String",
    "colour": 65,
    "tooltip": "Convert object to JSON string",
    "helpUrl": ""
  },
  {
    "type": "ai_request",
    "message0": "AI request url %1 model %2 prompt %3 stream %4 think %5 store in %6",
    "args0": [
      {"type": "input_value", "name": "URL", "check": "String"},
      {"type": "input_value", "name": "MODEL", "check": "String"},
      {"type": "input_value", "name": "PROMPT", "check": "String"},
      {"type": "input_value", "name": "STREAM", "check": "Boolean"},
      {"type": "input_value", "name": "THINK", "check": "Boolean"},
      {"type": "field_variable", "name": "VAR", "variable": "response"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#87CEEB",
    "tooltip": "Query Ollama LLM and store the reply",
    "helpUrl": ""
  },
  {
    "type": "http_wait",
    "message0": "http wait endpoint %1 field %2 store in %3",
    "args0": [
      {"type": "input_value", "name": "ENDPOINT", "check": "String"},
      {"type": "input_value", "name": "FIELD", "check": "String"},
      {"type": "field_variable", "name": "VAR", "variable": "value"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#76CB6F",
    "tooltip": "Wait for HTTP request and store field",
    "helpUrl": ""
  },
  {
    "type": "http_get_request",
    "message0": "http get request endpoint %1 field %2",
    "args0": [
      {"type": "input_value", "name": "ENDPOINT", "check": "String"},
      {"type": "input_value", "name": "FIELD", "check": "String"}
    ],
    "output": null,
    "colour": "#76CB6F",
    "tooltip": "Get next HTTP request if available",
    "helpUrl": ""
  },
  {
    "type": "memory_set",
    "message0": "memory set storage %1 namespace %2 key %3 value %4",
    "args0": [
      {"type": "input_value", "name": "SERVER", "check": "String"},
      {"type": "input_value", "name": "NAMESPACE", "check": "String"},
      {"type": "input_value", "name": "KEY", "check": "String"},
      {"type": "input_value", "name": "VALUE"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#795548",
    "tooltip": "Store a value inside a local SQLite memory file on the robot",
    "helpUrl": ""
  },
  {
    "type": "memory_get",
    "message0": "memory get storage %1 namespace %2 key %3",
    "args0": [
      {"type": "input_value", "name": "SERVER", "check": "String"},
      {"type": "input_value", "name": "NAMESPACE", "check": "String"},
      {"type": "input_value", "name": "KEY", "check": "String"}
    ],
    "output": null,
    "colour": "#795548",
    "tooltip": "Retrieve a value from the local SQLite memory file",
    "helpUrl": ""
  },
  {
    "type": "memory_delete",
    "message0": "memory delete storage %1 namespace %2 key %3",
    "args0": [
      {"type": "input_value", "name": "SERVER", "check": "String"},
      {"type": "input_value", "name": "NAMESPACE", "check": "String"},
      {"type": "input_value", "name": "KEY", "check": "String"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#795548",
    "tooltip": "Remove a value from the local SQLite memory file",
    "helpUrl": ""
  },
  {
    "type": "device_log_message",
    "message0": "device log message url %1 device %2 level %3 message %4",
    "args0": [
      {"type": "input_value", "name": "URL", "check": "String"},
      {"type": "input_value", "name": "DEVICE", "check": "Number"},
      {"type": "field_dropdown", "name": "LEVEL", "options": [["info", "info"], ["warning", "warning"], ["error", "error"]]},
      {"type": "input_value", "name": "MESSAGE", "check": "String"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#5C6BC0",
    "tooltip": "Send a text log to the platform",
    "helpUrl": ""
  },
  {
    "type": "device_log_metric",
    "message0": "device log metric url %1 device %2 type %3 label %4 value %5 unit %6",
    "args0": [
      {"type": "input_value", "name": "URL", "check": "String"},
      {"type": "input_value", "name": "DEVICE", "check": "Number"},
      {"type": "field_dropdown", "name": "KIND", "options": [["metric", "metric"], ["temperature", "temperature"], ["cpu", "cpu"], ["storage", "storage"]]},
      {"type": "input_value", "name": "LABEL", "check": "String"},
      {"type": "input_value", "name": "VALUE"},
      {"type": "input_value", "name": "UNIT", "check": "String"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#5C6BC0",
    "tooltip": "Send a metric log to the platform",
    "helpUrl": ""
  },
  {
    "type": "rpi_cpu_temp",
    "message0": "CPU temperature",
    "output": null,
    "colour": "#BC3657",
    "tooltip": "Read CPU temperature",
    "helpUrl": ""
  },
  {
    "type": "rpi_gpu_temp",
    "message0": "GPU temperature",
    "output": null,
    "colour": "#BC3657",
    "tooltip": "Read GPU temperature",
    "helpUrl": ""
  },
  {
    "type": "rpi_cpu_usage",
    "message0": "CPU usage",
    "output": null,
    "colour": "#BC3657",
    "tooltip": "Get CPU utilisation",
    "helpUrl": ""
  },
  {
    "type": "rpi_ram_usage",
    "message0": "RAM usage",
    "output": null,
    "colour": "#BC3657",
    "tooltip": "Get RAM utilisation",
    "helpUrl": ""
  },
  {
    "type": "i2c_write",
    "message0": "I2C write addr %1 reg %2 value %3",
    "args0": [
      {"type": "field_number", "name": "ADDR", "value": 0},
      {"type": "field_number", "name": "REG", "value": 0},
      {"type": "field_number", "name": "VAL", "value": 0}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#BC3657",
    "tooltip": "Write to I2C device",
    "helpUrl": ""
  },
  {
    "type": "i2c_read",
    "message0": "I2C read addr %1 reg %2",
    "args0": [
      {"type": "field_number", "name": "ADDR", "value": 0},
      {"type": "field_number", "name": "REG", "value": 0}
    ],
    "output": null,
    "colour": "#BC3657",
    "tooltip": "Read from I2C device",
    "helpUrl": ""
  },
  {
    "type": "serial_send",
    "message0": "serial send port %1 baud %2 message %3",
    "args0": [
      {"type": "field_input", "name": "PORT", "text": "/dev/ttyS0"},
      {"type": "field_number", "name": "BAUD", "value": 9600},
      {"type": "input_value", "name": "MSG", "check": "String"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#BC3657",
    "tooltip": "Send data over serial",
    "helpUrl": ""
  },
  {
    "type": "serial_read",
    "message0": "serial read line port %1 baud %2",
    "args0": [
      {"type": "field_input", "name": "PORT", "text": "/dev/ttyS0"},
      {"type": "field_number", "name": "BAUD", "value": 9600}
    ],
    "output": null,
    "colour": "#BC3657",
    "tooltip": "Read line from serial",
    "helpUrl": ""
  },
  {
    "type": "mfrc522_read",
    "message0": "MFRC522 read tag",
    "output": null,
    "colour": "#BC3657",
    "tooltip": "Read UID and payload from an RFID tag",
    "helpUrl": ""
  },
  {
    "type": "mfrc522_write",
    "message0": "MFRC522 write text %1",
    "args0": [
      {"type": "input_value", "name": "TEXT", "check": "String"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#BC3657",
    "tooltip": "Write a short text payload to an RFID tag",
    "helpUrl": ""
  },
  {
    "type": "ds18b20_temp",
    "message0": "DS18B20 %1 temperature",
    "args0": [
      {"type": "field_input", "name": "ID", "text": "28-00000"}
    ],
    "output": null,
    "colour": "#BC3657",
    "tooltip": "Read DS18B20 temperature",
    "helpUrl": ""
  },
  {
    "type": "dht11_temp",
    "message0": "DHT11 GPIO %1 temperature",
    "args0": [
      {"type": "field_number", "name": "PIN", "value": 4}
    ],
    "output": null,
    "colour": "#BC3657",
    "tooltip": "Read DHT11 temperature",
    "helpUrl": ""
  },
  {
    "type": "dht11_humidity",
    "message0": "DHT11 GPIO %1 humidity",
    "args0": [
      {"type": "field_number", "name": "PIN", "value": 4}
    ],
    "output": null,
    "colour": "#BC3657",
    "tooltip": "Read DHT11 humidity",
    "helpUrl": ""
  },
  {
    "type": "dht22_temp",
    "message0": "DHT22 GPIO %1 temperature",
    "args0": [
      {"type": "field_number", "name": "PIN", "value": 4}
    ],
    "output": null,
    "colour": "#BC3657",
    "tooltip": "Read DHT22 temperature",
    "helpUrl": ""
  },
  {
    "type": "dht22_humidity",
    "message0": "DHT22 GPIO %1 humidity",
    "args0": [
      {"type": "field_number", "name": "PIN", "value": 4}
    ],
    "output": null,
    "colour": "#BC3657",
    "tooltip": "Read DHT22 humidity",
    "helpUrl": ""
  },
  {
    "type": "rpi_motion",
    "message0": "PIR motion GPIO %1",
    "args0": [
      {"type": "field_number", "name": "PIN", "value": 17}
    ],
    "output": null,
    "colour": "#BC3657",
    "tooltip": "Read PIR sensor",
    "helpUrl": ""
  },
  {
    "type": "ir_receive",
    "message0": "IR receiver GPIO %1 active?",
    "args0": [
      {"type": "field_number", "name": "PIN", "value": 18}
    ],
    "output": "Boolean",
    "colour": "#BC3657",
    "tooltip": "Read the digital signal from a demodulating IR receiver module",
    "helpUrl": ""
  },
  {
    "type": "ir_send",
    "message0": "IR send remote %1 command %2 repeat %3",
    "args0": [
      {"type": "input_value", "name": "REMOTE", "check": "String"},
      {"type": "input_value", "name": "COMMAND", "check": "String"},
      {"type": "input_value", "name": "COUNT", "check": "Number"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#BC3657",
    "tooltip": "Send an infrared command defined in your LIRC configuration",
    "helpUrl": ""
  },
  {
    "type": "rpi_encoder_steps",
    "message0": "encoder steps CLK %1 DT %2",
    "args0": [
      {"type": "field_number", "name": "CLK", "value": 17},
      {"type": "field_number", "name": "DT", "value": 18}
    ],
    "output": null,
    "colour": "#BC3657",
    "tooltip": "Read rotary encoder steps",
    "helpUrl": ""
  },
  {
    "type": "rpi_encoder_direction",
    "message0": "encoder direction CLK %1 DT %2",
    "args0": [
      {"type": "field_number", "name": "CLK", "value": 17},
      {"type": "field_number", "name": "DT", "value": 18}
    ],
    "output": null,
    "colour": "#BC3657",
    "tooltip": "Read rotary encoder direction",
    "helpUrl": ""
  },
  {
    "type": "ads1015_read",
    "message0": "ADS1015 channel %1",
    "args0": [
      {"type": "field_dropdown", "name": "CHAN", "options": [["0","0"],["1","1"],["2","2"],["3","3"]]}
    ],
    "output": null,
    "colour": "#BC3657",
    "tooltip": "Read ADS1015 channel",
    "helpUrl": ""
  },
  {
    "type": "rpi_camera_photo",
    "message0": "camera capture %1 width %2 height %3",
    "args0": [
      {"type": "field_input", "name": "FILE", "text": "image.jpg"},
      {"type": "field_number", "name": "W", "value": 640},
      {"type": "field_number", "name": "H", "value": 480}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#BC3657",
    "tooltip": "Capture photo with Pi camera",
    "helpUrl": ""
  },
  {
    "type": "rpi_camera_video",
    "message0": "record video %1 secs %2 width %3 height %4",
    "args0": [
      {"type": "field_input", "name": "FILE", "text": "video.h264"},
      {"type": "field_number", "name": "DUR", "value": 5},
      {"type": "field_number", "name": "W", "value": 640},
      {"type": "field_number", "name": "H", "value": 480}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#BC3657",
    "tooltip": "Record video with Pi camera",
    "helpUrl": ""
  },
  {
    "type": "hailo_yolo_start",
    "message0": "start Hailo YOLO",
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#87CEEB",
    "tooltip": "Launch Hailo object detection",
    "helpUrl": ""
  },
  {
    "type": "hailo_yolo_get",
    "message0": "get Hailo detection",
    "output": null,
    "colour": "#87CEEB",
    "tooltip": "Retrieve next detection result",
    "helpUrl": ""
  },
  {
    "type": "ws_start",
    "message0": "start websocket server host %1 port %2",
    "args0": [
      {"type": "field_input", "name": "HOST", "text": "0.0.0.0"},
      {"type": "field_number", "name": "PORT", "value": 8765}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#76CB6F",
    "tooltip": "Start websocket server",
    "helpUrl": ""
  },
  {
    "type": "ws_running",
    "message0": "websocket server running?",
    "output": "Boolean",
    "colour": "#76CB6F",
    "tooltip": "Check if websocket server is running",
    "helpUrl": ""
  },
  {
    "type": "ws_send",
    "message0": "websocket send %1",
    "args0": [
      {"type": "input_value", "name": "MSG", "check": "String"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#76CB6F",
    "tooltip": "Send message over websocket",
    "helpUrl": ""
  },
  {
    "type": "ws_client_count",
    "message0": "websocket client count",
    "output": null,
    "colour": "#76CB6F",
    "tooltip": "Number of connected websocket clients",
    "helpUrl": ""
  },
  {
    "type": "time_wait",
    "message0": "wait %1 seconds",
    "args0": [
      {"type": "input_value", "name": "SECS", "check": "Number"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": 120,
    "tooltip": "Pause execution",
    "helpUrl": ""
  },
  {
    "type": "animation_play",
    "message0": "play animation %1",
    "args0": [
      {"type": "field_input", "name": "NAME", "text": "intro"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": 120,
    "tooltip": "Play a saved animation timeline",
    "helpUrl": ""
  },
  {
    "type": "logic_while",
    "message0": "while %1",
    "args0": [{"type": "input_value", "name": "COND", "check": "Boolean"}],
    "message1": "do %1",
    "args1": [{"type": "input_statement", "name": "DO"}],
    "previousStatement": null,
    "nextStatement": null,
    "colour": 120,
    "tooltip": "While loop",
    "helpUrl": ""
  },
  {
    "type": "logic_loop",
    "message0": "loop forever",
    "message1": "do %1",
    "args1": [{"type": "input_statement", "name": "DO"}],
    "previousStatement": null,
    "nextStatement": null,
    "colour": 120,
    "tooltip": "Infinite loop",
    "helpUrl": ""
  },
  {
    "type": "setup_block",
    "message0": "setup",
    "message1": "do %1",
    "args1": [{"type": "input_statement", "name": "DO"}],
    "previousStatement": null,
    "nextStatement": null,
    "colour": 20,
    "tooltip": "Code executed once at startup",
    "helpUrl": ""
  },
  {
    "type": "loop_block",
    "message0": "loop",
    "message1": "do %1",
    "args1": [{"type": "input_statement", "name": "DO"}],
    "previousStatement": null,
    "nextStatement": null,
    "colour": 20,
    "tooltip": "Main loop executed repeatedly",
    "helpUrl": ""
  },
  {
    "type": "loop_function",
    "message0": "function %1",
    "args0": [
      {"type": "field_input", "name": "NAME", "text": "function1"}
    ],
    "message1": "do %1",
    "args1": [{"type": "input_statement", "name": "STACK"}],
    "previousStatement": null,
    "nextStatement": null,
    "colour": 20,
    "tooltip": "Define a reusable function",
    "helpUrl": ""
  },
  {
    "type": "loop_function_call",
    "message0": "call function",
    "previousStatement": null,
    "nextStatement": null,
    "colour": 20,
    "tooltip": "Call a named function",
    "helpUrl": ""
  },
  {
    "type": "ui_config",
    "message0": "ui animation %1 fps %2",
    "args0": [
      {"type": "input_value", "name": "ENABLE", "check": "Boolean"},
      {"type": "input_value", "name": "FPS", "check": "Number"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#FF9800",
    "tooltip": "Configure UI animation",
    "helpUrl": ""
  },
  {
    "type": "ui_start",
    "message0": "ui start width %1 height %2 color %3",
    "args0": [
      {"type": "input_value", "name": "W", "check": "Number"},
      {"type": "input_value", "name": "H", "check": "Number"},
      {"type": "input_value", "name": "COL", "check": "String"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#FF9800",
    "tooltip": "Start UI server",
    "helpUrl": ""
  },
  {
    "type": "ui_launch",
    "message0": "start UI",
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#FF9800",
    "tooltip": "Start UI server with defaults",
    "helpUrl": ""
  },
  {
    "type": "ui_add_text",
    "message0": "ui add text id %1 content %2",
    "args0": [
      {"type": "input_value", "name": "ID", "check": "String"},
      {"type": "input_value", "name": "TXT", "check": "String"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#FF9800",
    "tooltip": "Add text element to canvas",
    "helpUrl": ""
  },
  {
    "type": "ui_set_text",
    "message0": "ui text %1 content %2",
    "args0": [
      {"type": "input_value", "name": "ID", "check": "String"},
      {"type": "input_value", "name": "TXT", "check": "String"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#FF9800",
    "tooltip": "Change text content",
    "helpUrl": ""
  },
  {
    "type": "ui_add_image",
    "message0": "ui add image id %1 src %2 width %3 height %4",
    "args0": [
      {"type": "input_value", "name": "ID", "check": "String"},
      {"type": "input_value", "name": "SRC", "check": "String"},
      {"type": "input_value", "name": "W", "check": "Number"},
      {"type": "input_value", "name": "H", "check": "Number"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#FF9800",
    "tooltip": "Add image to canvas",
    "helpUrl": ""
  },
  {
    "type": "ui_add_sprite",
    "message0": "ui add sprite id %1 frames %2 fps %3 loop %4 width %5 height %6",
    "args0": [
      {"type": "input_value", "name": "ID", "check": "String"},
      {"type": "input_value", "name": "FRAMES", "check": "String"},
      {"type": "input_value", "name": "FPS", "check": "Number"},
      {"type": "input_value", "name": "LOOP", "check": "Boolean"},
      {"type": "input_value", "name": "W", "check": "Number"},
      {"type": "input_value", "name": "H", "check": "Number"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#FF9800",
    "tooltip": "Add animated sprite to canvas",
    "helpUrl": ""
  },
  {
    "type": "ui_set_text_color",
    "message0": "ui text %1 color %2",
    "args0": [
      {"type": "input_value", "name": "ID", "check": "String"},
      {"type": "input_value", "name": "COL", "check": "String"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#FF9800",
    "tooltip": "Set text color",
    "helpUrl": ""
  },
  {
    "type": "ui_set_text_size",
    "message0": "ui text %1 size %2",
    "args0": [
      {"type": "input_value", "name": "ID", "check": "String"},
      {"type": "input_value", "name": "SIZE", "check": "Number"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#FF9800",
    "tooltip": "Set text size",
    "helpUrl": ""
  },
  {
    "type": "ui_set_position",
    "message0": "ui element %1 position x %2 y %3",
    "args0": [
      {"type": "input_value", "name": "ID", "check": "String"},
      {"type": "input_value", "name": "X", "check": "Number"},
      {"type": "input_value", "name": "Y", "check": "Number"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#FF9800",
    "tooltip": "Set element position",
    "helpUrl": ""
  },
  {
    "type": "ui_set_rotation",
    "message0": "ui element %1 rotation %2",
    "args0": [
      {"type": "input_value", "name": "ID", "check": "String"},
      {"type": "input_value", "name": "ANGLE", "check": "Number"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#FF9800",
    "tooltip": "Set element rotation",
    "helpUrl": ""
  },
  {
    "type": "ui_set_image_source",
    "message0": "ui image %1 source %2",
    "args0": [
      {"type": "input_value", "name": "ID", "check": "String"},
      {"type": "input_value", "name": "SRC", "check": "String"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#FF9800",
    "tooltip": "Change image source",
    "helpUrl": ""
  },
  {
    "type": "ui_set_sprite_frames",
    "message0": "ui sprite %1 frames %2",
    "args0": [
      {"type": "input_value", "name": "ID", "check": "String"},
      {"type": "input_value", "name": "FRAMES", "check": "String"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#FF9800",
    "tooltip": "Replace sprite frames",
    "helpUrl": ""
  },
  {
    "type": "ui_sprite_play",
    "message0": "ui sprite %1 play",
    "args0": [
      {"type": "input_value", "name": "ID", "check": "String"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#FF9800",
    "tooltip": "Play sprite animation",
    "helpUrl": ""
  },
  {
    "type": "ui_sprite_pause",
    "message0": "ui sprite %1 pause",
    "args0": [
      {"type": "input_value", "name": "ID", "check": "String"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#FF9800",
    "tooltip": "Pause sprite animation",
    "helpUrl": ""
  },
  {
    "type": "ui_sprite_set_frame",
    "message0": "ui sprite %1 set frame %2",
    "args0": [
      {"type": "input_value", "name": "ID", "check": "String"},
      {"type": "input_value", "name": "FRAME", "check": "Number"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#FF9800",
    "tooltip": "Set sprite frame index",
    "helpUrl": ""
  },
  {
    "type": "ui_sprite_set_fps",
    "message0": "ui sprite %1 fps %2",
    "args0": [
      {"type": "input_value", "name": "ID", "check": "String"},
      {"type": "input_value", "name": "FPS", "check": "Number"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#FF9800",
    "tooltip": "Set sprite animation FPS",
    "helpUrl": ""
  },
  {
    "type": "ui_sprite_set_loop",
    "message0": "ui sprite %1 loop %2",
    "args0": [
      {"type": "input_value", "name": "ID", "check": "String"},
      {"type": "input_value", "name": "LOOP", "check": "Boolean"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#FF9800",
    "tooltip": "Enable or disable sprite loop",
    "helpUrl": ""
  },
  {
    "type": "ui_set_size",
    "message0": "ui element %1 size w %2 h %3",
    "args0": [
      {"type": "input_value", "name": "ID", "check": "String"},
      {"type": "input_value", "name": "W", "check": "Number"},
      {"type": "input_value", "name": "H", "check": "Number"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#FF9800",
    "tooltip": "Set element size",
    "helpUrl": ""
  },
  {
    "type": "ui_set_visible",
    "message0": "ui element %1 visible %2",
    "args0": [
      {"type": "input_value", "name": "ID", "check": "String"},
      {"type": "input_value", "name": "VIS", "check": "Boolean"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#FF9800",
    "tooltip": "Show or hide element",
    "helpUrl": ""
  },
  {
    "type": "ui_get_event",
    "message0": "ui get event",
    "output": null,
    "colour": "#FF9800",
    "tooltip": "Get next UI event",
    "helpUrl": ""
  },
  {
    "type": "play_audio",
    "message0": "play audio %1",
    "args0": [
      {"type": "input_value", "name": "SRC", "check": "String"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#E91E63",
    "tooltip": "Play an audio file",
    "helpUrl": ""
  },
  {
    "type": "pause_audio",
    "message0": "pause audio",
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#E91E63",
    "tooltip": "Pause audio playback",
    "helpUrl": ""
  },
  {
    "type": "stop_audio",
    "message0": "stop audio",
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#E91E63",
    "tooltip": "Stop audio playback",
    "helpUrl": ""
  },
  {
    "type": "set_volume",
    "message0": "set volume %1",
    "args0": [
      {"type": "input_value", "name": "VOL", "check": "Number"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#E91E63",
    "tooltip": "Set playback volume (0-100)",
    "helpUrl": ""
  },
  {
    "type": "piper_config",
    "message0": "piper config model %1 config %2 use cuda %3",
    "args0": [
      {"type": "input_value", "name": "MODEL", "check": "String"},
      {"type": "input_value", "name": "CONF", "check": "String"},
      {"type": "input_value", "name": "CUDA", "check": "Boolean"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#9C27B0",
    "tooltip": "Configure Piper TTS",
    "helpUrl": ""
  },
  {
    "type": "piper_speak",
    "message0": "piper say %1",
    "args0": [
      {"type": "input_value", "name": "TEXT", "check": "String"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#9C27B0",
    "tooltip": "Speak text using Piper",
    "helpUrl": ""
  },
  {
    "type": "piper_cli",
    "message0": "piper cli say %1 model %2 config %3",
    "args0": [
      {"type": "input_value", "name": "TEXT", "check": "String"},
      {"type": "input_value", "name": "MODEL", "check": "String"},
      {"type": "input_value", "name": "CONF", "check": "String"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#9C27B0",
    "tooltip": "Speak text using Piper CLI",
    "helpUrl": ""
  },
  {
    "type": "ollama_start",
    "message0": "ollama start model %1",
    "args0": [
      {"type": "input_value", "name": "MODEL", "check": "String"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#87CEEB",
    "tooltip": "Load an Ollama model into memory",
    "helpUrl": ""
  },
  {
    "type": "ollama_stop",
    "message0": "ollama stop model %1",
    "args0": [
      {"type": "input_value", "name": "MODEL", "check": "String"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#87CEEB",
    "tooltip": "Unload an Ollama model from memory",
    "helpUrl": ""
  },
  {
    "type": "ollama_ps",
    "message0": "ollama running store in %1",
    "args0": [
      {"type": "field_variable", "name": "VAR", "variable": "models"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#87CEEB",
    "tooltip": "List models currently in memory",
    "helpUrl": ""
  },
  {
    "type": "ml_predict",
    "message0": "ml predict url %1 model %2 sample %3 store in %4",
    "args0": [
      {"type": "input_value", "name": "URL", "check": "String"},
      {"type": "input_value", "name": "MODEL", "check": "String"},
      {"type": "input_value", "name": "SAMPLE", "check": "String"},
      {"type": "field_variable", "name": "VAR", "variable": "result"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#87CEEB",
    "tooltip": "Send sample to ML inference API",
    "helpUrl": ""
  },
  {
    "type": "ml_predict_image",
    "message0": "ml predict image url %1 model %2 image %3 store in %4",
    "args0": [
      {"type": "input_value", "name": "URL", "check": "String"},
      {"type": "input_value", "name": "MODEL", "check": "String"},
      {"type": "input_value", "name": "IMAGE", "check": "String"},
      {"type": "field_variable", "name": "VAR", "variable": "result"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#87CEEB",
    "tooltip": "Send base64 image to ML inference API",
    "helpUrl": ""
  },
  {
    "type": "ml_predict_yolo",
    "message0": "ml predict yolo url %1 model %2 image %3 store in %4",
    "args0": [
      {"type": "input_value", "name": "URL", "check": "String"},
      {"type": "input_value", "name": "MODEL", "check": "String"},
      {"type": "input_value", "name": "IMAGE", "check": "String"},
      {"type": "field_variable", "name": "VAR", "variable": "result"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#87CEEB",
    "tooltip": "Send image to YOLO detection API",
    "helpUrl": ""
  },
  {
    "type": "ml_local_predict",
    "message0": "ml local predict model %1 sample %2 store in %3",
    "args0": [
      {"type": "input_value", "name": "MODEL", "check": "String"},
      {"type": "input_value", "name": "SAMPLE", "check": "String"},
      {"type": "field_variable", "name": "VAR", "variable": "result"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#87CEEB",
    "tooltip": "Run prediction with a local model",
    "helpUrl": ""
  },
  {
    "type": "ml_local_predict_image",
    "message0": "ml local predict image model %1 image %2 store in %3",
    "args0": [
      {"type": "input_value", "name": "MODEL", "check": "String"},
      {"type": "input_value", "name": "IMAGE", "check": "String"},
      {"type": "field_variable", "name": "VAR", "variable": "result"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#87CEEB",
    "tooltip": "Classify image with a local model",
    "helpUrl": ""
  },
  {
    "type": "ml_local_predict_yolo",
    "message0": "ml local yolo model %1 image %2 store in %3",
    "args0": [
      {"type": "input_value", "name": "MODEL", "check": "String"},
      {"type": "input_value", "name": "IMAGE", "check": "String"},
      {"type": "field_variable", "name": "VAR", "variable": "result"}
    ],
    "previousStatement": null,
    "nextStatement": null,
    "colour": "#87CEEB",
    "tooltip": "Run YOLO detection locally",
    "helpUrl": ""
  }
]);

if (!Blockly.Blocks['loop_function'].onchange) {
  Blockly.Blocks['loop_function'].onchange = function(event) {
    if (!this.workspace || this.isInFlyout) return;
    var relevant = !event || event.type === Blockly.Events.BLOCK_CREATE || event.type === Blockly.Events.BLOCK_DELETE;
    if (!relevant && event.type === Blockly.Events.BLOCK_CHANGE) {
      relevant = event.blockId === this.id && event.name === 'NAME';
    }
    if (!relevant) return;
    var nameField = (this.getFieldValue && this.getFieldValue('NAME')) || '';
    var trimmed = nameField.trim();
    var safeName = sanitizeLoopFunctionName(nameField);
    var duplicates = 0;
    getLoopFunctionBlocks(this.workspace).forEach(function(block) {
      if (sanitizeLoopFunctionName(block.getFieldValue('NAME')) === safeName) {
        duplicates += 1;
      }
    });
    if (!trimmed) {
      this.setWarningText('Give the function a name.');
    } else if (duplicates > 1) {
      this.setWarningText('Another function already has this name.');
    } else {
      this.setWarningText(null);
    }
  };
}

Blockly.Blocks['loop_function_call'] = {
  init: function() {
    var dropdown = new Blockly.FieldDropdown(function() {
      return getLoopFunctionOptions(this);
    });
    var originalClassValidation = dropdown.doClassValidation_ && dropdown.doClassValidation_.bind(dropdown);
    dropdown.doClassValidation_ = function(newValue) {
      var validated = originalClassValidation ? originalClassValidation(newValue) : newValue;
      if (validated == null && newValue) {
        return sanitizeLoopFunctionName(newValue);
      }
      return validated;
    };
    this.appendDummyInput()
        .appendField('call function')
        .appendField(dropdown, 'NAME');
    this.setPreviousStatement(true, null);
    this.setNextStatement(true, null);
    this.setColour(20);
    this.setTooltip('Call a named function');
    this.setHelpUrl('');
    updateLoopFunctionCallState(this);
    if (this.data) {
      var restored = sanitizeLoopFunctionName(this.data);
      this.__pendingLoopFunctionName = restored;
      this.setFieldValue(restored, 'NAME');
      updateLoopFunctionCallState(this);
    }
  },
  onchange: function(event) {
    if (!this.workspace || this.isInFlyout) return;
    if (!event || event.type === Blockly.Events.BLOCK_CREATE || event.type === Blockly.Events.BLOCK_DELETE) {
      updateLoopFunctionCallState(this);
      return;
    }
    if (event.type === Blockly.Events.BLOCK_CHANGE) {
      if (event.blockId === this.id && event.name === 'NAME') {
        updateLoopFunctionCallState(this);
      } else {
        var affected = getLoopFunctionBlocks(this.workspace).some(function(block) { return block.id === event.blockId; });
        if (affected) {
          updateLoopFunctionCallState(this);
        }
      }
    }
  }
};

// Python generators
Blockly.Python['rpi_gpio_write'] = function(block) {
  var pin = block.getFieldValue('PIN');
  var state = block.getFieldValue('STATE');
  Blockly.Python.definitions_['import_gpio'] = 'import RPi.GPIO as GPIO\nGPIO.setmode(GPIO.BCM)';
  var code = 'GPIO.setup(' + pin + ', GPIO.OUT)\nGPIO.output(' + pin + ', GPIO.' + state + ')\n';
  return code;
};

Blockly.Python['rpi_rgb_led'] = function(block) {
  var rPin = block.getFieldValue('R_PIN');
  var gPin = block.getFieldValue('G_PIN');
  var bPin = block.getFieldValue('B_PIN');
  var color = block.getFieldValue('COLOR') || '#000000';
  var freq = parseInt(block.getFieldValue('FREQ'), 10);
  if (isNaN(freq) || freq < 1) {
    freq = 1;
  }
  var isAnode = block.getFieldValue('COMMON') === 'ANODE';
  Blockly.Python.definitions_['import_gpio'] = 'import RPi.GPIO as GPIO\nGPIO.setmode(GPIO.BCM)';
  Blockly.Python.definitions_['rgb_pwm_channels'] = 'rgb_pwm_channels = {}';
  var func = Blockly.Python.provideFunction_(
    'set_rgb_led',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(r_pin, g_pin, b_pin, color, frequency=100, common_anode=False):',
     '  for pin in (r_pin, g_pin, b_pin):',
     '    GPIO.setup(pin, GPIO.OUT)',
     "  color = (color or '').lstrip('#')",
     '  if len(color) != 6:',
     '    return',
     '  try:',
     '    values = [int(color[i:i+2], 16) / 255 * 100 for i in range(0, 6, 2)]',
     '  except ValueError:',
     '    return',
     '  for pin, value in zip((r_pin, g_pin, b_pin), values):',
     '    pwm = rgb_pwm_channels.get(pin)',
     '    if pwm is None:',
     '      pwm = GPIO.PWM(pin, frequency)',
     '      pwm.start(100 if common_anode else 0)',
     '      rgb_pwm_channels[pin] = pwm',
     '    else:',
     '      try:',
     '        pwm.ChangeFrequency(frequency)',
     '      except AttributeError:',
     '        pass',
     '    duty = 100 - value if common_anode else value',
     '    pwm.ChangeDutyCycle(max(0, min(100, duty)))']
  );
  var code = func + '(' + rPin + ', ' + gPin + ', ' + bPin + ', ' + JSON.stringify(color) + ', ' + freq + ', ' + (isAnode ? 'True' : 'False') + ')\n';
  return code;
};

Blockly.Python['ws2812b_set_pixel'] = function(block) {
  var pin = block.getFieldValue('PIN');
  var count = block.getFieldValue('COUNT');
  var index = block.getFieldValue('INDEX');
  var color = block.getFieldValue('COLOR') || '#000000';
  var brightness = block.getFieldValue('BRIGHTNESS');
  Blockly.Python.definitions_['import_ws2812'] = 'from rpi_ws281x import PixelStrip, Color';
  Blockly.Python.definitions_['ws2812b_strips'] = 'ws2812b_strips = {}';
  var getStrip = Blockly.Python.provideFunction_(
    'ws2812b_get_strip',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(pin, count, brightness, freq=800000, dma=10, invert=False, channel=0):',
     '  try:',
     '    pin = int(pin)',
     '    count = int(count)',
     '  except (TypeError, ValueError):',
     '    return None',
     '  if count <= 0:',
     '    return None',
     '  try:',
     '    brightness = int(brightness)',
     '  except (TypeError, ValueError):',
     '    brightness = 255',
     '  brightness = max(0, min(255, brightness))',
     '  key = (pin, count, freq, dma, invert, channel)',
     '  strip = ws2812b_strips.get(key)',
     '  if strip is None:',
     '    strip = PixelStrip(count, pin, freq_hz=freq, dma=dma, invert=invert, brightness=brightness, channel=channel)',
     '    strip.begin()',
     '    ws2812b_strips[key] = strip',
     '  else:',
     '    try:',
     '      strip.setBrightness(brightness)',
     '    except AttributeError:',
     '      pass',
     '  return strip']
  );
  var func = Blockly.Python.provideFunction_(
    'ws2812b_set_pixel_helper',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(pin, count, index, color, brightness):',
     '  strip = ' + getStrip + '(pin, count, brightness)',
     '  if strip is None:',
     '    return',
     "  color = (color or '').lstrip('#')",
     '  if len(color) != 6:',
     '    return',
     '  try:',
     '    r = int(color[0:2], 16)',
     '    g = int(color[2:4], 16)',
     '    b = int(color[4:6], 16)',
     '  except ValueError:',
     '    return',
     '  try:',
     '    index = int(index)',
     '  except (TypeError, ValueError):',
     '    index = 0',
     '  try:',
     '    count_int = int(count)',
     '  except (TypeError, ValueError):',
     '    return',
     '  if count_int <= 0:',
     '    return',
     '  index = max(0, min(count_int - 1, index))',
     '  strip.setPixelColor(index, Color(r, g, b))',
     '  strip.show()']
  );
  var code = func + '(' + pin + ', ' + count + ', ' + index + ', ' + JSON.stringify(color) + ', ' + brightness + ')\n';
  return code;
};

Blockly.Python['ws2812b_fill'] = function(block) {
  var pin = block.getFieldValue('PIN');
  var count = block.getFieldValue('COUNT');
  var color = block.getFieldValue('COLOR') || '#000000';
  var brightness = block.getFieldValue('BRIGHTNESS');
  Blockly.Python.definitions_['import_ws2812'] = 'from rpi_ws281x import PixelStrip, Color';
  Blockly.Python.definitions_['ws2812b_strips'] = 'ws2812b_strips = {}';
  var getStrip = Blockly.Python.provideFunction_(
    'ws2812b_get_strip',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(pin, count, brightness, freq=800000, dma=10, invert=False, channel=0):',
     '  try:',
     '    pin = int(pin)',
     '    count = int(count)',
     '  except (TypeError, ValueError):',
     '    return None',
     '  if count <= 0:',
     '    return None',
     '  try:',
     '    brightness = int(brightness)',
     '  except (TypeError, ValueError):',
     '    brightness = 255',
     '  brightness = max(0, min(255, brightness))',
     '  key = (pin, count, freq, dma, invert, channel)',
     '  strip = ws2812b_strips.get(key)',
     '  if strip is None:',
     '    strip = PixelStrip(count, pin, freq_hz=freq, dma=dma, invert=invert, brightness=brightness, channel=channel)',
     '    strip.begin()',
     '    ws2812b_strips[key] = strip',
     '  else:',
     '    try:',
     '      strip.setBrightness(brightness)',
     '    except AttributeError:',
     '      pass',
     '  return strip']
  );
  var func = Blockly.Python.provideFunction_(
    'ws2812b_fill_helper',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(pin, count, color, brightness):',
     '  strip = ' + getStrip + '(pin, count, brightness)',
     '  if strip is None:',
     '    return',
     "  color = (color or '').lstrip('#')",
     '  if len(color) != 6:',
     '    return',
     '  try:',
     '    r = int(color[0:2], 16)',
     '    g = int(color[2:4], 16)',
     '    b = int(color[4:6], 16)',
     '  except ValueError:',
     '    return',
     '  try:',
     '    count_int = int(count)',
     '  except (TypeError, ValueError):',
     '    return',
     '  if count_int <= 0:',
     '    return',
     '  for i in range(count_int):',
     '    strip.setPixelColor(i, Color(r, g, b))',
     '  strip.show()']
  );
  var code = func + '(' + pin + ', ' + count + ', ' + JSON.stringify(color) + ', ' + brightness + ')\n';
  return code;
};

Blockly.Python['rpi_gpio_read'] = function(block) {
  var pin = block.getFieldValue('PIN');
  var pull = block.getFieldValue('PULL');
  Blockly.Python.definitions_['import_gpio'] = 'import RPi.GPIO as GPIO\nGPIO.setmode(GPIO.BCM)';
  var func = Blockly.Python.provideFunction_(
    'read_gpio_pin',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(pin, pull):',
     '  GPIO.setup(pin, GPIO.IN, pull_up_down=getattr(GPIO, pull, GPIO.PUD_OFF))',
     '  return GPIO.input(pin)']
  );
  var code = func + '(' + pin + ', ' + JSON.stringify(pull) + ')';
  return [code, Blockly.Python.ORDER_FUNCTION_CALL];
};

Blockly.Python['rpi_servo'] = function(block) {
  var pin = block.getFieldValue('PIN');
  var angle = block.getFieldValue('ANGLE');
  Blockly.Python.definitions_['import_gpio'] = 'import RPi.GPIO as GPIO\nGPIO.setmode(GPIO.BCM)';
  Blockly.Python.definitions_['import_time'] = 'import time';
  var func = Blockly.Python.provideFunction_(
      'set_servo_angle',
      ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(pin, angle):',
       '  GPIO.setup(pin, GPIO.OUT)',
       '  pwm = GPIO.PWM(pin, 50)',
       '  pwm.start(0)',
       '  duty = angle / 18 + 2',
       '  pwm.ChangeDutyCycle(duty)',
       '  time.sleep(0.5)',
       '  pwm.stop()']);
  var code = 'set_servo_angle(' + pin + ', ' + angle + ')\n';
  return code;
};

Blockly.Python['rpi_ultrasonic'] = function(block) {
  var trig = block.getFieldValue('TRIG');
  var echo = block.getFieldValue('ECHO');
  Blockly.Python.definitions_['import_gpio'] = 'import RPi.GPIO as GPIO\nGPIO.setmode(GPIO.BCM)';
  Blockly.Python.definitions_['import_time'] = 'import time';
  var func = Blockly.Python.provideFunction_(
      'read_distance',
      ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(trig, echo):',
       '  GPIO.setup(trig, GPIO.OUT)',
       '  GPIO.setup(echo, GPIO.IN)',
       '  GPIO.output(trig, False)',
       '  time.sleep(0.1)',
       '  GPIO.output(trig, True)',
       '  time.sleep(0.00001)',
       '  GPIO.output(trig, False)',
       '  while GPIO.input(echo)==0:',
       '    pulse_start = time.time()',
       '  while GPIO.input(echo)==1:',
       '    pulse_end = time.time()',
       '  duration = pulse_end - pulse_start',
       '  distance = duration * 17150',
       '  return distance']);
  var code = 'read_distance(' + trig + ', ' + echo + ')';
  return [code, Blockly.Python.ORDER_FUNCTION_CALL];
};

Blockly.Python['http_get'] = function(block) {
  var url = Blockly.Python.valueToCode(block, 'URL', Blockly.Python.ORDER_ATOMIC) || '""';
  Blockly.Python.definitions_['import_requests'] = 'import requests';
  var code = 'requests.get(' + url + ').text';
  return [code, Blockly.Python.ORDER_FUNCTION_CALL];
};

Blockly.Python['https_get'] = function(block) {
  var url = Blockly.Python.valueToCode(block, 'URL', Blockly.Python.ORDER_ATOMIC) || '""';
  Blockly.Python.definitions_['import_requests'] = 'import requests';
  var func = Blockly.Python.provideFunction_(
      'ensure_https_url',
      ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(url):',
       '    url = str(url)',
       '    if url.startswith("https://"):',
       '        return url',
       '    if url.startswith("http://"):',
       '        return "https://" + url.split("://", 1)[1]',
       '    return "https://" + url.lstrip("/")']);
  var code = 'requests.get(' + func + '(' + url + ')).text';
  return [code, Blockly.Python.ORDER_FUNCTION_CALL];
};

Blockly.Python['mqtt_publish'] = function(block) {
  var topic = Blockly.Python.valueToCode(block, 'TOPIC', Blockly.Python.ORDER_ATOMIC) || '""';
  var msg = Blockly.Python.valueToCode(block, 'MSG', Blockly.Python.ORDER_ATOMIC) || '""';
  Blockly.Python.definitions_['mqtt_helpers'] = [
    'import paho.mqtt.publish as publish',
    'import paho.mqtt.subscribe as subscribe',
    'MQTT_HOST = None',
    'MQTT_PORT = None',
    'def mqtt_config(host, port):',
    '    global MQTT_HOST, MQTT_PORT',
    '    MQTT_HOST = host',
    '    MQTT_PORT = port',
    '',
    'def mqtt_publish(topic, msg):',
    '    kwargs = {}',
    '    if MQTT_HOST:',
    '        kwargs["hostname"] = MQTT_HOST',
    '    if MQTT_PORT is not None:',
    '        kwargs["port"] = MQTT_PORT',
    '    publish.single(topic, msg, **kwargs)',
    '',
    'def mqtt_subscribe(topic):',
    '    kwargs = {}',
    '    if MQTT_HOST:',
    '        kwargs["hostname"] = MQTT_HOST',
    '    if MQTT_PORT is not None:',
    '        kwargs["port"] = MQTT_PORT',
    '    return subscribe.simple(topic, **kwargs).payload.decode()'
  ].join('\n');
  var code = 'mqtt_publish(' + topic + ', ' + msg + ')\n';
  return code;
};

Blockly.Python['mqtt_subscribe'] = function(block) {
  var topic = Blockly.Python.valueToCode(block, 'TOPIC', Blockly.Python.ORDER_ATOMIC) || '""';
  Blockly.Python.definitions_['mqtt_helpers'] = [
    'import paho.mqtt.publish as publish',
    'import paho.mqtt.subscribe as subscribe',
    'MQTT_HOST = None',
    'MQTT_PORT = None',
    'def mqtt_config(host, port):',
    '    global MQTT_HOST, MQTT_PORT',
    '    MQTT_HOST = host',
    '    MQTT_PORT = port',
    '',
    'def mqtt_publish(topic, msg):',
    '    kwargs = {}',
    '    if MQTT_HOST:',
    '        kwargs["hostname"] = MQTT_HOST',
    '    if MQTT_PORT is not None:',
    '        kwargs["port"] = MQTT_PORT',
    '    publish.single(topic, msg, **kwargs)',
    '',
    'def mqtt_subscribe(topic):',
    '    kwargs = {}',
    '    if MQTT_HOST:',
    '        kwargs["hostname"] = MQTT_HOST',
    '    if MQTT_PORT is not None:',
    '        kwargs["port"] = MQTT_PORT',
    '    return subscribe.simple(topic, **kwargs).payload.decode()'
  ].join('\n');
  var code = 'mqtt_subscribe(' + topic + ')';
  return [code, Blockly.Python.ORDER_FUNCTION_CALL];
};

Blockly.Python['mqtt_config'] = function(block) {
  var host = Blockly.Python.valueToCode(block, 'HOST', Blockly.Python.ORDER_ATOMIC) || '""';
  var port = Blockly.Python.valueToCode(block, 'PORT', Blockly.Python.ORDER_ATOMIC) || '1883';
  Blockly.Python.definitions_['mqtt_helpers'] = [
    'import paho.mqtt.publish as publish',
    'import paho.mqtt.subscribe as subscribe',
    'MQTT_HOST = None',
    'MQTT_PORT = None',
    'def mqtt_config(host, port):',
    '    global MQTT_HOST, MQTT_PORT',
    '    MQTT_HOST = host',
    '    MQTT_PORT = port',
    '',
    'def mqtt_publish(topic, msg):',
    '    kwargs = {}',
    '    if MQTT_HOST:',
    '        kwargs["hostname"] = MQTT_HOST',
    '    if MQTT_PORT is not None:',
    '        kwargs["port"] = MQTT_PORT',
    '    publish.single(topic, msg, **kwargs)',
    '',
    'def mqtt_subscribe(topic):',
    '    kwargs = {}',
    '    if MQTT_HOST:',
    '        kwargs["hostname"] = MQTT_HOST',
    '    if MQTT_PORT is not None:',
    '        kwargs["port"] = MQTT_PORT',
    '    return subscribe.simple(topic, **kwargs).payload.decode()'
  ].join('\n');
  var code = 'mqtt_config(' + host + ', ' + port + ')\n';
  return code;
};

Blockly.Python['json_parse'] = function(block) {
  var data = Blockly.Python.valueToCode(block, 'DATA', Blockly.Python.ORDER_ATOMIC) || '""';
  Blockly.Python.definitions_['import_json'] = 'import json';
  var code = 'json.loads(' + data + ')';
  return [code, Blockly.Python.ORDER_FUNCTION_CALL];
};

Blockly.Python['json_get'] = function(block) {
  var obj = Blockly.Python.valueToCode(block, 'OBJ', Blockly.Python.ORDER_ATOMIC) || '{}';
  var key = block.getFieldValue('KEY') || '';
  var code = obj + '[' + JSON.stringify(key) + ']';
  return [code, Blockly.Python.ORDER_MEMBER];
};

Blockly.Python['json_set'] = function(block) {
  var obj = Blockly.Python.valueToCode(block, 'OBJ', Blockly.Python.ORDER_ATOMIC) || '{}';
  var key = block.getFieldValue('KEY') || '';
  var value = Blockly.Python.valueToCode(block, 'VALUE', Blockly.Python.ORDER_ASSIGNMENT) || 'None';
  var code = obj + '[' + JSON.stringify(key) + '] = ' + value + '\n';
  return code;
};

Blockly.Python['json_stringify'] = function(block) {
  var obj = Blockly.Python.valueToCode(block, 'OBJ', Blockly.Python.ORDER_ATOMIC) || '{}';
  Blockly.Python.definitions_['import_json'] = 'import json';
  var code = 'json.dumps(' + obj + ')';
  return [code, Blockly.Python.ORDER_FUNCTION_CALL];
};

Blockly.Python['ai_request'] = function(block) {
  var url = Blockly.Python.valueToCode(block, 'URL', Blockly.Python.ORDER_ATOMIC) || '""';
  var model = Blockly.Python.valueToCode(block, 'MODEL', Blockly.Python.ORDER_ATOMIC) || '""';
  var prompt = Blockly.Python.valueToCode(block, 'PROMPT', Blockly.Python.ORDER_ATOMIC) || '""';
  var stream = Blockly.Python.valueToCode(block, 'STREAM', Blockly.Python.ORDER_ATOMIC) || 'False';
  var think = Blockly.Python.valueToCode(block, 'THINK', Blockly.Python.ORDER_ATOMIC) || 'False';
  var variable = Blockly.Python.variableDB_.getName(block.getFieldValue('VAR'), Blockly.VARIABLE_CATEGORY_NAME);
  Blockly.Python.definitions_['import_requests'] = 'import requests';
  var code = variable + ' = requests.post(' + url + ', json={"model": ' + model + ', "prompt": ' + prompt + ', "stream": ' + stream + ', "think": ' + think + '}).json().get("response", "")\n';
  return code;
};

Blockly.Python['http_wait'] = function(block) {
  var endpoint = Blockly.Python.valueToCode(block, 'ENDPOINT', Blockly.Python.ORDER_ATOMIC) || '"/"';
  var field = Blockly.Python.valueToCode(block, 'FIELD', Blockly.Python.ORDER_ATOMIC) || '""';
  var variable = Blockly.Python.variableDB_.getName(block.getFieldValue('VAR'), Blockly.VARIABLE_CATEGORY_NAME);
  Blockly.Python.definitions_['http_server_imports'] = httpServerImports;
  Blockly.Python.definitions_['http_server_support'] = httpServerSupport;
  var code = variable + ' = http_wait(' + field + ', endpoint=' + endpoint + ')\n';
  return code;
};

Blockly.Python['http_get_request'] = function(block) {
  var endpoint = Blockly.Python.valueToCode(block, 'ENDPOINT', Blockly.Python.ORDER_ATOMIC) || '"/"';
  var field = Blockly.Python.valueToCode(block, 'FIELD', Blockly.Python.ORDER_ATOMIC) || '""';
  Blockly.Python.definitions_['http_server_imports'] = httpServerImports;
  Blockly.Python.definitions_['http_server_support'] = httpServerSupport;
  var code = 'http_get_request(' + field + ', endpoint=' + endpoint + ')';
  return [code, Blockly.Python.ORDER_FUNCTION_CALL];
};

Blockly.Python['memory_set'] = function(block) {
  var server = Blockly.Python.valueToCode(block, 'SERVER', Blockly.Python.ORDER_ATOMIC) || '""';
  var namespace = Blockly.Python.valueToCode(block, 'NAMESPACE', Blockly.Python.ORDER_ATOMIC) || '"default"';
  var key = Blockly.Python.valueToCode(block, 'KEY', Blockly.Python.ORDER_ATOMIC) || '""';
  var value = Blockly.Python.valueToCode(block, 'VALUE', Blockly.Python.ORDER_NONE) || 'None';
  Blockly.Python.definitions_['import_sqlite3'] = 'import sqlite3';
  Blockly.Python.definitions_['import_os'] = 'import os';
  Blockly.Python.definitions_['import_json'] = 'import json';
  Blockly.Python.definitions_['import_datetime'] = 'from datetime import datetime';
  var dbPathFunc = Blockly.Python.provideFunction_(
    'memory_db_path',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(path):',
     '    base = str(path or "").strip()',
     '    if not base:',
     '        base = "robot_memory.db"',
     '    if base == ":memory:" or base.startswith("file:"):',
     '        return base',
     '    full = os.path.abspath(base)',
     '    directory = os.path.dirname(full)',
     '    if directory and not os.path.isdir(directory):',
     '        os.makedirs(directory, exist_ok=True)',
     '    return full']
  );
  var ensureSchemaFunc = Blockly.Python.provideFunction_(
    'memory_ensure_schema',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(conn):',
     '    conn.execute("""CREATE TABLE IF NOT EXISTS memory_items (',
     '        id INTEGER PRIMARY KEY AUTOINCREMENT,',
     '        namespace TEXT NOT NULL,',
     '        key TEXT NOT NULL,',
     '        data TEXT NOT NULL,',
     '        created_at TEXT NOT NULL,',
     '        updated_at TEXT NOT NULL,',
     '        UNIQUE(namespace, key)',
     '    )""")',
     '    conn.execute("CREATE INDEX IF NOT EXISTS idx_memory_namespace ON memory_items(namespace)")',
     '    conn.commit()']
  );
  var normaliseNamespaceFunc = Blockly.Python.provideFunction_(
    'memory_normalise_namespace',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(namespace):',
     '    if namespace is None:',
     '        return "default"',
     '    ns = str(namespace).strip()',
     '    return ns or "default"']
  );
  var normaliseKeyFunc = Blockly.Python.provideFunction_(
    'memory_normalise_key',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(key):',
     '    if key is None:',
     '        return ""',
     '    return str(key).strip()']
  );
  var openFunc = Blockly.Python.provideFunction_(
    'memory_open',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(path):',
     '    db_path = ' + dbPathFunc + '(path)',
     '    conn = sqlite3.connect(db_path)',
     '    ' + ensureSchemaFunc + '(conn)',
     '    return conn']
  );
  var encodeFunc = Blockly.Python.provideFunction_(
    'memory_encode_value',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(value):',
     '    try:',
     '        return json.dumps(value)',
     '    except (TypeError, ValueError):',
     '        return json.dumps(value, default=str)']
  );
  var storeFunc = Blockly.Python.provideFunction_(
    'memory_store_value',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(path, namespace, key, value):',
     '    ns = ' + normaliseNamespaceFunc + '(namespace)',
     '    k = ' + normaliseKeyFunc + '(key)',
     '    if not k:',
     '        raise ValueError("Memory key is required")',
     '    payload = ' + encodeFunc + '(value)',
     '    timestamp = datetime.utcnow().isoformat()',
     '    conn = ' + openFunc + '(path)',
     '    try:',
     '        conn.execute("""',
     '            INSERT INTO memory_items(namespace, key, data, created_at, updated_at)',
     '            VALUES(?, ?, ?, ?, ?)',
     '            ON CONFLICT(namespace, key) DO UPDATE SET',
     '                data=excluded.data,',
     '                updated_at=excluded.updated_at',
     '        """, (ns, k, payload, timestamp, timestamp))',
     '        conn.commit()',
     '    finally:',
     '        conn.close()']
  );
  var code = storeFunc + '(' + server + ', ' + namespace + ', ' + key + ', ' + value + ')\n';
  return code;
};

Blockly.Python['memory_get'] = function(block) {
  var server = Blockly.Python.valueToCode(block, 'SERVER', Blockly.Python.ORDER_ATOMIC) || '""';
  var namespace = Blockly.Python.valueToCode(block, 'NAMESPACE', Blockly.Python.ORDER_ATOMIC) || '"default"';
  var key = Blockly.Python.valueToCode(block, 'KEY', Blockly.Python.ORDER_ATOMIC) || '""';
  Blockly.Python.definitions_['import_sqlite3'] = 'import sqlite3';
  Blockly.Python.definitions_['import_os'] = 'import os';
  Blockly.Python.definitions_['import_json'] = 'import json';
  var dbPathFunc = Blockly.Python.provideFunction_(
    'memory_db_path',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(path):',
     '    base = str(path or "").strip()',
     '    if not base:',
     '        base = "robot_memory.db"',
     '    if base == ":memory:" or base.startswith("file:"):',
     '        return base',
     '    full = os.path.abspath(base)',
     '    directory = os.path.dirname(full)',
     '    if directory and not os.path.isdir(directory):',
     '        os.makedirs(directory, exist_ok=True)',
     '    return full']
  );
  var ensureSchemaFunc = Blockly.Python.provideFunction_(
    'memory_ensure_schema',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(conn):',
     '    conn.execute("""CREATE TABLE IF NOT EXISTS memory_items (',
     '        id INTEGER PRIMARY KEY AUTOINCREMENT,',
     '        namespace TEXT NOT NULL,',
     '        key TEXT NOT NULL,',
     '        data TEXT NOT NULL,',
     '        created_at TEXT NOT NULL,',
     '        updated_at TEXT NOT NULL,',
     '        UNIQUE(namespace, key)',
     '    )""")',
     '    conn.execute("CREATE INDEX IF NOT EXISTS idx_memory_namespace ON memory_items(namespace)")',
     '    conn.commit()']
  );
  var normaliseNamespaceFunc = Blockly.Python.provideFunction_(
    'memory_normalise_namespace',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(namespace):',
     '    if namespace is None:',
     '        return "default"',
     '    ns = str(namespace).strip()',
     '    return ns or "default"']
  );
  var normaliseKeyFunc = Blockly.Python.provideFunction_(
    'memory_normalise_key',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(key):',
     '    if key is None:',
     '        return ""',
     '    return str(key).strip()']
  );
  var openFunc = Blockly.Python.provideFunction_(
    'memory_open',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(path):',
     '    db_path = ' + dbPathFunc + '(path)',
     '    conn = sqlite3.connect(db_path)',
     '    ' + ensureSchemaFunc + '(conn)',
     '    return conn']
  );
  var decodeFunc = Blockly.Python.provideFunction_(
    'memory_decode_value',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(raw):',
     '    try:',
     '        return json.loads(raw)',
     '    except (TypeError, ValueError):',
     '        return raw']
  );
  var fetchFunc = Blockly.Python.provideFunction_(
    'memory_fetch_value',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(path, namespace, key, default=None):',
     '    ns = ' + normaliseNamespaceFunc + '(namespace)',
     '    k = ' + normaliseKeyFunc + '(key)',
     '    if not k:',
     '        return default',
     '    conn = ' + openFunc + '(path)',
     '    try:',
     '        cur = conn.execute("SELECT data FROM memory_items WHERE namespace=? AND key=?", (ns, k))',
     '        row = cur.fetchone()',
     '        if not row:',
     '            return default',
     '        return ' + decodeFunc + '(row[0])',
     '    finally:',
     '        conn.close()']
  );
  var code = fetchFunc + '(' + server + ', ' + namespace + ', ' + key + ')';
  return [code, Blockly.Python.ORDER_FUNCTION_CALL];
};

Blockly.Python['memory_delete'] = function(block) {
  var server = Blockly.Python.valueToCode(block, 'SERVER', Blockly.Python.ORDER_ATOMIC) || '""';
  var namespace = Blockly.Python.valueToCode(block, 'NAMESPACE', Blockly.Python.ORDER_ATOMIC) || '"default"';
  var key = Blockly.Python.valueToCode(block, 'KEY', Blockly.Python.ORDER_ATOMIC) || '""';
  Blockly.Python.definitions_['import_sqlite3'] = 'import sqlite3';
  Blockly.Python.definitions_['import_os'] = 'import os';
  var dbPathFunc = Blockly.Python.provideFunction_(
    'memory_db_path',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(path):',
     '    base = str(path or "").strip()',
     '    if not base:',
     '        base = "robot_memory.db"',
     '    if base == ":memory:" or base.startswith("file:"):',
     '        return base',
     '    full = os.path.abspath(base)',
     '    directory = os.path.dirname(full)',
     '    if directory and not os.path.isdir(directory):',
     '        os.makedirs(directory, exist_ok=True)',
     '    return full']
  );
  var ensureSchemaFunc = Blockly.Python.provideFunction_(
    'memory_ensure_schema',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(conn):',
     '    conn.execute("""CREATE TABLE IF NOT EXISTS memory_items (',
     '        id INTEGER PRIMARY KEY AUTOINCREMENT,',
     '        namespace TEXT NOT NULL,',
     '        key TEXT NOT NULL,',
     '        data TEXT NOT NULL,',
     '        created_at TEXT NOT NULL,',
     '        updated_at TEXT NOT NULL,',
     '        UNIQUE(namespace, key)',
     '    )""")',
     '    conn.execute("CREATE INDEX IF NOT EXISTS idx_memory_namespace ON memory_items(namespace)")',
     '    conn.commit()']
  );
  var normaliseNamespaceFunc = Blockly.Python.provideFunction_(
    'memory_normalise_namespace',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(namespace):',
     '    if namespace is None:',
     '        return "default"',
     '    ns = str(namespace).strip()',
     '    return ns or "default"']
  );
  var normaliseKeyFunc = Blockly.Python.provideFunction_(
    'memory_normalise_key',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(key):',
     '    if key is None:',
     '        return ""',
     '    return str(key).strip()']
  );
  var openFunc = Blockly.Python.provideFunction_(
    'memory_open',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(path):',
     '    db_path = ' + dbPathFunc + '(path)',
     '    conn = sqlite3.connect(db_path)',
     '    ' + ensureSchemaFunc + '(conn)',
     '    return conn']
  );
  var deleteFunc = Blockly.Python.provideFunction_(
    'memory_delete_value',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(path, namespace, key):',
     '    ns = ' + normaliseNamespaceFunc + '(namespace)',
     '    k = ' + normaliseKeyFunc + '(key)',
     '    if not k:',
     '        return False',
     '    conn = ' + openFunc + '(path)',
     '    try:',
     '        cur = conn.execute("DELETE FROM memory_items WHERE namespace=? AND key=?", (ns, k))',
     '        conn.commit()',
     '        return cur.rowcount > 0',
     '    finally:',
     '        conn.close()']
  );
  var code = deleteFunc + '(' + server + ', ' + namespace + ', ' + key + ')\n';
  return code;
};

Blockly.Python['device_log_message'] = function(block) {
  var url = Blockly.Python.valueToCode(block, 'URL', Blockly.Python.ORDER_ATOMIC) || '""';
  var device = Blockly.Python.valueToCode(block, 'DEVICE', Blockly.Python.ORDER_ATOMIC) || '0';
  var level = block.getFieldValue('LEVEL') || 'info';
  var message = Blockly.Python.valueToCode(block, 'MESSAGE', Blockly.Python.ORDER_ATOMIC) || '""';
  Blockly.Python.definitions_['import_requests'] = 'import requests';
  var func = Blockly.Python.provideFunction_(
    'device_log_post',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(url, payload):',
     '    try:',
     '        base = str(url or "").rstrip("/")',
     '        if not base:',
     '            return',
     '        requests.post(base + "/api/device_logs", json=payload, timeout=2)',
     '    except Exception:',
     '        pass']
  );
  var payload = '{\"device_id\": ' + device + ', \"kind\": \"message\", \"level\": ' + JSON.stringify(level) + ', \"message\": ' + message + '}';
  var code = func + '(' + url + ', ' + payload + ')\n';
  return code;
};

Blockly.Python['device_log_metric'] = function(block) {
  var url = Blockly.Python.valueToCode(block, 'URL', Blockly.Python.ORDER_ATOMIC) || '""';
  var device = Blockly.Python.valueToCode(block, 'DEVICE', Blockly.Python.ORDER_ATOMIC) || '0';
  var kind = block.getFieldValue('KIND') || 'metric';
  var label = Blockly.Python.valueToCode(block, 'LABEL', Blockly.Python.ORDER_ATOMIC) || '""';
  var value = Blockly.Python.valueToCode(block, 'VALUE', Blockly.Python.ORDER_ATOMIC) || '""';
  var unit = Blockly.Python.valueToCode(block, 'UNIT', Blockly.Python.ORDER_ATOMIC) || '""';
  Blockly.Python.definitions_['import_requests'] = 'import requests';
  var func = Blockly.Python.provideFunction_(
    'device_log_post',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(url, payload):',
     '    try:',
     '        base = str(url or "").rstrip("/")',
     '        if not base:',
     '            return',
     '        requests.post(base + "/api/device_logs", json=payload, timeout=2)',
     '    except Exception:',
     '        pass']
  );
  var payload = '{\"device_id\": ' + device + ', \"kind\": ' + JSON.stringify(kind) + ', \"label\": ' + label + ', \"value\": ' + value + ', \"unit\": ' + unit + '}';
  var code = func + '(' + url + ', ' + payload + ')\n';
  return code;
};

Blockly.Python['rpi_cpu_temp'] = function(block) {
  var func = Blockly.Python.provideFunction_(
    'get_cpu_temp',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '():',
     '  with open("/sys/class/thermal/thermal_zone0/temp") as f:',
     '    return float(f.read()) / 1000.0']
  );
  var code = func + '()';
  return [code, Blockly.Python.ORDER_FUNCTION_CALL];
};

Blockly.Python['rpi_gpu_temp'] = function(block) {
  Blockly.Python.definitions_['import_subprocess'] = 'import subprocess';
  var func = Blockly.Python.provideFunction_(
    'get_gpu_temp',
    ["def " + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + "():",
     "  out = subprocess.check_output(['vcgencmd', 'measure_temp']).decode()",
     "  return float(out.split('=')[1].split(\"'\")[0])"]
  );
  var code = func + '()';
  return [code, Blockly.Python.ORDER_FUNCTION_CALL];
};

Blockly.Python['rpi_cpu_usage'] = function(block) {
  Blockly.Python.definitions_['import_psutil'] = 'import psutil';
  var code = 'psutil.cpu_percent(interval=None)';
  return [code, Blockly.Python.ORDER_FUNCTION_CALL];
};

Blockly.Python['rpi_ram_usage'] = function(block) {
  Blockly.Python.definitions_['import_psutil'] = 'import psutil';
  var code = 'psutil.virtual_memory().percent';
  return [code, Blockly.Python.ORDER_FUNCTION_CALL];
};

Blockly.Python['i2c_write'] = function(block) {
  var addr = block.getFieldValue('ADDR');
  var reg = block.getFieldValue('REG');
  var val = block.getFieldValue('VAL');
  Blockly.Python.definitions_['import_smbus'] = 'import smbus';
  var func = Blockly.Python.provideFunction_(
    'i2c_write',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(a, r, v):',
     '  bus = smbus.SMBus(1)',
     '  bus.write_byte_data(a, r, v)']
  );
  var code = func + '(' + addr + ', ' + reg + ', ' + val + ')\n';
  return code;
};

Blockly.Python['i2c_read'] = function(block) {
  var addr = block.getFieldValue('ADDR');
  var reg = block.getFieldValue('REG');
  Blockly.Python.definitions_['import_smbus'] = 'import smbus';
  var func = Blockly.Python.provideFunction_(
    'i2c_read',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(a, r):',
     '  bus = smbus.SMBus(1)',
     '  return bus.read_byte_data(a, r)']
  );
  var code = func + '(' + addr + ', ' + reg + ')';
  return [code, Blockly.Python.ORDER_FUNCTION_CALL];
};


Blockly.Python['serial_send'] = function(block) {
  var port = block.getFieldValue('PORT');
  var baud = block.getFieldValue('BAUD');
  var msg = Blockly.Python.valueToCode(block, 'MSG', Blockly.Python.ORDER_ATOMIC) || '""';
  Blockly.Python.definitions_['import_serial'] = 'import serial';
  var func = Blockly.Python.provideFunction_(
    'serial_send',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(p, b, m):',
     '  with serial.Serial(p, b, timeout=1) as s:',
     '    s.write(m.encode())']
  );
  var code = func + '(' + port + ', ' + baud + ', ' + msg + ')\n';
  return code;
};

Blockly.Python['serial_read'] = function(block) {
  var port = block.getFieldValue('PORT');
  var baud = block.getFieldValue('BAUD');
  Blockly.Python.definitions_['import_serial'] = 'import serial';
  var func = Blockly.Python.provideFunction_(
    'serial_read',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(p, b):',
     '  with serial.Serial(p, b, timeout=1) as s:',
     '    return s.readline().decode().strip()']
  );
  var code = func + '(' + port + ', ' + baud + ')';
  return [code, Blockly.Python.ORDER_FUNCTION_CALL];
};

Blockly.Python['mfrc522_read'] = function(block) {
  Blockly.Python.definitions_['import_mfrc522'] = 'from mfrc522 import SimpleMFRC522';
  Blockly.Python.definitions_['mfrc522_reader'] = 'mfrc522_reader = SimpleMFRC522()';
  var func = Blockly.Python.provideFunction_(
    'mfrc522_read',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(reader):',
     '  try:',
     '    tag_id, text = reader.read()',
     '    return {"id": tag_id, "text": text.strip()}',
     '  except Exception as exc:',
     '    print(f"RFID read error: {exc}")',
     '    return None']
  );
  var code = func + '(mfrc522_reader)';
  return [code, Blockly.Python.ORDER_FUNCTION_CALL];
};

Blockly.Python['mfrc522_write'] = function(block) {
  var text = Blockly.Python.valueToCode(block, 'TEXT', Blockly.Python.ORDER_NONE) || '""';
  Blockly.Python.definitions_['import_mfrc522'] = 'from mfrc522 import SimpleMFRC522';
  Blockly.Python.definitions_['mfrc522_reader'] = 'mfrc522_reader = SimpleMFRC522()';
  var func = Blockly.Python.provideFunction_(
    'mfrc522_write',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(reader, payload):',
     '  try:',
     '    reader.write(str(payload))',
     '    return True',
     '  except Exception as exc:',
     '    print(f"RFID write error: {exc}")',
     '    return False']
  );
  var code = func + '(mfrc522_reader, ' + text + ')\n';
  return code;
};

Blockly.Python['ds18b20_temp'] = function(block) {
  var sensor = block.getFieldValue('ID');
  var func = Blockly.Python.provideFunction_(
    'read_ds18b20',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(sid):',
     '  path = f"/sys/bus/w1/devices/{sid}/w1_slave"',
     '  with open(path) as f:',
     '    data = f.read().split("t=")[-1]',
     '    return float(data) / 1000.0']
  );
  var code = func + '("' + sensor + '")';
  return [code, Blockly.Python.ORDER_FUNCTION_CALL];
};

Blockly.Python['dht11_temp'] = function(block) {
  var pin = block.getFieldValue('PIN');
  Blockly.Python.definitions_['import_dht'] = 'import Adafruit_DHT';
  var code = 'Adafruit_DHT.read_retry(Adafruit_DHT.DHT11, ' + pin + ')[1]';
  return [code, Blockly.Python.ORDER_FUNCTION_CALL];
};

Blockly.Python['dht11_humidity'] = function(block) {
  var pin = block.getFieldValue('PIN');
  Blockly.Python.definitions_['import_dht'] = 'import Adafruit_DHT';
  var code = 'Adafruit_DHT.read_retry(Adafruit_DHT.DHT11, ' + pin + ')[0]';
  return [code, Blockly.Python.ORDER_FUNCTION_CALL];
};

Blockly.Python['dht22_temp'] = function(block) {
  var pin = block.getFieldValue('PIN');
  Blockly.Python.definitions_['import_dht'] = 'import Adafruit_DHT';
  var code = 'Adafruit_DHT.read_retry(Adafruit_DHT.DHT22, ' + pin + ')[1]';
  return [code, Blockly.Python.ORDER_FUNCTION_CALL];
};

Blockly.Python['dht22_humidity'] = function(block) {
  var pin = block.getFieldValue('PIN');
  Blockly.Python.definitions_['import_dht'] = 'import Adafruit_DHT';
  var code = 'Adafruit_DHT.read_retry(Adafruit_DHT.DHT22, ' + pin + ')[0]';
  return [code, Blockly.Python.ORDER_FUNCTION_CALL];
};

Blockly.Python['time_wait'] = function(block) {
  var secs = Blockly.Python.valueToCode(block, 'SECS', Blockly.Python.ORDER_ATOMIC) || '0';
  Blockly.Python.definitions_['import_time'] = 'import time';
  var code = 'time.sleep(' + secs + ')\n';
  return code;
};

Blockly.Python['animation_play'] = function(block) {
  var name = block.getFieldValue('NAME') || '';
  var animations = (typeof animationState !== 'undefined' ? animationState : {});
  var animationsLiteral = toPythonLiteral(animations);
  Blockly.Python.definitions_['import_time'] = 'import time';
  Blockly.Python.definitions_['import_gpio'] = 'import RPi.GPIO as GPIO\nGPIO.setmode(GPIO.BCM)';
  Blockly.Python.definitions_['import_ws2812'] = 'from rpi_ws281x import PixelStrip, Color';
  Blockly.Python.definitions_['animations_data'] = 'animations = ' + animationsLiteral;
  Blockly.Python.definitions_['rgb_pwm_channels'] = 'rgb_pwm_channels = {}';
  Blockly.Python.definitions_['ws2812b_strips'] = 'ws2812b_strips = {}';

  var setServo = Blockly.Python.provideFunction_(
    'set_servo_angle',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(pin, angle):',
     '  GPIO.setup(pin, GPIO.OUT)',
     '  pwm = GPIO.PWM(pin, 50)',
     '  pwm.start(0)',
     '  duty = angle / 18 + 2',
     '  pwm.ChangeDutyCycle(duty)',
     '  time.sleep(0.5)',
     '  pwm.stop()']
  );

  var setRgb = Blockly.Python.provideFunction_(
    'set_rgb_led',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(r_pin, g_pin, b_pin, color, frequency=100, common_anode=False):',
     '  for pin in (r_pin, g_pin, b_pin):',
     '    GPIO.setup(pin, GPIO.OUT)',
     "  color = (color or '').lstrip('#')",
     '  if len(color) != 6:',
     '    return',
     '  try:',
     '    values = [int(color[i:i+2], 16) / 255 * 100 for i in range(0, 6, 2)]',
     '  except ValueError:',
     '    return',
     '  for pin, value in zip((r_pin, g_pin, b_pin), values):',
     '    pwm = rgb_pwm_channels.get(pin)',
     '    if pwm is None:',
     '      pwm = GPIO.PWM(pin, frequency)',
     '      pwm.start(100 if common_anode else 0)',
     '      rgb_pwm_channels[pin] = pwm',
     '    else:',
     '      try:',
     '        pwm.ChangeFrequency(frequency)',
     '      except AttributeError:',
     '        pass',
     '    duty = 100 - value if common_anode else value',
     '    pwm.ChangeDutyCycle(max(0, min(100, duty)))']
  );

  var setGpio = Blockly.Python.provideFunction_(
    'set_gpio_output',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(pin, state):',
     '  GPIO.setup(pin, GPIO.OUT)',
     '  level = GPIO.HIGH if str(state).upper() == "HIGH" else GPIO.LOW',
     '  GPIO.output(pin, level)']
  );

  var getStrip = Blockly.Python.provideFunction_(
    'ws2812b_get_strip',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(pin, count, brightness, freq=800000, dma=10, invert=False, channel=0):',
     '  try:',
     '    pin = int(pin)',
     '    count = int(count)',
     '  except (TypeError, ValueError):',
     '    return None',
     '  if count <= 0:',
     '    return None',
     '  try:',
     '    brightness = int(brightness)',
     '  except (TypeError, ValueError):',
     '    brightness = 255',
     '  brightness = max(0, min(255, brightness))',
     '  key = (pin, count, freq, dma, invert, channel)',
     '  strip = ws2812b_strips.get(key)',
     '  if strip is None:',
     '    strip = PixelStrip(count, pin, freq_hz=freq, dma=dma, invert=invert, brightness=brightness, channel=channel)',
     '    strip.begin()',
     '    ws2812b_strips[key] = strip',
     '  else:',
     '    try:',
     '      strip.setBrightness(brightness)',
     '    except AttributeError:',
     '      pass',
     '  return strip']
  );

  var wsSetPixel = Blockly.Python.provideFunction_(
    'ws2812b_set_pixel_timeline',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(pin, count, index, color, brightness):',
     '  strip = ' + getStrip + '(pin, count, brightness)',
     '  if strip is None:',
     '    return',
     "  color = (color or '').lstrip('#')",
     '  if len(color) != 6:',
     '    return',
     '  try:',
     '    r = int(color[0:2], 16)',
     '    g = int(color[2:4], 16)',
     '    b = int(color[4:6], 16)',
     '  except ValueError:',
     '    return',
     '  try:',
     '    index = int(index)',
     '  except (TypeError, ValueError):',
     '    index = 0',
     '  try:',
     '    count_int = int(count)',
     '  except (TypeError, ValueError):',
     '    return',
     '  if count_int <= 0:',
     '    return',
     '  index = max(0, min(count_int - 1, index))',
     '  strip.setPixelColor(index, Color(r, g, b))',
     '  strip.show()']
  );

  var wsFill = Blockly.Python.provideFunction_(
    'ws2812b_fill_timeline',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(pin, count, color, brightness):',
     '  strip = ' + getStrip + '(pin, count, brightness)',
     '  if strip is None:',
     '    return',
     "  color = (color or '').lstrip('#')",
     '  if len(color) != 6:',
     '    return',
     '  try:',
     '    r = int(color[0:2], 16)',
     '    g = int(color[2:4], 16)',
     '    b = int(color[4:6], 16)',
     '  except ValueError:',
     '    return',
     '  try:',
     '    count_int = int(count)',
     '  except (TypeError, ValueError):',
     '    return',
     '  if count_int <= 0:',
     '    return',
     '  for i in range(count_int):',
     '    strip.setPixelColor(i, Color(r, g, b))',
     '  strip.show()']
  );

  var playAnimation = Blockly.Python.provideFunction_(
    'play_animation',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(name):',
     '  if not name:',
     '    return',
     '  frames = animations.get(name)',
     '  if not frames:',
     '    return',
     '  try:',
     '    frames = sorted(frames, key=lambda f: float(f.get("t", 0)))',
     '  except Exception:',
     '    pass',
     '  last_t = 0.0',
     '  for frame in frames:',
     '    try:',
     '      current_t = float(frame.get("t", 0))',
     '    except Exception:',
     '      current_t = 0.0',
     '    delay = max(0.0, current_t - last_t)',
     '    if delay:',
     '      time.sleep(delay)',
     '    last_t = current_t',
     '    ftype = frame.get("type")',
     '    if ftype == "servo":',
     '      ' + setServo + '(frame.get("pin"), frame.get("angle", 0))',
     '    elif ftype == "rgb":',
     '      ' + setRgb + '(frame.get("r_pin"), frame.get("g_pin"), frame.get("b_pin"), frame.get("color", "#000000"), frame.get("freq", 100), frame.get("common_anode", False))',
     '    elif ftype == "gpio":',
     '      ' + setGpio + '(frame.get("pin"), frame.get("state", "LOW"))',
     '    elif ftype == "ws2812b_pixel":',
     '      ' + wsSetPixel + '(frame.get("pin"), frame.get("count"), frame.get("index", 0), frame.get("color", "#000000"), frame.get("brightness", 255))',
     '    elif ftype == "ws2812b_fill":',
     '      ' + wsFill + '(frame.get("pin"), frame.get("count"), frame.get("color", "#000000"), frame.get("brightness", 255))']
  );

  var code = playAnimation + '(' + JSON.stringify(name) + ')\n';
  return code;
};

Blockly.Python['rpi_motion'] = function(block) {
  var pin = block.getFieldValue('PIN');
  Blockly.Python.definitions_['import_gpio'] = 'import RPi.GPIO as GPIO\nGPIO.setmode(GPIO.BCM)';
  var code = 'GPIO.setup(' + pin + ', GPIO.IN)\nGPIO.input(' + pin + ')';
  return [code, Blockly.Python.ORDER_FUNCTION_CALL];
};

Blockly.Python['ir_receive'] = function(block) {
  var pin = block.getFieldValue('PIN');
  Blockly.Python.definitions_['import_gpio'] = 'import RPi.GPIO as GPIO\nGPIO.setmode(GPIO.BCM)';
  var code = 'GPIO.setup(' + pin + ', GPIO.IN)\nGPIO.input(' + pin + ')';
  return [code, Blockly.Python.ORDER_FUNCTION_CALL];
};

Blockly.Python['ir_send'] = function(block) {
  var remote = Blockly.Python.valueToCode(block, 'REMOTE', Blockly.Python.ORDER_ATOMIC) || '""';
  var command = Blockly.Python.valueToCode(block, 'COMMAND', Blockly.Python.ORDER_ATOMIC) || '""';
  var count = Blockly.Python.valueToCode(block, 'COUNT', Blockly.Python.ORDER_ATOMIC) || '1';
  Blockly.Python.definitions_['import_subprocess'] = 'import subprocess';
  var func = Blockly.Python.provideFunction_(
    'ir_send_command',
    [
      'def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(remote, command, count=1):',
      '  if not remote or not command:',
      '    return False',
      '  count = max(1, int(count))',
      '  for _ in range(count):',
      '    result = subprocess.run(["irsend", "SEND_ONCE", str(remote), str(command)], capture_output=True)',
      '    if result.returncode != 0:',
      '      raise RuntimeError(f"irsend failed: {result.stderr.decode(errors=\"ignore\")}")',
      '  return True'
    ]
  );
  var code = func + '(' + remote + ', ' + command + ', ' + count + ')\n';
  return code;
};

Blockly.Python['rpi_encoder_steps'] = function(block) {
  var clk = block.getFieldValue('CLK');
  var dt = block.getFieldValue('DT');
  Blockly.Python.definitions_['import_gpio'] = 'import RPi.GPIO as GPIO\nGPIO.setmode(GPIO.BCM)';
  Blockly.Python.definitions_['encoder_support'] = [
    'encoders = {}',
    'def _setup_encoder(clk, dt):',
    '    if (clk, dt) in encoders: return',
    '    GPIO.setup(clk, GPIO.IN, pull_up_down=GPIO.PUD_UP)',
    '    GPIO.setup(dt, GPIO.IN, pull_up_down=GPIO.PUD_UP)',
    '    encoders[(clk, dt)] = {"pos":0, "dir":0}',
    '    def _cb(channel, clk=clk, dt=dt):',
    '        a = GPIO.input(clk)',
    '        b = GPIO.input(dt)',
    '        data = encoders[(clk, dt)]',
    '        if a == b:',
    '            data["pos"] += 1',
    '            data["dir"] = 1',
    '        else:',
    '            data["pos"] -= 1',
    '            data["dir"] = -1',
    '    GPIO.add_event_detect(clk, GPIO.BOTH, callback=_cb)',
    '    GPIO.add_event_detect(dt, GPIO.BOTH, callback=_cb)',
    '',
    'def encoder_steps(clk, dt):',
    '    _setup_encoder(clk, dt)',
    '    return encoders[(clk, dt)]["pos"]',
    '',
    'def encoder_direction(clk, dt):',
    '    _setup_encoder(clk, dt)',
    '    return encoders[(clk, dt)]["dir"]'
  ].join('\n');
  var code = 'encoder_steps(' + clk + ', ' + dt + ')';
  return [code, Blockly.Python.ORDER_FUNCTION_CALL];
};

Blockly.Python['rpi_encoder_direction'] = function(block) {
  var clk = block.getFieldValue('CLK');
  var dt = block.getFieldValue('DT');
  Blockly.Python.definitions_['import_gpio'] = 'import RPi.GPIO as GPIO\nGPIO.setmode(GPIO.BCM)';
  Blockly.Python.definitions_['encoder_support'] = [
    'encoders = {}',
    'def _setup_encoder(clk, dt):',
    '    if (clk, dt) in encoders: return',
    '    GPIO.setup(clk, GPIO.IN, pull_up_down=GPIO.PUD_UP)',
    '    GPIO.setup(dt, GPIO.IN, pull_up_down=GPIO.PUD_UP)',
    '    encoders[(clk, dt)] = {"pos":0, "dir":0}',
    '    def _cb(channel, clk=clk, dt=dt):',
    '        a = GPIO.input(clk)',
    '        b = GPIO.input(dt)',
    '        data = encoders[(clk, dt)]',
    '        if a == b:',
    '            data["pos"] += 1',
    '            data["dir"] = 1',
    '        else:',
    '            data["pos"] -= 1',
    '            data["dir"] = -1',
    '    GPIO.add_event_detect(clk, GPIO.BOTH, callback=_cb)',
    '    GPIO.add_event_detect(dt, GPIO.BOTH, callback=_cb)',
    '',
    'def encoder_steps(clk, dt):',
    '    _setup_encoder(clk, dt)',
    '    return encoders[(clk, dt)]["pos"]',
    '',
    'def encoder_direction(clk, dt):',
    '    _setup_encoder(clk, dt)',
    '    return encoders[(clk, dt)]["dir"]'
  ].join('\n');
  var code = 'encoder_direction(' + clk + ', ' + dt + ')';
  return [code, Blockly.Python.ORDER_FUNCTION_CALL];
};

Blockly.Python['ads1015_read'] = function(block) {
  var chan = block.getFieldValue('CHAN');
  Blockly.Python.definitions_['import_board'] = 'import board, busio';
  Blockly.Python.definitions_['import_ads'] = 'from adafruit_ads1x15.ads1015 import ADS1015\nfrom adafruit_ads1x15.analog_in import AnalogIn';
  var func = Blockly.Python.provideFunction_(
    'read_ads_channel',
    ['def ' + Blockly.Python.FUNCTION_NAME_PLACEHOLDER_ + '(c):',
     '  i2c = busio.I2C(board.SCL, board.SDA)',
     '  ads = ADS1015(i2c)',
     '  ch = AnalogIn(ads, c)',
     '  return ch.value']
  );
  var code = func + '(' + chan + ')';
  return [code, Blockly.Python.ORDER_FUNCTION_CALL];
};

Blockly.Python['rpi_camera_photo'] = function(block) {
  var file = block.getFieldValue('FILE');
  var w = block.getFieldValue('W');
  var h = block.getFieldValue('H');
  Blockly.Python.definitions_['camera_imports'] = cameraImports;
  Blockly.Python.definitions_['camera_support'] = cameraSupport;
  var code = 'camera_capture("' + file + '", ' + w + ', ' + h + ')\n';
  return code;
};

Blockly.Python['rpi_camera_video'] = function(block) {
  var file = block.getFieldValue('FILE');
  var dur = block.getFieldValue('DUR');
  var w = block.getFieldValue('W');
  var h = block.getFieldValue('H');
  Blockly.Python.definitions_['camera_imports'] = cameraImports;
  Blockly.Python.definitions_['camera_support'] = cameraSupport;
  var code = 'camera_record("' + file + '", ' + dur + ', ' + w + ', ' + h + ')\n';
  return code;
};

Blockly.Python['hailo_yolo_start'] = function(block) {
  Blockly.Python.definitions_['hailo_imports'] = hailoImports;
  Blockly.Python.definitions_['hailo_support'] = hailoSupport;
  var code = 'hailo_yolo_start()\n';
  return code;
};

Blockly.Python['hailo_yolo_get'] = function(block) {
  Blockly.Python.definitions_['hailo_imports'] = hailoImports;
  Blockly.Python.definitions_['hailo_support'] = hailoSupport;
  var code = 'hailo_yolo_get()';
  return [code, Blockly.Python.ORDER_FUNCTION_CALL];
};

Blockly.Python['ws_start'] = function(block) {
  var host = block.getFieldValue('HOST');
  var port = block.getFieldValue('PORT');
  Blockly.Python.definitions_['ws_imports'] = wsImports;
  Blockly.Python.definitions_['ws_support'] = wsSupport;
  var code = 'ws_start_server(host="' + host + '", port=' + port + ')\n';
  return code;
};

Blockly.Python['ws_running'] = function(block) {
  Blockly.Python.definitions_['ws_imports'] = wsImports;
  Blockly.Python.definitions_['ws_support'] = wsSupport;
  var code = 'ws_running()';
  return [code, Blockly.Python.ORDER_FUNCTION_CALL];
};

Blockly.Python['ws_send'] = function(block) {
  var msg = Blockly.Python.valueToCode(block, 'MSG', Blockly.Python.ORDER_ATOMIC) || '""';
  Blockly.Python.definitions_['ws_imports'] = wsImports;
  Blockly.Python.definitions_['ws_support'] = wsSupport;
  var code = 'ws_send(' + msg + ')\n';
  return code;
};

Blockly.Python['ws_client_count'] = function(block) {
  Blockly.Python.definitions_['ws_imports'] = wsImports;
  Blockly.Python.definitions_['ws_support'] = wsSupport;
  var code = 'ws_client_count()';
  return [code, Blockly.Python.ORDER_FUNCTION_CALL];
};

Blockly.Python['logic_while'] = function(block) {
  var cond = Blockly.Python.valueToCode(block, 'COND', Blockly.Python.ORDER_NONE) || 'False';
  var branch = Blockly.Python.statementToCode(block, 'DO');
  if (!branch) branch = Blockly.Python.PASS;
  var code = 'while ' + cond + ':\n' + branch;
  return code;
};

Blockly.Python['logic_loop'] = function(block) {
  var branch = Blockly.Python.statementToCode(block, 'DO');
  if (!branch) branch = Blockly.Python.PASS;
  var code = 'while True:\n' + branch;
  return code;
};

Blockly.Python['setup_block'] = function(block) {
  var branch = Blockly.Python.statementToCode(block, 'DO');
  if (!branch) branch = Blockly.Python.PASS;
  var code = 'def setup():\n' + branch + '\n';
  return code;
};

Blockly.Python['loop_block'] = function(block) {
  var branch = Blockly.Python.statementToCode(block, 'DO');
  if (!branch) branch = Blockly.Python.PASS;
  var code = 'def loop():\n' + branch + '\nsetup()\nwhile True:\n    loop()\n';
  return code;
};
Blockly.Python['loop_function'] = function(block) {
  var raw = block.getFieldValue('NAME');
  var name = sanitizeLoopFunctionName(raw);
  var branch = Blockly.Python.statementToCode(block, 'STACK');
  if (!branch) branch = Blockly.Python.PASS;
  var code = 'def ' + name + '():\n' + branch + '\n';
  Blockly.Python.definitions_['loop_function_' + name] = code;
  return '';
};
Blockly.Python['loop_function_call'] = function(block) {
  var name = block.getFieldValue('NAME');
  if (!name) {
    return '';
  }
  var code = name + '()\n';
  return code;
};
Blockly.Python['ui_config'] = function(block) {
  var en = Blockly.Python.valueToCode(block, 'ENABLE', Blockly.Python.ORDER_ATOMIC) || 'True';
  var fps = Blockly.Python.valueToCode(block, 'FPS', Blockly.Python.ORDER_ATOMIC) || '60';
  Blockly.Python.definitions_['ui_imports'] = uiImports;
  Blockly.Python.definitions_['ui_support'] = uiSupport;
  var code = 'ui_config(' + en + ', ' + fps + ')\n';
  return code;
};



Blockly.Python['ui_start'] = function(block) {
  var w = Blockly.Python.valueToCode(block, 'W', Blockly.Python.ORDER_ATOMIC) || '640';
  var h = Blockly.Python.valueToCode(block, 'H', Blockly.Python.ORDER_ATOMIC) || '480';
  var col = Blockly.Python.valueToCode(block, 'COL', Blockly.Python.ORDER_ATOMIC) || '\'#000000\'';
  Blockly.Python.definitions_['ws_imports'] = wsImports;
  Blockly.Python.definitions_['ws_support'] = wsSupport;
  Blockly.Python.definitions_['ui_imports'] = uiImports;
  Blockly.Python.definitions_['ui_support'] = uiSupport;
  var code = 'ui_start(width=' + w + ', height=' + h + ', color=' + col + ')\n';
  return code;
};

Blockly.Python['ui_launch'] = function(block) {
  Blockly.Python.definitions_['ws_imports'] = wsImports;
  Blockly.Python.definitions_['ws_support'] = wsSupport;
  Blockly.Python.definitions_['ui_imports'] = uiImports;
  Blockly.Python.definitions_['ui_support'] = uiSupport;
  var code = 'ui_start()\n';
  return code;
};

Blockly.Python['ui_add_text'] = function(block) {
  var id = Blockly.Python.valueToCode(block, 'ID', Blockly.Python.ORDER_ATOMIC) || '""';
  var txt = Blockly.Python.valueToCode(block, 'TXT', Blockly.Python.ORDER_ATOMIC) || '""';
  Blockly.Python.definitions_['ui_imports'] = uiImports;
  Blockly.Python.definitions_['ui_support'] = uiSupport;
  Blockly.Python.definitions_['ws_imports'] = wsImports;
  Blockly.Python.definitions_['ws_support'] = wsSupport;
  var code = 'ui_send({"cmd":"add_text","id":' + id + ',"text":' + txt + '})\n';
  return code;
};
Blockly.Python['ui_set_text'] = function(block) {
  var id = Blockly.Python.valueToCode(block, 'ID', Blockly.Python.ORDER_ATOMIC) || '""';
  var txt = Blockly.Python.valueToCode(block, 'TXT', Blockly.Python.ORDER_ATOMIC) || '""';
  Blockly.Python.definitions_['ui_imports'] = uiImports;
  Blockly.Python.definitions_['ui_support'] = uiSupport;
  Blockly.Python.definitions_['ws_imports'] = wsImports;
  Blockly.Python.definitions_['ws_support'] = wsSupport;
  var code = 'ui_send({"cmd":"set_text","id":' + id + ',"text":' + txt + '})\n';
  return code;
};

Blockly.Python['ui_add_image'] = function(block) {
  var id = Blockly.Python.valueToCode(block, 'ID', Blockly.Python.ORDER_ATOMIC) || '""';
  var src = Blockly.Python.valueToCode(block, 'SRC', Blockly.Python.ORDER_ATOMIC) || '""';
  var w = Blockly.Python.valueToCode(block, 'W', Blockly.Python.ORDER_ATOMIC) || '0';
  var h = Blockly.Python.valueToCode(block, 'H', Blockly.Python.ORDER_ATOMIC) || '0';
  Blockly.Python.definitions_['ui_imports'] = uiImports;
  Blockly.Python.definitions_['ui_support'] = uiSupport;
  Blockly.Python.definitions_['ws_imports'] = wsImports;
  Blockly.Python.definitions_['ws_support'] = wsSupport;
  var code = 'ui_send({"cmd":"add_image","id":' + id + ',"src":' + src + ',"w":' + w + ',"h":' + h + '})\n';
  return code;
};

Blockly.Python['ui_add_sprite'] = function(block) {
  var id = Blockly.Python.valueToCode(block, 'ID', Blockly.Python.ORDER_ATOMIC) || '""';
  var frames = Blockly.Python.valueToCode(block, 'FRAMES', Blockly.Python.ORDER_ATOMIC) || '[]';
  var fps = Blockly.Python.valueToCode(block, 'FPS', Blockly.Python.ORDER_ATOMIC) || '12';
  var loop = Blockly.Python.valueToCode(block, 'LOOP', Blockly.Python.ORDER_ATOMIC) || 'True';
  var w = Blockly.Python.valueToCode(block, 'W', Blockly.Python.ORDER_ATOMIC) || '0';
  var h = Blockly.Python.valueToCode(block, 'H', Blockly.Python.ORDER_ATOMIC) || '0';
  Blockly.Python.definitions_['ui_imports'] = uiImports;
  Blockly.Python.definitions_['ui_support'] = uiSupport;
  Blockly.Python.definitions_['ws_imports'] = wsImports;
  Blockly.Python.definitions_['ws_support'] = wsSupport;
  var code = 'ui_send({\"cmd\":\"add_sprite\",\"id\":' + id + ',\"frames\":' + frames + ',\"fps\":' + fps + ',\"loop\":' + loop + ',\"w\":' + w + ',\"h\":' + h + '})\n';
  return code;
};

Blockly.Python['ui_set_text_color'] = function(block) {
  var id = Blockly.Python.valueToCode(block, 'ID', Blockly.Python.ORDER_ATOMIC) || '""';
  var col = Blockly.Python.valueToCode(block, 'COL', Blockly.Python.ORDER_ATOMIC) || '""';
  Blockly.Python.definitions_['ui_imports'] = uiImports;
  Blockly.Python.definitions_['ui_support'] = uiSupport;
  Blockly.Python.definitions_['ws_imports'] = wsImports;
  Blockly.Python.definitions_['ws_support'] = wsSupport;
  var code = 'ui_send({"cmd":"set_text_color","id":' + id + ',"color":' + col + '})\n';
  return code;
};

Blockly.Python['ui_set_text_size'] = function(block) {
  var id = Blockly.Python.valueToCode(block, 'ID', Blockly.Python.ORDER_ATOMIC) || '""';
  var size = Blockly.Python.valueToCode(block, 'SIZE', Blockly.Python.ORDER_ATOMIC) || '0';
  Blockly.Python.definitions_['ui_imports'] = uiImports;
  Blockly.Python.definitions_['ui_support'] = uiSupport;
  Blockly.Python.definitions_['ws_imports'] = wsImports;
  Blockly.Python.definitions_['ws_support'] = wsSupport;
  var code = 'ui_send({"cmd":"set_text_size","id":' + id + ',"size":' + size + '})\n';
  return code;
};

Blockly.Python['ui_set_position'] = function(block) {
  var id = Blockly.Python.valueToCode(block, 'ID', Blockly.Python.ORDER_ATOMIC) || '""';
  var x = Blockly.Python.valueToCode(block, 'X', Blockly.Python.ORDER_ATOMIC) || '0';
  var y = Blockly.Python.valueToCode(block, 'Y', Blockly.Python.ORDER_ATOMIC) || '0';
  Blockly.Python.definitions_['ui_imports'] = uiImports;
  Blockly.Python.definitions_['ui_support'] = uiSupport;
  Blockly.Python.definitions_['ws_imports'] = wsImports;
  Blockly.Python.definitions_['ws_support'] = wsSupport;
  var code = 'ui_send({"cmd":"set_position","id":' + id + ',"x":' + x + ',"y":' + y + '})\n';
  return code;
};

Blockly.Python['ui_set_rotation'] = function(block) {
  var id = Blockly.Python.valueToCode(block, 'ID', Blockly.Python.ORDER_ATOMIC) || '""';
  var angle = Blockly.Python.valueToCode(block, 'ANGLE', Blockly.Python.ORDER_ATOMIC) || '0';
  Blockly.Python.definitions_['ui_imports'] = uiImports;
  Blockly.Python.definitions_['ui_support'] = uiSupport;
  Blockly.Python.definitions_['ws_imports'] = wsImports;
  Blockly.Python.definitions_['ws_support'] = wsSupport;
  var code = 'ui_send({"cmd":"set_rotation","id":' + id + ',"angle":' + angle + '})\n';
  return code;
};

Blockly.Python['ui_set_image_source'] = function(block) {
  var id = Blockly.Python.valueToCode(block, 'ID', Blockly.Python.ORDER_ATOMIC) || '""';
  var src = Blockly.Python.valueToCode(block, 'SRC', Blockly.Python.ORDER_ATOMIC) || '""';
  Blockly.Python.definitions_['ui_imports'] = uiImports;
  Blockly.Python.definitions_['ui_support'] = uiSupport;
  Blockly.Python.definitions_['ws_imports'] = wsImports;
  Blockly.Python.definitions_['ws_support'] = wsSupport;
  var code = 'ui_send({"cmd":"set_image_source","id":' + id + ',"src":' + src + '})\n';
  return code;
};

Blockly.Python['ui_set_sprite_frames'] = function(block) {
  var id = Blockly.Python.valueToCode(block, 'ID', Blockly.Python.ORDER_ATOMIC) || '""';
  var frames = Blockly.Python.valueToCode(block, 'FRAMES', Blockly.Python.ORDER_ATOMIC) || '[]';
  Blockly.Python.definitions_['ui_imports'] = uiImports;
  Blockly.Python.definitions_['ui_support'] = uiSupport;
  Blockly.Python.definitions_['ws_imports'] = wsImports;
  Blockly.Python.definitions_['ws_support'] = wsSupport;
  var code = 'ui_send({\"cmd\":\"set_sprite_frames\",\"id\":' + id + ',\"frames\":' + frames + '})\n';
  return code;
};

Blockly.Python['ui_sprite_play'] = function(block) {
  var id = Blockly.Python.valueToCode(block, 'ID', Blockly.Python.ORDER_ATOMIC) || '""';
  Blockly.Python.definitions_['ui_imports'] = uiImports;
  Blockly.Python.definitions_['ui_support'] = uiSupport;
  Blockly.Python.definitions_['ws_imports'] = wsImports;
  Blockly.Python.definitions_['ws_support'] = wsSupport;
  var code = 'ui_send({\"cmd\":\"sprite_play\",\"id\":' + id + '})\n';
  return code;
};

Blockly.Python['ui_sprite_pause'] = function(block) {
  var id = Blockly.Python.valueToCode(block, 'ID', Blockly.Python.ORDER_ATOMIC) || '""';
  Blockly.Python.definitions_['ui_imports'] = uiImports;
  Blockly.Python.definitions_['ui_support'] = uiSupport;
  Blockly.Python.definitions_['ws_imports'] = wsImports;
  Blockly.Python.definitions_['ws_support'] = wsSupport;
  var code = 'ui_send({\"cmd\":\"sprite_pause\",\"id\":' + id + '})\n';
  return code;
};

Blockly.Python['ui_sprite_set_frame'] = function(block) {
  var id = Blockly.Python.valueToCode(block, 'ID', Blockly.Python.ORDER_ATOMIC) || '""';
  var frame = Blockly.Python.valueToCode(block, 'FRAME', Blockly.Python.ORDER_ATOMIC) || '0';
  Blockly.Python.definitions_['ui_imports'] = uiImports;
  Blockly.Python.definitions_['ui_support'] = uiSupport;
  Blockly.Python.definitions_['ws_imports'] = wsImports;
  Blockly.Python.definitions_['ws_support'] = wsSupport;
  var code = 'ui_send({\"cmd\":\"sprite_set_frame\",\"id\":' + id + ',\"frame\":' + frame + '})\n';
  return code;
};

Blockly.Python['ui_sprite_set_fps'] = function(block) {
  var id = Blockly.Python.valueToCode(block, 'ID', Blockly.Python.ORDER_ATOMIC) || '""';
  var fps = Blockly.Python.valueToCode(block, 'FPS', Blockly.Python.ORDER_ATOMIC) || '12';
  Blockly.Python.definitions_['ui_imports'] = uiImports;
  Blockly.Python.definitions_['ui_support'] = uiSupport;
  Blockly.Python.definitions_['ws_imports'] = wsImports;
  Blockly.Python.definitions_['ws_support'] = wsSupport;
  var code = 'ui_send({\"cmd\":\"sprite_set_fps\",\"id\":' + id + ',\"fps\":' + fps + '})\n';
  return code;
};

Blockly.Python['ui_sprite_set_loop'] = function(block) {
  var id = Blockly.Python.valueToCode(block, 'ID', Blockly.Python.ORDER_ATOMIC) || '""';
  var loop = Blockly.Python.valueToCode(block, 'LOOP', Blockly.Python.ORDER_ATOMIC) || 'True';
  Blockly.Python.definitions_['ui_imports'] = uiImports;
  Blockly.Python.definitions_['ui_support'] = uiSupport;
  Blockly.Python.definitions_['ws_imports'] = wsImports;
  Blockly.Python.definitions_['ws_support'] = wsSupport;
  var code = 'ui_send({\"cmd\":\"sprite_set_loop\",\"id\":' + id + ',\"loop\":' + loop + '})\n';
  return code;
};

Blockly.Python['ui_set_size'] = function(block) {
  var id = Blockly.Python.valueToCode(block, 'ID', Blockly.Python.ORDER_ATOMIC) || '""';
  var w = Blockly.Python.valueToCode(block, 'W', Blockly.Python.ORDER_ATOMIC) || '0';
  var h = Blockly.Python.valueToCode(block, 'H', Blockly.Python.ORDER_ATOMIC) || '0';
  Blockly.Python.definitions_['ui_imports'] = uiImports;
  Blockly.Python.definitions_['ui_support'] = uiSupport;
  Blockly.Python.definitions_['ws_imports'] = wsImports;
  Blockly.Python.definitions_['ws_support'] = wsSupport;
  var code = 'ui_send({"cmd":"set_size","id":' + id + ',"w":' + w + ',"h":' + h + '})\n';
  return code;
};

Blockly.Python['ui_set_visible'] = function(block) {
  var id = Blockly.Python.valueToCode(block, 'ID', Blockly.Python.ORDER_ATOMIC) || '""';
  var vis = Blockly.Python.valueToCode(block, 'VIS', Blockly.Python.ORDER_ATOMIC) || 'True';
  Blockly.Python.definitions_['ui_imports'] = uiImports;
  Blockly.Python.definitions_['ui_support'] = uiSupport;
  Blockly.Python.definitions_['ws_imports'] = wsImports;
  Blockly.Python.definitions_['ws_support'] = wsSupport;
  var code = 'ui_send({"cmd":"set_visible","id":' + id + ',"visible":' + vis + '})\n';
  return code;
};


Blockly.Python['ui_get_event'] = function(block) {
  Blockly.Python.definitions_['ui_imports'] = uiImports;
  Blockly.Python.definitions_['ui_support'] = uiSupport;
  Blockly.Python.definitions_['ws_imports'] = wsImports;
  Blockly.Python.definitions_['ws_support'] = wsSupport;
  var code = 'ui_get_event()';
  return [code, Blockly.Python.ORDER_FUNCTION_CALL];
};

Blockly.Python['play_audio'] = function(block) {
  var src = Blockly.Python.valueToCode(block, 'SRC', Blockly.Python.ORDER_ATOMIC) || '""';
  Blockly.Python.definitions_['audio_imports'] = audioImports;
  Blockly.Python.definitions_['audio_support'] = audioSupport;
  var code = 'play_audio(' + src + ')\n';
  return code;
};

Blockly.Python['pause_audio'] = function(block) {
  Blockly.Python.definitions_['audio_imports'] = audioImports;
  Blockly.Python.definitions_['audio_support'] = audioSupport;
  return 'pause_audio()\n';
};

Blockly.Python['stop_audio'] = function(block) {
  Blockly.Python.definitions_['audio_imports'] = audioImports;
  Blockly.Python.definitions_['audio_support'] = audioSupport;
  return 'stop_audio()\n';
};

Blockly.Python['set_volume'] = function(block) {
  var vol = Blockly.Python.valueToCode(block, 'VOL', Blockly.Python.ORDER_ATOMIC) || '100';
  Blockly.Python.definitions_['audio_imports'] = audioImports;
  Blockly.Python.definitions_['audio_support'] = audioSupport;
  return 'set_volume(' + vol + ')\n';
};

Blockly.Python['piper_config'] = function(block) {
  var model = Blockly.Python.valueToCode(block, 'MODEL', Blockly.Python.ORDER_ATOMIC) || '""';
  var conf = Blockly.Python.valueToCode(block, 'CONF', Blockly.Python.ORDER_ATOMIC) || 'None';
  var cuda = Blockly.Python.valueToCode(block, 'CUDA', Blockly.Python.ORDER_ATOMIC) || 'False';
  Blockly.Python.definitions_['audio_imports'] = audioImports;
  Blockly.Python.definitions_['audio_support'] = audioSupport;
  Blockly.Python.definitions_['piper_imports'] = piperImports;
  Blockly.Python.definitions_['piper_support'] = piperSupport;
  var code = 'piper_config(' + model + ', ' + conf + ', ' + cuda + ')\n';
  return code;
};

Blockly.Python['piper_speak'] = function(block) {
  var txt = Blockly.Python.valueToCode(block, 'TEXT', Blockly.Python.ORDER_ATOMIC) || '""';
  Blockly.Python.definitions_['audio_imports'] = audioImports;
  Blockly.Python.definitions_['audio_support'] = audioSupport;
  Blockly.Python.definitions_['piper_imports'] = piperImports;
  Blockly.Python.definitions_['piper_support'] = piperSupport;
  var code = 'piper_speak(' + txt + ')\n';
  return code;
};

Blockly.Python['piper_cli'] = function(block) {
  var txt = Blockly.Python.valueToCode(block, 'TEXT', Blockly.Python.ORDER_ATOMIC) || '""';
  var model = Blockly.Python.valueToCode(block, 'MODEL', Blockly.Python.ORDER_ATOMIC) || '""';
  var conf = Blockly.Python.valueToCode(block, 'CONF', Blockly.Python.ORDER_ATOMIC) || '""';
  Blockly.Python.definitions_['import_subprocess'] = 'import subprocess';
  Blockly.Python.definitions_['piper_cli_support'] = piperCliSupport;
  var code = 'piper_cli_speak(' + txt + ', ' + model + ', ' + conf + ')\n';
  return code;
};

Blockly.Python['ollama_start'] = function(block) {
  var model = Blockly.Python.valueToCode(block, 'MODEL', Blockly.Python.ORDER_ATOMIC) || '""';
  Blockly.Python.definitions_['import_requests'] = 'import requests';
  var code = 'requests.post("http://localhost:11434/api/generate", json={"model": ' + model + '})\n';
  return code;
};

Blockly.Python['ollama_stop'] = function(block) {
  var model = Blockly.Python.valueToCode(block, 'MODEL', Blockly.Python.ORDER_ATOMIC) || '""';
  Blockly.Python.definitions_['import_requests'] = 'import requests';
  var code = 'requests.post("http://localhost:11434/api/generate", json={"model": ' + model + ', "keep_alive": 0})\n';
  return code;
};

Blockly.Python['ollama_ps'] = function(block) {
  var variable = Blockly.Python.variableDB_.getName(block.getFieldValue('VAR'), Blockly.VARIABLE_CATEGORY_NAME);
  Blockly.Python.definitions_['import_requests'] = 'import requests';
  var code = variable + ' = requests.get("http://localhost:11434/api/ps").json().get("models", [])\n';
  return code;
};

Blockly.Python['ml_predict'] = function(block) {
  var url = Blockly.Python.valueToCode(block, 'URL', Blockly.Python.ORDER_ATOMIC) || '""';
  var model = Blockly.Python.valueToCode(block, 'MODEL', Blockly.Python.ORDER_ATOMIC) || '""';
  var sample = Blockly.Python.valueToCode(block, 'SAMPLE', Blockly.Python.ORDER_ATOMIC) || '""';
  var variable = Blockly.Python.variableDB_.getName(block.getFieldValue('VAR'), Blockly.VARIABLE_CATEGORY_NAME);
  Blockly.Python.definitions_['import_requests'] = 'import requests';
  var code = 'try:\n';
  code += '    _url = str(' + url + ')\n';
  code += '    if not _url.rstrip("/").endswith("api/predict"):\n';
  code += '        _url = _url.rstrip("/") + "/api/predict"\n';
  code += '    _r = requests.post(_url, json={"model": ' + model + ', "sample": ' + sample + '}, timeout=5)\n';
  code += '    _r.raise_for_status()\n';
  code += '    ' + variable + ' = _r.json()\n';
  code += 'except Exception as e:\n';
  code += '    print(f"ml_predict failed: {e}")\n';
  code += '    ' + variable + ' = {"prediction": "", "probability": 0}\n';
  // default empty response so callers can safely access prediction keys
  return code;
};

Blockly.Python['ml_predict_image'] = function(block) {
  var url = Blockly.Python.valueToCode(block, 'URL', Blockly.Python.ORDER_ATOMIC) || '""';
  var model = Blockly.Python.valueToCode(block, 'MODEL', Blockly.Python.ORDER_ATOMIC) || '""';
  var img = Blockly.Python.valueToCode(block, 'IMAGE', Blockly.Python.ORDER_ATOMIC) || '""';
  var variable = Blockly.Python.variableDB_.getName(block.getFieldValue('VAR'), Blockly.VARIABLE_CATEGORY_NAME);
  Blockly.Python.definitions_['import_requests'] = 'import requests';
  var code = 'try:\n';
  code += '    _url = str(' + url + ')\n';
  code += '    if not _url.rstrip("/").endswith("api/predict_image"):\n';
  code += '        _url = _url.rstrip("/") + "/api/predict_image"\n';
  code += '    _r = requests.post(_url, json={"model": ' + model + ', "image": ' + img + '}, timeout=5)\n';
  code += '    _r.raise_for_status()\n';
  code += '    ' + variable + ' = _r.json()\n';
  code += 'except Exception as e:\n';
  code += '    print(f"ml_predict_image failed: {e}")\n';
  code += '    ' + variable + ' = {"prediction": "", "probability": 0}\n';
  return code;
};

Blockly.Python['ml_predict_yolo'] = function(block) {
  var url = Blockly.Python.valueToCode(block, 'URL', Blockly.Python.ORDER_ATOMIC) || '""';
  var model = Blockly.Python.valueToCode(block, 'MODEL', Blockly.Python.ORDER_ATOMIC) || '""';
  var img = Blockly.Python.valueToCode(block, 'IMAGE', Blockly.Python.ORDER_ATOMIC) || '""';
  var variable = Blockly.Python.variableDB_.getName(block.getFieldValue('VAR'), Blockly.VARIABLE_CATEGORY_NAME);
  Blockly.Python.definitions_['import_requests'] = 'import requests';
  var code = 'try:\n';
  code += '    _url = str(' + url + ')\n';
  code += '    if not _url.rstrip("/").endswith("api/predict_yolo"):\n';
  code += '        _url = _url.rstrip("/") + "/api/predict_yolo"\n';
  code += '    _r = requests.post(_url, json={"model": ' + model + ', "image": ' + img + '}, timeout=5)\n';
  code += '    _r.raise_for_status()\n';
  code += '    ' + variable + ' = _r.json()\n';
  code += 'except Exception as e:\n';
  code += '    print(f"ml_predict_yolo failed: {e}")\n';
  code += '    ' + variable + ' = {"boxes": [], "scores": [], "classes": [], "names": []}\n';
  return code;
};

Blockly.Python['ml_local_predict'] = function(block) {
  var model = Blockly.Python.valueToCode(block, 'MODEL', Blockly.Python.ORDER_ATOMIC) || '""';
  var sample = Blockly.Python.valueToCode(block, 'SAMPLE', Blockly.Python.ORDER_ATOMIC) || '""';
  var variable = Blockly.Python.variableDB_.getName(block.getFieldValue('VAR'), Blockly.VARIABLE_CATEGORY_NAME);
  Blockly.Python.definitions_['import_ml_inference'] = 'import ml_inference';
  var code = 'try:\n';
  code += '    _predict = ml_inference.load_model(' + model + ')\n';
  code += '    ' + variable + ' = _predict(' + sample + ')\n';
  code += 'except Exception as e:\n';
  code += '    print(f"ml_local_predict failed: {e}")\n';
  code += '    ' + variable + ' = (None, None)\n';
  return code;
};

Blockly.Python['ml_local_predict_image'] = function(block) {
  var model = Blockly.Python.valueToCode(block, 'MODEL', Blockly.Python.ORDER_ATOMIC) || '""';
  var img = Blockly.Python.valueToCode(block, 'IMAGE', Blockly.Python.ORDER_ATOMIC) || '""';
  var variable = Blockly.Python.variableDB_.getName(block.getFieldValue('VAR'), Blockly.VARIABLE_CATEGORY_NAME);
  Blockly.Python.definitions_['import_ml_inference'] = 'import ml_inference';
  var code = 'try:\n';
  code += '    _predict = ml_inference.load_model(' + model + ')\n';
  code += '    ' + variable + ' = _predict(' + img + ')\n';
  code += 'except Exception as e:\n';
  code += '    print(f"ml_local_predict_image failed: {e}")\n';
  code += '    ' + variable + ' = (None, None)\n';
  return code;
};

Blockly.Python['ml_local_predict_yolo'] = function(block) {
  var model = Blockly.Python.valueToCode(block, 'MODEL', Blockly.Python.ORDER_ATOMIC) || '""';
  var img = Blockly.Python.valueToCode(block, 'IMAGE', Blockly.Python.ORDER_ATOMIC) || '""';
  var variable = Blockly.Python.variableDB_.getName(block.getFieldValue('VAR'), Blockly.VARIABLE_CATEGORY_NAME);
  Blockly.Python.definitions_['import_ml_inference'] = 'import ml_inference';
  var code = 'try:\n';
  code += '    _predict = ml_inference.load_model(' + model + ', "yolo")\n';
  code += '    ' + variable + ' = _predict(' + img + ')\n';
  code += 'except Exception as e:\n';
  code += '    print(f"ml_local_predict_yolo failed: {e}")\n';
  code += '    ' + variable + ' = ({}, None)\n';
  return code;
};
// Utility to download code
function download(filename, text) {
  var element = document.createElement('a');
  var name = (typeof projectName !== 'undefined' ? projectName.replace(/\s+/g, '_') : 'project');
  element.setAttribute('href', 'data:text/plain;charset=utf-8,' + encodeURIComponent(text));
  element.setAttribute('download', filename || (name + '.py'));
  element.style.display = 'none';
  document.body.appendChild(element);
  element.click();
  document.body.removeChild(element);
}

function parseImports(code) {
  var imports = [];
  code.split('\n').forEach(function(line) {
    var m = line.match(/^\s*import\s+([\w\.]+)/);
    if (m) {
      imports.push(m[1].split('.')[0]);
    } else {
      m = line.match(/^\s*from\s+([\w\.]+)\s+import/);
      if (m) imports.push(m[1].split('.')[0]);
    }
  });
  var u = [];
  imports.forEach(function(i){ if(u.indexOf(i) === -1) u.push(i); });
  return u;
}

function collectRequirements() {
  var reqs = [];
  if (!workspace) return reqs;
  workspace.getAllBlocks(false).forEach(function(block) {
    var comp = loadedComponents[block.type];
    if (comp && comp.requirement) {
      comp.requirement.split('\n').forEach(function(r) {
        r = r.trim();
        if (r && reqs.indexOf(r) === -1) reqs.push(r);
      });
    }
    var pkg = builtinRequirements[block.type];
    if (pkg) {
      pkg.split('\n').forEach(function(r) {
        r = r.trim();
        if (r && reqs.indexOf(r) === -1) reqs.push(r);
      });
    }
  });
  return reqs;
}

function getRequirements(code) {
  // Only include packages explicitly listed as component requirements.
  // Imports found in the generated Python code should not be added
  // automatically so they don't appear in the requirements file.
  return collectRequirements();
}

function generateUiInitCode() {
  if (typeof savedUiState === 'undefined') return '';
  var lines = [];
  Object.keys(savedUiState).forEach(function(id){
    if (id === '_uploads' || id === '_audio') return;
    var d = savedUiState[id] || {};
    if (d.type === 'text') {
      var text = (d.text || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      lines.push('ui_send({"cmd":"add_text","id":"' + id + '","text":"' + text + '"})');
      lines.push('ui_send({"cmd":"set_position","id":"' + id + '","x":' + (d.x || 0) + ',"y":' + (d.y || 0) + '})');
      if (d.color) lines.push('ui_send({"cmd":"set_text_color","id":"' + id + '","color":"' + d.color + '"})');
      if (d.fontSize) lines.push('ui_send({"cmd":"set_text_size","id":"' + id + '","size":' + parseInt(d.fontSize) + '})');
      if (d.rotation) lines.push('ui_send({"cmd":"set_rotation","id":"' + id + '","angle":' + d.rotation + '})');
      if (d.visible === false) lines.push('ui_send({"cmd":"set_visible","id":"' + id + '","visible":False})');
    } else if (d.type === 'image') {
      var src = 'assets/' + (d.src || '').split('/').pop();
      lines.push('ui_send({"cmd":"add_image","id":"' + id + '","src":"' + src + '","w":' + (d.width || 0) + ',"h":' + (d.height || 0) + '})');
      lines.push('ui_send({"cmd":"set_position","id":"' + id + '","x":' + (d.x || 0) + ',"y":' + (d.y || 0) + '})');
      if (d.rotation) lines.push('ui_send({"cmd":"set_rotation","id":"' + id + '","angle":' + d.rotation + '})');
      if (d.visible === false) lines.push('ui_send({"cmd":"set_visible","id":"' + id + '","visible":False})');
    }
  });
  return lines.join('\n');
}

function downloadZip(code, reqs) {
  var zip = new JSZip();
  zip.file('project.py', code);
  zip.file('run_project.sh', RUN_SH);
  if (reqs && reqs.length) {
    zip.file('requirements.txt', reqs.join('\n'));
  }
  function finish() {
    zip.generateAsync({type:'blob'}).then(function(content){
      var element = document.createElement('a');
      element.href = URL.createObjectURL(content);
      var name = (typeof projectName !== 'undefined' ? projectName.replace(/\s+/g, '_') : 'project');
      element.setAttribute('download', name + '.zip');
      element.style.display = 'none';
      document.body.appendChild(element);
      element.click();
      document.body.removeChild(element);
    });
  }
  var files = [];
  if (typeof uploadedImages !== 'undefined' && uploadedImages.length) {
    files = files.concat(uploadedImages);
  }
  if (typeof uploadedAudio !== 'undefined' && uploadedAudio.length) {
    files = files.concat(uploadedAudio);
  }
  if (files.length) {
    var done = 0;
    var folder = zip.folder('assets');
    files.forEach(function(p){
      fetch(p).then(function(r){return r.blob();}).then(function(b){
        folder.file(p.split('/').pop(), b);
        done++; if(done===files.length) finish();
      }).catch(function(){ done++; if(done===files.length) finish();});
    });
  } else {
    finish();
  }
}

function generateZipData(code, reqs, cb) {
  var zip = new JSZip();
  zip.file('project.py', code);
  zip.file('run_project.sh', RUN_SH);
  if (reqs && reqs.length) {
    zip.file('requirements.txt', reqs.join('\n'));
  }
  function finish() {
    zip.generateAsync({type:'base64'}).then(function(content){
      cb(content);
    });
  }
  var files = [];
  if (typeof uploadedImages !== 'undefined' && uploadedImages.length) {
    files = files.concat(uploadedImages);
  }
  if (typeof uploadedAudio !== 'undefined' && uploadedAudio.length) {
    files = files.concat(uploadedAudio);
  }
  if (files.length) {
    var done = 0;
    var folder = zip.folder('assets');
    files.forEach(function(p){
      fetch(p).then(function(r){return r.blob();}).then(function(b){
        folder.file(p.split('/').pop(), b);
        done++; if(done===files.length) finish();
      }).catch(function(){ done++; if(done===files.length) finish();});
    });
  } else {
    finish();
  }
}

function injectUiInit(code, init) {
  if (!init) return code;
  var injected = init
    .split('\n')
    .map(function(l){ return '  ' + l; })
    .join('\n');
  var idx = code.indexOf('def loop():');
  if (idx !== -1) {
    return code.slice(0, idx) + injected + '\n' + code.slice(idx);
  }
  return code + '\n' + injected;
}

function showPython() {
  var code = Blockly.Python.workspaceToCode(workspace);
  var init = generateUiInitCode();
  code = injectUiInit(code, init);
  var el = document.getElementById('pythonArea');
  var container = document.getElementById('pythonContainer');
  if (el) {
    el.textContent = code;
    if (window.hljs) hljs.highlightElement(el);
  }
  if (container) {
    container.style.display = 'block';
  }
}

function togglePython() {
  var container = document.getElementById('pythonContainer');
  var button = document.getElementById('togglePythonBtn');
  if (!container) {
    showPython();
    return;
  }
  var isHidden = container.style.display === 'none' || container.style.display === '';
  if (isHidden) {
    showPython();
    if (button) button.textContent = 'Hide Python';
  } else {
    container.style.display = 'none';
    if (button) button.textContent = 'View Python';
  }
}

function downloadPython() {
  var code = Blockly.Python.workspaceToCode(workspace);
  var init = generateUiInitCode();
  code = injectUiInit(code, init);
  var reqs = getRequirements(code);
  if (reqs.length) {
    downloadZip(code, reqs);
  } else {
    var name = (typeof projectName !== 'undefined' ? projectName.replace(/\s+/g, '_') + '.py' : 'project.py');
    download(name, code);
  }
}

function deployPython(url, deviceId, password) {
  if (!deviceId) return;
  if (typeof app !== 'undefined') {
    app.deployLog = 'Deploying...\n';
  }
  var code = Blockly.Python.workspaceToCode(workspace);
  var init = generateUiInitCode();
  code = injectUiInit(code, init);
  var reqs = getRequirements(code);
  generateZipData(code, reqs, function(zipData){
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: code,
        requirements: reqs,
        zip: zipData,
        device_id: deviceId,
        password: password
      })
    })
      .then(function(response){
        var reader = response.body.getReader();
        var decoder = new TextDecoder();
        function read(){
          return reader.read().then(function(result){
            if (result.done) return;
            var text = decoder.decode(result.value, {stream: true});
            if (typeof app !== 'undefined') {
              app.deployLog += text;
            } else {
              console.log(text);
            }
            return read();
          });
        }
        return read();
      })
      .catch(function(err){
        if (typeof app !== 'undefined') {
          app.deployLog += err.message || 'Deployment failed';
        } else {
          alert('Deployment failed');
        }
      });
  });
}

function serverAction(url, deviceId, password, action) {
  if (!deviceId || !password) return;
  if (typeof app !== 'undefined') {
    app.deployLog = action + '...\n';
  }
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: deviceId, password: password })
  })
    .then(function(response){
      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      function read(){
        return reader.read().then(function(result){
          if (result.done) return;
          var text = decoder.decode(result.value, {stream: true});
          if (typeof app !== 'undefined') {
            app.deployLog += text;
          } else {
            console.log(text);
          }
          return read();
        });
      }
      return read();
    })
    .catch(function(err){
      if (typeof app !== 'undefined') {
        app.deployLog += err.message || 'Operation failed';
      } else {
        alert('Operation failed');
      }
    });
}

function applyBlockStyles(workspace) {
  var custom = customTypes;
  function styleBlock(block) {
    if (!block.svgGroup_) return;
    var info = loadedComponents[block.type];
    if (custom.indexOf(block.type) !== -1 && info && info.text_color) {
      var texts = block.getSvgRoot().querySelectorAll('.blocklyText');
      texts.forEach(function(t) { t.setAttribute('fill', info.text_color); });
    }
  }
  workspace.getAllBlocks(false).forEach(styleBlock);
  workspace.addChangeListener(function(e) {
    if (e.type === Blockly.Events.BLOCK_CREATE) {
      var block = workspace.getBlockById(e.blockId);
      if (block) styleBlock(block);
    }
  });
}

function loadCustomComponents(list) {
  if (!Array.isArray(list)) return;
  list.forEach(function(comp) {
    if (!comp || !comp.name) return;
    try {
      if (!Blockly.Blocks[comp.name]) {
        Blockly.Blocks[comp.name] = {
          init: function() {
            this.appendDummyInput().appendField(comp.name);
            var params = [];
            try { params = JSON.parse(comp.params || '[]'); } catch (e) {}
            var block = this;
            params.forEach(function(p) {
              var n = (p.name || '').toUpperCase();
              if (p.type === 'text') {
                block.appendValueInput(n).setCheck('String').appendField(p.name);
              } else if (p.type === 'variable') {
                block.appendDummyInput().appendField(new Blockly.FieldVariable(p.name), n);
              }
            });
            if (comp.output) {
              this.setOutput(true, comp.output || null);
            } else {
              this.setPreviousStatement(true, null);
              this.setNextStatement(true, null);
            }
            this.setColour(comp.color || 160);
            this.setTooltip(comp.doc || '');
          }
        };
       Blockly.Python[comp.name] = function(block) {
         var code = comp.code || '';
          if (comp.imports) {
            comp.imports.split('\n').forEach(function(line, idx) {
              var cleaned = line.trim();
              if (cleaned) {
                if (!/^\s*(import |from )/.test(cleaned)) {
                  cleaned = 'import ' + cleaned;
                }
                Blockly.Python.definitions_['custom_' + comp.name + '_import_' + idx] = cleaned;
              }
            });
          }
         var params = [];
          try { params = JSON.parse(comp.params || '[]'); } catch (e) {}
          params.forEach(function(p) {
            var n = (p.name || '').toUpperCase();
            var val = '';
            if (p.type === 'text') {
              val = Blockly.Python.valueToCode(block, n, Blockly.Python.ORDER_ATOMIC) || '""';
            } else if (p.type === 'variable') {
              val = Blockly.Python.variableDB_.getName(block.getFieldValue(n), Blockly.VARIABLE_CATEGORY_NAME);
            }
            code = code.replace(new RegExp('{{' + p.name + '}}', 'g'), val);
          });
          if (comp.output) {
            return [code, Blockly.Python.ORDER_NONE];
          }
          return code + '\n';
        };
        customTypes.push(comp.name);
        loadedComponents[comp.name] = comp;
      }
    } catch (err) {
      console.error('Failed to load component', comp.name, err);
    }
  });
}
