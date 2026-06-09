// 注意：installTimeControl 会被 renderer 经 Function.toString() 注入浏览器，
// 故函数体内不得引用任何外部变量、import 或闭包以外的符号。
export function installTimeControl(g) {
  let virtualNow = 0;
  let timerSeq = 1;
  const timers = new Map();      // id -> { time, cb, args, interval|null }
  let rafSeq = 1;
  let rafQueue = new Map();      // id -> cb

  const RealDate = g.Date;
  // VirtualDate 构造时显式 return 一个 RealDate 实例（覆盖 this）；因 prototype 与
  // RealDate 共享，instanceof / 实例方法均正确。无参 → 虚拟时刻；有参 → 透传。
  function VirtualDate(...args) {
    if (!(this instanceof VirtualDate)) return new RealDate(virtualNow).toString();
    if (args.length === 0) return new RealDate(virtualNow);
    return new RealDate(...args);
  }
  VirtualDate.now = () => virtualNow;
  VirtualDate.parse = RealDate.parse;
  VirtualDate.UTC = RealDate.UTC;
  VirtualDate.prototype = RealDate.prototype;
  g.Date = VirtualDate;

  if (g.performance) g.performance.now = () => virtualNow;

  g.requestAnimationFrame = (cb) => { const id = rafSeq++; rafQueue.set(id, cb); return id; };
  g.cancelAnimationFrame = (id) => { rafQueue.delete(id); };

  g.setTimeout = (cb, delay = 0, ...args) => {
    const id = timerSeq++;
    timers.set(id, { time: virtualNow + Math.max(0, delay), cb, args, interval: null });
    return id;
  };
  g.clearTimeout = (id) => { timers.delete(id); };
  g.setInterval = (cb, delay = 0, ...args) => {
    const id = timerSeq++;
    const period = Math.max(1, delay);
    timers.set(id, { time: virtualNow + period, cb, args, interval: period });
    return id;
  };
  g.clearInterval = (id) => { timers.delete(id); };

  function fireDueTimers(target) {
    // 仅触发 drain 开始时已存在的定时器；回调中新建的留到下一帧（防 0 延迟自链死循环）。
    const eligible = new Set(timers.keys());
    while (true) {
      let pick = null;
      // 取最早到期者；同一 time 用严格 < 比较，故按 Map 插入顺序（先注册先触发）。
      for (const [id, t] of timers) {
        if (eligible.has(id) && t.time <= target && (pick === null || t.time < pick.t.time)) pick = { id, t };
      }
      if (!pick) break;
      virtualNow = pick.t.time;
      if (pick.t.interval !== null) pick.t.time = virtualNow + pick.t.interval;
      else { timers.delete(pick.id); eligible.delete(pick.id); }
      pick.t.cb(...pick.t.args);
    }
  }

  // 前置条件：ms 单调不减（逐帧步进总是向前）。回退会导致已过定时器再次到期。
  function goToTime(ms) {
    fireDueTimers(ms);
    virtualNow = ms;
    const due = rafQueue;
    rafQueue = new Map();
    for (const cb of due.values()) cb(virtualNow);
    if (g.document && g.document.getAnimations) {
      for (const anim of g.document.getAnimations()) {
        try { anim.currentTime = ms; if (anim.pause) anim.pause(); } catch (_) {}
      }
    }
  }

  g.__timeweb = { goToTime, get currentTime() { return virtualNow; } };
  return g.__timeweb;
}
