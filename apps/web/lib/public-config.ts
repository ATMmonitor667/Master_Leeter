const LOCAL_API = "http://localhost:4000";

export function productionDeployment(): boolean {
  return process.env.NEXT_PUBLIC_APP_ENV === "production" || process.env.NEXT_PUBLIC_APP_ENV === "preview";
}

function endpoint(value: string | undefined, fallback: string, protocols: readonly string[], name: string): URL {
  let parsed: URL;
  try { parsed = new URL(value || fallback); } catch { throw new Error(`${name} is invalid`); }
  if (!protocols.includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
    throw new Error(`${name} is invalid`);
  }
  if (productionDeployment() && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]")) {
    throw new Error(`${name} cannot use localhost in production`);
  }
  return parsed;
}

export function apiBaseUrl(): string {
  return endpoint(
    process.env.NEXT_PUBLIC_API_URL,
    LOCAL_API,
    productionDeployment() ? ["https:"] : ["http:", "https:"],
    "NEXT_PUBLIC_API_URL",
  ).origin;
}

export function apiUrl(path: string): string {
  return new URL(path, `${apiBaseUrl()}/`).toString();
}

export function webSocketBaseUrl(): string {
  const api = new URL(apiBaseUrl());
  const derived = `${api.protocol === "https:" ? "wss:" : "ws:"}//${api.host}`;
  return endpoint(
    process.env.NEXT_PUBLIC_WS_URL,
    derived,
    productionDeployment() ? ["wss:"] : ["ws:", "wss:"],
    "NEXT_PUBLIC_WS_URL",
  ).origin;
}
