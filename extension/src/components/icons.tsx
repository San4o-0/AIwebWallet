/**
 * Інлайнові SVG-іконки дизайн-системи: аутлайн, stroke 1.5px, без бібліотек
 * і CDN. Розмір керується пропом size (за замовчуванням 20px), колір —
 * currentColor.
 */
import type { SVGProps } from 'react';

export interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

function base(size: number | undefined, props: Omit<IconProps, 'size'>) {
  return {
    width: size ?? 20,
    height: size ?? 20,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    ...props,
  } as const;
}

export function IconHome({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-5.5h-5V21H5a1 1 0 0 1-1-1v-9.5Z" />
    </svg>
  );
}

export function IconActivity({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M3 12h3.5l2.5-7 4 14 2.5-7H21" />
    </svg>
  );
}

export function IconQr({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1" />
      <path d="M13.5 13.5h3v3h-3zM17 17h3v3" />
    </svg>
  );
}

export function IconChat({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M21 12a8 8 0 0 1-8 8c-1.2 0-2.4-.25-3.4-.72L4 20.5l1.22-5.6A8 8 0 1 1 21 12Z" />
    </svg>
  );
}

export function IconMore({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M4 7h16M4 12h16M4 17h10" />
    </svg>
  );
}

export function IconSend({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M7 17 17 7M9 7h8v8" />
    </svg>
  );
}

export function IconReceive({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M17 7 7 17M15 17H7V9" />
    </svg>
  );
}

export function IconCopy({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </svg>
  );
}

export function IconCheck({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="m5 12.5 5 5L19.5 7" />
    </svg>
  );
}

export function IconLock({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

export function IconChevronLeft({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="m14.5 5-7 7 7 7" />
    </svg>
  );
}

export function IconChevronRight({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="m9.5 5 7 7-7 7" />
    </svg>
  );
}

export function IconChevronDown({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="m6 9.5 6 6 6-6" />
    </svg>
  );
}

export function IconExternal({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
    </svg>
  );
}

export function IconShield({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M12 3.5 5 6v5.5c0 4.4 3 7.7 7 9 4-1.3 7-4.6 7-9V6l-7-2.5Z" />
    </svg>
  );
}

export function IconSwap({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M4 8h13M14 4.5 17.5 8 14 11.5M20 16H7M10 12.5 6.5 16l3.5 3.5" />
    </svg>
  );
}

export function IconSparkle({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M12 4c.6 3.8 2.6 5.8 6.5 6.5-3.9.7-5.9 2.7-6.5 6.5-.6-3.8-2.6-5.8-6.5-6.5C9.4 9.8 11.4 7.8 12 4ZM18.5 15.5c.3 1.7 1.2 2.6 3 3-1.8.4-2.7 1.3-3 3-.3-1.7-1.2-2.6-3-3 1.8-.4 2.7-1.3 3-3Z" />
    </svg>
  );
}

export function IconGrid({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </svg>
  );
}

/**
 * Фірмовий знак: подвійний ромб (сейфовий вензель) у латуні.
 * Використовується на Onboarding / Unlock.
 */
export function BrandMark({ size = 44, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 44 44"
      fill="none"
      aria-hidden
      {...props}
    >
      <path
        d="M22 4 40 22 22 40 4 22 22 4Z"
        stroke="var(--color-brass)"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M22 13 31 22 22 31 13 22 22 13Z"
        stroke="var(--color-brass)"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="22" cy="22" r="1.8" fill="var(--color-brass)" />
    </svg>
  );
}
