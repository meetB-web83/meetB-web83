import { HTMLAttributes, forwardRef } from 'react';

type Variant = 'light' | 'dark' | 'featured';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: Variant;
}

const variantStyles: Record<Variant, string> = {
  light: 'card-light',
  dark: 'card-dark',
  featured: 'card-featured',
};

export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ variant = 'light', className = '', children, ...props }, ref) => {
    return (
      <div ref={ref} className={`card ${variantStyles[variant]} ${className}`} {...props}>
        {children}
      </div>
    );
  },
);

Card.displayName = 'Card';
