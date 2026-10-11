/** Load authentication only when a request actually needs it. */
export { SignInRequired } from "./auth-error";
export async function apiFetch(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const auth = await import("./auth");
  return auth.apiFetch(input, init);
}
