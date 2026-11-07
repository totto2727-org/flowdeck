import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Only class composition belongs here. Product behavior stays outside generated UI. */
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs))
