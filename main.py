import os
import random
import requests
import asyncio
import subprocess
import threading
import time
from datetime import datetime, timedelta
from bs4 import BeautifulSoup
from fastapi import FastAPI
import uvicorn

app = FastAPI()

# ==============================================================================
# CONFIGURATION
# ==============================================================================
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")

WA_API_URL = "http://localhost:3000/send"
WA_GROUP_ID = ""  # Populate after retrieving Group ID from logs

# Notification intervals
INACTIVE_LOG_INTERVAL = timedelta(minutes=30)    # status log every 30 min when idle
ACTIVE_ALERT_INTERVAL = timedelta(minutes=5)     # alert every 5 min when seats open

last_inactive_log_time = datetime.min
last_active_alert_time = datetime.min
total_scan_count = 0

# ==============================================================================
# NODE GATEWAY (subprocess + watchdog that restarts it if it dies)
# ==============================================================================
node_process = None
stop_requested = False

def stream_node_logs(pipe, prefix):
    for line in iter(pipe.readline, ''):
        if line:
            print(f"[{prefix}] {line.strip()}", flush=True)

def monitor_node_gateway():
    """Watchdog: if the Node gateway exits (crash, OOM, ...), restart it."""
    global node_process
    while not stop_requested:
        proc = node_process
        if proc is None:
            return
        rc = proc.wait()
        print(f"🔴 Node gateway exited (code {rc}). Restarting in 15s...", flush=True)
        if stop_requested:
            return
        time.sleep(15)
        if stop_requested:
            return
        start_node_gateway()

def start_node_gateway():
    global node_process
    try:
        print("🔄 Starting Node.js gateway...", flush=True)
        node_process = subprocess.Popen(
            ["node", "server.js"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1
        )
        threading.Thread(target=stream_node_logs, args=(node_process.stdout, "NODE"), daemon=True).start()
        threading.Thread(target=stream_node_logs, args=(node_process.stderr, "NODE-ERR"), daemon=True).start()
        threading.Thread(target=monitor_node_gateway, daemon=True).start()
    except Exception as e:
        print(f"🔴 Failed to start Node process: {e}", flush=True)

# ==============================================================================
# NOTIFICATION BROADCASTER
# ==============================================================================
def broadcast_alert(message):
    if TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID:
        try:
            url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
            requests.post(url, json={"chat_id": TELEGRAM_CHAT_ID, "text": message}, timeout=10)
        except Exception as e:
            print(f"Telegram Error: {e}", flush=True)

    if WA_GROUP_ID:
        try:
            requests.post(WA_API_URL, json={"to": WA_GROUP_ID, "body": message}, timeout=10)
        except Exception as e:
            print(f"WhatsApp Error: {e}", flush=True)

# ==============================================================================
# WATCHTOWER SCANNER – REAL LOGIC (inspect the Goethe page)
# ==============================================================================
async def check_goethe_status():
    """
    Returns True if exam seats are available (registration form present),
    False otherwise.
    """
    url = "https://www.goethe.de/ins/pk/en/m/spr/prf/gzsd1.cfm"
    try:
        # Use a proper User-Agent to avoid being blocked
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
        response = requests.get(url, headers=headers, timeout=15)
        soup = BeautifulSoup(response.text, 'html.parser')

        # 1. Check for the date selector (indicates active exams)
        date_selector = soup.find('select', {'name': 'examDate'})
        if date_selector and date_selector.find_all('option'):
            return True

        # 2. Check for the "no examinations" message
        no_exam_msg = soup.find(text=lambda t: t and "no examinations" in t.lower())
        if no_exam_msg:
            return False

        # 3. Fallback: look for a registration form (adjust ID if needed)
        if soup.find('form', {'id': 'registrationForm'}):
            return True

        # If unsure, assume inactive to avoid false alarms
        return False
    except Exception as e:
        print(f"Scraper error: {e}")
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

            # Scan every 1–3 minutes (randomised to avoid pattern detection)
            sleep_seconds = random.randint(60, 180)
            await asyncio.sleep(sleep_seconds)

        except Exception as e:
            print(f"Loop Error: {e}", flush=True)
            await asyncio.sleep(60)

# ==============================================================================
# APP LIFECYCLE
# ==============================================================================
@app.on_event("startup")
async def startup_event():
    start_node_gateway()
    asyncio.create_task(watchtower_loop())

@app.get("/")
def root():
    return {"status": "Watchtower is running"}

@app.get("/api/status")
def read_status():
    return {"status": "Watchtower is running"}

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
