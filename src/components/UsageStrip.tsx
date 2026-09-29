import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { AlertTriangle, RefreshCw, X } from "lucide-react";
import type { AthenaClient } from "../api/athenaClient";
import type { UsageAccount, UsageSnapshot, UsageWindow } from "../types";
import {
  accountTitle,
  chipLabel,
  chipWindows,
  clockOffsetMs,
  compactAccountLabel,
  compactAriaLabel,
  formatAge,
  formatDuration,
  formatPercent,
  formatResetCountdown,
  headlineWindow,
  isLive,
  openWindows,
  presentSnapshot,
  statusLabel,
  usageLevel,
  usagePollDelay,
} from "../usage";

// Subscription quota bars under the header. The laptop's backend owns provider
// logins and a shared cache; this only polls that cache (faster while a probe
// is running, paused while the app is in the background).

type RefreshFailure = { accountKey: string | null; message: string };

function useUsage(client: AthenaClient) {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [receivedAt, setReceivedAt] = useState<number | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<RefreshFailure | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const rescheduleRef = useRef<((delayMs: number) => void) | null>(null);
  // Responses are applied in the order their requests were issued, so a poll
  // sent before a refresh cannot land afterwards and undo it.
  const issuedRef = useRef(0);
  const appliedRef = useRef(0);
  const latestRef = useRef<UsageSnapshot | null>(null);

  const apply = useCallback((sequence: number, next: UsageSnapshot) => {
    if (sequence < appliedRef.current) return false;
    appliedRef.current = sequence;
    latestRef.current = next;
    setSnapshot(next);
    setReceivedAt(Date.now());
    setPollError(null);
    return true;
  }, []);

  useEffect(() => {
    let active = true;
    let loading = false;
    let timer: number | undefined;
    const load = async () => {
      window.clearTimeout(timer);
      if (loading || document.visibilityState === "hidden") return;
      loading = true;
      const sequence = ++issuedRef.current;
      let unsupported = false;
      try {
        const next = await client.usage();
        if (active && apply(sequence, next)) setRefreshError(null);
      } catch (loadError) {
        const message = messageOf(loadError);
        // A host whose Athena predates usage monitoring answers 404 forever;
        // stop asking until the app comes back to the foreground.
        unsupported = message.startsWith("404");
        if (active && sequence >= appliedRef.current) {
          appliedRef.current = sequence;
          if (unsupported) {
            latestRef.current = null;
            setSnapshot(null);
            setPollError(null);
          } else {
            setPollError(message);
          }
        }
      } finally {
        loading = false;
      }
      if (active && !unsupported) timer = window.setTimeout(() => void load(), usagePollDelay(latestRef.current));
    };
    rescheduleRef.current = (delayMs) => {
      if (loading) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), delayMs);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void load();
    };
    void load();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      rescheduleRef.current = null;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [client, apply]);

  const refresh = useCallback(
    async (accountKey?: string) => {
      setRefreshing(true);
      setRefreshError(null);
      const sequence = ++issuedRef.current;
      try {
        const next = await client.refreshUsage(accountKey);
        // Keep following a probe that is still running instead of idling for a minute.
        if (apply(sequence, next)) rescheduleRef.current?.(usagePollDelay(next));
      } catch (error) {
        setRefreshError({ accountKey: accountKey ?? null, message: messageOf(error) });
      } finally {
        setRefreshing(false);
      }
    },
    [client, apply],
  );

  return { snapshot, receivedAt, pollError, refreshError, refreshing, refresh };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick, intervalMs);
    // Back from the background, countdowns and staleness must not wait for the next tick.
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [intervalMs]);
  return now;
}

