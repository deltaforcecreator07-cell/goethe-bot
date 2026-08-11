import asyncio
import random
from datetime import datetime
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import httpx

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------
# TELEGRAM CONFIGURATION
# ---------------------------------------------------------
TELEGRAM_BOT_TOKEN = "8690556037:AAHJfav6p-RWU8688XWkuJpgHaPxahIjVkE"  # Replace with token from @BotFather
TELEGRAM_CHAT_ID = "@GoetheA1SlotAlerts"  # Replace with your channel username (@my_channel) or private ID (-100...)

TARGET_URL = "https://www.goethe.de/ins/pk/en/spr/prf/gzsd1.cfm"

system_state = {
    "is_open": False,
    "status_text": "INITIALIZING",
    "last_checked": "N/A",
    "details": "System starting up..."
}

async def send_telegram_alert():
    """Posts a high-priority push notification directly to the Telegram Channel."""
    message = (
        "🚨 <b>GOETHE A1 EXAM SEATS OPEN!</b> 🚨\n\n"
        "Exam booking slots have been detected on the portal!\n\n"
        "👉 <a href='https://www.goethe.de/ins/pk/en/spr/prf/gzsd1.cfm'><b>CLICK HERE TO BOOK NOW</b></a>"
    )
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": message,
        "parse_mode": "HTML",
        "disable_web_page_preview": False
    }
    
    async with httpx.AsyncClient() as client:
        try:
            res = await client.post(url, json=payload)
            print(f"Telegram Alert Sent! Status Code: {res.status_code}")
        except Exception as e:
            print(f"Failed to send Telegram alert: {e}")

async def scrape_goethe():
    global system_state
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
    }
    
    async with httpx.AsyncClient(follow_redirects=True, timeout=15.0) as client:
        while True:
            try:
                response = await client.get(TARGET_URL, headers=headers)
                now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S PKT")
                
                if response.status_code == 200:
                    no_dates_phrase = "UNFORTUNATELY, NO EXAMINATION DATES ARE CURRENTLY AVAILABLE"
                    
                    if no_dates_phrase in response.text.upper():
                        system_state["is_open"] = False
                        system_state["status_text"] = "NO DATES AVAILABLE"
                        system_state["details"] = "Monitoring portal for available slots."
                    else:
                        # TRIGGER ALERT: Only send if status flips from CLOSED -> OPEN
                        if not system_state["is_open"]:
                            await send_telegram_alert()
                            
                        system_state["is_open"] = True
                        system_state["status_text"] = "BOOKING OPEN!"
                        system_state["details"] = "Slots detected! Click link to book immediately."
                    
                    system_state["last_checked"] = now_str
                else:
                    system_state["status_text"] = "SITE ERROR"
                    system_state["details"] = f"HTTP Status: {response.status_code}"
            
            except Exception as e:
                system_state["status_text"] = "ERROR"
                system_state["details"] = "Connection timeout or server error. Retrying..."
            
            wait_time = random.randint(240, 420)
            print(f"[{now_str}] Scan complete. Next scan in {wait_time // 60}m {wait_time % 60}s.")
            await asyncio.sleep(wait_time)

@app.on_event("startup")
async def startup_event():
    asyncio.create_task(scrape_goethe())

@app.get("/api/status")
async def get_status():
    return system_state

# TEST ENDPOINT: Visit https://your-render-url.onrender.com/api/test-telegram to test the notification
@app.get("/api/test-telegram")
async def test_telegram():
    await send_telegram_alert()
    return {"message": "Test message sent to Telegram channel!"}
