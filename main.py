import os
import time
import requests
import asyncio
from datetime import datetime, timedelta
from fastapi import FastAPI
import uvicorn

app = FastAPI()

# ==============================================================================
# CONFIGURATION
# ==============================================================================
TELEGRAM_BOT_TOKEN = "YOUR_TELEGRAM_TOKEN_HERE"
TELEGRAM_CHAT_ID = "YOUR_TELEGRAM_CHAT_ID_HERE"

# WhatsApp Local Gateway (Running on port 3000 inside Render)
WA_API_URL = "http://localhost:3000/send"
WA_GROUP_ID = "" # We will fill this in after finding it in the Render logs

# Intervals
INACTIVE_LOG_INTERVAL = timedelta(hours=1)
ACTIVE_ALERT_INTERVAL = timedelta(minutes=15)

last_inactive_log_time = datetime.min
last_active_alert_time = datetime.min
total_scan_count = 0

# ==============================================================================
# COMMUNICATION LAYER
# ==============================================================================
def broadcast_alert(message):
    """Fires to both Telegram and WhatsApp simultaneously."""
    # 1. Telegram
    try:
        url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
        requests.post(url, json={"chat_id": TELEGRAM_CHAT_ID, "text": message}, timeout=10)
    except Exception as e:
        print(f"Telegram Error: {e}")

    # 2. WhatsApp
    if WA_GROUP_ID != "":
        try:
            requests.post(WA_API_URL, json={"to": WA_GROUP_ID, "body": message}, timeout=10)
        except Exception as e:
            print(f"WhatsApp Error: {e}")

# ==============================================================================
# WATCHTOWER CORE LOGIC
# ==============================================================================
async def check_goethe_status():
    """Your logic to check Goethe website goes here."""
    # REPLACE THIS with your actual Goethe checking code (BeautifulSoup/requests).
    # For now, it simulates checking and returning False (seats closed).
    await asyncio.sleep(2) 
    return False

async def watchtower_loop():
    global last_inactive_log_time, last_active_alert_time, total_scan_count
    
    print("🚀 Watchtower Scanner Started...")
    while True:
        try:
            now = datetime.utcnow()
            is_active = await check_goethe_status()
            total_scan_count += 1
            
            if is_active:
                # 🟢 ACTIVE BOOKINGS (Every 15 mins)
                if now - last_active_alert_time >= ACTIVE_ALERT_INTERVAL:
                    msg = "🚨 URGENT: GOETHE SEATS ARE ACTIVE!\nSlot changes detected. Initiate Sniper Bot!"
                    broadcast_alert(msg)
                    last_active_alert_time = now
            else:
                # 🔴 INACTIVE BOOKINGS (Every 1 Hour)
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
            
            # Delay between scans to evade Cloudflare (4 to 6 minutes)
            await asyncio.sleep(300) 
            
        except Exception as e:
            print(f"Loop Error: {e}")
            await asyncio.sleep(60)

# ==============================================================================
# RENDER KEEP-ALIVE ENDPOINT
# ==============================================================================
@app.on_event("startup")
async def startup_event():
    asyncio.create_task(watchtower_loop())

@app.get("/api/status")
def read_status():
    return {"status": "Watchtower is running"}

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)