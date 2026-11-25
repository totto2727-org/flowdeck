import { clsx } from 'clsx'
import type { ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Combines class names for the generated UI.
 * @param {...ClassValue} inputs The class names and conditions.
 * @returns {string} The merged Tailwind class names.
 */
export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs))
