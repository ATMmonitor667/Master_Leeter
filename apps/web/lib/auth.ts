import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { apiBaseUrl } from "./public-config";
import { authEnabled } from "./auth-mode";
import { SignInRequired } from "./auth-error";
export { authEnabled, SignInRequired };

let client: SupabaseClient | undefined;
export function authClient(): SupabaseClient {
  if (client) return client;
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  const key = process.env["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"];
  if (!url || !key || key.startsWith("sb_secret_"))
    throw new Error("Sign-in is unavailable. Please try again later.");
  client = createClient(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
  return client;
}

/** Credentials are attached only to the configured API origin. */
export async function apiFetch(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const api = new URL(apiBaseUrl());
  const url = new URL(input, api);
  if (url.origin !== api.origin) throw new Error("Unexpected API destination");
  if (!authEnabled())
    return fetch(url.toString(), { ...init, redirect: "error" });
  const auth = authClient().auth;
  const { data, error } = await auth.getSession();
  if (error || !data.session) throw new SignInRequired();
  const send = (token: string) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    return fetch(url.toString(), {
      ...init,
      headers,
      cache: "no-store",
      redirect: "error",
    });
  };
  const response = await send(data.session.access_token);
  if (response.status !== 401) return response;
  const refreshed = await auth.refreshSession();
  if (refreshed.error && (refreshed.error.name === "AuthRetryableFetchError" ||
      refreshed.error.status === 429 || (refreshed.error.status ?? 0) >= 500)) {
    throw new Error("The sign-in service is temporarily unavailable. Please retry.");
  }
  const requireSignIn = async (): Promise<never> => {
    // A rejected cached session otherwise makes /login redirect immediately
    // back to the protected page, which sends the candidate to /login again.
    await auth.signOut({ scope: "local" });
    throw new SignInRequired();
  };
  if (refreshed.error || !refreshed.data.session) return requireSignIn();
  const retry = await send(refreshed.data.session.access_token);
  if (retry.status === 401) return requireSignIn();
  return retry;
}
