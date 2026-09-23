/**
 * 观察脚本行为中立性反例（规范 §2.2：观察不得改变页面行为）。
 *
 * 在 node:vm 沙箱里执行真实 OBSERVER_SCRIPT_SOURCE，用最小假件驱动：
 * - SSE onXXX 赋值后页面回调必须仍被调用（反例：包装只上报不回调）；
 * - 重新赋值不堆叠包装监听器（重复 emit / 旧 handler 复活都是行为改变）；
 * - addEventListener 第三参（once / capture）必须透传；
 * - 构造器包装后 instanceof 原生判断必须成立（prototype 指回原生）；
 * - crypto 结果原样返回。
 */

import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

import { OBSERVER_BINDING_NAME, OBSERVER_SCRIPT_SOURCE } from './observerScript';

interface RegisteredListener {
  type: string;
  listener: (event: unknown) => unknown;
  options: unknown;
  capture: boolean;
}

/** WHATWG：capture 来自第三参 true 或 options.capture === true，是监听器身份的一部分。 */
function normalizeCapture(options: unknown): boolean {
  if (options === true) return true;
  if (options && typeof options === 'object' && (options as { capture?: unknown }).capture === true) {
    return true;
  }
  return false;
}

class FakeEventSource {
  url: string;
  // 观察脚本会在实例上重定义这些属性（defineProperty），类型上先声明
  onmessage: ((event: { data?: string }) => unknown) | null = null;
  onopen: ((event: unknown) => unknown) | null = null;
  onerror: ((event: unknown) => unknown) | null = null;
  private listeners: RegisteredListener[] = [];

  constructor(url: string) {
    this.url = String(url);
  }

  addEventListener(type: string, listener: (event: unknown) => unknown, options?: unknown): void {
    this.listeners.push({ type, listener, options, capture: normalizeCapture(options) });
  }

  removeEventListener(type: string, listener: (event: unknown) => unknown, options?: unknown): void {
    const capture = normalizeCapture(options);
    this.listeners = this.listeners.filter(
      registered =>
        !(registered.type === type && registered.listener === listener && registered.capture === capture),
    );
  }

  /** 原生事件派发：直接驱动已注册监听器（不经过页面可见属性）。 */
  dispatch(type: string, event: Record<string, unknown>): void {
    for (const registered of [...this.listeners]) {
      if (registered.type === type) registered.listener(event);
    }
  }

  registeredOptions(type: string): unknown[] {
    return this.listeners.filter(registered => registered.type === type).map(row => row.options);
  }

  close(): void {}
}

/**
 * 实现 once 消费与 capture 移除语义的 EventSource 假件（WHATWG）：
 * options.once 触发一次后从列表移除；重复注册按 (type, callback, capture) 去重；
 * 移除按 capture 匹配，capture 不匹配是 no-op；已中止的 AbortSignal 注册直接不生效。
 */
class OnceAwareEventSource {
  url: string;
  onmessage: ((event: { data?: string }) => unknown) | null = null;
  onopen: ((event: unknown) => unknown) | null = null;
  onerror: ((event: unknown) => unknown) | null = null;
  private listeners: RegisteredListener[] = [];

  constructor(url: string) {
    this.url = String(url);
  }

  addEventListener(type: string, listener: (event: unknown) => unknown, options?: unknown): void {
    const capture = normalizeCapture(options);
    if (options && typeof options === 'object') {
      const signal = (options as { signal?: { aborted?: boolean } }).signal;
      if (signal && signal.aborted) return;
    }
    const duplicate = this.listeners.some(
      registered =>
        registered.type === type &&
        registered.listener === listener &&
        registered.capture === capture,
    );
    if (duplicate) return;
    this.listeners.push({ type, listener, options, capture });
  }

  removeEventListener(
    type: string,
    listener: (event: unknown) => unknown,
    options?: unknown,
  ): void {
    const capture = normalizeCapture(options);
    this.listeners = this.listeners.filter(
      registered =>
        !(registered.type === type && registered.listener === listener && registered.capture === capture),
    );
  }

