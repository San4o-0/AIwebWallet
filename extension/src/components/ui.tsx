/**
 * Спільні UI-примітиви дизайн-системи «приватний банк»:
 * латунний акцент, hairline-бордери, серифні заголовки, 8px-сітка.
 * Без дизайн-бібліотек.
 */
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

import { IconChevronDown } from './icons';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

const buttonStyles: Record<ButtonVariant, string> = {
  primary:
    'bg-brass text-bg hover:bg-brass-bright disabled:bg-raised disabled:text-muted/60',
  secondary:
    'border border-hairline bg-raised text-ink hover:border-muted/40 disabled:text-muted/50 disabled:hover:border-hairline',
  danger:
    'bg-terra text-bg hover:bg-terra/85 disabled:bg-raised disabled:text-muted/60',
  ghost: 'bg-transparent text-muted hover:bg-raised/70 hover:text-ink',
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

/** Підпис поля — та сама small-caps мова, що й eyebrow, тільки тихіша. */
function FieldLabel({ children }: { children: ReactNode }) {
  return <span className="eyebrow mb-2 block">{children}</span>;
}

const inputClasses =
  'w-full rounded-xl border border-hairline bg-surface px-3.5 py-2.5 text-sm text-ink placeholder:text-muted/50 outline-none transition-colors focus:border-brass';

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

export function Field({ label, className = '', id, ...rest }: FieldProps) {
  return (
    <label className="block text-left">
      {label !== undefined && <FieldLabel>{label}</FieldLabel>}
      <input id={id} {...rest} className={`${inputClasses} ${className}`} />
    </label>
  );
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
}

export function Textarea({ label, className = '', ...rest }: TextareaProps) {
  return (
    <label className="block text-left">
      {label !== undefined && <FieldLabel>{label}</FieldLabel>}
      <textarea {...rest} className={`${inputClasses} resize-none ${className}`} />
    </label>
  );
}

/**
 * Поле вводу seed-фрази (онбординг-імпорт і відновлення пароля): mono,
 * без spellcheck/автозаповнення — фраза не має потрапляти у словники браузера.
 */
export function SeedPhraseTextarea({ className = '', ...rest }: TextareaProps) {
  return (
    <Textarea
      rows={3}
      placeholder="слово слово слово …"
      spellCheck={false}
      autoComplete="off"
      autoCapitalize="off"
      autoCorrect="off"
      {...rest}
      className={`font-mono ${className}`}
    />
  );
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
}

export function Select({ label, className = '', children, ...rest }: SelectProps) {
  return (
    <label className="block text-left">
      {label !== undefined && <FieldLabel>{label}</FieldLabel>}
      <span className="relative block">
        <select {...rest} className={`${inputClasses} appearance-none pr-9 ${className}`}>
          {children}
        </select>
        <IconChevronDown
          size={16}
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted"
        />
      </span>
    </label>
  );
}

export function Card({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-[14px] border border-hairline bg-surface p-4 ${className}`}>
      {children}
    </div>
  );
}

/** Дрібний small-caps підпис розділу (наскрізна мова всіх екранів). */
export function Eyebrow({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return <p className={`eyebrow ${className}`}>{children}</p>;
}

/** Заголовок екрана — серифний display. */
export function ScreenTitle({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <h1 className={`font-display text-[21px] font-semibold leading-tight text-ink ${className}`}>
      {children}
    </h1>
  );
}

/** Шапка екрана: eyebrow над серифним заголовком. */
export function ScreenHeader({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header>
      <Eyebrow className="mb-1">{eyebrow}</Eyebrow>
      <ScreenTitle>{title}</ScreenTitle>
      {children}
    </header>
  );
}

/**
 * Шапка кроку багатокрокового флоу (онбординг, відновлення пароля):
 * eyebrow «Крок N з M · Розділ» + серифний заголовок + латунні прогрес-риски.
 */
export function StepHeader({
  step,
  total,
  section,
  title,
}: {
  step: number;
  total: number;
  section: string;
  title: string;
}) {
  return (
    <header>
      <Eyebrow className="mb-1">
        Крок {step} з {total} · {section}
      </Eyebrow>
      <ScreenTitle>{title}</ScreenTitle>
      <div className="mt-3 flex gap-1.5" aria-hidden>
        {Array.from({ length: total }, (_, index) => (
          <span
            key={index}
            className={`h-0.5 flex-1 rounded-full ${
              index < step ? 'bg-brass' : 'bg-hairline'
            }`}
          />
        ))}
      </div>
    </header>
  );
}

export function Spinner() {
  return (
    <div
      className="size-5 animate-spin rounded-full border-2 border-hairline border-t-brass"
      role="status"
      aria-label="Завантаження"
    />
  );
}

export function EmptyState({
  icon,
  title,
  hint,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-[14px] border border-dashed border-hairline px-6 py-8 text-center">
      {icon !== undefined && <span className="text-muted/70">{icon}</span>}
      <p className="text-sm font-medium text-muted">{title}</p>
      {hint !== undefined && <p className="text-xs leading-relaxed text-muted/70">{hint}</p>}
    </div>
  );
}

/** Конкретна помилка без вибачень + дія повторення, якщо доречна. */
export function ErrorNote({
  children,
  onRetry,
}: {
  children: ReactNode;
  onRetry?: () => void;
}) {
  return (
    <div className="rounded-[14px] border border-terra/40 bg-terra/10 p-3.5">
      <p className="text-xs leading-relaxed text-ink">{children}</p>
      {onRetry !== undefined && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 text-xs font-semibold text-terra transition-colors hover:text-ink"
        >
          Спробувати ще раз
        </button>
      )}
    </div>
  );
}

/** Кругла іконка-кнопка (шапки екранів). */
export function IconButton({
  label,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      {...rest}
      className={`flex size-9 items-center justify-center rounded-full border border-hairline bg-surface text-muted transition-colors hover:border-brass/50 hover:text-brass ${className}`}
    />
  );
}