export function UsageStrip({ client }: { client: AthenaClient }) {
  const { snapshot: received, receivedAt, pollError, refreshError, refreshing, refresh } = useUsage(client);
  const now = useNow(30_000);
  const snapshot = presentSnapshot(received, {
    receivedAt,
    now,
    pollFailed: pollError !== null,
    unreachableMessage: "Couldn't reach the laptop; showing the last values it reported.",
  });
  // Reset times and ages are laptop timestamps; read them on the laptop's clock.
  const hostNow = now + clockOffsetMs(received, receivedAt);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const accounts = snapshot?.accounts ?? [];
  const selected = accounts.find((account) => account.key === openKey) ?? null;

  // An account that drops out of the snapshot closes its sheet for good,
  // rather than leaving a closed-but-selected sheet to pop back open later.
  useEffect(() => {
    if (openKey !== null && received !== null && !selected) setOpenKey(null);
  }, [openKey, received, selected]);

  // Before the first answer, or on a host whose Athena predates usage
  // monitoring, the strip stays out of the way; the app banner covers outages.
  if (accounts.length === 0) return null;

  const errorFor = (account: UsageAccount): string | null => {
    if (pollError) return `Laptop error: ${pollError}`;
    if (refreshError && (refreshError.accountKey === null || refreshError.accountKey === account.key)) {
      return `Refresh failed: ${refreshError.message}`;
    }
    return null;
  };
  const close = () => {
    setOpenKey(null);
    triggerRef.current?.focus();
  };

  return (
    <>
      <div className="usageStrip" role="group" aria-label="Subscription usage">
        {accounts.map((account) => (
          <UsageChip
            key={account.key}
            account={account}
            accounts={accounts}
            now={hostNow}
            onOpen={(button) => {
              triggerRef.current = button;
              setOpenKey(account.key);
            }}
          />
        ))}
      </div>
      {selected && (
        <UsageSheet
          account={selected}
          accounts={accounts}
          now={hostNow}
          refreshing={refreshing}
          error={errorFor(selected)}
          onSelect={setOpenKey}
          onRefresh={refresh}
          onClose={close}
        />
      )}
    </>
  );
}

function UsageChip({
  account,
  accounts,
  now,
  onOpen,
}: {
  account: UsageAccount;
  accounts: UsageAccount[];
  now: number;
  onOpen: (button: HTMLButtonElement) => void;
}) {
  const headline = headlineWindow(account, now);
  const windows = chipWindows(account, now);
  const profile = chipLabel(account, accounts);
  const label = compactAriaLabel(account, accounts, now);
  return (
    <button
      type="button"
      className={`usageChip ${account.provider}${isLive(account) ? "" : " notLive"}`}
      aria-haspopup="dialog"
      aria-label={label}
      onClick={(event) => onOpen(event.currentTarget)}
    >
      <span className="usageChipHead">
        <span className={`providerDot ${account.provider}`} aria-hidden="true" />
        <span className="usageChipName">{account.provider_name}</span>
        {profile && <span className="usageChipProfile">{profile}</span>}
        <strong className={headline ? `level-${usageLevel(headline.used_percent)}` : undefined}>
          {headline ? formatPercent(headline.used_percent) : account.status === "loading" ? "…" : "—"}
        </strong>
      </span>
      {windows.length > 0 ? (
        <span className="usageTracks" aria-hidden="true">
          {windows.map((window) => (
            <span key={window.id} className="usageTrack">
              <span className={`usageFill level-${usageLevel(window.used_percent)}`} style={{ width: `${window.used_percent}%` }} />
            </span>
          ))}
        </span>
      ) : (
        <span className={`usageChipNote status-${account.status}`}>{statusLabel(account)}</span>
      )}
    </button>
  );
}

