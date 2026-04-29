/**
 * React Debugger — Standalone SDK (no external dependencies)
 * Connects your app to the debugger desktop at localhost:8347
 * Only active in __DEV__ mode — zero impact in production.
 */
import { setConfig, startDebugger, initDebugger, debuggerMiddleware, reportNavigation, reportNavigationEvent, disconnectDebugger } from "./core";

setConfig({
  host: "localhost",
  getDeviceInfo: () => {
    const width = typeof window !== "undefined" ? window.innerWidth : 1024;
    const height = typeof window !== "undefined" ? window.innerHeight : 768;
    const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "Unknown Web Browser";
    return {
      id: `web_${Date.now().toString(36)}`,
      name: `Web Browser`,
      platform: "web",
      osVersion: userAgent.substring(0, 50),
      appName: `(web) ${Date.now().toString(36)}`,
      appVersion: "0.0.0",
      sdkVersion: "1.0.0",
      isEmulator: false,
      screenSize: { width, height },
    };
  },
  storage: {
    capture: async (send) => {
      try {
        if (typeof window === "undefined" || !window.localStorage) return;
        const entries = [];
        for (let i = 0; i < window.localStorage.length; i++) {
          const key = window.localStorage.key(i);
          const value = window.localStorage.getItem(key);
          entries.push({ key, value });
        }
        send("storage", "storage:list", { entries });
      } catch (e) {}
    },
    remove: async (key) => {
      try {
        if (typeof window === "undefined" || !window.localStorage) return;
        window.localStorage.removeItem(key);
      } catch (e) {}
    },
    clear: async () => {
      try {
        if (typeof window !== "undefined" && window.localStorage) window.localStorage.clear();
      } catch (e) {}
    }
  },
  app: {
    reload: () => {
      try {
        if (typeof window !== "undefined") window.location.reload();
      } catch (e) {}
    },
    deepLink: (url) => {
      try {
        if (typeof window !== "undefined") window.location.href = url;
      } catch (e) {}
    }
  }
});

startDebugger();

export { initDebugger, debuggerMiddleware, reportNavigation, reportNavigationEvent, disconnectDebugger };
