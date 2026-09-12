import type { ReactNode } from "react";
import { AuthBoundary } from "../../components/AuthBoundary";
export default function InterviewLayout({ children }: { children: ReactNode }) {
  return <AuthBoundary>{children}</AuthBoundary>;
}
