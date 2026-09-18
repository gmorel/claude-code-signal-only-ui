import type { Theme } from '../theme.ts'
import { theme as kanban } from './kanban.ts'
import { theme as gmorel } from './gmorel.ts'
import { theme as receipt } from './receipt.ts'

// The only place a theme is listed (SPEC §4): a new file under hooks/themes/ becomes a `/signal theme <id>` word by being imported here and nowhere else.

export const themes: Record<string, Theme> = {
  [receipt.id]: receipt,
  [kanban.id]: kanban,
  [gmorel.id]: gmorel,
}

/** the theme a preference names; an id no file answers falls back rather than leaving the card undrawn */
export const themeOf = (id: string, fallback = 'gmorel'): Theme => themes[id] ?? themes[fallback] ?? gmorel
