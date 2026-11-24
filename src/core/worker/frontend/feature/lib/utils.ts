import { clsx } from 'clsx'
import type { ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Only class composition belongs here. Product behavior stays outside generated UI. */
export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs))
