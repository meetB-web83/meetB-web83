-- 002_registry_project_description.sql — scope §4 requires a project description.

ALTER TABLE registry_projects ADD COLUMN description TEXT;
