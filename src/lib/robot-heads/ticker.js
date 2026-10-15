// Robot Heads by Fayaz Ahmed — MIT; see LICENSE. Ported to JavaScript for Lumen.
const pointer = { x: NaN, y: NaN };
const subscribers = /* @__PURE__ */ new Set();
let frame = 0;
let last = 0;
let listening = false;
function loop(now) {
  frame = 0;
  const dt = last ? Math.min(0.1, (now - last) / 1e3) : 0;
  last = now;
  subscribers.forEach((fn) => fn(dt));
  if (subscribers.size) frame = requestAnimationFrame(loop);
}
function start() {
  if (frame || typeof document === "undefined" || document.hidden) return;
  last = 0;
  frame = requestAnimationFrame(loop);
}
function stop() {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
}
function listen() {
  if (listening || typeof document === "undefined") return;
  listening = true;
  const away = () => {
    pointer.x = NaN;
    pointer.y = NaN;
  };
  document.addEventListener("pointermove", (e) => {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
  }, { passive: true });
  document.addEventListener("pointerleave", away);
  window.addEventListener("blur", away);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else if (subscribers.size) start();
  });
}
function subscribe(fn) {
  listen();
  subscribers.add(fn);
  start();
  return () => {
    subscribers.delete(fn);
    if (!subscribers.size) stop();
  };
}
export {
  pointer,
  subscribe
};
