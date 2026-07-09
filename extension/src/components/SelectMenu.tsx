/**
 * Доступний кастомний селектор (listbox) — заміна нативного <select> там, де
 * пункти потребують іконок (мережа/актив на Send). Стиль тригера повторює
 * поля вводу (bg-surface, hairline-бордер, бурштиновий фокус); список спливає
 * плашкою bg-raised з плавною появою (animate-rise; reduced-motion → миттєво).
 *
 * Доступність: role="listbox"/"option", aria-expanded/-selected, керування
 * фокусом + aria-activedescendant, повна клавіатура (стрілки, Enter/Space,
 * Esc, Home/End, Tab), клік поза списком закриває. Логічні властивості
 * (start/end) — коректний RTL для ar/ur.
 */
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { IconCheck, IconChevronDown } from './icons';

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  /** Вторинний підпис праворуч (тикер / повна назва), muted. */
  secondary?: string;
  icon?: ReactNode;
}

export interface SelectMenuProps<T extends string> {
  label?: string;
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  className?: string;
}

const triggerBase =
  'flex w-full items-center gap-2.5 rounded-lg border bg-surface px-3.5 py-2.5 text-sm text-ink outline-none transition-colors focus-visible:border-accent focus-visible:shadow-[0_0_0_1px_var(--color-accent)]';

export function SelectMenu<T extends string>({
  label,
  value,
  options,
  onChange,
  className = '',
}: SelectMenuProps<T>) {
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (index: number) => `${baseId}-opt-${index}`;

  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const selected = options[selectedIndex] ?? options[0];

  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const [dropUp, setDropUp] = useState(false);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const optionRefs = useRef<(HTMLLIElement | null)[]>([]);

  const openMenu = () => {
    // Напрямок розкриття: якщо під тригером тісно, а зверху місця більше — вгору.
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const below = window.innerHeight - rect.bottom;
      setDropUp(below < 240 && rect.top > below);
    }
    setActiveIndex(selectedIndex);
    setOpen(true);
  };

  const closeMenu = (returnFocus = true) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  const commit = (index: number) => {
    const option = options[index];
    if (option) onChange(option.value);
    closeMenu();
  };

  // При відкритті — фокус на список і прокрутка активного пункту у зону видимості.
  useLayoutEffect(() => {
    if (!open) return;
    listRef.current?.focus();
    optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open) optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  const onTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openMenu();
    }
  };

  const onListKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((i) => Math.min(options.length - 1, i + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
        break;
      case 'Home':
        e.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        e.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        commit(activeIndex);
        break;
      case 'Escape':
        e.preventDefault();
        closeMenu();
        break;
      case 'Tab':
        // Не блокуємо Tab — просто закриваємо, фокус іде далі природно.
        closeMenu(false);
        break;
    }
  };

  return (
    <label className="block text-start">
      {label !== undefined && (
        <span id={`${baseId}-label`} className="eyebrow mb-2 block">
          {label}
        </span>
      )}
      <div className={`relative ${className}`}>
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-labelledby={label !== undefined ? `${baseId}-label ${baseId}-value` : undefined}
          onClick={() => (open ? closeMenu(false) : openMenu())}
          onKeyDown={onTriggerKeyDown}
          className={`${triggerBase} ${open ? 'border-accent' : 'border-hairline'}`}
        >
          {selected?.icon !== undefined && <span className="shrink-0">{selected.icon}</span>}
          <span id={`${baseId}-value`} className="min-w-0 flex-1 truncate">
            {selected?.label}
          </span>
          {selected?.secondary !== undefined && (
            <span className="shrink-0 text-xs text-muted">{selected.secondary}</span>
          )}
          <IconChevronDown
            size={16}
            className={`shrink-0 text-muted transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
          />
        </button>

        {open && (
          <>
            {/* Прозорий бекдроп: клік поза списком закриває його. */}
            <div className="fixed inset-0 z-20" aria-hidden onClick={() => closeMenu(false)} />
            <ul
              ref={listRef}
              id={listId}
              role="listbox"
              tabIndex={-1}
              aria-activedescendant={optionId(activeIndex)}
              onKeyDown={onListKeyDown}
              className={`animate-rise absolute inset-x-0 z-30 max-h-[260px] overflow-auto rounded-lg border border-hairline bg-raised py-1 shadow-xl outline-none ${
                dropUp ? 'bottom-full mb-1' : 'top-full mt-1'
              }`}
            >
              {options.map((option, index) => {
                const isSelected = option.value === value;
                const isActive = index === activeIndex;
                return (
                  <li
                    key={option.value}
                    ref={(el) => {
                      optionRefs.current[index] = el;
                    }}
                    id={optionId(index)}
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => commit(index)}
                    onMouseMove={() => setActiveIndex(index)}
                    className={`flex min-h-9 cursor-pointer items-center gap-2.5 px-3 py-2 text-sm transition-colors ${
                      isActive ? 'bg-surface' : ''
                    }`}
                  >
                    {option.icon !== undefined && (
                      <span className="shrink-0">{option.icon}</span>
                    )}
                    <span
                      className={`min-w-0 flex-1 truncate ${isSelected ? 'text-accent' : 'text-ink'}`}
                    >
                      {option.label}
                    </span>
                    {option.secondary !== undefined && (
                      <span className="shrink-0 text-xs text-muted">{option.secondary}</span>
                    )}
                    {isSelected && (
                      <IconCheck size={15} className="shrink-0 text-accent" />
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </label>
  );
}
