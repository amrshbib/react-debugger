/**
 * React Debugger — Standalone SDK (no external dependencies)
 * Connects your app to the debugger desktop at localhost:8347
 * Only active in __DEV__ mode — zero impact in production.
 */

export const IS_DEV =true

export const DEBUGGER_PORT = 8347;

const _global = typeof globalThis !== "undefined" ? globalThis : (typeof window !== "undefined" ? window : (typeof global !== "undefined" ? global : (typeof self !== "undefined" ? self : {})));

export let config = {
  host: "localhost",
  getDeviceInfo: () => ({}),
  storage: {
    capture: async (send) => {},
    remove: async (key) => {},
    clear: async () => {},
  },
  app: {
    reload: () => {},
    deepLink: (url) => {}
  }
};

export function setConfig(c) {
  config = { ...config, ...c };
}

const HEARTBEAT_INTERVAL = 10000;

let ws = null;
let connected = false;
let sessionId = null;
let msgCounter = 0;
let heartbeatTimer = null;
let reconnectTimer = null;
let originalFetch = null;
let originalConsole = {};

// User-provided device info (set via initDebugger)
let userDeviceInfo = {};

// Guard against multiple initializations
if (_global.__RN_DEBUGGER_INSTALLED__) {
  // Already installed, but we might want to export the functions again
} else {
  _global.__RN_DEBUGGER_INSTALLED__ = true;
}

function send(domain, event, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    if (originalConsole.log && domain === "navigation") {
      originalConsole.log(`[React Debugger] WebSocket: Sending navigation event to server...`);
    }
    const safePayload = JSON.parse(JSON.stringify(payload, createSafeReplacer()));
    ws.send(
      JSON.stringify({
        id: genId("msg"),
        domain,
        event,
        payload: safePayload,
        timestamp: Date.now(),
        sessionId,
      })
    );
  } catch (e) {
    if (originalConsole.error) originalConsole.error("[React Debugger] Send failed:", e);
  }
}

function createSafeReplacer() {
  const seen = new WeakSet();
  return (key, value) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) {
        return "[Circular]";
      }
      seen.add(value);
    }
    if (typeof value === "function") return "[Function]";
    if (typeof value === "symbol") return "[Symbol]";
    if (value instanceof Error) return { message: value.message, stack: value.stack };
    return value;
  };
}

function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${(msgCounter++).toString(36)}`;
}

// ─── Connection ──────────────────────────────────────────────────

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  try {
    ws = new WebSocket(`ws://${config.host}:${DEBUGGER_PORT}/device`);

    ws.onopen = () => {
      // Send handshake — merge user-provided info over defaults
      send("connection", "connection:handshake", {
        deviceInfo: {
          ...config.getDeviceInfo(),
          ...userDeviceInfo,
        },
        supportedDomains: ["network", "logs", "state", "performance"],
        protocolVersion: "1.0.0",
      });
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.event === "connection:ack") {
          sessionId = msg.payload.sessionId;
          connected = true;
          startHeartbeat();
          
          if (fiberRoots && fiberRoots.length > 0) {
            fiberRoots.forEach(root => detectAndTrackContexts(root.current));
          }

          if (originalConsole.log) {
            originalConsole.log(`%c[React Debugger] Connected to Desktop (Session: ${sessionId})`, "color: #0078ff; font-weight: bold;");
            originalConsole.log("%c[Navigation Tracker] Use <NavigationContainer onStateChange={reportNavigation}> to track navigation live.", "color: #faad14;");
          }
        }
        if (msg.event === "connection:ping") {
          send("connection", "connection:pong", {});
        }
        if (msg.event === "ui:capture-start") {
          captureComponentTree();
        }

        // Handle custom commands
        if (msg.domain === "system") {
          handleIncomingCommand(msg);
        }
      } catch (e) {}
    };

    ws.onclose = () => {
      connected = false;
      stopHeartbeat();
      // Reconnect in 5s
      reconnectTimer = setTimeout(connect, 5000);
    };

    ws.onerror = () => {
      // onclose will fire
    };
  } catch (e) {
    reconnectTimer = setTimeout(connect, 5000);
  }
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    send("connection", "connection:ping", {});
  }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ─── Network Interceptor ─────────────────────────────────────────

