// ── Theme catalog ────────────────────────────────────────────────────────────
// Source of truth for themes Obligate offers in the theme selector.
// Apps consume `preferredTheme` (the id) from the SSO assertion and apply
// the matching local theme. The `tokens` / `perApp` / `fonts` blocks here
// are forwarded as-is so apps that don't ship their own implementation
// can render the theme from these values.

export type ThemeAppKey = 'obliview' | 'obliguard' | 'oblimap' | 'obliance' | 'obliplan' | 'oblidesk' | 'oblihub' | 'obliwan';

export interface ThemeAppAccent {
  accent: string;
  hover:  string;
  dark:   string;
}

export interface ThemeFonts {
  sans: string[];
  mono: string[];
}

export interface ThemeDefinition {
  id: string;
  name: string;
  description: string;
  isDefault: boolean;
  layoutVersion: string | null;
  tokens: Record<string, string>;
  perApp: Record<ThemeAppKey, ThemeAppAccent> | null;
  fonts: ThemeFonts | null;
}

// Default theme — Obli Operator (shared Obli palette).
export const OBLI_OPERATOR_THEME: ThemeDefinition = {
  id: 'obli-operator',
  name: 'Obli Operator',
  description: 'Default dark theme for the Obli suite — Rajdhani display + JetBrains Mono numerics, brighter type scale, depth via shadow (no borders), per-app accent.',
  isDefault: true,
  layoutVersion: 'v1',

  tokens: {
    '--c-bg-primary':       '11 13 26',
    '--c-bg-secondary':     '19 23 40',
    '--c-bg-tertiary':      '24 28 48',
    '--c-bg-hover':         '255 255 255 / 0.04',
    '--c-bg-active':        '255 255 255 / 0.06',
    '--c-border':           '255 255 255 / 0.05',
    '--c-border-light':     '255 255 255 / 0.08',
    '--c-text-primary':     '232 236 245',
    '--c-text-secondary':   '140 147 182',
    '--c-text-muted':       '75 82 115',

    '--c-status-up':        '30 221 138',
    '--c-status-down':      '107 115 153',
    '--c-status-pending':   '79 123 255',
    '--c-status-warning':   '245 166 35',
    '--c-status-critical':  '224 58 58',

    '--c-accent':           '224 58 58',
    '--c-accent-hover':     '255 104 104',
    '--c-accent-dark':      '180 30 30',
    '--c-primary':          '224 58 58',
  },

  perApp: {
    obliview:  { accent: '43 196 189',  hover: '95 217 211',  dark: '24 142 138' },
    obliguard: { accent: '245 166 35',  hover: '255 184 74',  dark: '184 124 24' },
    oblimap:   { accent: '30 221 138',  hover: '92 240 168',  dark: '20 165 105' },
    obliance:  { accent: '224 58 58',   hover: '255 104 104', dark: '180 30 30'  },
    obliplan:  { accent: '124 108 255', hover: '157 140 255', dark: '86 70 200'  },
    oblidesk:  { accent: '34 184 245',  hover: '95 208 255',  dark: '23 137 187' },
    oblihub:   { accent: '45 78 201',   hover: '90 120 232',  dark: '30 56 158'  },
    obliwan:   { accent: '144 164 174', hover: '176 190 197', dark: '96 125 139' },
  },

  fonts: {
    sans: ['Rajdhani', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
    mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace'],
  },
};

// Light companion to Obli Operator. Same spatial rhythm (no borders on cards,
// depth via shadow, Inter/JetBrains Mono fonts), but on a soft-white surface
// with an indigo default accent and per-app dot colors tuned for a light bg.
export const OBLI_DAYLIGHT_THEME: ThemeDefinition = {
  id: 'obli-daylight',
  name: 'Obli Daylight',
  description: 'Bright, soft light theme — friendly Inter type, subtle shadows, indigo default accent, same per-app accents as Obli Operator, tuned for readability on white.',
  isDefault: false,
  layoutVersion: 'v1',

  tokens: {
    '--c-bg-primary':       '250 251 253',   // #fafbfd  page bg
    '--c-bg-secondary':     '255 255 255',   // #ffffff  cards
    '--c-bg-tertiary':      '243 245 249',   // #f3f5f9  input/toolbar
    '--c-bg-hover':         '15 23 42 / 0.04',
    '--c-bg-active':        '15 23 42 / 0.07',
    '--c-border':           '15 23 42 / 0.08',
    '--c-border-light':     '15 23 42 / 0.12',
    '--c-text-primary':     '15 23 42',      // #0f172a slate-900
    '--c-text-secondary':   '71 85 105',     // slate-600
    '--c-text-muted':       '148 163 184',   // slate-400

    '--c-status-up':        '16 163 96',     // green-600
    '--c-status-down':      '148 163 184',
    '--c-status-pending':   '37 99 235',
    '--c-status-warning':   '217 119 6',
    '--c-status-critical':  '220 38 38',

    '--c-accent':           '79 70 229',     // #4f46e5 indigo-600
    '--c-accent-hover':     '99 102 241',    // indigo-500
    '--c-accent-dark':      '55 48 163',     // indigo-800
    '--c-primary':          '79 70 229',
  },

  // Slightly deeper variants for perApp dots so they read on white without
  // looking neon. Same identities as Obli Operator.
  perApp: {
    obliview:  { accent: '13 148 136',  hover: '20 184 166',  dark: '15 118 110' },   // teal
    obliguard: { accent: '217 119 6',   hover: '234 88 12',   dark: '154 52 18'  },   // amber-orange
    oblimap:   { accent: '22 163 74',   hover: '34 197 94',   dark: '21 128 61'  },   // green
    obliance:  { accent: '220 38 38',   hover: '239 68 68',   dark: '153 27 27'  },   // red
    obliplan:  { accent: '99 102 241',  hover: '129 140 248', dark: '67 56 202'  },   // indigo (softer than operator's violet)
    oblidesk:  { accent: '2 132 199',   hover: '14 165 233',  dark: '7 89 133'   },   // sky-600 (cyan tuned for white)
    oblihub:   { accent: '37 99 235',   hover: '59 130 246',  dark: '30 64 175'  },   // blue-600
    obliwan:   { accent: '96 125 139',  hover: '120 144 156', dark: '69 90 100'  },   // blue-grey-500 (300 is unreadable on white)
  },

  fonts: {
    sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
    mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace'],
  },
};

// Dark companion of Obli Daylight: Nord "Polar Night" neutrals (mid-dark slate,
// softer than Operator's near-black), so a second server can be told apart at a
// glance without switching to a light theme. It is a DARK theme for every
// light/dark decision (logo, charts, native controls). Dim changes NEUTRALS
// ONLY: accents (default + per app) and fonts are Operator's, by reference, so
// they can never diverge. Every token is a plain RGB triplet (no alpha).
export const OBLI_DIM_THEME: ThemeDefinition = {
  id: 'obli-dim',
  name: 'Obli Dim',
  description: 'Mid-dark slate theme (Nord Polar Night) — dark companion of Obli Daylight, softer than Obli Operator; same accents as Obli Operator, only the neutrals change.',
  isDefault: false,
  layoutVersion: 'v1',

  tokens: {
    '--c-bg-primary':       '46 52 64',      // #2e3440  page bg
    '--c-bg-secondary':     '59 66 82',      // #3b4252  cards / surfaces
    '--c-bg-tertiary':      '67 76 94',      // #434c5e  input/toolbar
    '--c-bg-hover':         '70 80 99',      // #465063  hover, one step above tertiary
    '--c-bg-active':        '74 84 104',     // #4a5468  active / selected
    '--c-border':           '76 86 106',     // #4c566a
    '--c-border-light':     '94 106 130',    // #5e6a82
    '--c-text-primary':     '236 239 244',   // #eceff4
    '--c-text-secondary':   '216 222 233',   // #d8dee9
    '--c-text-muted':       '163 171 188',   // #a3abbc

    '--c-status-up':        '108 203 143',   // #6ccb8f
    '--c-status-down':      '138 147 166',   // #8a93a6  offline (neutral, as in Operator)
    '--c-status-pending':   '136 166 224',   // #88a6e0  Nord blue
    '--c-status-warning':   '235 203 139',   // #ebcb8b
    '--c-status-critical':  '255 107 107',   // #ff6b6b

    '--c-accent':           '224 58 58',     // = Obli Operator
    '--c-accent-hover':     '255 104 104',
    '--c-accent-dark':      '180 30 30',
    '--c-primary':          '224 58 58',
  },

  // Same per-app accents as Obli Operator: the app in use keeps its colour.
  perApp: OBLI_OPERATOR_THEME.perApp,

  fonts: OBLI_OPERATOR_THEME.fonts,
};

// Legacy themes kept for users who chose them before obli-operator existed.
// CSS implementation lives in client/src/index.css (`[data-theme="modern"]` and
// `[data-theme="neon"]`); the catalog entries here are descriptors only.
export const OBLI_CLASSIC_THEME: ThemeDefinition = {
  id: 'modern',
  name: 'Modern UI',
  description: 'Original GitHub-inspired dark theme with gold accent.',
  isDefault: false,
  layoutVersion: null,
  tokens: {},
  perApp: null,
  fonts: null,
};

export const OBLI_NEON_THEME: ThemeDefinition = {
  id: 'neon',
  name: 'Neon UI',
  description: 'High-contrast neon variant with light gold accent.',
  isDefault: false,
  layoutVersion: null,
  tokens: {},
  perApp: null,
  fonts: null,
};

export const THEME_CATALOG: ThemeDefinition[] = [
  OBLI_OPERATOR_THEME,
  OBLI_DAYLIGHT_THEME,
  OBLI_DIM_THEME,
  OBLI_CLASSIC_THEME,
  OBLI_NEON_THEME,
];

export const DEFAULT_THEME_ID = OBLI_OPERATOR_THEME.id;

export function getThemeById(id: string): ThemeDefinition | undefined {
  return THEME_CATALOG.find(t => t.id === id);
}

export function getPerAppAccent(themeId: string, app: ThemeAppKey): ThemeAppAccent | null {
  const theme = getThemeById(themeId);
  return theme?.perApp?.[app] ?? null;
}
