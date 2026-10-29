import { ButtonHTMLAttributes, forwardRef, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'outline' | 'ghost';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Segmented arrow tile (DESIGN.md compound action trigger). Off for ghost by default. */
  arrow?: boolean;
  children: ReactNode;
}

const variantStyles: Record<Variant, string> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  outline: 'btn-outline',
  ghost: 'btn-ghost',
};

const sizeStyles: Record<Size, string> = {
  sm: 'btn-sm',
  md: 'btn-md',
  lg: 'btn-lg',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', arrow, className = '', children, ...props }, ref) => {
    const showArrow = arrow ?? (variant === 'primary' || variant === 'secondary');
    return (
      <button
        ref={ref}
        className={`btn ${variantStyles[variant]} ${sizeStyles[size]} ${className}`}
        {...props}
      >
        <span className="btn-label">{children}</span>
        {showArrow && (
          <span className="btn-arrow" aria-hidden="true">
            ↗
          </span>
        )}
      </button>
    );
  },
);

Button.displayName = 'Button';
