/**
 * React Debugger — Standalone SDK (no external dependencies)
 * Connects your app to the debugger desktop at localhost:8347
 * Only active in __DEV__ mode — zero impact in production.
 */
import { Dimensions, Platform, NativeModules } from "react-native";
import { setConfig, startDebugger, initDebugger, debuggerMiddleware, reportNavigation, reportNavigationEvent, disconnectDebugger } from "./core";

let host = "localhost";
try {
  const scriptURL = NativeModules?.SourceCode?.scriptURL;
  if (scriptURL) {
    const match = scriptURL.match(/^https?:\/\/([^:\/]+)/);
    if (match) {
      host = match[1];
    }
  } else if (Platform?.OS === "android") {
    host = "10.0.2.2";
  }
} catch (e) {
  if (Platform?.OS === "android") {
    host = "10.0.2.2";
  }
}

setConfig({
  host,
  getDeviceInfo: () => {
    const { width, height } = Dimensions.get("window");
    return {
      id: `${Platform.OS}_${Date.now().toString(36)}`,
      name: `${Platform.OS} Device`,
      platform: Platform.OS,
      osVersion: String(Platform.Version),
      appName: `(${Platform.OS}) ${Date.now().toString(36)}`,
      appVersion: "0.0.0",
      sdkVersion: "1.0.0",
      isEmulator: false,
      screenSize: { width, height },
    };
  },
  storage: {
    capture: async (send) => {
      try {
        const AsyncStorage = global.AsyncStorage || (function () { try { return require("@react-native-async-storage/async-storage").default || require("react-native").AsyncStorage; } catch (e) { return null; } })();
        if (!AsyncStorage) return;
        const keys = await AsyncStorage.getAllKeys();
        const pairs = await AsyncStorage.multiGet(keys);
        const entries = pairs.map(([key, value]) => ({ key, value }));
        send("storage", "storage:list", { entries });
      } catch (e) {}
    },
    remove: async (key) => {
      try {
        const AsyncStorage = global.AsyncStorage || (function () { try { return require("@react-native-async-storage/async-storage").default || require("react-native").AsyncStorage; } catch (e) { return null; } })();
        if (!AsyncStorage) return;
        await AsyncStorage.removeItem(key);
      } catch (e) {}
    },
    clear: async () => {
      try {
        const AsyncStorage = global.AsyncStorage || (function () { try { return require("@react-native-async-storage/async-storage").default || require("react-native").AsyncStorage; } catch (e) { return null; } })();
        if (AsyncStorage) await AsyncStorage.clear();
      } catch (e) {}
    }
  },
  app: {
    reload: () => {
      try {
        const DevSettings = require("react-native").DevSettings;
        if (DevSettings) DevSettings.reload();
      } catch (e) {}
    },
    deepLink: (url) => {
      try {
        const Linking = require("react-native").Linking;
        if (Linking) Linking.openURL(url);
      } catch (e) {}
    }
  }
});

startDebugger();

export { initDebugger, debuggerMiddleware, reportNavigation, reportNavigationEvent, disconnectDebugger };
