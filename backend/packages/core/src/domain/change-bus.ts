export interface PromptChangeEvent {
  type: 'prompt';
  action: 'create' | 'update' | 'delete' | 'toggle';
  promptId: string;
  projectId: string | null;
  timestamp: string;
}

type ChangeHandler = (event: PromptChangeEvent) => void;

/**
 * In-memory pub/sub for prompt change events.
 * Core service publishes mutations; the MCP adapter subscribes via SSE.
 */
export class ChangeBus {
  private handlers = new Map<string, ChangeHandler>();
  private counter = 0;

  subscribe(handler: ChangeHandler): string {
    const id = String(++this.counter);
    this.handlers.set(id, handler);
    return id;
  }

  unsubscribe(id: string): void {
    this.handlers.delete(id);
  }

  publish(event: PromptChangeEvent): void {
    for (const handler of this.handlers.values()) {
      try {
        handler(event);
      } catch {
        // Handler errors must not break other subscribers
      }
    }
  }

  handlerCount(): number {
    return this.handlers.size;
  }
}
