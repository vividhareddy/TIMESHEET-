/**
 * Remembers (in memory only) that the user has just signed in, so the assistant greets them once after sign-in
 * and not on every page reload while a session is restored.
 */
let pending = false;

export function markSignedIn(): void {
  pending = true;
}

/** True once after each sign-in. */
export function takeSignInGreeting(): boolean {
  const value = pending;
  pending = false;
  return value;
}
