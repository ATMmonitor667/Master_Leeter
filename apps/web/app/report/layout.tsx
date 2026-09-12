import type { ReactNode } from "react";
import { AuthBoundary } from "../../components/AuthBoundary";
export default function ReportLayout({ children }: { children: ReactNode }) {
  return <AuthBoundary>{children}</AuthBoundary>;
}
