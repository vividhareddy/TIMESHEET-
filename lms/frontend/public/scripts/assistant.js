// TimeTrack Assistant inside the LMS: a chat button that opens the timesheet's assistant in a frame
// (TIMESHEET_URL/assistant/embed). The assistant itself lives in the timesheet app, so both portals share one
// assistant and one sign-in. Shown only to signed-in LMS users, and only when the LMS knows the timesheet address.
(function () {
  'use strict';
  const CLOSE_MESSAGE = 'timetrack-assistant:close';
  let embedUrl = null;
  let button = null;
  let panel = null;
  let frame = null;
  let isOpen = false;
  let checking = false;

  const chatIcon =
    '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>';
  const closeIcon =
    '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

  async function readSession() {
    try {
      const response = await fetch('api/session', { credentials: 'same-origin', headers: { 'X-Portal-Request': '1' } });
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  }

  function render() {
    if (!button) return;
    button.classList.toggle('is-open', isOpen);
    button.setAttribute('aria-expanded', String(isOpen));
    button.setAttribute('aria-label', isOpen ? 'Close TimeTrack Assistant' : 'Open TimeTrack Assistant');
    button.querySelector('.tt-assistant-icon').innerHTML = isOpen ? closeIcon : chatIcon;
    panel.hidden = !isOpen;
  }

  function toggle(force) {
    isOpen = typeof force === 'boolean' ? force : !isOpen;
    if (isOpen && !frame) {
      // The frame is created on first open, so the LMS does not load the assistant until someone wants it.
      frame = document.createElement('iframe');
      frame.src = embedUrl;
      frame.title = 'TimeTrack Assistant';
      frame.setAttribute('allow', 'clipboard-write');
      panel.appendChild(frame);
    }
    render();
    if (isOpen) frame.focus();
    else button.focus();
  }

  function build() {
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'tt-assistant-button';
    button.innerHTML = '<span class="tt-assistant-icon"></span><span class="tt-assistant-label">Need a hand?</span>';
    button.addEventListener('click', () => toggle());

    panel = document.createElement('div');
    panel.className = 'tt-assistant-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'TimeTrack Assistant');
    panel.hidden = true;

    document.body.append(panel, button);
    render();
  }

  function remove() {
    button?.remove();
    panel?.remove();
    button = panel = frame = null;
    isOpen = false;
  }

  /** Shows the button for a signed-in user and removes it after sign-out. */
  async function sync() {
    if (checking) return;
    checking = true;
    const session = await readSession();
    checking = false;
    const signedIn = Boolean(session && session.user && session.timesheetUrl);
    if (signedIn && !button) {
      embedUrl = session.timesheetUrl.replace(/\/+$/, '') + '/assistant/embed';
      build();
    } else if (!signedIn && button) {
      remove();
    }
  }

  window.addEventListener('message', (event) => {
    if (!embedUrl || event.origin !== new URL(embedUrl, location.href).origin) return;
    if (event.data && event.data.type === CLOSE_MESSAGE) toggle(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen) toggle(false);
  });
  // Sign-in and sign-out change the page's #route, so the session is checked again then.
  window.addEventListener('hashchange', () => void sync());
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void sync());
  else void sync();
})();
