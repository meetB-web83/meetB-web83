import { CSSProperties } from 'react';

interface ToggleOption<T extends string> {
  value: T;
  label: string;
}

interface ToggleSwitchProps<T extends string> {
  options: ToggleOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}

/**
 * Brutalist toggle switch: one bordered track, one black knob that slides to
 * the active segment. Clicking any segment moves the switch there (DESIGN.md
 * flat elevation: hard shadow, sharp corners, mono labels).
 */
export function ToggleSwitch<T extends string>({ options, value, onChange, ariaLabel }: ToggleSwitchProps<T>) {
  const activeIndex = Math.max(0, options.findIndex((opt) => opt.value === value));
  const knobStyle: CSSProperties = {
    width: `${100 / options.length}%`,
    transform: `translateX(${activeIndex * 100}%)`,
  };

  return (
    <div className="toggle-switch" role="group" aria-label={ariaLabel}>
      <span className="toggle-switch-knob" style={knobStyle} aria-hidden="true" />
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={`toggle-switch-option${opt.value === value ? ' is-active' : ''}`}
          aria-pressed={opt.value === value}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
