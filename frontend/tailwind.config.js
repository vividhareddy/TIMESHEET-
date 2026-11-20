/** Colours come from CSS variables (src/index.css) so the whole palette switches between light and dark themes. */
const v = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;
const scale = (name) => Object.fromEntries(['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'].map((s) => [s, v(`${name}-${s}`)]));

/** @type {import('tailwindcss').Config} */
export default {
  // relative: the Express server (started from backend/) runs Vite, so paths must not depend on the working directory.
  content: { relative: true, files: ['./index.html', './src/**/*.{ts,tsx}'] },
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'Segoe UI', 'sans-serif'],
      },
      colors: {
        slate: scale('slate'),
        emerald: scale('emerald'),
        amber: scale('amber'),
        rose: scale('rose'),
        violet: scale('violet'),
        teal: scale('teal'),
        orange: scale('orange'),
        red: scale('red'),
        brand: scale('brand'),
        sidebar: {
          DEFAULT: v('sidebar-default'),
          hover: v('sidebar-hover'),
          active: v('sidebar-active'),
          border: v('sidebar-border'),
          muted: v('sidebar-muted'),
        },
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.04)',
        pop: '0 10px 30px -10px rgb(15 23 42 / 0.25)',
      },
    },
  },
  plugins: [],
};
