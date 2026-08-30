export function parseAuthBrokerBaseUrl(candidate: string): string {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("Invalid auth broker URL.");
  }
  if (url.protocol !== "https:") throw new Error("Auth broker must use HTTPS.");
  if (
    candidate !== candidate.trim() ||
    /%(?:2e|2f|5c)/i.test(candidate) ||
    candidate.includes("\\") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !safePath(url.pathname)
  ) {
    throw new Error("Invalid auth broker URL.");
  }
  return url.pathname === "/"
    ? url.origin
    : `${url.origin}${url.pathname.replace(/\/$/, "")}`;
}

export function joinAuthBrokerPath(baseUrl: string, path: string): string {
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

function safePath(pathname: string) {
  if (pathname.includes("//")) return false;
  return pathname
    .split("/")
    .filter(Boolean)
    .every(
      (segment) =>
        /^[A-Za-z0-9._~-]+$/.test(segment) &&
        segment !== "." &&
        segment !== "..",
    );
}
