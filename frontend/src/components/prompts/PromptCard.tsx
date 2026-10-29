import { KeyboardEvent } from "react";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import type { Prompt, PromptView } from "./types";

interface PromptCardProps {
  prompt: PromptView;
  /** Global/built-in rows inside a project view are context only. */
  readOnly?: boolean;
  onEdit: (prompt: Prompt) => void;
  onToggle: (prompt: Prompt, enabled: boolean) => void;
  onPreview: (prompt: Prompt) => void;
  onDelete: (prompt: Prompt) => void;
}

export function PromptCard({
  prompt,
  readOnly = false,
  onEdit,
  onToggle,
  onPreview,
  onDelete,
}: PromptCardProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (readOnly) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onEdit(prompt);
    }
  };

  return (
    <div
      className={`task-card prompt-card${readOnly ? " prompt-card--readonly" : ""}`}
      onClick={readOnly ? undefined : () => onEdit(prompt)}
      onKeyDown={handleKeyDown}
      role={readOnly ? undefined : "button"}
      tabIndex={readOnly ? undefined : 0}
      aria-label={readOnly ? undefined : `Edit prompt ${prompt.name}`}
    >
      <div className="task-card-header prompt-card-header">
        <div className="prompt-card-heading">
          <strong className="task-card-title">{prompt.name}</strong>
          <div className="prompt-card-badges">
            {prompt.is_builtin && <Badge>built-in</Badge>}
            {prompt.project_id ? <Badge>project</Badge> : <Badge>global</Badge>}
            {prompt.shadowsGlobal && (
              <Badge variant="info">shadows global</Badge>
            )}
            {readOnly && <Badge variant="dark">inherited</Badge>}
            {!prompt.enabled && <Badge variant="warning">disabled</Badge>}
          </div>
        </div>
      </div>
      <div className="task-card-body">
        {prompt.description && (
          <p className="task-card-objective">{prompt.description}</p>
        )}
        <pre className="prompt-template">{prompt.template}</pre>
      </div>
      <div
        className="task-card-footer"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="prompt-card-footer-left">
          <span className="task-card-meta">v{prompt.version}</span>
          <span className="task-card-meta">{prompt.category}</span>
          <div className="prompt-card-actions">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPreview(prompt)}
            >
              Preview
            </Button>
            {!readOnly && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onEdit(prompt)}
              >
                Edit
              </Button>
            )}
            {!readOnly && !prompt.is_builtin && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onDelete(prompt)}
              >
                Delete
              </Button>
            )}
          </div>

          {!readOnly && (
            <div
              className="prompt-card-toggle"
              onClick={(event) => event.stopPropagation()}
            >
              <ToggleSwitch
                options={[
                  { value: "on", label: "On" },
                  { value: "off", label: "Off" },
                ]}
                value={prompt.enabled ? "on" : "off"}
                onChange={(value) => onToggle(prompt, value === "on")}
                ariaLabel={`${prompt.name} enabled`}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
