import type { SVGProps } from "react";
export type IconName =
  | "mic"
  | "mic-off"
  | "code"
  | "notes"
  | "captions"
  | "check"
  | "arrow"
  | "close"
  | "clock"
  | "history"
  | "settings"
  | "info"
  | "alert"
  | "download"
  | "trash"
  | "more"
  | "sun"
  | "moon"
  | "monitor"
  | "play"
  | "stop"
  | "speaker"
  | "chevron"
  | "drag"
  | "external";
export function Icon({
  name,
  ...props
}: SVGProps<SVGSVGElement> & { name: IconName }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <use href={"/icons.svg#" + name} />
    </svg>
  );
}
