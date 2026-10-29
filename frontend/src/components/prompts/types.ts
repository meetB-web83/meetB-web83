export interface Prompt {
  id: string;
  name: string;
  description: string | null;
  category: string;
  template: string;
  arguments: unknown[];
  project_id: string | null;
  is_builtin: boolean;
  enabled: boolean;
  version: number;
  created_at?: string;
  updated_at?: string;
}

/** Display-only metadata added when the project view merges project and global scopes. */
export interface PromptView extends Prompt {
  /** Project row that overrides a global/built-in prompt with the same name. */
  shadowsGlobal?: boolean;
  /** Global/built-in row shown as read-only context in the project view. */
  inherited?: boolean;
}

export interface PromptFormValues {
  name: string;
  description: string;
  category: string;
  template: string;
}
