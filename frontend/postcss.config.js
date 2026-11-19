import { fileURLToPath } from 'node:url';

// The Express server (started from backend/) runs Vite, so point Tailwind at its config explicitly instead of
// letting it search the working directory.
export default {
  plugins: {
    tailwindcss: { config: fileURLToPath(new URL('./tailwind.config.js', import.meta.url)) },
    autoprefixer: {},
  },
};
