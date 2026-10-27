import sqlite3
import os

db_path = os.path.expanduser('~/.workjournal/registry.db')
print(f"DB path: {db_path}")
print(f"Exists: {os.path.exists(db_path)}")

if os.path.exists(db_path):
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
    tables = cursor.fetchall()
    print(f"Tables: {tables}")
    conn.close()
else:
    print("DB file not found")