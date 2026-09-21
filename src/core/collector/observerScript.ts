/**
 * 页面世界观察脚本（规范 §7.2 / §8.4 / §8.5 / §8.6）。
 * 单一 binding 上报，payload 以 `kind` 字段路由：
 *   crypto（WebCrypto 调用）/ action（点击·表单提交）/ webrtc / webtransport / sse
 *   / observer-hook-failed（钩子安装失败记账：缺失必须显式，安装 catch 不静默）。
 * 必须在导航前用 Page.addScriptToEvaluateOnNewDocument 注入，Worker 会话
 * 用 Runtime.evaluate 注入；全程 try/catch，只观察不改值：
 * - 包装方法一律调用原实现并把结果原样返回页面；
 * - 不消费任何流（WebTransport 入站流读走即改变页面行为，故只观察生命周期）；
 * - 不监听键盘输入（规范 §7.2）。
 */

export const OBSERVER_BINDING_NAME = '__kvmReconObserver';

/** binding payload 顶层的 kind 路由值（与 attach 层路由一致）。 */
export type ObserverPayloadKind =
  | 'crypto'
  | 'action'
  | 'webrtc'
  | 'webtransport'
  | 'sse'
  | 'observer-hook-failed';

export const OBSERVER_SCRIPT_SOURCE = `(function () {
  var bindingName = ${JSON.stringify(OBSERVER_BINDING_NAME)};
  var root = globalThis;
  if (root.__kvmReconObserverInstalled) return;
  try {
    Object.defineProperty(root, '__kvmReconObserverInstalled', { value: true, enumerable: false });
  } catch (_error) { return; }

  function report(payload) {
    try {
      var fn = root[bindingName];
      if (typeof fn === 'function') fn(JSON.stringify(payload));
    } catch (_error) {}
  }

  // 钩子安装失败记账：观察面缺失必须显式（规范 §3），安装 catch 不得静默。
  // report() 通道自身失败时无法经 binding 自举上报，是文档化不可上报边界。
  function reportHookFailure(hook, stage, error) {
    report({
      kind: 'observer-hook-failed',
      hook: hook,
      stage: stage,
      detail: String(error && error.message ? error.message : error)
    });
  }

  // ---------- 正文编码 ----------

  function bytesToB64(value) {
    if (value == null) return null;
    try {
      if (typeof value === 'string') return btoa(unescape(encodeURIComponent(value)));
      var bytes;
      if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
      else if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) {
        bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      } else {
        return null;
      }
      var bin = '';
      for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    } catch (_error) {
      return null;
    }
  }

  function blobToB64(blob, done) {
    try {
      blob.arrayBuffer().then(function (buffer) {
        done(bytesToB64(buffer));
      }, function () { done(null); });
    } catch (_error) {
      done(null);
    }
  }

  // ---------- crypto（规范 §8.6） ----------

  function installCryptoHook() {
    var subtle = root.crypto && root.crypto.subtle;
    if (!subtle || subtle.__kvmReconHooked) return;
    try {
      Object.defineProperty(subtle, '__kvmReconHooked', { value: true, enumerable: false });
    } catch (_error) {
      reportHookFailure('crypto', 'install', _error);
      return;
    }

    function algorithmName(algorithm) {
      if (typeof algorithm === 'string') return algorithm;
      if (algorithm && typeof algorithm.name === 'string') return algorithm.name;
      return 'unknown';
    }

    function algorithmParams(algorithm) {
      if (!algorithm || typeof algorithm === 'string') return {};
      try { return JSON.parse(JSON.stringify(algorithm)); }
      catch (_error) { return { name: algorithmName(algorithm) }; }
    }

    function callerSite() {
      try {
        var stack = new Error().stack || '';
        return (stack.split('\\n')[3] || stack.split('\\n')[2] || '').trim();
      } catch (_error) {
        return '';
      }
    }

    function wrap(methodName, op, inputIndex, outputIsKey) {
      var original = subtle[methodName];
      if (typeof original !== 'function') return;
      try {
        Object.defineProperty(subtle, methodName, {
          value: function () {
            var args = Array.prototype.slice.call(arguments);
            var site = callerSite();
            var algorithm = args[0];
            var input = args[inputIndex];
            return original.apply(subtle, args).then(function (result) {
              report({
                kind: 'crypto',
                op: op,
                algorithm: algorithmName(algorithm),
                algorithmParams: algorithmParams(algorithm),
                inputB64: bytesToB64(input),
                outputB64: outputIsKey ? null : bytesToB64(result),
                outputMeta:
                  outputIsKey && result && result.algorithm
                    ? { type: result.type, algorithm: result.algorithm }
                    : null,
                scriptUrl: site
              });
              return result;
            }, function (error) {
              report({
                kind: 'crypto',
                op: op,
                algorithm: algorithmName(algorithm),
                algorithmParams: algorithmParams(algorithm),
                inputB64: bytesToB64(input),
                error: String(error && error.message ? error.message : error),
                scriptUrl: site
              });
              throw error;
            });
          },
          writable: true,
          enumerable: false,
          configurable: true
        });
      } catch (_error) {
        reportHookFailure('crypto', 'wrap:' + methodName, _error);
      }
    }

    wrap('digest', 'digest', 1, false);
    wrap('encrypt', 'encrypt', 2, false);
    wrap('decrypt', 'decrypt', 2, false);
    wrap('sign', 'sign', 2, false);
    wrap('verify', 'verify', 2, false);
    wrap('deriveBits', 'derive-bits', 2, false);
    wrap('exportKey', 'export-key', 1, false);
    wrap('generateKey', 'generate-key', 0, true);
    wrap('importKey', 'import-key', 1, true);
    wrap('deriveKey', 'derive-key', 2, true);
  }

  // ---------- 用户操作（规范 §7.2 / §8.4：无键盘值） ----------

  function elementSummary(el) {
    try {
      if (!el || !el.tagName) return String(el);
      var parts = [String(el.tagName).toLowerCase()];
      if (el.id) parts.push('#' + el.id);
      if (el.name) parts.push('[name=' + el.name + ']');
      var cls = el.getAttribute && el.getAttribute('class');
      if (cls) parts.push('.' + String(cls).split(/\\s+/)[0]);
      var label =
        el.getAttribute &&
        (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title'));
      var text = String(el.textContent || '').replace(/\\s+/g, ' ').trim();
      var summary = parts.join('');
      if (label) summary += ' "' + label + '"';
      if (text) summary += ' text:' + text;
      return summary;
    } catch (_error) {
      return 'element';
    }
  }

  function pageUrl() {
    try { return root.location && root.location.href ? root.location.href : null; }
    catch (_error) { return null; }
  }

  function installActionListeners() {
    var doc = root.document;
    if (!doc || doc.__kvmReconActionHooked) return;
    try {
      Object.defineProperty(doc, '__kvmReconActionHooked', { value: true, enumerable: false });
    } catch (_error) {
      reportHookFailure('action', 'install', _error);
      return;
    }
    try {
      doc.addEventListener('click', function (event) {
        report({
          kind: 'action',
          actionKind: 'click',
          elementSummary: elementSummary(event.target),
          url: pageUrl()
        });
      }, true);
      doc.addEventListener('submit', function (event) {
        report({
          kind: 'action',
          actionKind: 'form-submit',
          elementSummary: elementSummary(event.target),
          url: pageUrl()
        });
      }, true);
    } catch (_error) {
      reportHookFailure('action', 'listeners', _error);
    }
  }

  // ---------- WebRTC（规范 §8.5） ----------

  function installWebRtcHook() {
    var NativePC = root.RTCPeerConnection;
    if (typeof NativePC !== 'function' || NativePC.__kvmReconHooked) return;
    var pcSeq = 0;

    function fingerprintLines(sdp) {
      var out = [];
      try {
        var lines = String(sdp).split('\\n');
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (line.indexOf('a=fingerprint:') === 0) out.push(line);
        }
      } catch (_error) {}
      return out;
    }

    function safeJson(value) {
      try { return JSON.parse(JSON.stringify(value)); }
      catch (_error) { return null; }
    }

    function patchDataChannel(pcId, dc) {
      var dcId = null;
      var messageIndex = 0;
      try { dcId = String(dc.label || dc.id || 'datachannel'); } catch (_error) { dcId = 'datachannel'; }
      function message(direction, data) {
        function emit(b64, byteLength) {
          report({
            kind: 'webrtc',
            pcId: pcId,
            eventKind: 'datachannel-message',
            direction: direction,
            dataChannelId: dcId,
            messageIndex: messageIndex,
            fin: true,
            messageB64: b64,
            messageBytes: byteLength == null ? null : byteLength
          });
          messageIndex += 1;
        }
        var b64 = bytesToB64(data);
        if (b64 != null) {
          emit(b64, data && data.byteLength != null ? data.byteLength : data.length);
        } else if (data && typeof data.arrayBuffer === 'function') {
          blobToB64(data, function (converted) { emit(converted, null); });
        } else {
          emit(null, null);
        }
      }
      try {
        dc.addEventListener('open', function () {
          report({
            kind: 'webrtc',
            pcId: pcId,
            eventKind: 'datachannel-opened',
            dataChannelId: dcId
          });
        }, false);
        dc.addEventListener('close', function () {
          report({
            kind: 'webrtc',
            pcId: pcId,
            eventKind: 'datachannel-closed',
            dataChannelId: dcId
          });
        }, false);
        dc.addEventListener('message', function (event) {
          message('down', event.data);
        }, false);
      } catch (_error) {
        reportHookFailure('webrtc-datachannel', 'install', _error);
      }
      try {
        var nativeSend = dc.send;
        if (typeof nativeSend === 'function') {
          dc.send = function (data) {
            message('up', data);
            return nativeSend.call(dc, data);
          };
        }
      } catch (_error) {
        reportHookFailure('webrtc-datachannel', 'send-wrap', _error);
      }
    }

    try {
      // 已知边界（P3-B，审计第三轮）：构造器包装返回原生实例，
      // 「class X extends RTCPeerConnection/WebTransport/EventSource」的子类
      // 拿到的是原生对象而非子类实例，子类原型方法不可用。
      // 修复需 Proxy 级构造器方案；BMC 页面极少子类化这些接口，本轮显式记为边界不修复。
      // （WebTransport / EventSource 的构造器包装同此边界。）
      var WrappedPC = function RTCPeerConnection() {
        if (!(this instanceof WrappedPC)) {
          // WebIDL：构造器无 new 调用按原生语义抛 TypeError
          throw new TypeError("Constructor RTCPeerConnection requires 'new'");
        }
        var instance = new (Function.prototype.bind.apply(NativePC, [null].concat(
          Array.prototype.slice.call(arguments)
        )))();
        var pcId = 'pc-' + (pcSeq += 1);
          try {
            Object.defineProperty(instance, '__kvmReconPcId', { value: pcId, enumerable: false });
          } catch (_error) {}
          report({
            kind: 'webrtc',
            pcId: pcId,
            eventKind: 'peer-connection-created',
            detail: { configuration: safeJson(arguments[0]) }
          });
          try {
            instance.setLocalDescription = function (description) {
              var result = NativePC.prototype.setLocalDescription.apply(instance, arguments);
              var then = result && typeof result.then === 'function' ? result : Promise.resolve(result);
              then.then(function () {
                report({
                  kind: 'webrtc',
                  pcId: pcId,
                  eventKind: 'offer',
                  detail: { type: description && description.type, sdp: description && description.sdp }
                });
                var fingerprints = fingerprintLines(description && description.sdp);
                for (var i = 0; i < fingerprints.length; i++) {
                  report({
                    kind: 'webrtc',
                    pcId: pcId,
                    eventKind: 'dtls-fingerprint',
                    detail: { fingerprint: fingerprints[i] }
                  });
                }
              }, function () {});
              return result;
            };
            instance.setRemoteDescription = function (description) {
              var result = NativePC.prototype.setRemoteDescription.apply(instance, arguments);
              var then = result && typeof result.then === 'function' ? result : Promise.resolve(result);
              then.then(function () {
                report({
                  kind: 'webrtc',
                  pcId: pcId,
                  eventKind: 'answer',
                  detail: { type: description && description.type, sdp: description && description.sdp }
                });
                var fingerprints = fingerprintLines(description && description.sdp);
                for (var i = 0; i < fingerprints.length; i++) {
                  report({
                    kind: 'webrtc',
                    pcId: pcId,
                    eventKind: 'dtls-fingerprint',
                    detail: { fingerprint: fingerprints[i] }
                  });
                }
              }, function () {});
              return result;
            };
            instance.addIceCandidate = function (candidate) {
              var result = NativePC.prototype.addIceCandidate.apply(instance, arguments);
              var then = result && typeof result.then === 'function' ? result : Promise.resolve(result);
              then.then(function () {
                report({
                  kind: 'webrtc',
                  pcId: pcId,
                  eventKind: 'ice-candidate',
                  detail: { candidate: safeJson(candidate) }
                });
              }, function () {});
              return result;
            };
            instance.getStats = function () {
              var result = NativePC.prototype.getStats.apply(instance, arguments);
              var then = result && typeof result.then === 'function' ? result : Promise.resolve(result);
              then.then(function (statsReport) {
                report({
                  kind: 'webrtc',
                  pcId: pcId,
                  eventKind: 'stats',
                  detail: { stats: safeJson(statsReport) }
                });
              }, function () {});
              return result;
            };
            instance.createDataChannel = function () {
              var dc = NativePC.prototype.createDataChannel.apply(instance, arguments);
              if (dc) patchDataChannel(pcId, dc);
              return dc;
            };
            var closedReported = false;
            var nativeClose = instance.close.bind(instance);
            instance.close = function () {
              var closed = nativeClose();
              if (!closedReported) {
                closedReported = true;
                report({
                  kind: 'webrtc',
                  pcId: pcId,
                  eventKind: 'other',
                  detail: { closed: true }
                });
              }
              return closed;
            };
          } catch (_error) {
            reportHookFailure('webrtc', 'instance-patch', _error);
          }
          return instance;
        };
      // prototype 指回原生：instanceof / 原型方法访问与未包装时一致
      try { WrappedPC.prototype = NativePC.prototype; } catch (_error) {}
      Object.defineProperty(root, 'RTCPeerConnection', {
        value: WrappedPC,
        writable: true,
        enumerable: false,
        configurable: true
      });
    } catch (_error) {
      reportHookFailure('webrtc', 'install', _error);
    }
  }

  // ---------- WebTransport（规范 §8.5：生命周期；payload 不可观测） ----------
  // 入站流 / datagram 读走即消费，tee 会改变页面时序与背压，因此只观察
  // 生命周期与页面主动发起的出站流创建；payload 缺口由主侧显式记账。

  function installWebTransportHook() {
    var NativeWT = root.WebTransport;
    if (typeof NativeWT !== 'function' || NativeWT.__kvmReconHooked) return;
    var wtSeq = 0;
    var streamSeq = 0;

    try {
      var WrappedWT = function WebTransport(url) {
        if (!(this instanceof WrappedWT)) {
          // WebIDL：构造器无 new 调用按原生语义抛 TypeError
          throw new TypeError("Constructor WebTransport requires 'new'");
        }
        var instance = new (Function.prototype.bind.apply(NativeWT, [null].concat(
          Array.prototype.slice.call(arguments)
        )))();
        var wtId = 'wt-' + (wtSeq += 1);
        var closedReported = false;
          try {
            Object.defineProperty(instance, '__kvmReconWtId', { value: wtId, enumerable: false });
          } catch (_error) {}
          report({ kind: 'webtransport', wtId: wtId, eventKind: 'created', url: String(url) });
          try {
            instance.closed.then(function () {
              if (closedReported) return;
              closedReported = true;
              report({ kind: 'webtransport', wtId: wtId, eventKind: 'closed' });
            }, function () {});
          } catch (_error) {
            reportHookFailure('webtransport', 'closed-watch', _error);
          }
          try {
            var nativeClose = instance.close.bind(instance);
            instance.close = function () {
              var result = nativeClose();
              if (!closedReported) {
                closedReported = true;
                report({ kind: 'webtransport', wtId: wtId, eventKind: 'closed' });
              }
              return result;
            };
          } catch (_error) {
            reportHookFailure('webtransport', 'close-patch', _error);
          }
          try {
            var patchStreamFactory = function (methodName) {
              var native = instance[methodName];
              if (typeof native !== 'function') return;
              instance[methodName] = function () {
                var result = native.apply(instance, arguments);
                var then = result && typeof result.then === 'function' ? result : Promise.resolve(result);
                then.then(function () {
                  report({
                    kind: 'webtransport',
                    wtId: wtId,
                    eventKind: 'stream-opened',
                    streamId: 'wts-' + (streamSeq += 1),
                    direction: 'up'
                  });
                }, function () {});
                return result;
              };
            };
            patchStreamFactory('createBidirectionalStream');
            patchStreamFactory('createUnidirectionalStream');
          } catch (_error) {
            reportHookFailure('webtransport', 'stream-factory', _error);
          }
          return instance;
        };
      // prototype 指回原生：instanceof / 原型方法访问与未包装时一致
      try { WrappedWT.prototype = NativeWT.prototype; } catch (_error) {}
      Object.defineProperty(root, 'WebTransport', {
        value: WrappedWT,
        writable: true,
        enumerable: false,
        configurable: true
      });
    } catch (_error) {
      reportHookFailure('webtransport', 'install', _error);
    }
  }

  // ---------- SSE / EventSource（规范 §8.5） ----------

  function installSseHook() {
    var NativeES = root.EventSource;
    if (typeof NativeES !== 'function' || NativeES.__kvmReconHooked) return;
    var sseSeq = 0;

    function emit(source, sseId, eventKind, detail) {
      var row = { kind: 'sse', sseId: sseId, eventKind: eventKind, url: source.url };
      if (detail) {
        row.event = detail.event || undefined;
        row.serverEventId = detail.serverEventId || undefined;
        row.retryMs = detail.retryMs == null ? undefined : detail.retryMs;
        row.dataB64 = detail.dataB64 == null ? undefined : detail.dataB64;
      }
      report(row);
    }

    try {
      var WrappedES = function EventSource() {
        if (!(this instanceof WrappedES)) {
          // WebIDL：构造器无 new 调用按原生语义抛 TypeError
          throw new TypeError("Constructor EventSource requires 'new'");
        }
        var source = new (Function.prototype.bind.apply(NativeES, [null].concat(
          Array.prototype.slice.call(arguments)
        )))();
        var sseId = 'sse-' + (sseSeq += 1);
          try {
            Object.defineProperty(source, '__kvmReconSseId', { value: sseId, enumerable: false });
          } catch (_error) {}
          try {
            source.addEventListener('open', function () {
              emit(source, sseId, 'connected');
            }, false);
            source.addEventListener('error', function (event) {
              emit(source, sseId, 'error');
            }, false);
          } catch (_error) {
            reportHookFailure('sse', 'listeners', _error);
          }
          try {
            var nativeAddEventListener = source.addEventListener.bind(source);
            var nativeRemoveEventListener = source.removeEventListener
              ? source.removeEventListener.bind(source)
              : null;
            // 页面可见监听器身份保真：包装层按「原始 listener → 包装」登记，
            // 页面 removeEventListener(原始 listener) 时移除对应包装，移除不被静默吞掉。
            // 登记表按条目列表存（listener → [{type, capture, wrapper}]）：
            // 同一 listener 可按不同 capture 注册多条，每条都必须可移除
            var wrappersByListener = new Map();
            var propState = {};
            var normalizeCapture = function (third) {
              if (third === true) return true;
              if (third && typeof third === 'object' && third.capture === true) return true;
              return false;
            };
            source.addEventListener = function (type, listener) {
              if (typeof type === 'string' && typeof listener === 'function') {
                // 第三参（once / capture / signal）必须原样透传，否则页面行为被改变
                var extra = Array.prototype.slice.call(arguments, 2);
                // WHATWG：监听器身份是 (type, callback, capture)。同一身份的
                // 条目复用同一个包装对象，重新交给原生：包装仍在原生列表时
                // 原生按回调身份自己去重（no-op）；once 已消费 / signal 已中止
                // 时原生列表里已无该包装，重新注册天然生效——登记表不模拟
                // 原生列表状态。若每次生成新闭包，原生会把两个闭包当两个
                // 监听器，页面回调被调用两次（中立红线违规）
                var capture = normalizeCapture(arguments[2]);
                var entries = wrappersByListener.get(listener);
                if (entries) {
                  for (var i = 0; i < entries.length; i++) {
                    if (entries[i].type === type && entries[i].capture === capture) {
                      nativeAddEventListener.apply(source, [type, entries[i].wrapper].concat(extra));
                      return;
                    }
                  }
                } else {
                  entries = [];
                  wrappersByListener.set(listener, entries);
                }
                var wrapper = function (event) {
                  var data = event && event.data;
                  var b64 = bytesToB64(data);
                  emit(source, sseId, 'event', {
                    event: type === 'message' ? undefined : type,
                    serverEventId: event && event.lastEventId ? event.lastEventId : undefined,
                    dataB64: b64 == null ? (data == null ? null : bytesToB64(String(data))) : b64
                  });
                  return listener.apply(this, arguments);
                };
                entries.push({ type: type, capture: capture, wrapper: wrapper });
                nativeAddEventListener.apply(source, [type, wrapper].concat(extra));
                return;
              }
              return nativeAddEventListener.apply(source, arguments);
            };
            if (nativeRemoveEventListener) {
              source.removeEventListener = function (type, listener) {
                if (typeof type === 'string' && typeof listener === 'function') {
                  var extra = Array.prototype.slice.call(arguments, 2);
                  // WHATWG：移除身份也是 (type, callback, capture)，
                  // capture 不匹配时原生本来就是 no-op，这里同样按 capture 找条目
                  var capture = normalizeCapture(arguments[2]);
                  var entries = wrappersByListener.get(listener);
                  if (entries) {
                    for (var i = 0; i < entries.length; i++) {
                      if (entries[i].type === type && entries[i].capture === capture) {
                        var wrapper = entries[i].wrapper;
                        entries.splice(i, 1);
                        nativeRemoveEventListener.apply(source, [type, wrapper].concat(extra));
                        return;
                      }
                    }
                  }
                  // WHATWG：onXXX 事件处理器也在监听器列表里，按 capture=false
                  // 注册，removeEventListener(type, f) 同样能移除 onXXX = f；
                  // capture:true 的移除在原生语义下是 no-op，不得误清处理器状态
                  var state = capture === false ? propState[type] : undefined;
                  if (state && state.current === listener) {
                    var installed = state.installed;
                    state.current = null;
                    state.installed = null;
                    if (installed) {
                      nativeRemoveEventListener.apply(source, [type, installed].concat(extra));
                    }
                    return;
                  }
                }
                return nativeRemoveEventListener.apply(source, arguments);
              };
            }
            var props = { onmessage: 'message', onopen: 'open', onerror: 'error' };
            for (var prop in props) {
              (function (prop, type) {
                var state = { current: null, installed: null };
                propState[type] = state;
                try {
                  Object.defineProperty(source, prop, {
                    get: function () { return state.current; },
                    set: function (listener) {
                      // WebIDL：非 callable 赋值按 null 处理，同时移除已装包装
                      if (typeof listener !== 'function') {
                        state.current = null;
                        var stale = state.installed;
                        state.installed = null;
                        if (stale && nativeRemoveEventListener) {
                          try {
                            nativeRemoveEventListener(type, stale, false);
                          } catch (_error) {}
                        }
                        return;
                      }
                      state.current = listener;
                      // 重新赋值先移除旧包装监听器（不堆叠、旧 handler 不复活）
                      if (state.installed) {
                        var old = state.installed;
                        state.installed = null;
                        if (!nativeRemoveEventListener) return;
                        try {
                          nativeRemoveEventListener(type, old, false);
                        } catch (_error) { return; }
                      }
                      state.installed = function (event) {
                        try {
                          if (type === 'message') {
                            var data = event && event.data;
                            var b64 = bytesToB64(data);
                            emit(source, sseId, 'event', {
                              event: undefined,
                              serverEventId: event && event.lastEventId ? event.lastEventId : undefined,
                              dataB64: b64 == null ? (data == null ? null : bytesToB64(String(data))) : b64
                            });
                          } else if (type === 'open') {
                            emit(source, sseId, 'connected');
                          } else {
                            emit(source, sseId, 'error');
                          }
                        } catch (_error) {}
                        if (typeof state.current === 'function') return state.current.call(source, event);
                      };
                      nativeAddEventListener(type, state.installed, false);
                    },
                    // 原生事件处理器属性在原型上、不可枚举；实例自有属性同样不可枚举。
                    // delete 在原生是对原型访问器的 no-op：non-configurable 对齐该语义
                    enumerable: false,
                    configurable: false
                  });
                } catch (_error) {
                  reportHookFailure('sse', 'onxxx:' + prop, _error);
                }
              })(prop, props[prop]);
            }
          } catch (_error) {
            reportHookFailure('sse', 'install', _error);
          }
          try {
            var closedReported = false;
            var nativeClose = source.close.bind(source);
            source.close = function () {
              var result = nativeClose();
              if (!closedReported) {
                closedReported = true;
                emit(source, sseId, 'closed');
              }
              return result;
            };
          } catch (_error) {
            reportHookFailure('sse', 'close-patch', _error);
          }
          return source;
        };
      // prototype 指回原生：instanceof / 原型方法访问与未包装时一致
      try { WrappedES.prototype = NativeES.prototype; } catch (_error) {}
      Object.defineProperty(root, 'EventSource', {
        value: WrappedES,
        writable: true,
        enumerable: false,
        configurable: true
      });
    } catch (_error) {
      reportHookFailure('sse', 'install', _error);
    }
  }

  installCryptoHook();
  installActionListeners();
  installWebRtcHook();
  installWebTransportHook();
  installSseHook();
})();
`;
