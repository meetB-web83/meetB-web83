import sys
sys.path.insert(0, "C:\\Users\\meet.bhesaniya_moont\\AppData\\Local\\Python\\pythoncore-3.14-64\\Lib\\site-packages")
from agent_state_mcp.server import find_project_root, StateStore
root = find_project_root(r"C:\Users\meet.bhesaniya_moont\Documents\PROJECTS\PERSONAL_workJournal")
print("ROOT:", root)
store = StateStore(root)
ov = store.get_overview()
print("OVERVIEW_KEYS:", sorted(ov.keys()))
print("AGENTS:", list(ov.get("agents", {}).keys()))
print("TASKS_COUNT:", len(ov.get("tasks", {})))
print("AGENT_STATE_OK")
