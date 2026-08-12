import os
import time
import random
import requests
import asyncio
import subprocess
import threading
from datetime import datetime, timedelta
from fastapi import FastAPI
import uvicorn

app = FastAPI()

# ================= CONFIG =================
TELEGRAM_BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
TELEGRAM_CHAT_ID   = os.environ["TELEGRAM_CHAT_ID"]
GOETHE_URL         = os.environ.get("GOETHE_URL", "https://example.com/a1-exam")  # <-- REAL URL

INACTIVE_LOG_INTERVAL = timedelta(hours=1)
ACTIVE_ALERT_INTERVAL = timedelta(minutes=5)

last_inactive_log   = datetime.min
last_active_alert   = datetime.min
total_scans         = 0

wa_group_id = os.environ.get("WA_GROUP_ID", "")

# ================= NODE PROCESS =================
def stream_pipe(pipe, prefix):
    for line in iter(pipe.readline, ''):
        if line:
            print(f"[{prefix}] {line.strip()}", flush=True)

def start_node():
    try:
        print("🔄 Starting Node.js gateway...", flush=True)
        p = subprocess.Popen(
            ["node", "server.js"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True, bufsize=1
        )
        threading.Thread(target=stream_pipe, args=(p.stdout, "NODE"), daemon=True).start()
        threading.Thread(target=stream_pipe, args=(p.stderr, "NODE-ERR"), daemon=True).start()
    except Exception as e:
        print(f"❌ Node start error: {e}", flush=True)

# ================= NOTIFICATIONS =================
def send_telegram(text):
    try:
        requests.post(
            f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
            json={"chat_id": TELEGRAM_CHAT_ID, "text": text},
            timeout=10
        )
    except Exception as e:
        print(f"Telegram error: {e}", flush=True)

def send_whatsapp(text):
    global wa_group_id
    if not wa_group_id:
        return
    try:
        requests.post("http://localhost:3000/send",
            json={"to": wa_group_id, "body": text}, timeout=10)
    except Exception as e:
        print(f"WhatsApp error: {e}", flush=True)

def broadcast(text):
    send_telegram(text)
    send_whatsapp(text)

# ================= GOETHE CHECKER =================
def is_booking_open():
    """
    Replace with actual logic to scrape the Goethe A1 booking page.
    Return True if bookings are available.
    """
    try:
        resp = requests.get(GOETHE_URL, timeout=15)
        if resp.status_code != 200:
            return False
        # Example: look for text indicating open slots
        if "booking open" in resp.text.lower():
            return True
        return False
    except Exception as e:
        print(f"Error checking Goethe: {e}", flush=True)
        return False

# ================= WATCHTOWER LOOP =================
async def watchtower():
    global last_inactive_log, last_active_alert, total_scans, wa_group_id
    print("🚀 Watchtower started", flush=True)

    while True:
        try:
            now = datetime.utcnow()
            total_scans += 1
            active = is_booking_open()

            if active:
                if now - last_active_alert >= ACTIVE_ALERT_INTERVAL:
                    msg = "🚨 GOETHE SEATS ACTIVE!\nBookings open – secure your spot now!"
                    broadcast(msg)
                    last_active_alert = now
            else:
                if now - last_inactive_log >= INACTIVE_LOG_INTERVAL:
                    msg = (
                        "ℹ️ WATCHTOWER STATUS\n"
                        f"Bookings: CLOSED\n"
                        f"Total scans: {total_scans}\n"
                        f"Checking every 4-7 min"
                    )
                    broadcast(msg)
                    last_inactive_log = now
                    total_scans = 0

            await asyncio.sleep(random.randint(240, 420))

        except Exception as e:
            print(f"Loop error: {e}", flush=True)
            await asyncio.sleep(60)

@app.on_event("startup")
async def startup():
    start_node()
    asyncio.create_task(watchtower())

@app.get("/api/status")
def status():
    return {"status": "running", "wa_group_id": wa_group_id}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))
