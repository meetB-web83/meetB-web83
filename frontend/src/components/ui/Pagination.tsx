import { Button } from './Button';

interface PaginationProps {
  page: number;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}

/** Brutalist pager: Prev / PAGE n / Next. `hasNext` comes from a limit+1 fetch. */
export function Pagination({ page, hasNext, onPrev, onNext }: PaginationProps) {
  if (page === 0 && !hasNext) return null;

  return (
    <div className="pagination">
      <Button variant="secondary" size="sm" arrow={false} disabled={page === 0} onClick={onPrev}>
        ← Prev
      </Button>
      <span className="code-tag">PAGE {page + 1}</span>
      <Button variant="secondary" size="sm" arrow={false} disabled={!hasNext} onClick={onNext}>
        Next →
      </Button>
    </div>
  );
}
