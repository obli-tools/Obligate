/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: {
          primary:   'rgb(var(--c-bg-primary)   / <alpha-value>)',
          secondary: 'rgb(var(--c-bg-secondary) / <alpha-value>)',
          tertiary:  'rgb(var(--c-bg-tertiary)  / <alpha-value>)',
          hover:     'rgb(var(--c-bg-hover)     / <alpha-value>)',
          active:    'rgb(var(--c-bg-active)    / <alpha-value>)',
        },
        border: {
          DEFAULT: 'rgb(var(--c-border)       / <alpha-value>)',
          light:   'rgb(var(--c-border-light) / <alpha-value>)',
        },
        text: {
          primary:   'rgb(var(--c-text-primary)   / <alpha-value>)',
          secondary: 'rgb(var(--c-text-secondary) / <alpha-value>)',
          muted:     'rgb(var(--c-text-muted)     / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'rgb(var(--c-accent)       / <alpha-value>)',
          hover:   'rgb(var(--c-accent-hover) / <alpha-value>)',
          dark:    'rgb(var(--c-accent-dark)  / <alpha-value>)',
          text:    'rgb(var(--c-accent-text)  / <alpha-value>)',
        },
        primary: 'rgb(var(--c-primary) / <alpha-value>)',
        status: {
          up:       'rgb(var(--c-status-up)      / <alpha-value>)',
          'up-bg':  'rgb(var(--c-status-up-bg)   / <alpha-value>)',
          down:     'rgb(var(--c-status-down)     / <alpha-value>)',
          'down-bg':'rgb(var(--c-status-down-bg)  / <alpha-value>)',
          warning:  'rgb(var(--c-status-warning) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans:    ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        display: ['Rajdhani', 'Inter', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono:    ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 0 0 rgba(255,255,255,0.03), 0 6px 24px -8px rgba(0,0,0,0.45)',
        glow: '0 0 0 1px rgb(var(--c-accent) / 0.18) inset, 0 6px 28px -10px rgb(var(--c-accent) / 0.25)',
      },
    },
  },
  plugins: [],
};
