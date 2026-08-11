#!/bin/bash

# Force unbuffered output so logs print instantly in Render
export PYTHONUNBUFFERED=1

echo "Starting Node.js Gateway..."
node server.js &

# Give Node 5 seconds to initiate WebSocket connection
sleep 5

echo "Starting Python FastAPI Server..."
uvicorn main:app --host 0.0.0.0 --port $PORT
