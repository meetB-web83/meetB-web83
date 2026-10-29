import { useRef } from 'react';
import { PageHeader } from '../components/layout/PageHeader';
import { Button } from '../components/ui/Button';
import { PromptsPanel } from '../components/prompts/PromptsPanel';
import type { PromptsPanelHandle } from '../components/prompts/PromptsPanel';

export default function PromptsPage() {
  const panelRef = useRef<PromptsPanelHandle>(null);

  return (
    <div className="page">
      <div className="container">
        <PageHeader
          title="Prompts"
          description="Manage global prompts. Project prompts live inside each project."
          kicker="</prompts>"
          actions={
            <Button variant="primary" onClick={() => panelRef.current?.openCreate()}>
              New prompt
            </Button>
          }
        />
        <PromptsPanel ref={panelRef} />
      </div>
    </div>
  );
}
