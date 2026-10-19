import { HTMLAttributes, forwardRef } from 'react';

type Variant = 'default' | 'success' | 'warning' | 'error' | 'info' | 'dark';

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: Variant;
}

const variantStyles: Record<Variant, string> = {
  default: 'badge-default',
  success: 'badge-success',
  warning: 'badge-warning',
  error: 'badge-error',
  info: 'badge-info',
  dark: 'badge-dark',
};

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  ({ variant = 'default', className = '', children, ...props }, ref) => {
    return (
      <span ref={ref} className={`badge ${variantStyles[variant]} ${className}`} {...props}>
        {children}
      </span>
    );
  },
);

Badge.displayName = 'Badge';
