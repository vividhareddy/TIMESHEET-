// Starts the backend (which serves the React frontend itself via Vite middleware mode on the
// same port — see backend/src/server.ts) and opens the browser once, as soon as it responds.
// No extra dependencies: cross-platform browser launch and readiness polling use only Node builtins.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'backend');
const PORT = process.env.PORT || 5032;
const URL = `http://localhost:${PORT}`;

const child = spawn('npm', ['run', 'dev'], { cwd: backendDir, stdio: 'inherit', shell: true });

let childExited = false;
child.on('exit', (code) => {
  childExited = true;
  process.exit(code ?? 0);
});

function openBrowser(url) {
  console.log(`[dev] Opening ${url} in your browser...`);
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '""', url], { stdio: 'ignore', detached: true }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
  } else {
    spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
  }
}

async function waitForServerThenOpenBrowser() {
  while (!childExited) {
    try {
      const res = await fetch(`${URL}/api/health`);
      if (res.ok) {
        openBrowser(URL);
        return;
      }
    } catch {
      // Not listening yet — keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

void waitForServerThenOpenBrowser();
