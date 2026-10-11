"use client";
import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  type ReactNode,
} from "react";
import s from "./Primitives.module.css";
import { Icon, type IconName } from "./Icon";
export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
}) {
  return (
    <button
      {...props}
      type={props.type ?? "button"}
      disabled={props.disabled || loading}
      aria-busy={loading}
      data-variant={variant}
      data-size={size}
      className={s.button}
    >
      {loading && <Icon name="clock" />}
      {children}
    </button>
  );
}
export function IconButton({
  icon,
  label,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: IconName;
  label: string;
}) {
  return (
    <button
      {...props}
      type={props.type ?? "button"}
      className={`${s.button} ${s.iconButton}`}
      aria-label={label}
    >
      <Icon name={icon} />
    </button>
  );
}
export function Card({ children, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <section {...props} className={s.card}>
      {children}
    </section>
  );
}
export const Panel = Card;
export function Skeleton({ height = 20 }: { height?: number }) {
  return <span aria-hidden className={s.skeleton} style={{ height }} />;
}
export function Badge({ children }: { children: ReactNode }) {
  return <span className={s.badge}>{children}</span>;
}
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: (props: {
    id: string;
    "aria-describedby": string;
    "aria-invalid": boolean;
  }) => ReactNode;
}) {
  const id = useId();
  return (
    <div className={s.field}>
      <label htmlFor={id}>{label}</label>
      {children({
        id,
        "aria-describedby": `${id}-hint`,
        "aria-invalid": !!error,
      })}
      <span id={`${id}-hint`} className={error ? s.error : s.hint}>
        {error ?? hint}
      </span>
    </div>
  );
}
export function RadioCard({
  title,
  description,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  title: string;
  description: string;
}) {
  return (
    <label className={s.radio}>
      <input {...props} type="radio" />
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
    </label>
  );
}
export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} />;
}
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} />;
}
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} />;
}
export function Checkbox({
  label,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className={s.check}>
      <input {...props} type="checkbox" />
      {label}
    </label>
  );
}
export function Switch({
  label,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className={s.check}>
      <input {...props} type="checkbox" role="switch" />
      {label}
    </label>
  );
}
/** Native disclosure works with Enter, Space and touch without a focus trap. */
export function Popover({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <details className={s.popover}>
      <summary>{label}</summary>
      <div>{children}</div>
    </details>
  );
}
export function Meter({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <span>
        {label}: {Math.round(value)}%
      </span>
      <meter
        className={s.meter}
        min={0}
        max={100}
        value={value}
        aria-label={label}
      />
    </div>
  );
}
export function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className={s.stat}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
export function Dialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={s.dialog}
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <h2 id={id}>{title}</h2>
        <IconButton icon="close" label="Close dialog" onClick={onClose} />
      </div>
      {children}
    </dialog>
  );
}
export function Tabs({
  items,
  value,
  onChange,
}: {
  items: readonly string[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className={s.tabs} role="tablist">
      {items.map((item, index) => (
        <button
          className={s.button}
          key={item}
          role="tab"
          aria-selected={value === item}
          tabIndex={value === item ? 0 : -1}
          onClick={() => onChange(item)}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
              return;
            event.preventDefault();
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : (index +
                      (event.key === "ArrowRight" ? 1 : -1) +
                      items.length) %
                    items.length;
            onChange(items[next]!);
            (
              event.currentTarget.parentElement?.children[next] as HTMLElement
            )?.focus();
          }}
        >
          {item}
        </button>
      ))}
    </div>
  );
}
