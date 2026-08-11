import os
import time
import requests
import asyncio
import subprocess
import threading
import sys
from datetime import datetime, timedelta
from fastapi import FastAPI
import uvicorn

app = FastAPI()

# ==============================================================================
# CONFIGURATION
# ==============================================================================
TELEGRAM_BOT_TOKEN = "YOUR_TELEGRAM_TOKEN_HERE"
TELEGRAM_CHAT_ID = "YOUR_TELEGRAM_CHAT_ID_HERE"

# WhatsApp Local Gateway
WA_API_URL = "http://localhost:3000/send"
WA_GROUP_ID = ""  # Fill this after sniffing the ID from logs

# Intervals
INACTIVE_LOG_INTERVAL = timedelta(hours=1)
ACTIVE_ALERT_INTERVAL = timedelta(minutes=15)

last_inactive_log_time = datetime.min
last_active_alert_time = datetime.min
total_scan_count = 0

# ==============================================================================
# NODE.JS SUBPROCESS LOG STREAMER
# ==============================================================================
def stream_node_logs(pipe, prefix):
    """Pipes background Node.js console logs straight to Render output."""
    for line in iter(pipe.readline, ''):
        if line:
            print(f"[{prefix}] {line.strip()}", flush=True)

def start_node_gateway():
    """Spawns Node.js directly from Python."""
    try:
        print("🔄 Spawning Node.js WhatsApp Gateway process...", flush=True)
        node_process = subprocess.Popen(
            ["node", "server.js"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1
        )
        threading.Thread(target=stream_node_logs, args=(node_process.stdout, "NODE"), daemon=True).start()
        threading.Thread(target=stream_node_logs, args=(node_process.stderr, "NODE-ERR"), daemon=True).start()
    except Exception as e:
        print(f"🔴 Failed to start Node process: {e}", flush=True)

# ==============================================================================
# COMMUNICATION LAYER
# ==============================================================================
def broadcast_alert(message):
    try:
        url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
        requests.post(url, json={"chat_id": TELEGRAM_CHAT_ID, "text": message}, timeout=10)
    except Exception as e:
        print(f"Telegram Error: {e}", flush=True)

    if WA_GROUP_ID != "":
        try:
            requests.post(WA_API_URL, json={"to": WA_GROUP_ID, "body": message}, timeout=10)
        except Exception as e:
            print(f"WhatsApp Error: {e}", flush=True)

# ==============================================================================
# WATCHTOWER CORE LOGIC
# ==============================================================================
async def check_goethe_status():
    await asyncio.sleep(2) 
    return False

async def watchtower_loop():
    global last_inactive_log_time, last_active_alert_time, total_scan_count
    
    print("🚀 Watchtower Scanner Started...", flush=True)
    while True:
        try:
            now = datetime.utcnow()
            is_active = await check_goethe_status()
            total_scan_count += 1
            
            if is_active:
                if now - last_active_alert_time >= ACTIVE_ALERT_INTERVAL:
                    msg = "🚨 URGENT: GOETHE SEATS ARE ACTIVE!\nSlot changes detected. Initiate Sniper Bot!"
                    broadcast_alert(msg)
                    last_active_alert_time = now
            else:
                if now - last_inactive_log_time >= INACTIVE_LOG_INTERVAL:
                    msg = (
                        f"ℹ️ WATCHTOWER STATUS LOG\n\n"
                        f"Status: Background Scanning Active\n"
                        f"Total Scans Performed: {total_scan_count}\n"
                        f"Result: No active bookings found yet."
                    )
                    broadcast_alert(msg)
                    last_inactive_log_time = now
                    total_scan_count = 0
            
            await asyncio.sleep(300) 
            
        except Exception as e:
            print(f"Loop Error: {e}", flush=True)
            await asyncio.sleep(60)

# ==============================================================================
# APPLICATION LIFECYCLE
# ==============================================================================
@app.on_event("startup")
async def startup_event():
    start_node_gateway()
    asyncio.create_task(watchtower_loop())

@app.get("/api/status")
def read_status():
    return {"status": "Watchtower is running"}

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
