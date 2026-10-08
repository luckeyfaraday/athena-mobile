// Theme registry, mirroring context-workspace client/src/themes.ts. The colors
// live in styles/themes.css (copied from the desktop) as token blocks keyed by
// [data-theme]; this file names them and resolves the phone's preference.

export const themeIds = [
  "classic",
  "daylight",
  "nightfall",
  "fjord",
  "dusk",
  "ember",
  "neon",
  "solstice",
  "monolith",
  "press",
  "mono-dark",
  "mono-light",
  "contrast",
] as const;

export type ThemeId = (typeof themeIds)[number];
/** "laptop" follows desktop Athena's theme on the laptop; "system" follows the phone's light/dark setting. */
export type ThemePreference = ThemeId | "system" | "laptop";
export type ThemeAppearance = "dark" | "light";

export type ThemeDefinition = {
  id: ThemeId;
  label: string;
  description: string;
  appearance: ThemeAppearance;
};

export const themes: readonly ThemeDefinition[] = [
  { id: "classic", label: "Classic", appearance: "dark", description: "Athena's forest green with a gold signal. The original." },
  { id: "daylight", label: "Daylight", appearance: "light", description: "Warm paper and forest ink. Athena in daylight." },
  { id: "nightfall", label: "Nightfall", appearance: "dark", description: "Deep navy with an electric blue edge." },
  { id: "fjord", label: "Fjord", appearance: "dark", description: "Arctic slate and glacier cyan. Soft and calm." },
  { id: "dusk", label: "Dusk", appearance: "dark", description: "Plum night lit with rose and lavender." },
  { id: "ember", label: "Ember", appearance: "dark", description: "Charcoal and forge orange for long sessions." },
  { id: "neon", label: "Neon", appearance: "dark", description: "Synthwave violet, hot pink, and cyan glow." },
  { id: "solstice", label: "Solstice", appearance: "dark", description: "Solarized depths with sunlit cream text." },
  { id: "monolith", label: "Monolith", appearance: "dark", description: "Void black, acid lime, and hard edges." },
  { id: "press", label: "Press", appearance: "dark", description: "Warm editorial ink, serif headings, vermillion." },
  { id: "mono-dark", label: "Mono Dark", appearance: "dark", description: "Pure graphite. White is the only accent." },
  { id: "mono-light", label: "Mono Light", appearance: "light", description: "Paper white. Black is the only accent." },
  { id: "contrast", label: "High Contrast", appearance: "dark", description: "Pure black, bright text, signal yellow. Built for legibility." },
];

// What "Match system" resolves to, as on the desktop.
export const systemThemes: Record<ThemeAppearance, ThemeId> = { dark: "classic", light: "daylight" };

export const DEFAULT_THEME_PREFERENCE: ThemePreference = "laptop";

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && (themeIds as readonly string[]).includes(value);
}

export function parseThemePreference(value: unknown): ThemePreference | null {
  if (value === "system" || value === "laptop") return value;
  return isThemeId(value) ? value : null;
}

/**
 * The theme to paint. `laptopTheme` is desktop Athena's own preference string:
 * a theme id, "system" (here, the phone's own light/dark setting, since that is
 * the screen in front of you), or null when it never saved one, which the
 * desktop paints as Classic.
 */
export function resolveTheme(preference: ThemePreference, laptopTheme: string | null, systemPrefersLight: boolean): ThemeId {
  if (preference === "laptop") {
    if (isThemeId(laptopTheme)) return laptopTheme;
    return laptopTheme === "system" ? systemThemes[systemPrefersLight ? "light" : "dark"] : "classic";
  }
  if (preference === "system") return systemThemes[systemPrefersLight ? "light" : "dark"];
  return preference;
}

export function themeDefinition(id: ThemeId): ThemeDefinition {
  return themes.find((theme) => theme.id === id) ?? themes[0];
}

const THEME_KEY = "athena.theme";
const LAPTOP_THEME_KEY = "athena.laptopTheme";

export function readThemePreference(): ThemePreference {
  return parseThemePreference(readStored(THEME_KEY)) ?? DEFAULT_THEME_PREFERENCE;
}

export function writeThemePreference(preference: ThemePreference): void {
  writeStored(THEME_KEY, preference);
}

/** The laptop's theme from the last machines answer, so a cold start paints it before any fetch. */
export function readLaptopTheme(): string | null {
  return readStored(LAPTOP_THEME_KEY);
}

export function writeLaptopTheme(theme: string | null): void {
  if (theme) writeStored(LAPTOP_THEME_KEY, theme);
}

export function systemPrefersLight(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: light)").matches;
}

/** Paint a theme on the whole document and tint the phone's status bar to match. */
export function applyTheme(theme: ThemeId): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  const background = getComputedStyle(root).getPropertyValue("--bg").trim();
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta && background) meta.content = background;
}

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the choice lasts until the app reloads.
  }
}
