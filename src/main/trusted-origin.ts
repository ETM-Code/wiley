const TRUSTED_HTTP_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\//;

/**
 * The only origins allowed to drive the main process: the packaged app
 * protocol and a local dev server. Shared by the navigation/permission
 * handlers and the IPC sender check so the two can never drift apart.
 */
export function isTrustedOrigin(url: string): boolean {
  return url.startsWith("wiley://app/") || TRUSTED_HTTP_ORIGIN.test(url);
}