let originalXHROpen = null;
let originalXHRSend = null;
let originalWebSocket = null;
let networkInstalled = false;
let websocketInstalled = false;

function interceptNetwork() {
  if (networkInstalled) return;
  networkInstalled = true;

  // ── Intercept fetch ──
  originalFetch = _global.fetch;

  _global.fetch = async function (input, init) {
    const requestId = genId("net");
    const startTime = Date.now();
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method || "GET").toUpperCase();

    // Don't intercept our own debugger connections
    if (url.includes(`${config.host}:${DEBUGGER_PORT}`)) {
      return originalFetch.call(_global, input, init);
    }

    const headers = {};
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => (headers[k] = v));
      } else if (typeof init.headers === "object") {
        Object.assign(headers, init.headers);
      }
    }

    send("network", "network:request-started", {
      request: {
        id: requestId,
        url,
        method,
        headers,
        body: init?.body ? tryStringify(init.body) : undefined,
        timestamp: startTime,
        type: (url.toLowerCase().includes("signalr") || url.toLowerCase().includes("hub") || url.toLowerCase().includes("negotiate")) ? "SignalR" : undefined,
      },
    });

    try {
      const response = await originalFetch.call(_global, input, init);
      const duration = Date.now() - startTime;

      // Clone to read body without consuming
      let responseBody;
      try {
        const cloned = response.clone();
        responseBody = await cloned.text();
        try {
          responseBody = JSON.parse(responseBody);
        } catch {}
      } catch {
        responseBody = "[Could not read body]";
      }

      const responseHeaders = {};
      if (response.headers) {
        response.headers.forEach((v, k) => (responseHeaders[k] = v));
      }

      send("network", "network:request-completed", {
        requestId,
        response: {
          id: genId("res"),
          requestId,
          statusCode: response.status,
          headers: responseHeaders,
          body: responseBody,
          timestamp: Date.now(),
          duration,
          size: typeof responseBody === "string" ? responseBody.length : 0,
        },
        timing: {
          startTime,
          totalTime: duration,
        },
      });

      return response;
    } catch (error) {
      send("network", "network:request-failed", {
        requestId,
        error: {
          message: error.message || "Fetch failed",
        },
      });
      throw error;
    }
  };

  // ── Intercept XMLHttpRequest (used by Axios / apisauce) ──
  originalXHROpen = XMLHttpRequest.prototype.open;
  originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    try {
      const urlStr = typeof url === "string" ? url : url.toString();

      // Don't intercept our own debugger connections
      if (urlStr.includes(`${config.host}:${DEBUGGER_PORT}`)) {
        this._debuggerSkip = true;
        return originalXHROpen.apply(this, [method, url, ...args]);
      }

      this._debuggerMeta = {
        requestId: genId("net"),
        method: method.toUpperCase(),
        url: urlStr,
        startTime: Date.now(),
        headers: {},
      };

      // Intercept setRequestHeader to capture headers
      const origSetHeader = this.setRequestHeader;
      this.setRequestHeader = function (name, value) {
        try {
          if (this._debuggerMeta) {
            this._debuggerMeta.headers[name] = value;
          }
        } catch (e) {}
        return origSetHeader.apply(this, [name, value]);
      };
    } catch (e) {
      // Never crash the app
    }

    return originalXHROpen.apply(this, [method, url, ...args]);
  };

  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (this._debuggerMeta && !this._debuggerSkip) {
        const meta = this._debuggerMeta;

        send("network", "network:request-started", {
          request: {
            id: meta.requestId,
            url: meta.url,
            method: meta.method,
            headers: meta.headers,
            body: body ? tryStringify(body) : undefined,
            timestamp: meta.startTime,
            type: (meta.url.toLowerCase().includes("signalr") || meta.url.toLowerCase().includes("hub") || meta.url.toLowerCase().includes("negotiate")) ? "SignalR" : undefined,
          },
        });

        this.addEventListener("load", () => {
          try {
            let responseBody;
            try {
              if (this.responseType === "json") {
                responseBody = this.response;
              } else if (this.responseType === "" || this.responseType === "text") {
                try {
                  responseBody = JSON.parse(this.responseText);
                } catch {
                  responseBody = this.responseText;
                }
              } else {
                responseBody = `[${this.responseType} response]`;
              }
            } catch {
              responseBody = "[Could not read response]";
            }

            const responseHeaders = {};
            const allHeaders = this.getAllResponseHeaders() || "";
            for (const line of allHeaders.split("\r\n")) {
              const idx = line.indexOf(":");
              if (idx > 0) {
                responseHeaders[line.substring(0, idx).trim()] = line.substring(idx + 1).trim();
              }
            }

            let size = 0;
            try {
              if (typeof this.response === "string") {
                size = this.response.length;
              } else if (this.response) {
                size = JSON.stringify(this.response).length;
              }
            } catch {}

            send("network", "network:request-completed", {
              requestId: meta.requestId,
              response: {
                id: genId("res"),
                requestId: meta.requestId,
                statusCode: this.status,
                headers: responseHeaders,
                body: responseBody,
                timestamp: Date.now(),
                duration: Date.now() - meta.startTime,
                size,
              },
              timing: {
                startTime: meta.startTime,
                totalTime: Date.now() - meta.startTime,
              },
            });
          } catch (e) {
            // Never crash the app
          }
        });

        this.addEventListener("error", () => {
          send("network", "network:request-failed", {
            requestId: meta.requestId,
            error: { message: "XHR request failed" },
          });
        });

        this.addEventListener("timeout", () => {
          send("network", "network:request-failed", {
            requestId: meta.requestId,
            error: { message: "XHR request timed out", code: "TIMEOUT" },
          });
        });
      }
    } catch (e) {
      // Never crash the app
    }

    return originalXHRSend.call(this, body);
  };
}

