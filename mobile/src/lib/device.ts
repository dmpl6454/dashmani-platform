// Native device helpers. Screens import these — never the native modules directly —
// so every call is web-safe and never throws.
import { Linking, Platform } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import * as WebBrowser from "expo-web-browser";

export type HapticKind = "success" | "warning" | "error" | "selection" | "impact";

/** Light tactile feedback. No-op on web and wherever haptics are unavailable. */
export async function haptic(kind: HapticKind): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    switch (kind) {
      case "success":
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        return;
      case "warning":
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        return;
      case "error":
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      case "selection":
        await Haptics.selectionAsync();
        return;
      case "impact":
      default:
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        return;
    }
  } catch {
    /* haptics unavailable */
  }
}

/** Clipboard text, or null when empty, denied or unavailable. */
export async function readClipboardText(): Promise<string | null> {
  try {
    let text: string;
    if (Platform.OS === "web") {
      if (typeof navigator === "undefined" || !navigator.clipboard || !navigator.clipboard.readText) return null;
      text = await navigator.clipboard.readText();
    } else {
      text = await Clipboard.getStringAsync();
    }
    return typeof text === "string" && text.trim() ? text : null;
  } catch {
    return null;
  }
}

/** Open a document / file URL: in-app browser on native, a new tab on web. */
export async function openFile(url: string): Promise<void> {
  if (!url) return;
  if (Platform.OS === "web") {
    try {
      await Linking.openURL(url);
    } catch {
      /* the browser blocked it */
    }
    return;
  }
  try {
    await WebBrowser.openBrowserAsync(url);
  } catch {
    try {
      await Linking.openURL(url);
    } catch {
      /* nothing on the device can open it */
    }
  }
}
