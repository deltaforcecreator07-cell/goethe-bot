#!/bin/bash

# Start Node.js Gateway in the background
node server.js &

# Wait for Baileys to initialize
sleep 3

# Start Python Watchtower on the public Render port
uvicorn main:app --host 0.0.0.0 --port $PORT
