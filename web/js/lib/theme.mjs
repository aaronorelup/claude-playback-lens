// web/js/lib/theme.mjs — appearance: light / dark / follow the system.
//
// THREE STATES, ONE RECORDED FACT. `lens.theme` in localStorage holds exactly
// what the reader chose: 'light', 'dark', or nothing at all (= follow the
// system). The stylesheet does the rest — `data-theme` on <html> pins a mode,
// its absence hands the decision to `prefers-color-scheme` (styles.css, LAYER
// 1 blocks). Nothing here infers a mode: when the choice is 'system' the app
// reports what the browser says it prefers, and says that is where it came
// from.
//
// The FIRST paint is not this module's job — it happens before any module
// loads. index.html carries a five-line <head> bootstrap that reads the same
// key and sets the same attribute, so the page never flashes light. This
// module is the same operation, live, plus the control that drives it.

import { h } from '../format.mjs';
import { getPref, setPref } from './text.mjs';

export const THEMES = ['system', 'light', 'dark'];

/** What the reader chose. Never guesses: an unreadable/absent pref is 'system'. */
export function readTheme() {
  const v = getPref('theme', 'system');
  return THEMES.includes(v) ? v : 'system';
}

/** What the browser says it prefers, or null when it does not say. */
export function systemTheme() {
  try {
    if (typeof matchMedia !== 'function') return null;
    if (matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    if (matchMedia('(prefers-color-scheme: light)').matches) return 'light';
  } catch { /* no matchMedia (node, old engines) */ }
  return null;
}

/** The mode actually on screen, and where it came from. `null` = not recorded. */
export function effectiveTheme() {
  const choice = readTheme();
  if (choice !== 'system') return { mode: choice, from: 'your choice, saved in this browser' };
  const sys = systemTheme();
  return { mode: sys, from: sys ? 'your system preference' : null };
}

/** Put (or clear) `data-theme` on <html>. Safe where there is no document. */
export function applyTheme(mode) {
  const el = (typeof document !== 'undefined' && document && document.documentElement) || null;
  if (!el || typeof el.setAttribute !== 'function') return mode;
  if (mode === 'light' || mode === 'dark') el.setAttribute('data-theme', mode);
  else if (typeof el.removeAttribute === 'function') el.removeAttribute('data-theme');
  return mode;
}

const listeners = new Set();

/** Subscribe to changes so every mounted control repaints together. */
export function onThemeChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/**
 * Record the choice, apply it, tell every mounted control.
 *
 * Controls that carry an `.el` are dropped once that element has left the
 * document — #/settings mounts a fresh control on every visit, and without
 * this the set would grow one detached control per visit for the life of the
 * tab.
 */
export function setTheme(mode) {
  const m = THEMES.includes(mode) ? mode : 'system';
  setPref('theme', m);
  applyTheme(m);
  for (const fn of [...listeners]) {
    if (fn.el && fn.el.isConnected === false) { listeners.delete(fn); continue; }
    try { fn(m); } catch { /* one bad listener must not stop the rest */ }
  }
  return m;
}

const LABELS = { light: 'day', dark: 'night', system: 'system' };
const TITLES = {
  light: 'always the day palette',
  dark: 'always the night palette',
  system: 'follow this browser’s colour-scheme preference',
};

/**
 * The three-state control. A radio group, not a cycling button: all three
 * states are visible, and the chosen one is marked with aria-checked as well
 * as a class — never by colour alone.
 *
 * Returns a plain element; it repaints itself whenever setTheme runs anywhere.
 */
export function themeControl({ label = 'theme' } = {}) {
  const box = h('div', { class: 'lens-theme', role: 'radiogroup', 'aria-label': 'Appearance' });
  if (label) box.appendChild(h('span', { class: 'lens-theme__label' }, label));
  const btns = THEMES.map((mode) => h('button', {
    class: 'lens-theme__btn',
    type: 'button',
    role: 'radio',
    title: TITLES[mode],
    'aria-checked': 'false',
    onclick: () => setTheme(mode),
  }, LABELS[mode]));
  for (const b of btns) box.appendChild(b);

  const paint = (cur) => {
    THEMES.forEach((mode, i) => {
      const on = mode === cur;
      btns[i].setAttribute('aria-checked', on ? 'true' : 'false');
      btns[i].setAttribute('class', `lens-theme__btn${on ? ' is-active' : ''}`);
    });
  };
  paint(readTheme());
  paint.el = box;              // lets setTheme drop this control once it is detached
  onThemeChange(paint);
  return box;
}
