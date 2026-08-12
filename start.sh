#!/bin/bash

# Force unbuffered output so logs print instantly in Render
export PYTHONUNBUFFERED=1

# NOTE: main.py spawns the Node.js WhatsApp gateway itself (with a watchdog),
# so this script only runs uvicorn — starting node here too would create
# a second gateway fighting over port 3000.

echo "Starting Python FastAPI Server (spawns Node.js gateway)..."
uvicorn main:app --host 0.0.0.0 --port $PORT
