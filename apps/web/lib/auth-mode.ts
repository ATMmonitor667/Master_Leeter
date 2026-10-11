import { productionDeployment } from "./public-config";
export function authEnabled(): boolean {
  return (
    process.env["NEXT_PUBLIC_AUTH_MODE"] === "supabase" ||
    productionDeployment()
  );
}
