// Client-side Web Push enrollment. Talks to the notifier middleware mounted by
// the Vite dev server at /athena-push/*. Requires a secure context (HTTPS or
// localhost) — over plain-HTTP Tailscale the browser exposes no PushManager, so
// every call here short-circuits with a clear reason.

export type PushState = "unsupported" | "insecure" | "default" | "granted" | "denied";

export type EnableResult = { ok: boolean; state: PushState; error?: string };

const PUSH_BASE = "/athena-push";

export function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  if (!window.isSecureContext) return "insecure";
  const permission = Notification.permission;
  if (permission === "granted") {
    // Granted but the subscription may have been dropped; surface as default so
    // the UI re-offers enrollment.
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return sub ? "granted" : "default";
  }
  return permission;
}

export async function enablePush(): Promise<EnableResult> {
  if (!pushSupported()) return { ok: false, state: "unsupported" };
  if (!window.isSecureContext) return { ok: false, state: "insecure" };

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return { ok: false, state: permission };

  try {
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await fetchJson<{ publicKey: string }>(`${PUSH_BASE}/vapid`);
    const existing = await reg.pushManager.getSubscription();
    const subscription =
      existing ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      }));
    await fetchJson(`${PUSH_BASE}/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscription.toJSON()),
    });
    return { ok: true, state: "granted" };
  } catch (error) {
    return { ok: false, state: "granted", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await fetchJson(`${PUSH_BASE}/unsubscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

export async function sendTestPush(): Promise<void> {
  await fetchJson(`${PUSH_BASE}/test`, { method: "POST" });
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}

// The VAPID public key is delivered base64url; PushManager needs the raw bytes
// as an ArrayBuffer-backed BufferSource.
function urlBase64ToUint8Array(base64Url: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i += 1) view[i] = raw.charCodeAt(i);
  return buffer;
}
