import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface IdentityAdmin { deleteUser(userId: string): Promise<void> }

export class SupabaseIdentityAdmin implements IdentityAdmin {
  private readonly client: SupabaseClient;
  constructor(url: string, secretKey: string) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error("IDENTITY_CONFIGURATION"); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" ||
        parsed.search || parsed.hash || (!secretKey.startsWith("sb_secret_") && secretKey.split(".").length !== 3)) {
      throw new Error("IDENTITY_CONFIGURATION");
    }
    this.client = createClient(parsed.origin, secretKey, { auth: { autoRefreshToken: false, persistSession: false } });
  }
  async deleteUser(userId: string): Promise<void> {
    const result = await this.client.auth.admin.deleteUser(userId, false);
    if (result.error) throw new Error("IDENTITY_DELETION_FAILED");
  }
}

export function identityAdminFromEnv(env: NodeJS.ProcessEnv): IdentityAdmin | undefined {
  const url = env["SUPABASE_URL"]?.trim();
  const key = (env["SUPABASE_SECRET_KEY"] || env["SUPABASE_SERVICE_ROLE_KEY"])?.trim();
  return url && key ? new SupabaseIdentityAdmin(url, key) : undefined;
}