function interceptWebSocket() {
  if (websocketInstalled) return;
  websocketInstalled = true;

  originalWebSocket = _global.WebSocket;

  const PatchedWebSocket = function(url, protocols) {
    const socketId = genId("ws");
    const startTime = Date.now();
    const ws = new originalWebSocket(url, protocols);

    // Don't intercept our own debugger connection
    const urlStr = String(url || "");
    if (urlStr.includes(`${config.host}:${DEBUGGER_PORT}`)) {
      return ws;
    }

    send("network", "network:socket-opened", {
      id: socketId,
      url: urlStr,
      protocols: typeof protocols === "string" ? [protocols] : protocols || [],
      timestamp: startTime,
      type: (urlStr.toLowerCase().includes("signalr") || urlStr.toLowerCase().includes("hub")) ? "SignalR" : "WebSocket",
    });

    const origSend = ws.send.bind(ws);
    ws.send = function(data) {
      send("network", "network:socket-message-sent", {
        socketId,
        data: summarizeSocketData(data),
        size: getSocketDataSize(data),
        timestamp: Date.now(),
      });
      return origSend(data);
    };

    ws.addEventListener("message", (event) => {
      send("network", "network:socket-message-received", {
        socketId,
        data: summarizeSocketData(event.data),
        size: getSocketDataSize(event.data),
        timestamp: Date.now(),
      });
    });

    ws.addEventListener("close", (event) => {
      send("network", "network:socket-closed", {
        socketId,
        code: event.code,
        reason: event.reason,
        timestamp: Date.now(),
        duration: Date.now() - startTime,
      });
    });

    ws.addEventListener("error", (event) => {
      send("network", "network:socket-error", {
        socketId,
        message: "WebSocket connection failed",
        timestamp: Date.now(),
      });
    });

    return ws;
  };

  // Maintain prototype and static properties
  PatchedWebSocket.prototype = originalWebSocket.prototype;
  Object.assign(PatchedWebSocket, originalWebSocket);

  _global.WebSocket = PatchedWebSocket;
}

function summarizeSocketData(data) {
  if (typeof data === "string") return data.substring(0, 1000);
  if (data instanceof Blob) return `[Blob: ${data.size} bytes]`;
  if (data instanceof ArrayBuffer) return `[ArrayBuffer: ${data.byteLength} bytes]`;
  return `[Binary data: ${typeof data}]`;
}

function getSocketDataSize(data) {
  if (typeof data === "string") return data.length;
  if (data instanceof Blob) return data.size;
  if (data instanceof ArrayBuffer) return data.byteLength;
  return 0;
}

