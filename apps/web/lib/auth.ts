import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { apiBaseUrl, productionDeployment } from "./public-config";

let client: SupabaseClient | undefined;
export function authEnabled(): boolean {
  return process.env["NEXT_PUBLIC_AUTH_MODE"] === "supabase" || productionDeployment();
}
export function authClient(): SupabaseClient {
  if (client) return client;
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  const key = process.env["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"];
  if (!url || !key || key.startsWith("sb_secret_")) throw new Error("Sign-in is unavailable. Please try again later.");
  client = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
  return client;
}

export class SignInRequired extends Error {
  constructor() { super("Please sign in to continue."); }
}

/** Credentials are attached only to the configured API origin. */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const api = new URL(apiBaseUrl());
  const url = new URL(input, api);
  if (url.origin !== api.origin) throw new Error("Unexpected API destination");
  if (!authEnabled()) return fetch(url.toString(), { ...init, redirect: "error" });
  const auth = authClient().auth;
  const { data, error } = await auth.getSession();
  if (error || !data.session) throw new SignInRequired();
  const send = (token: string) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    return fetch(url.toString(), { ...init, headers, cache: "no-store", redirect: "error" });
  };
  const response = await send(data.session.access_token);
  if (response.status !== 401) return response;
  const refreshed = await auth.refreshSession();
  if (refreshed.error || !refreshed.data.session) throw new SignInRequired();
  const retry = await send(refreshed.data.session.access_token);
  if (retry.status === 401) throw new SignInRequired();
  return retry;
}
