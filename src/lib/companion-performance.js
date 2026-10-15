// Latest state wins during streaming. Hidden pages keep one snapshot and no timer.
export function latestRender(render, { delay = 100, hidden = () => document.hidden, schedule = setTimeout, cancel = clearTimeout } = {}) {
  let pending, timer = null;
  const flush = () => {
    timer = null;
    if (hidden() || pending === undefined) return;
    const value = pending; pending = undefined; render(value);
  };
  return {
    push(value) { pending = value; if (!hidden() && timer === null) timer = schedule(flush, delay); },
    resume() { if (pending !== undefined && !hidden() && timer === null) timer = schedule(flush, 0); },
    pause() { if (timer !== null) cancel(timer); timer = null; },
    clear() { this.pause(); pending = undefined; },
  };
}
export function transcriptWindow(messages, limit = 120) {
  return messages.slice(-limit).map((message, index) => ({ message, index: Math.max(0, messages.length - limit) + index, signature: JSON.stringify(message) }));
}