// ─── Console Interceptor ─────────────────────────────────────────

let consoleInstalled = false;

function interceptConsole() {
  if (consoleInstalled) return;
  consoleInstalled = true;

  const levels = ["log", "info", "warn", "error", "debug"];

  for (const level of levels) {
    originalConsole[level] = console[level];

    console[level] = (...args) => {
      // Always call original
      originalConsole[level].apply(console, args);

      // Skip our own messages
      const firstArg = String(args[0] || "");
      if (firstArg.includes("[React Debugger]")) return;

      const message = args
        .map((a) => {
          if (typeof a === "string") return a;
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(" ");

      send("logs", "log:received", {
        entry: {
          id: genId("log"),
          level,
          message,
          data: args.length > 1 ? args.slice(1).map(tryStringify) : undefined,
          timestamp: Date.now(),
          source: "javascript",
          stackTrace: level === "error" || level === "warn" ? captureStack() : undefined,
        },
      });
    };
  }
}

function captureStack() {
  try {
    const stack = new Error().stack;
    if (!stack) return [];
    return stack
      .split("\n")
      .slice(3)
      .map((line) => {
        const match = line.match(/at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/) || line.match(/at\s+(.+?):(\d+):(\d+)/);
        if (!match) return null;
        if (match.length === 5) {
          return {
            functionName: match[1],
            fileName: match[2],
            lineNumber: parseInt(match[3]),
            columnNumber: parseInt(match[4]),
          };
        }
        return {
          functionName: "<anonymous>",
          fileName: match[1],
          lineNumber: parseInt(match[2]),
          columnNumber: parseInt(match[3]),
        };
      })
      .filter(Boolean)
      .slice(0, 8);
  } catch {
    return [];
  }
}

// ─── Performance Monitor ─────────────────────────────────────────

let perfTimer = null;
let frameCount = 0;
let lastFrameTime = 0;
let rafId = null;

function startPerformanceMonitor() {
  if (config.getDeviceInfo().platform === 'web') return; // Don't track FPS/Perf on Web for now

  lastFrameTime = Date.now();

  const tick = () => {
    frameCount++;
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);

  perfTimer = setInterval(() => {
    const fps = Math.round((frameCount / 1000) * 1000);
    frameCount = 0;

    const memInfo = _global.performance?.memory;

    send("performance", "performance:metrics", {
      metrics: {
        fps: {
          current: fps,
          average: fps,
          min: fps,
          max: fps,
          dropped: 0,
        },
        memory: {
          jsHeapUsed: memInfo?.usedJSHeapSize || 0,
          jsHeapTotal: memInfo?.totalJSHeapSize || 0,
        },
        threads: {
          jsThread: { usage: 0, blockingTime: 0, longestTask: 0 },
          uiThread: { usage: 0, blockingTime: 0, longestTask: 0 },
        },
        timestamp: Date.now(),
      },
    });
  }, 1000);
}

// ─── Redux Integration (Middleware) ──────────────────────────────

let initialSnapshotSent = false;

function computeDiffs(prev, next, path = "") {
  const diffs = [];
  if (prev === next) return diffs;
  if (typeof prev !== typeof next || prev === null || next === null || typeof prev !== "object" || typeof next !== "object") {
    diffs.push({ path: path || "(root)", prev, next });
    return diffs;
  }
  const allKeys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of allKeys) {
    const fullPath = path ? `${path}.${key}` : key;
    if (!(key in prev)) {
      diffs.push({ path: fullPath, prev: undefined, next: next[key] });
    } else if (!(key in next)) {
      diffs.push({ path: fullPath, prev: prev[key], next: undefined });
    } else if (prev[key] !== next[key]) {
      if (typeof prev[key] === "object" && prev[key] !== null && typeof next[key] === "object" && next[key] !== null) {
        diffs.push(...computeDiffs(prev[key], next[key], fullPath));
      } else {
        diffs.push({ path: fullPath, prev: prev[key], next: next[key] });
      }
    }
  }
  return diffs;
}

export const debuggerMiddleware = (store) => (next) => (action) => {
  if (!IS_DEV) return next(action);

  try {
    // Send initial snapshot on first action
    if (!initialSnapshotSent && connected) {
      initialSnapshotSent = true;
      send("state", "state:snapshot", {
        snapshot: {
          id: genId("snap"),
          state: simplifyState(store.getState()),
          timestamp: Date.now(),
          source: "redux",
          storeName: "appStore",
        },
      });
    }

    const previousState = simplifyState(store.getState());
    const result = next(action);
    const nextState = simplifyState(store.getState());

    if (true) {
      const diffs = computeDiffs(previousState, nextState);

      send("state", "state:action", {
        action: {
          id: genId("action"),
          type: action.type || "unknown",
          payload: tryStringify(action),
          timestamp: Date.now(),
          source: "redux",
          storeName: "appStore",
        },
        previousSnapshot: {
          id: genId("snap"),
          state: previousState,
          timestamp: Date.now() - 1,
          source: "redux",
          storeName: "appStore",
        },
        nextSnapshot: {
          id: genId("snap"),
          state: nextState,
          timestamp: Date.now(),
          source: "redux",
          storeName: "appStore",
        },
        diffs,
      });
    }

    return result;
  } catch (e) {
    // never crash the app
    return next(action);
  }
};

function simplifyState(state) {
  try {
    const simplified = {};
    for (const key of Object.keys(state)) {
      if (key === "_persist") continue;
      simplified[key] = JSON.parse(JSON.stringify(state[key], safeReplacer));
    }
    return simplified;
  } catch {
    return { error: "Could not serialize state" };
  }
}

function safeReplacer(key, value) {
  if (typeof value === "function") return "[Function]";
  if (typeof value === "symbol") return "[Symbol]";
  if (value instanceof Error) return { message: value.message, stack: value.stack };
  return value;
}

function tryStringify(val) {
  if (typeof val === "string") return val;
  try {
    return JSON.parse(JSON.stringify(val, safeReplacer));
  } catch {
    return String(val);
  }
}

// ─── Main Init ───────────────────────────────────────────────────

export function startDebugger() {
  if (IS_DEV) {
    try {
      interceptConsole();
      interceptNetwork();
      interceptWebSocket();
      connect(); // Start connection early so it's ready for requests
      startPerformanceMonitor();
      originalConsole.log && originalConsole.log("[React Debugger] Network + Console interceptors installed at module load");
    } catch (e) {
      // Never crash the app
    }
  }
}

let globalTrackContexts = null;

export function initDebugger(data) {
  if (!IS_DEV) return;

  // Store user-provided device info so the handshake uses it
  if (data?.deviceInfo) {
    userDeviceInfo = data.deviceInfo;
  }
  
  if (data?.trackContexts) {
    globalTrackContexts = data.trackContexts;
  }
}

// ─── Storage Inspector ───────────────────────────────────────────

async function captureStorage() {
  if (config.storage && config.storage.capture) {
    await config.storage.capture(send);
  }
}

async function removeStorageItem(key) {
  if (config.storage && config.storage.remove) {
    await config.storage.remove(key);
    captureStorage(); // Refresh
  }
}

// ─── Navigation Debugger ─────────────────────────────────────────

function getLeafRoute(state) {
  if (!state || !state.routes || state.index === undefined) return null;
  const route = state.routes[state.index];
  if (!route) return null;

  if (route.state) {
    return getLeafRoute(route.state);
  }
  return route;
}

export function reportNavigation(state) {
  if (originalConsole.log) originalConsole.log("[React Debugger] Navigation: reportNavigation called.");
  if (!state) {
    if (originalConsole.log) originalConsole.log("[React Debugger] Navigation: State is null/undefined.");
    return;
  }
  try {
    const route = getLeafRoute(state);
    if (route) {
      if (originalConsole.log) originalConsole.log(`[React Debugger] Navigation: Found leaf route ${route.name}`);
      reportNavigationEvent(route.name, route.params);
    } else {
      if (originalConsole.log) originalConsole.log("[React Debugger] Navigation: Could not find leaf route in state.");
    }
  } catch (e) {
    if (originalConsole.error) originalConsole.error("[React Debugger] Navigation: Error in reportNavigation:", e);
  }
}

export function reportNavigationEvent(routeName, params = {}) {
  if (originalConsole.log) originalConsole.log(`[React Debugger] Navigation: reportNavigationEvent called for ${routeName}`);
  if (!routeName) {
    if (originalConsole.log) originalConsole.log("[React Debugger] Navigation: Route name is missing.");
    return;
  }
  try {
    const event = {
      id: genId("nav"),
      routeName,
      params,
      timestamp: Date.now(),
      type: "navigate",
    };
    if (originalConsole.log) originalConsole.log(`[React Debugger] Navigation: Sending event payload for ${routeName}`);
    send("navigation", "navigation:event", event);
  } catch (e) {
    if (originalConsole.error) originalConsole.error("[React Debugger] Navigation: Error in reportNavigationEvent:", e);
  }
}

// ─── Command Execution ───────────────────────────────────────────

function handleIncomingCommand(msg) {
  const { event, payload } = msg;
  if (originalConsole.log) originalConsole.log(`[React Debugger] Command received: ${event}`);

  if (event === "storage:getAll") {
    captureStorage();
  } else if (event === "storage:remove") {
    removeStorageItem(payload.key);
  } else if (event === "app:reload") {
    if (config.app && config.app.reload) config.app.reload();
  } else if (event === "app:deep-link") {
    if (config.app && config.app.deepLink) config.app.deepLink(payload.url);
  } else if (event === "app:clear-storage") {
    if (config.storage && config.storage.clear) {
      config.storage.clear();
      captureStorage(); // Refresh
    }
  } else if (event === "app:screenshot") {
    // Screenshot logic would ideally use takeSnapshot from react-native
    send("command", "command:result", {
      id: genId("cmd"),
      command: "app:screenshot",
      result: "Screenshot capture requires native view reference.",
      success: false,
      timestamp: Date.now(),
    });
  }
}

// ─── UI Inspector ────────────────────────────────────────────────

let lastCapturedTree = null;
let fiberRoots = [];
let nodeIdCounter = 0;

const previousContextValues = new WeakMap();
const contextCounter = new WeakMap();

function detectAndTrackContexts(fiber, parentName = "App") {
  if (!fiber ) return;
  
  let currentName = parentName;
  if (fiber.tag === 0 || fiber.tag === 1 || fiber.tag === 15) {
     currentName = fiber.type?.displayName || fiber.type?.name || parentName;
  }

  // Resilient check for Context.Provider (works across all React versions)
  let isContext = false;
  if (fiber.tag === 10) isContext = true;
  else if (fiber.type && typeof fiber.type === "object" && fiber.type.$$typeof) {
    const symbolStr = String(fiber.type.$$typeof);
    if (symbolStr === "Symbol(react.provider)" || fiber.type.$$typeof === 0xeacd || fiber.type.$$typeof === 60109) {
      isContext = true;
    }
  }

  if (isContext) {
    const value = fiber.memoizedProps?.value;
    const contextObj = fiber.type?._context || fiber.type;
    
    if (contextObj && value !== undefined) {
       const providerName = contextObj.displayName || `${currentName}Context`;
       
       let isWhitelisted = true;
       if (globalTrackContexts && Array.isArray(globalTrackContexts)) {
          isWhitelisted = globalTrackContexts.some(tracked => 
            providerName === tracked || 
            providerName === `${tracked}Context` ||
            providerName.toLowerCase().includes(tracked.toLowerCase())
          );
       }
       
       const prevValue = previousContextValues.get(contextObj);
       
       if (prevValue !== value) {
          const simplifiedPrev = simplifyState(prevValue);
          const simplifiedNext = simplifyState(value);
          const diffs = prevValue !== undefined ? computeDiffs(simplifiedPrev, simplifiedNext) : [];
          
          if (!previousContextValues.has(contextObj)) {
               if (isWhitelisted) {
                 const initialSnapID = genId('snap');
                 send('state', 'state:snapshot', { 
                    snapshot: {
                      id: initialSnapID,
                      state: simplifiedNext,
                      timestamp: Date.now(),
                      source: 'context',
                      storeName: providerName,
                    }
                 });
               
               let counter = 0;
               contextCounter.set(contextObj, counter);
               
               send('state', 'state:action', {
                  action: {
                    id: genId('action'),
                    type: `${providerName}/MOUNTED`,
                    payload: undefined,
                    timestamp: Date.now(),
                    source: 'context',
                    storeName: providerName,
                  },
                  previousSnapshot: {
                    id: genId('snap'),
                    state: {},
                    timestamp: Date.now() - 1,
                    source: 'context',
                    storeName: providerName,
                  },
                  nextSnapshot: {
                    id: initialSnapID,
                    state: simplifiedNext,
                    timestamp: Date.now(),
                    source: 'context',
                    storeName: providerName,
                  },
                  diffs: [{ path: '(root)', type: 'added', prev: undefined, next: simplifiedNext }],
               });

               // Send a confirmational log to the user's Desktop console!
               send("logs", "log:received", {
                  entry: {
                    id: genId("log"),
                    level: "info",
                    message: `[Context Tracker] Successfully discovered and began tracking Provider: ${providerName}`,
                    timestamp: Date.now(),
                    source: "javascript",
                  },
               });
               }
          } else if (diffs.length > 0) {
               if (isWhitelisted) {
                 let counter = contextCounter.get(contextObj) || 0;
                 counter++;
                 contextCounter.set(contextObj, counter);

                 send('state', 'state:action', {
                    action: {
                      id: genId('action'),
                      type: `${providerName}/update#${counter}`,
                      payload: undefined,
                      timestamp: Date.now(),
                      source: 'context',
                      storeName: providerName,
                    },
                    previousSnapshot: {
                      id: genId('snap'),
                      state: simplifiedPrev,
                      timestamp: Date.now() - 1,
                      source: 'context',
                      storeName: providerName,
                    },
                    nextSnapshot: {
                      id: genId('snap'),
                      state: simplifiedNext,
                      timestamp: Date.now(),
                      source: 'context',
                      storeName: providerName,
                    },
                    diffs,
                 });
               }
          }
          previousContextValues.set(contextObj, value);
       }
    }
  }

  let child = fiber.child;
  while (child) {
    detectAndTrackContexts(child, currentName);
    child = child.sibling;
  }
}

// Patch the EXISTING React DevTools hook (React Native already sets one up)
function installInspectorHook() {
  const hook = _global.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) {
    _global.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      checkDCE: () => {},
      supportsFiber: true,
      renderers: new Map(),
      onScheduleFiberRoot: () => {},
      onCommitFiberRoot: (_id, root) => {
        storeFiberRoot(root);
        detectAndTrackContexts(root.current);
      },
      onCommitFiberUnmount: () => {},
      inject: (renderer) => {
        const id = Math.random();
        _global.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers.set(id, renderer);
        return id;
      },
    };
    return;
  }

  const originalOnCommit = hook.onCommitFiberRoot;
  hook.onCommitFiberRoot = function (id, root, priorityLevel) {
    storeFiberRoot(root);
    detectAndTrackContexts(root.current);
    
    if (typeof originalOnCommit === "function") {
      try {
        originalOnCommit.call(this, id, root, priorityLevel);
      } catch (e) {}
    }
  };
}

