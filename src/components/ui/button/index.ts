import type { VariantProps } from 'class-variance-authority'
import { cva } from 'class-variance-authority'

export { default as Button } from './Button.vue'

export const buttonVariants = cva(
  'cursor-pointer disabled:cursor-not-allowed [-webkit-tap-highlight-color:transparent] focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 rounded-lg border border-transparent bg-clip-padding text-sm font-medium focus-visible:ring-3 aria-invalid:ring-3 [&_svg:not([class*=size-])]:size-4 group/button inline-flex shrink-0 items-center justify-center whitespace-nowrap transition-all outline-none select-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        'sidebar-action': 'w-full flex items-center gap-[11px] py-2.5 px-3 rounded-lg text-left text-[13px] font-medium h-auto justify-start hover:bg-sidebar-accent',
        'project-row': 'flex items-center gap-1.5 w-auto py-1 px-1.5 text-[13px] font-medium min-w-0 min-h-8 text-left h-auto justify-start flex-1 shrink-1 [@media(pointer:coarse)]:min-h-9 bg-transparent text-inherit hover:bg-transparent',
        'session-link': 'flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left py-1 px-0 text-xs leading-5 font-normal h-auto block shrink-1 rounded-none [@media(pointer:coarse)]:min-h-9 bg-transparent text-inherit hover:bg-transparent',
        'context-chip': 'flex items-center gap-[7px] p-1.5 rounded-md max-w-[40%] text-xs whitespace-nowrap h-auto max-[700px]:gap-1 hover:enabled:bg-accent',
        'context-menu-item': 'flex items-center w-full gap-2 text-left py-[5px] px-2 rounded-md text-[13px] h-auto justify-start hover:bg-accent',
        default: 'bg-primary text-primary-foreground [a]:hover:bg-primary/80',
        outline: 'border-border bg-background hover:bg-muted hover:text-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50 aria-expanded:bg-muted aria-expanded:text-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80 aria-expanded:bg-secondary aria-expanded:text-secondary-foreground',
        ghost: 'hover:bg-muted hover:text-foreground dark:hover:bg-muted/50 aria-expanded:bg-muted aria-expanded:text-foreground',
        destructive: 'bg-destructive/10 hover:bg-destructive/20 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/20 text-destructive focus-visible:border-destructive/40 dark:hover:bg-destructive/30',
        quiet: 'text-muted-foreground hover:bg-accent hover:text-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        'content': 'h-auto',
        'default': 'h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
        'xs': 'h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*=size-])]:size-3',
        'sm': 'h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*=size-])]:size-3.5',
        'lg': 'h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
        'quiet': 'h-auto rounded-md px-[9px] py-1.5 text-xs max-[640px]:p-[5px] max-[640px]:text-[11px]',
        'workspace': 'h-auto rounded-lg px-3.5 py-2 text-[13px]',
        'toolbar': 'size-7 rounded-md text-muted-foreground',
        'row-action': 'size-6 rounded-md text-muted-foreground [@media(pointer:coarse)]:size-8',
        'review': 'size-auto rounded-[3px] p-1 text-muted-foreground [&_svg:not([class*=size-])]:size-3.5',
        'icon': 'size-8',
        'icon-xs': 'size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*=size-])]:size-3',
        'icon-sm': 'size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg',
        'icon-lg': 'size-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)
export type ButtonVariants = VariantProps<typeof buttonVariants>