  dispatch(type: string, event: Record<string, unknown>): void {
    for (const registered of [...this.listeners]) {
      if (registered.type !== type) continue;
      const once =
        registered.options === true ||
        (registered.options &&
          typeof registered.options === 'object' &&
          (registered.options as { once?: unknown }).once === true);
      if (once) {
        this.listeners = this.listeners.filter(row => row !== registered);
      }
      registered.listener(event);
    }
  }

  registeredOptions(type: string): unknown[] {
    return this.listeners.filter(registered => registered.type === type).map(row => row.options);
  }

  close(): void {}
}

/**
 * 实现 WHATWG 事件监听器去重语义的 EventSource 假件：
 * 相同 (type, callback, capture) 的重复 addEventListener 是 no-op；
 * removeEventListener 按 (type, callback, capture) 匹配。
 */
class DedupEventSource {
  url: string;
  onmessage: ((event: { data?: string }) => unknown) | null = null;
  onopen: ((event: unknown) => unknown) | null = null;
  onerror: ((event: unknown) => unknown) | null = null;
  private listeners: RegisteredListener[] = [];

  constructor(url: string) {
    this.url = String(url);
  }

  addEventListener(type: string, listener: (event: unknown) => unknown, options?: unknown): void {
    const capture = normalizeCapture(options);
    const duplicate = this.listeners.some(
      registered =>
        registered.type === type &&
        registered.listener === listener &&
        registered.capture === capture,
    );
    if (duplicate) return;
    this.listeners.push({ type, listener, options, capture });
  }

  removeEventListener(
    type: string,
    listener: (event: unknown) => unknown,
    options?: unknown,
  ): void {
    const capture = normalizeCapture(options);
    this.listeners = this.listeners.filter(
      registered =>
        !(registered.type === type && registered.listener === listener && registered.capture === capture),
    );
  }

  dispatch(type: string, event: Record<string, unknown>): void {
    for (const registered of [...this.listeners]) {
      if (registered.type === type) registered.listener(event);
    }
  }

  registeredOptions(type: string): unknown[] {
    return this.listeners.filter(registered => registered.type === type).map(row => row.options);
  }

  close(): void {}
}

class FakeRTCPeerConnection {
  constructor(_configuration?: unknown) {}

  setLocalDescription(): Promise<void> {
    return Promise.resolve();
  }
  setRemoteDescription(): Promise<void> {
    return Promise.resolve();
  }
  addIceCandidate(): Promise<void> {
    return Promise.resolve();
  }
  getStats(): Promise<unknown> {
    return Promise.resolve({});
  }
  createDataChannel(): unknown {
    return {};
  }
  close(): void {}
}

class FakeWebTransport {
  closed: Promise<void> = Promise.resolve();

  constructor(_url?: string) {}

  close(): void {}
}

interface EventSourceLike {
  addEventListener(type: string, listener: (event: unknown) => unknown, options?: unknown): void;
  removeEventListener(
    type: string,
    listener: (event: unknown) => unknown,
    options?: unknown,
  ): void;
  dispatch(type: string, event: Record<string, unknown>): void;
  registeredOptions(type: string): unknown[];
}

type EventSourceClass = new (url: string) => EventSourceLike;

