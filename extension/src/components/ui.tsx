/**
 * Спільні UI-примітиви дизайн-системи «торговий термінал»:
 * бурштиновий акцент, hairline-бордери, mono-заголовки, квадратніші кути
 * (7–10px), різкі переходи 100–150ms. Без дизайн-бібліотек.
 */
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { useTranslation } from 'react-i18next';

import { IconChevronDown } from './icons';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

const buttonStyles: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-bg hover:bg-accent-bright disabled:bg-raised disabled:text-muted/60',
  secondary:
    'border border-hairline bg-raised text-ink hover:border-muted/40 disabled:text-muted/50 disabled:hover:border-hairline',
  danger:
    'bg-danger text-bg hover:bg-danger/85 disabled:bg-raised disabled:text-muted/60',
  ghost: 'bg-transparent text-muted hover:bg-raised/70 hover:text-ink',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Button({ variant = 'primary', className = '', ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      className={`rounded-lg px-4 py-2.5 text-sm font-semibold transition-[background-color,border-color,color,transform] duration-100 active:scale-[0.98] disabled:cursor-not-allowed disabled:active:scale-100 ${buttonStyles[variant]} ${className}`}
    />
  );
}

/** Підпис поля — та сама small-caps мова, що й eyebrow, тільки тихіша. */
function FieldLabel({ children }: { children: ReactNode }) {
  return <span className="eyebrow mb-2 block">{children}</span>;
}

const inputClasses =
  'w-full rounded-lg border border-hairline bg-surface px-3.5 py-2.5 text-sm text-ink placeholder:text-muted/50 outline-none transition-colors focus:border-accent';

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

export function Field({ label, className = '', id, ...rest }: FieldProps) {
  return (
    <label className="block text-start">
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
    <label className="block text-start">
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
  const { t } = useTranslation();
  return (
    <Textarea
      rows={3}
      placeholder={t('common.seedPlaceholder')}
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
    <label className="block text-start">
      {label !== undefined && <FieldLabel>{label}</FieldLabel>}
      <span className="relative block">
        <select {...rest} className={`${inputClasses} appearance-none pe-9 ${className}`}>
          {children}
        </select>
        <IconChevronDown
          size={16}
          className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-muted"
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
    <div className={`rounded-[10px] border border-hairline bg-surface p-4 ${className}`}>
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

/** Заголовок екрана — mono-display (термінальна шапка). */
export function ScreenTitle({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <h1 className={`font-display text-[19px] font-semibold leading-tight tracking-tight text-ink ${className}`}>
      {children}
    </h1>
  );
}

/** Шапка екрана: eyebrow над mono-заголовком. */
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
 * eyebrow «Крок N з M · Розділ» + mono-заголовок + бурштинові прогрес-риски.
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
  const { t } = useTranslation();
  return (
    <header>
      <Eyebrow className="mb-1">
        {t('common.stepHeader', { step, total, section })}
      </Eyebrow>
      <ScreenTitle>{title}</ScreenTitle>
      <div className="mt-3 flex gap-1.5" aria-hidden>
        {Array.from({ length: total }, (_, index) => (
          <span
            key={index}
            className={`h-0.5 flex-1 ${
              index < step ? 'bg-accent' : 'bg-hairline'
            }`}
          />
        ))}
      </div>
    </header>
  );
}

export function Spinner() {
  const { t } = useTranslation();
  return (
    <div
      className="size-5 animate-spin rounded-full border-2 border-hairline border-t-accent"
      role="status"
      aria-label={t('common.loading')}
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
    <div className="flex flex-col items-center gap-2 rounded-[10px] border border-dashed border-hairline px-6 py-8 text-center">
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
  const { t } = useTranslation();
  return (
    <div className="rounded-[10px] border border-danger/40 bg-danger/10 p-3.5">
      <p className="text-xs leading-relaxed text-ink">{children}</p>
      {onRetry !== undefined && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 text-xs font-semibold text-danger transition-colors hover:text-ink"
        >
          {t('common.retry')}
        </button>
      )}
    </div>
  );
}

/** Квадратна іконка-кнопка (шапки екранів). */
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
      className={`flex size-9 items-center justify-center rounded-lg border border-hairline bg-surface text-muted transition-[border-color,color,transform] duration-100 hover:border-accent/50 hover:text-accent active:scale-95 ${className}`}
    />
  );
}
