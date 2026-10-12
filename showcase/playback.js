// A presentation timer, independent of capture state or real machine activity.
export function createPlayback({ interval, advance, enabled = true, onChange,
 schedule = setTimeout, cancel = clearTimeout }) {
 let visible = false, foreground = true, timer;
 function update() {
  if (timer !== undefined) cancel(timer);
  timer = undefined;
  const running = enabled && visible && foreground;
  onChange({ enabled, running });
  if (running) timer = schedule(() => { timer = undefined; advance(); update(); }, interval);
 }
 const player = {
  pause() { enabled = false; update(); },
  toggle() { enabled = !enabled; update(); },
  setVisible(value) { if (visible !== value) { visible = value; update(); } },
  setForeground(value) { if (foreground !== value) { foreground = value; update(); } }
 };
 update();
 return player;
}