function installObserver(
  eventSourceClass: EventSourceClass = FakeEventSource,
  cryptoSubtle?: object,
) {
  const reports: Array<Record<string, unknown>> = [];
  const sandbox: Record<string, unknown> = {
    btoa: (text: string) => Buffer.from(text, 'binary').toString('base64'),
    unescape,
    location: { href: 'https://bmc.test/console' },
    document: { addEventListener(): void {} },
    crypto: cryptoSubtle
      ? { subtle: cryptoSubtle }
      : {
          subtle: {
            async digest(): Promise<string> {
              return 'digest-result';
            },
          },
        },
    RTCPeerConnection: FakeRTCPeerConnection,
    WebTransport: FakeWebTransport,
    EventSource: eventSourceClass,
    [OBSERVER_BINDING_NAME]: (payload: string) => {
      reports.push(JSON.parse(payload) as Record<string, unknown>);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(OBSERVER_SCRIPT_SOURCE, sandbox);
  return { sandbox, reports };
}

/**
 * render-surface 钩子沙箱假件：document.createElement /
 * HTMLCanvasElement.prototype.getContext / Worker / SharedWorker /
 * requestAnimationFrame 均为最小假件，验证包装中立性与上报。
 * 假件类每次调用新建（prototype 独立）：观察脚本会 defineProperty 到
 * Host prototype 上，跨测试共享类会把上一个沙箱的包装闭包漏进来。
 */
function installRenderSurfaceObserver() {
  const reports: Array<Record<string, unknown>> = [];
  class FakeHTMLCanvasElement {
    private reportedContexts = new Set<string>();
    getContext(contextId: string): unknown {
      // 模拟 DOM：同一 canvas 上再取相同 context 的典型结果是 null
      if (this.reportedContexts.has(contextId)) return null;
      this.reportedContexts.add(contextId);
      return { contextId };
    }
  }
  class FakeVideoElement {
    tagName = 'VIDEO';
  }
  class FakeDivElement {
    tagName = 'DIV';
  }
  class FakeWorker {
    constructor(public scriptUrl: string) {}
    postMessage(): void {}
  }
  class FakeSharedWorker {
    port = {};
    constructor(public scriptUrl: string) {}
  }
  let rafHandle = 0;
  const sandbox: Record<string, unknown> = {
    btoa: (text: string) => Buffer.from(text, 'binary').toString('base64'),
    unescape,
    location: { href: 'https://bmc.test/viewer' },
    document: {
      addEventListener(): void {},
      createElement(tagName: string) {
        const tag = String(tagName).toLowerCase();
        if (tag === 'canvas') return new FakeHTMLCanvasElement();
        if (tag === 'video') return new FakeVideoElement();
        return new FakeDivElement();
      },
    },
    HTMLCanvasElement: FakeHTMLCanvasElement,
    Worker: FakeWorker,
    SharedWorker: FakeSharedWorker,
    crypto: { subtle: {} },
    requestAnimationFrame(callback: (timestamp: number) => unknown): number {
      rafHandle += 1;
      // 同步触发回调（vm 沙箱内无法 await 宿主微任务队列，假件直接调用）
      callback(16.7);
      return rafHandle;
    },
    [OBSERVER_BINDING_NAME]: (payload: string) => {
      reports.push(JSON.parse(payload) as Record<string, unknown>);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(OBSERVER_SCRIPT_SOURCE, sandbox);
  return { sandbox, reports, FakeWorker, FakeSharedWorker };
}

describe('观察脚本行为中立性（真实脚本在 vm 沙箱执行）', () => {
  it('SSE onmessage 赋值后页面回调仍被调用，且证据照常上报', () => {
    const { sandbox } = installObserver();
    const EventSource = sandbox.EventSource as typeof FakeEventSource;
    const source = new EventSource('https://bmc.test/events');
    const received: Array<string | undefined> = [];
    source.onmessage = event => {
      received.push((event as { data?: string }).data);
    };
    source.dispatch('message', { data: 'kvm-event-1', lastEventId: '7' });
    expect(received).toEqual(['kvm-event-1']);
  });

  it('SSE onmessage 重新赋值不堆叠：旧 handler 不复活、每事件只上报一次', () => {
    const { sandbox, reports } = installObserver();
    const EventSource = sandbox.EventSource as typeof FakeEventSource;
    const source = new EventSource('https://bmc.test/events');
    const stale: Array<string | undefined> = [];
    const fresh: Array<string | undefined> = [];
    source.onmessage = event => {
      stale.push((event as { data?: string }).data);
    };
    source.onmessage = event => {
      fresh.push((event as { data?: string }).data);
    };
    source.dispatch('message', { data: 'once', lastEventId: '1' });
    expect(stale).toEqual([]);
    expect(fresh).toEqual(['once']);
    const sseReports = reports.filter(report => report.kind === 'sse');
    expect(sseReports).toHaveLength(1);
  });

  it('SSE addEventListener 第三参（once 等）原样透传给原生', () => {
    const { sandbox } = installObserver();
    const EventSource = sandbox.EventSource as typeof FakeEventSource;
    const source = new EventSource('https://bmc.test/events');
    const received: string[] = [];
    source.addEventListener(
      'message',
      event => {
        received.push((event as { data?: string }).data ?? '');
      },
      { once: true },
    );
    expect(source.registeredOptions('message')).toEqual([{ once: true }]);
    source.dispatch('message', { data: 'opts-kept' });
    expect(received).toEqual(['opts-kept']);
  });

  it('构造器包装后 instanceof 原生判断仍成立（RTC / WebTransport / EventSource）', () => {
    const { sandbox } = installObserver();
    const pc = new (sandbox.RTCPeerConnection as typeof FakeRTCPeerConnection)({ iceServers: [] });
    expect(pc instanceof (sandbox.RTCPeerConnection as typeof FakeRTCPeerConnection)).toBe(true);
    expect(pc instanceof FakeRTCPeerConnection).toBe(true);
    const transport = new (sandbox.WebTransport as typeof FakeWebTransport)('https://bmc.test/wt');
    expect(transport instanceof (sandbox.WebTransport as typeof FakeWebTransport)).toBe(true);
    const eventSource = new (sandbox.EventSource as typeof FakeEventSource)('https://bmc.test/sse');
    expect(eventSource instanceof (sandbox.EventSource as typeof FakeEventSource)).toBe(true);
  });

  it('SSE addEventListener 后 removeEventListener(原始 listener) 必须移除包装', () => {
    // 反例：包装层把包装函数注册到原生，页面按原始 listener 移除时
    // 匹配不到 → 移除静默失败，页面监听器继续被触发。
    const { sandbox } = installObserver();
    const EventSource = sandbox.EventSource as typeof FakeEventSource;
    const source = new EventSource('https://bmc.test/events');
    const received: string[] = [];
    const listener = (event: unknown) => {
      received.push((event as { data?: string }).data ?? '');
    };
    source.addEventListener('message', listener);
    source.removeEventListener('message', listener);
    source.dispatch('message', { data: 'after-remove' });
    expect(received).toEqual([]);
  });

  it('SSE addEventListener 相同 (type, listener, capture) 重复注册按 WHATWG 是 no-op', () => {
    // 反例（DedupEventSource 假件实现原生 DOM 去重语义）：
    // 每次注册都生成新闭包 → 两个不同闭包在原生看来是两个监听器 →
    // 同一事件页面 listener 被调用两次、证据重复上报（中立红线违规）。
    const { sandbox, reports } = installObserver(DedupEventSource);
    const EventSource = sandbox.EventSource as typeof FakeEventSource;
    const source = new EventSource('https://bmc.test/events');
    const received: string[] = [];
    const listener = (event: unknown) => {
      received.push((event as { data?: string }).data ?? '');
    };
    source.addEventListener('message', listener);
    source.addEventListener('message', listener);
    expect(source.registeredOptions('message')).toHaveLength(1);
    source.dispatch('message', { data: 'once-only', lastEventId: '1' });
    expect(received).toEqual(['once-only']);
    const sseReports = reports.filter(report => report.kind === 'sse');
    expect(sseReports).toHaveLength(1);
  });

  it('SSE 同 listener 不同 capture 各自注册且都可通过 removeEventListener 移除', () => {
    // 反例：映射表只按 type 存一条，第二个注册覆盖第一个 →
    // 第一个包装再也移除不掉（移除路径找不到映射，静默失败）。
    const { sandbox } = installObserver(DedupEventSource);
    const EventSource = sandbox.EventSource as typeof FakeEventSource;
    const source = new EventSource('https://bmc.test/events');
    const listener = (event: unknown) => {};
    source.addEventListener('message', listener);
    source.addEventListener('message', listener, true);
    expect(source.registeredOptions('message')).toHaveLength(2);
    source.removeEventListener('message', listener);
    expect(source.registeredOptions('message')).toHaveLength(1);
    source.removeEventListener('message', listener, true);
    expect(source.registeredOptions('message')).toHaveLength(0);
  });

  it('SSE once 监听器触发后再注册同 listener 必须重新生效', () => {
    // 反例（OnceAwareEventSource 假件实现 once 消费语义）：
    // once 包装被原生触发后已从原生列表移除，但登记表条目滞留；
    // 再注册同 (type, listener, capture) 命中查重直接 return →
    // 原生注册数为 0，页面回调不再触发（断线重连后重挂具名监听的页面可命中）。
    const { sandbox } = installObserver(OnceAwareEventSource);
    const EventSource = sandbox.EventSource as typeof FakeEventSource;
    const source = new EventSource('https://bmc.test/events');
    const received: string[] = [];
    const listener = (event: unknown) => {
      received.push((event as { data?: string }).data ?? '');
    };
    source.addEventListener('message', listener, { once: true });
    source.dispatch('message', { data: 'first', lastEventId: '1' });
    expect(received).toEqual(['first']);
    source.addEventListener('message', listener);
    expect(source.registeredOptions('message')).toHaveLength(1);
    source.dispatch('message', { data: 'second', lastEventId: '2' });
    expect(received).toEqual(['first', 'second']);
  });

  it('SSE onmessage 处理器用 capture:true 移除是 no-op，处理器继续触发', () => {
    // 反例（WHATWG：onXXX 处理器按 capture=false 注册，capture 不匹配的移除是 no-op）：
    // 包装层在包装条目未命中后直接清空 onXXX 状态 → 页面处理器被误移除。
    const { sandbox } = installObserver(OnceAwareEventSource);
    const EventSource = sandbox.EventSource as typeof FakeEventSource;
    const source = new EventSource('https://bmc.test/events');
    const received: string[] = [];
    const listener = (event: unknown) => {
      received.push((event as { data?: string }).data ?? '');
    };
    source.onmessage = listener;
    source.removeEventListener('message', listener, true);
    source.dispatch('message', { data: 'still-there', lastEventId: '1' });
    expect(received).toEqual(['still-there']);
  });

  it('SSE onmessage 赋值后 removeEventListener(该 listener) 也能移除（WHATWG 语义）', () => {
    // 反例：onXXX 装的是内部包装，页面 removeEventListener('message', f)
    // 传原始 f，原生里没有注册 → 移除静默失败。
    const { sandbox } = installObserver();
    const EventSource = sandbox.EventSource as typeof FakeEventSource;
    const source = new EventSource('https://bmc.test/events');
    const received: string[] = [];
    const listener = (event: unknown) => {
      received.push((event as { data?: string }).data ?? '');
    };
    source.onmessage = listener;
    source.removeEventListener('message', listener);
    source.dispatch('message', { data: 'after-remove' });
    expect(received).toEqual([]);
  });

  it('SSE onXXX 不成为实例自有可枚举属性（原生在原型上）', () => {
    // 反例：defineProperty enumerable:true 使 onmessage 出现在 Object.keys。
    const { sandbox } = installObserver();
    const EventSource = sandbox.EventSource as typeof FakeEventSource;
    const source = new EventSource('https://bmc.test/events');
    source.onmessage = () => {};
    const keys = Object.keys(source);
    expect(keys).not.toContain('onmessage');
    expect(keys).not.toContain('onopen');
    expect(keys).not.toContain('onerror');
  });

  it('SSE onmessage 非函数赋值按 null 处理（WebIDL 语义）', () => {
    // 反例：非 callable 赋值后 getter 返回原值；且旧包装未被移除。
    const { sandbox } = installObserver();
    const EventSource = sandbox.EventSource as typeof FakeEventSource;
    const source = new EventSource('https://bmc.test/events');
    const received: string[] = [];
    source.onmessage = (event: { data?: string }) => {
      received.push(event.data ?? '');
    };
    (source as unknown as { onmessage: unknown }).onmessage = 'not-a-function';
    expect((source as unknown as { onmessage: unknown }).onmessage).toBeNull();
    source.dispatch('message', { data: 'must-not-fire' });
    expect(received).toEqual([]);
  });

  it('构造器无 new 调用按原生语义抛 TypeError（EventSource / RTC / WebTransport）', () => {
    // 反例：包装函数是普通 function，无 new 调用不抛错还静默构造。
    // 注：沙箱 realm 的 TypeError 不是宿主 TypeError 实例，按消息断言。
    const { sandbox } = installObserver();
    expect(() => {
      (sandbox.EventSource as unknown as (url: string) => unknown)('https://bmc.test/sse');
    }).toThrow("Constructor EventSource requires 'new'");
    expect(() => {
      (sandbox.RTCPeerConnection as unknown as () => unknown)();
    }).toThrow("Constructor RTCPeerConnection requires 'new'");
    expect(() => {
      (sandbox.WebTransport as unknown as (url: string) => unknown)('https://bmc.test/wt');
    }).toThrow("Constructor WebTransport requires 'new'");
  });

  it('已知边界：extends 包装构造器的子类拿到原生实例，子类原型方法不可用', () => {
    // 已知边界（显式文档化，不修复）：构造器包装返回原生实例（prototype 指回
    // 原生），class X extends EventSource 的 super() 之后拿到的不是子类实例。
    // 修复需 Proxy 级构造器方案；BMC 页面极少子类化这些接口（见脚本内注释）。
    const { sandbox } = installObserver();
    const WrappedEventSource = sandbox.EventSource as new (url: string) => FakeEventSource;
    class MyEventSource extends WrappedEventSource {
      customMethod(): string {
        return 'subclass';
      }
    }
    const instance = new MyEventSource('https://bmc.test/sse');
    expect(instance instanceof FakeEventSource).toBe(true);
    expect(instance instanceof MyEventSource).toBe(false);
    expect((instance as unknown as MyEventSource).customMethod).toBeUndefined();
  });

  it('crypto 包装结果原样返回，证据照常上报', async () => {
    const { sandbox, reports } = installObserver();
    const subtle = (sandbox.crypto as {
      subtle: { digest(algorithm: string, data: Uint8Array): Promise<string> };
    }).subtle;
    const result = await subtle.digest('SHA-256', new Uint8Array([1, 2, 3]));
    expect(result).toBe('digest-result');
    const cryptoReports = reports.filter(report => report.kind === 'crypto');
    expect(cryptoReports).toHaveLength(1);
    expect(cryptoReports[0]).toMatchObject({ op: 'digest', algorithm: 'SHA-256' });
  });

  it('反例：crypto.subtle 不可包装时钩子失败必须显式上报，不得静默', async () => {
    // 冻结的 subtle：defineProperty 抛错 → 包装安装静默跳过 → digest 调用
    // 零 crypto 行。缺失必须显式（规范 §3）：至少要有一条钩子失败记账行。
    const frozenSubtle = Object.freeze({
      async digest(): Promise<string> {
        return 'digest-result';
      },
    });
    const { sandbox, reports } = installObserver(undefined, frozenSubtle);
    const subtle = (sandbox.crypto as {
      subtle: { digest(algorithm: string, data: Uint8Array): Promise<string> };
    }).subtle;
    const result = await subtle.digest('SHA-256', new Uint8Array([1, 2, 3]));
    expect(result).toBe('digest-result');
    const cryptoRows = reports.filter(report => report.kind === 'crypto');
    const hookFailures = reports.filter(report => report.kind === 'observer-hook-failed');
    expect(cryptoRows.length + hookFailures.length).toBeGreaterThanOrEqual(1);
    expect(hookFailures[0]).toMatchObject({ hook: 'crypto' });
  });

  it('SSE delete source.onmessage 是 no-op（non-configurable 对齐原型访问器语义）', () => {
    // 原生 onXXX 在原型上是访问器、页面实例无自有属性，delete 恒为 no-op。
    // 包装层自有访问器 configurable:false：sloppy 删除同样 no-op，处理器状态不丢。
    const { sandbox } = installObserver();
    const EventSource = sandbox.EventSource as typeof FakeEventSource;
    const source = new EventSource('https://bmc.test/events');
    const received: string[] = [];
    source.onmessage = (event: unknown) => {
      received.push((event as { data?: string }).data ?? '');
    };
    // new Function 体为 sloppy 模式，等价经典页面脚本里的 delete
    const sloppyDelete = new Function('obj', 'return delete obj.onmessage') as (obj: unknown) => boolean;
    const deleted = sloppyDelete(source);
    expect(deleted).toBe(false);
    expect(typeof source.onmessage).toBe('function');
    source.dispatch('message', { data: 'after-delete' });
    expect(received).toEqual(['after-delete']);
  });

  it('已知边界：onXXX + addEventListener 同 listener 单次移除的中间态与原生相反，终态一致', () => {
    // 边界：onmessage = f 与 addEventListener("message", f) 双通道注册同一
    // listener 时，包装层保留两条原生注册（onXXX 安装包装 + 条目包装）；
    // 原生按 (type, callback, capture) 身份去重为一条。单次 removeEventListener
    // 先移除 addEventListener 条目（原生先移除 onXXX 条目）——中间态相反；
    // 两次移除后全清，终态与原生一致。
    const { sandbox } = installObserver(DedupEventSource);
    const EventSource = sandbox.EventSource as typeof FakeEventSource;
    const source = new EventSource('https://bmc.test/events');
    const received: string[] = [];
    const listener = (event: unknown) => {
      received.push((event as { data?: string }).data ?? '');
    };
    source.onmessage = listener;
    source.addEventListener('message', listener);
    source.removeEventListener('message', listener);
    source.dispatch('message', { data: 'after-first-remove' });
    // 中间态：仍有一条注册存活，处理器仍触发
    expect(received).toEqual(['after-first-remove']);
    source.removeEventListener('message', listener);
    source.dispatch('message', { data: 'after-second-remove' });
    // 终态：全清，与原生一致
    expect(received).toEqual(['after-first-remove']);
  });

  it('RTC close 重复调用只上报一次 closed', () => {
    const { sandbox, reports } = installObserver();
    const pc = new (sandbox.RTCPeerConnection as typeof FakeRTCPeerConnection)({});
    pc.close();
    pc.close();
    const closedReports = reports.filter(
      report =>
        report.kind === 'webrtc' &&
        (report.detail as { closed?: boolean } | undefined)?.closed === true,
    );
    expect(closedReports).toHaveLength(1);
  });

  it('反例：DataChannel 监听安装失败必须显式上报钩子失败，不得静默', () => {
    // 恶意 dc：createDataChannel 返回无 addEventListener 的对象 →
    // 监听安装抛错被 catch 吞掉 → datachannel 证据面整体缺失零记账。
    // 缺失必须显式（规范 §3）：至少要有一条 webrtc-datachannel 钩子失败行。
    const { sandbox, reports } = installObserver();
    const pc = new (sandbox.RTCPeerConnection as typeof FakeRTCPeerConnection)({});
    const dc = pc.createDataChannel();
    expect(dc).toEqual({});
    const hookFailures = reports.filter(report => report.kind === 'observer-hook-failed');
    expect(hookFailures.length).toBeGreaterThanOrEqual(1);
    expect(hookFailures[0]).toMatchObject({ hook: 'webrtc-datachannel', stage: 'install' });
  });

  it('SSE close 重复调用只上报一次 closed', () => {
    const { sandbox, reports } = installObserver();
    const EventSource = sandbox.EventSource as typeof FakeEventSource;
    const source = new EventSource('https://bmc.test/events');
    source.close();
    source.close();
    const closedReports = reports.filter(
      report => report.kind === 'sse' && report.eventKind === 'closed',
    );
    expect(closedReports).toHaveLength(1);
  });

  it('render-surface：new Worker 原生实例保真（instanceof）+ 构造事实上报', () => {
    const { sandbox, reports, FakeWorker } = installRenderSurfaceObserver();
    const Worker = sandbox.Worker as typeof FakeWorker;
    const worker = new Worker('http://bmc.test/viewer-worker.js');
    expect(worker instanceof Worker).toBe(true);
    expect(worker.scriptUrl).toBe('http://bmc.test/viewer-worker.js');
    const surfaceReports = reports.filter(report => report.kind === 'render-surface');
    expect(surfaceReports).toHaveLength(1);
    expect(surfaceReports[0]).toMatchObject({
      surface: 'worker',
      detail: 'http://bmc.test/viewer-worker.js',
    });
  });

  it('render-surface：Worker 无 new 调用按原生语义抛 TypeError', () => {
    const { sandbox } = installRenderSurfaceObserver();
    expect(() => {
      (sandbox.Worker as unknown as (url: string) => unknown)('http://bmc.test/w.js');
    }).toThrow("Constructor Worker requires 'new'");
  });

  it('render-surface：createElement canvas/video 上报，其他标签不上报且元素原样返回', () => {
    const { sandbox, reports } = installRenderSurfaceObserver();
    const document = sandbox.document as {
      createElement(tagName: string): { tagName?: string };
    };
    const canvas = document.createElement('canvas');
    expect(canvas).toBeInstanceOf(Object);
    const video = document.createElement('video');
    expect((video as { tagName: string }).tagName).toBe('VIDEO');
    const div = document.createElement('div');
    expect((div as { tagName: string }).tagName).toBe('DIV');
    const surfaces = reports
      .filter(report => report.kind === 'render-surface')
      .map(report => report.surface);
    expect(surfaces).toEqual(['canvas', 'video']);
  });

  it('render-surface：getContext 取到 context 上报一次；同元素重复调用不刷行；取 null 不算新建表面', () => {
    const { sandbox, reports } = installRenderSurfaceObserver();
    const document = sandbox.document as { createElement(tagName: string): { getContext(contextId: string): unknown } };
    const canvas = document.createElement('canvas');
    expect(canvas.getContext('2d')).toBeTypeOf('object');
    // 同一元素第二次 getContext（假件返回 null）：不重复上报
    expect(canvas.getContext('2d')).toBeNull();
    const contextReports = reports.filter(
      report => report.kind === 'render-surface' && report.surface === 'canvas-context',
    );
    expect(contextReports).toHaveLength(1);
    expect(contextReports[0]).toMatchObject({ detail: '2d' });
    // 另一个元素再取 context → 各自上报
    const second = document.createElement('canvas');
    expect(second.getContext('webgl')).toBeTypeOf('object');
    const afterSecond = reports.filter(
      report => report.kind === 'render-surface' && report.surface === 'canvas-context',
    );
    expect(afterSecond).toHaveLength(2);
    expect(afterSecond[1]).toMatchObject({ detail: 'webgl' });
  });

  it('render-surface：rAF 回调原样触发（时间戳透传）且稀疏上报（第 1、30 次，其后每 600 次）', () => {
    const { sandbox, reports } = installRenderSurfaceObserver();
    const raf = sandbox.requestAnimationFrame as (callback: (timestamp: number) => unknown) => number;
    const received: number[] = [];
    const handle = raf(timestamp => {
      received.push(timestamp);
    });
    expect(handle).toBeTypeOf('number');
    expect(received).toEqual([16.7]);
    const surface = reports.filter(report => report.kind === 'render-surface');
    expect(surface).toHaveLength(1);
    expect(surface[0]).toMatchObject({ surface: 'request-animation-frame', detail: '1' });

    // 连续驱动 40 次回调：第 2..29 次不上报，第 30 次上报
    for (let i = 0; i < 40; i += 1) {
      raf(() => {});
    }
    const rafReports = reports
      .filter(report => report.kind === 'render-surface' && report.surface === 'request-animation-frame')
      .map(report => report.detail);
    expect(rafReports).toEqual(['1', '30']);
  });

  it('render-surface：new SharedWorker 上报 shared-worker + 脚本 URL', () => {
    const { sandbox, reports, FakeSharedWorker } = installRenderSurfaceObserver();
    const SharedWorker = sandbox.SharedWorker as typeof FakeSharedWorker;
    const shared = new SharedWorker('http://bmc.test/shared-worker.js');
    expect(shared instanceof SharedWorker).toBe(true);
    expect(shared.port).toBeTypeOf('object');
    const surfaces = reports.filter(report => report.kind === 'render-surface');
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]).toMatchObject({
      surface: 'shared-worker',
      detail: 'http://bmc.test/shared-worker.js',
    });
  });
});
