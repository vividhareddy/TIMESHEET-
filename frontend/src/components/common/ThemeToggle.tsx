import { Moon, Sun } from 'lucide-react';
import { useTheme } from '@/hooks/useTheme';
import { cn } from '@/utils/format';

/** Switches between light and dark mode (shared with the LMS, like its moon/sun button). */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggle } = useTheme();
  const dark = theme === 'dark';
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={dark}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={dark ? 'Light mode' : 'Dark mode'}
      className={cn('group relative rounded-md p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700', className)}
    >
      <span className="relative block h-5 w-5">
        <Sun className={cn('absolute inset-0 h-5 w-5 transition-all duration-300', dark ? 'rotate-0 scale-100 opacity-100' : '-rotate-90 scale-50 opacity-0')} />
        <Moon className={cn('absolute inset-0 h-5 w-5 transition-all duration-300', dark ? 'rotate-90 scale-50 opacity-0' : 'rotate-0 scale-100 opacity-100')} />
      </span>
    </button>
  );
}