function storeFiberRoot(root) {
  if (!root || !root.current) return;
  if (!fiberRoots.includes(root)) {
    fiberRoots.push(root);
  }
}

// Safe prop serialization — avoid circular refs and huge objects
function safeProps(obj, depth) {
  if (depth > 2) return "[deep]";
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    if (obj.length > 10) return `[Array(${obj.length})]`;
    return obj.map((v) => safeProps(v, depth + 1));
  }
  // Skip React elements, functions, symbols
  if (obj.$$typeof) return "[ReactElement]";

  const result = {};
  const keys = Object.keys(obj);
  for (let i = 0; i < Math.min(keys.length, 20); i++) {
    const k = keys[i];
    const v = obj[k];
    if (typeof v === "function") {
      result[k] = "[Function]";
    } else if (typeof v === "symbol") {
      result[k] = String(v);
    } else if (typeof v === "object" && v !== null) {
      result[k] = safeProps(v, depth + 1);
    } else {
      result[k] = v;
    }
  }
  if (keys.length > 20) result["..."] = `+${keys.length - 20} more`;
  return result;
}

function traverseFiber(fiber, depth) {
  if (!fiber || depth > 30) return null;

  let name = "Unknown";
  let type = "composite";
  const tag = fiber.tag;

  // React Fiber tags: 0=FunctionComponent, 1=ClassComponent, 3=HostRoot,
  // 5=HostComponent, 6=HostText, 11=ForwardRef, 15=SimpleMemoComponent
  if (tag === 5 || tag === 27) {
    // HostComponent (View, Text, etc.)
    name = fiber.type || "View";
    type = "host";
  } else if (tag === 6) {
    // HostText — skip
    return null;
  } else if (tag === 0 || tag === 15) {
    // FunctionComponent / SimpleMemoComponent
    name = fiber.type?.displayName || fiber.type?.name || "Anonymous";
    type = "composite";
  } else if (tag === 1) {
    // ClassComponent
    name = fiber.type?.displayName || fiber.type?.name || "ClassComponent";
    type = "composite";
  } else if (tag === 11) {
    // ForwardRef
    const innerName = fiber.type?.render?.displayName || fiber.type?.render?.name;
    name = innerName ? `ForwardRef(${innerName})` : "ForwardRef";
    type = "composite";
  } else if (tag === 3) {
    name = "Root";
    type = "composite";
  } else if (tag === 7) {
    name = "Fragment";
    type = "composite";
  } else if (tag === 10) {
    name = "Context.Provider";
    type = "composite";
  } else if (tag === 9) {
    name = "Context.Consumer";
    type = "composite";
  } else if (tag === 16) {
    name = "Lazy";
    type = "composite";
  } else {
    // Skip other internal fiber types
    name = `Fiber(tag=${tag})`;
    type = "composite";
  }

  nodeIdCounter++;
  const node = {
    id: `fiber_${nodeIdCounter}`,
    name,
    type,
    props: safeProps(fiber.memoizedProps || {}, 0),
    children: [],
  };

  // Collect children
  let child = fiber.child;
  while (child) {
    const childNode = traverseFiber(child, depth + 1);
    if (childNode) {
      node.children.push(childNode);
    }
    child = child.sibling;
  }

  return node;
}

