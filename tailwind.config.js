/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'Segoe UI', 'sans-serif'],
      },
      colors: {
        sidebar: {
          DEFAULT: '#1e293b',
          hover: '#273449',
          active: '#334155',
          border: '#2c3a50',
          muted: '#94a3b8',
        },
        brand: {
          50: '#eef4fb',
          100: '#d9e6f5',
          200: '#b6cdea',
          500: '#3b6db3',
          600: '#2f5c9e',
          700: '#274c83',
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
