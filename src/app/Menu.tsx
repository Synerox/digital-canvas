// Adapted from FSM Designer (https://github.com/Synerox/fsm-designer, MIT, same author).
// Menu bar drop-down (File, language), with one level of submenu (Export).
// Keyboard use follows the WAI-ARIA menu button pattern: Enter, Space or
// ArrowDown on the button opens the menu with focus on its first item;
// ArrowUp/ArrowDown/Home/End move between items, ArrowRight/ArrowLeft open
// and close the submenu, Escape closes and returns focus to the button, and
// Tab or Shift+Tab (focus moving elsewhere) closes the menu.

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

export interface MenuItem {
  label: string;
  shortcut?: string;
  onSelect?: () => void;
  submenu?: MenuItem[];
  /** Shown with a check mark (a pick-one list such as the language menu). */
  checked?: boolean;
  /** Language of the label when it differs from the page's (the language names). */
  lang?: string;
}

const items = (list: Element | null | undefined) => [...(list?.querySelectorAll<HTMLButtonElement>(':scope > li > button') ?? [])];

export function Menu({ label, items: entries, disabled, testId, icon, title }: { label: ReactNode; items: MenuItem[]; disabled?: boolean; testId?: string; icon?: boolean; title?: string }) {
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // Which item to focus once the list (or submenu) has rendered, when it was opened from the keyboard.
  const focusNext = useRef<'first' | 'last' | 'sub' | null>(null);

  useEffect(() => {
    const want = focusNext.current;
    if (!open || !want) return;
    focusNext.current = null;
    const list = ref.current?.querySelector(want === 'sub' ? '.submenu' : '.menu-list');
    const all = items(list);
    (want === 'last' ? all[all.length - 1] : all[0])?.focus();
  }, [open, sub]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      const at = document.activeElement;
      const subList = at?.closest('.submenu');
      if (subList) { setSub(null); subList.parentElement?.querySelector<HTMLButtonElement>(':scope > button')?.focus(); return; }
      close(!!at && !!ref.current?.contains(at));
    };
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', esc, true);
    return () => { document.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', esc, true); };
  }, [open]);

  /** Close; `refocus` puts focus back on the menu button (keyboard use), since the focused item goes away. */
  const close = (refocus = false) => { setOpen(false); setSub(null); if (refocus) trigger.current?.focus(); };
  const choose = (item: MenuItem, keyboard: boolean) => { close(keyboard); item.onSelect?.(); };
  const openWith = (focus: 'first' | 'last' | null) => { focusNext.current = focus; setOpen(true); };
  /** Open submenu `i` from the keyboard with focus on its first item. If hovering already opened it, setSub would not re-render, so focus it here. */
  const enterSub = (i: number) => {
    if (sub === i) return items(ref.current?.querySelector('.submenu'))[0]?.focus();
    focusNext.current = 'sub';
    setSub(i);
  };

  const onListKey = (e: KeyboardEvent<HTMLUListElement>, nested: boolean) => {
    const all = items(e.currentTarget);
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (at === -1) return; // the key is for a nested list
    const move = (i: number) => all[(i + all.length) % all.length]?.focus();
    const item = nested ? undefined : entries[at];
    if (e.key === 'ArrowDown') move(at + 1);
    else if (e.key === 'ArrowUp') move(at - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(all.length - 1);
    else if (e.key === 'ArrowRight' && !nested && item?.submenu) enterSub(at);
    else if (e.key === 'ArrowLeft' && nested) { setSub(null); e.currentTarget.parentElement?.querySelector<HTMLButtonElement>(':scope > button')?.focus(); }
    // Shift+Tab would land on the menu button, which is inside the wrapper,
    // so onBlur would keep the menu open; close it and focus the button here.
    else if (e.key === 'Tab' && e.shiftKey) close(true);
    else return;
    e.preventDefault(); // also tells App's shortcut handler the key is taken
  };

  const list = (shown: MenuItem[], nested: boolean) => (
    <ul className={nested ? 'menu-list submenu' : 'menu-list'} role='menu' onKeyDown={(e) => onListKey(e, nested)}>
      {shown.map((item, i) => (
        <li key={item.label} role='none' onPointerEnter={nested ? undefined : () => setSub(item.submenu ? i : null)}>
          <button
            role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
            tabIndex={-1}
            aria-checked={item.checked}
            aria-haspopup={item.submenu ? 'menu' : undefined}
            aria-expanded={item.submenu ? sub === i : undefined}
            // detail is 0 for a click made with Enter or Space.
            onClick={(e) => {
              if (!item.submenu) return choose(item, e.detail === 0);
              if (e.detail === 0) enterSub(i);
              else setSub(i);
            }}
          >
            {item.checked !== undefined && <span className='check' aria-hidden='true'>{item.checked ? '✓' : ''}</span>}
            <span lang={item.lang}>{item.label}</span>
            {item.shortcut && <span className='shortcut'>{item.shortcut}</span>}
            {item.submenu && <span className='chevron' aria-hidden='true'>›</span>}
          </button>
          {item.submenu && sub === i && list(item.submenu, true)}
        </li>
      ))}
    </ul>
  );

  return (
    <div
      className={icon ? 'menu icon-menu' : 'menu'}
      ref={ref}
      onBlur={(e) => { if (open && e.relatedTarget && !ref.current?.contains(e.relatedTarget)) close(); }}
    >
      <button
        ref={trigger}
        className={`menu-trigger${open ? ' active' : ''}`}
        aria-haspopup='menu'
        aria-expanded={open}
        disabled={disabled}
        data-testid={testId}
        title={title}
        aria-label={title}
        onClick={(e) => (open ? close() : openWith(e.detail === 0 ? 'first' : null))}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          e.preventDefault();
          const want = e.key === 'ArrowDown' ? 'first' : 'last';
          if (!open) return openWith(want);
          const all = items(ref.current?.querySelector('.menu-list'));
          (want === 'first' ? all[0] : all[all.length - 1])?.focus();
        }}
      >
        {label}
        {!icon && <svg className='caret-down' width='8' height='8' viewBox='0 0 8 8' aria-hidden='true'><path d='M0.5 2.25h7L4 6.25Z' fill='currentColor' /></svg>}
      </button>
      {open && list(entries, false)}
    </div>
  );
}
