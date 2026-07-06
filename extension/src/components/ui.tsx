/** Мінімальні спільні UI-компоненти (без дизайн-бібліотек). */
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

const buttonStyles: Record<ButtonVariant, string> = {
  primary:
    'bg-emerald-500 text-zinc-950 hover:bg-emerald-400 disabled:bg-zinc-700 disabled:text-zinc-500',
  secondary:
    'bg-zinc-800 text-zinc-100 hover:bg-zinc-700 disabled:bg-zinc-800/50 disabled:text-zinc-600',
  danger:
    'bg-red-500/90 text-zinc-50 hover:bg-red-500 disabled:bg-zinc-700 disabled:text-zinc-500',
  ghost: 'bg-transparent text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Button({ variant = 'primary', className = '', ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      className={`rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed ${buttonStyles[variant]} ${className}`}
    />
  );
}

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

export function Field({ label, className = '', id, ...rest }: FieldProps) {
  return (
    <label className="block text-left">
      {label !== undefined && (
        <span className="mb-1.5 block text-xs font-medium text-zinc-400">{label}</span>
      )}
      <input
        id={id}
        {...rest}
        className={`w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3.5 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 outline-none transition-colors focus:border-emerald-500/70 ${className}`}
      />
    </label>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-zinc-800/80 bg-zinc-900/70 p-4 ${className}`}>
      {children}
    </div>
  );
}

export function ScreenTitle({ children }: { children: ReactNode }) {
  return <h1 className="text-lg font-bold tracking-tight text-zinc-50">{children}</h1>;
}

export function Spinner() {
  return (
    <div
      className="size-5 animate-spin rounded-full border-2 border-zinc-700 border-t-emerald-400"
      role="status"
      aria-label="Завантаження"
    />
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="py-8 text-center text-sm text-zinc-500">{children}</p>;
}