function captureComponentTree() {
  // Try to capture from stored fiber roots
  if (fiberRoots.length > 0) {
    try {
      nodeIdCounter = 0;
      const root = fiberRoots[fiberRoots.length - 1]; // Use latest root
      const tree = traverseFiber(root.current, 0);
      if (tree) {
        lastCapturedTree = tree;
        send("ui-inspector", "ui-inspector:tree-updated", { tree });
        return;
      }
    } catch (e) {
      originalConsole.error && originalConsole.error("[React Debugger] UI Capture error:", e);
    }
  }

  if (lastCapturedTree) {
    send("ui-inspector", "ui-inspector:tree-updated", { tree: lastCapturedTree });
    return;
  }

  send("ui-inspector", "ui-inspector:tree-updated", {
    tree: {
      id: "root-wait",
      name: "Waiting for React render...",
      type: "composite",
      props: {},
      children: [
        {
          id: "tip",
          name: "Navigate or interact with your app to trigger a render",
          type: "host",
          props: {},
          children: [],
        },
      ],
    },
  });
}

export function reportComponentTree(tree) {
  if (!tree) return;
  lastCapturedTree = tree;
  if (true) {
    send("ui-inspector", "ui-inspector:tree-updated", { tree });
  }
}

// Install the hook IMMEDIATELY
installInspectorHook();

export function disconnectDebugger() {
  if (perfTimer) clearInterval(perfTimer);
  if (rafId) cancelAnimationFrame(rafId);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);

  // Restore console
  for (const [level, fn] of Object.entries(originalConsole)) {
    console[level] = fn;
  }

  // Restore fetch
  if (originalFetch) {
    _global.fetch = originalFetch;
  }

  // Restore XHR
  if (originalXHROpen) {
    XMLHttpRequest.prototype.open = originalXHROpen;
    originalXHROpen = null;
  }
  if (originalXHRSend) {
    XMLHttpRequest.prototype.send = originalXHRSend;
    originalXHRSend = null;
  }

  if (ws) ws.close();
  connected = false;
}