function UsageSheet({
  account,
  accounts,
  now,
  refreshing,
  error,
  onSelect,
  onRefresh,
  onClose,
}: {
  account: UsageAccount;
  accounts: UsageAccount[];
  now: number;
  refreshing: boolean;
  error: string | null;
  onSelect: (key: string) => void;
  onRefresh: (accountKey?: string) => Promise<void>;
  onClose: () => void;
}) {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    sheetRef.current?.focus();
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if ((event.key === "ArrowRight" || event.key === "ArrowLeft") && (event.target as Element).getAttribute("role") === "tab") {
      const index = accounts.findIndex((item) => item.key === account.key);
      const next = accounts[(index + (event.key === "ArrowRight" ? 1 : accounts.length - 1)) % accounts.length];
      onSelect(next.key);
      window.requestAnimationFrame(() => sheetRef.current?.querySelector<HTMLElement>(`[data-usage-tab="${next.key}"]`)?.focus());
    }
  };

  const windows = openWindows(account, now);
  const busy = refreshing || account.refreshing;
  const titleId = `usage-sheet-${account.key.replace(/[^a-z0-9]/gi, "")}`;
  const nextCheck = account.next_refresh_at ? Math.max(0, (Date.parse(account.next_refresh_at) - now) / 1000) : null;

  return (
    <div className="sheetBackdrop" onClick={onClose}>
      <div
        className={`sheet usageSheet ${account.provider}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={sheetRef}
        onKeyDown={onKeyDown}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheetHead">
          <div>
            <strong id={titleId}>
              {account.provider_name}
              {account.plan && <span className="usagePlan">{account.plan}</span>}
            </strong>
            <small>{accountTitle(account)}{account.account.organization ? ` · ${account.account.organization}` : ""}</small>
          </div>
          <button className="iconButton" type="button" onClick={onClose} aria-label="Close usage details">
            <X size={18} />
          </button>
        </div>

        {accounts.length > 1 && (
          <div className="usageTabs" role="tablist" aria-label="Accounts">
            {accounts.map((item) => (
              <button
                key={item.key}
                type="button"
                role="tab"
                data-usage-tab={item.key}
                aria-selected={item.key === account.key}
                tabIndex={item.key === account.key ? 0 : -1}
                className={item.key === account.key ? "usageTab active" : "usageTab"}
                onClick={() => onSelect(item.key)}
              >
                <span className={`providerDot ${item.provider}`} aria-hidden="true" />
                {compactAccountLabel(item, accounts)}
              </button>
            ))}
          </div>
        )}

        <div className="usageSheetBody" role="tabpanel" aria-labelledby={titleId}>
          <p className={`usageStatus status-${account.status}${account.stale ? " stale" : ""}`}>
            <i aria-hidden="true" />
            {/* Only the status is live; the ticking age would be re-announced every minute. */}
            <strong role="status">{statusLabel(account)}</strong>
            {account.fetched_at && <span> · updated {formatAge(account.fetched_at, now)}</span>}
          </p>
          {account.message && (
            <p className="usageMessage">
              <AlertTriangle size={13} aria-hidden="true" />
              {account.message}
            </p>
          )}

          {windows.length > 0 ? (
            <ul className={account.stale ? "usageWindows stale" : "usageWindows"}>
              {windows.map((window) => (
                <UsageWindowRow key={window.id} window={window} now={now} stale={account.stale} />
              ))}
            </ul>
          ) : (
            (account.status === "loading" || account.status === "ok") && (
              <p className="usageEmptyNote">
                {account.status === "loading" ? "Reading quota windows…" : "No quota window is open right now; the next check reads the new ones."}
              </p>
            )
          )}

          <div className="usageProfiles">
            <span>{account.profiles.length > 1 ? "Profiles" : "Profile"}</span>
            {account.profiles.map((profile) => (
              <p key={profile.path}>
                <strong>{profile.label}</strong> <code>{profile.path}</code>
              </p>
            ))}
          </div>

          <div className="usageSheetFoot">
            <button type="button" className="ghostButton" onClick={() => void onRefresh(account.key)} disabled={busy}>
              <RefreshCw size={14} className={busy ? "spinning" : undefined} aria-hidden="true" />
              {busy ? "Refreshing…" : "Refresh"}
            </button>
            <span>{nextCheck !== null && !busy ? `Next check in ${formatDuration(nextCheck)}` : ""}</span>
          </div>
          {error && <p className="usageMessage">{error}</p>}
          <p className="usageFootnote">Limits reported by each provider for the laptop's signed-in CLIs. Local transcript token counts are not included.</p>
        </div>
      </div>
    </div>
  );
}

function UsageWindowRow({ window, now, stale }: { window: UsageWindow; now: number; stale: boolean }) {
  const percent = formatPercent(window.used_percent);
  const reset = formatResetCountdown(window.resets_at, now);
  return (
    <li className="usageWindow">
      <div className="usageWindowHead">
        <span>{window.label}</span>
        <strong className={`level-${usageLevel(window.used_percent)}`}>{percent}</strong>
      </div>
      <div
        className="usageTrack large"
        role="meter"
        aria-label={`${window.label} limit`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(window.used_percent)}
        aria-valuetext={`${percent} used${stale ? ", last known value" : ""}. ${reset}`}
      >
        <span className={`usageFill level-${usageLevel(window.used_percent)}`} style={{ width: `${window.used_percent}%` }} />
      </div>
      <small>{reset}</small>
    </li>
  );
}
