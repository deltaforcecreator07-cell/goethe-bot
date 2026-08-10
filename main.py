import asyncio
import random
from datetime import datetime
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import httpx

app = FastAPI()

# Add CORS Middleware to allow your Lovable frontend to fetch data
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # Allows any external website to read this API
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Direct target page for Goethe A1 Exam
TARGET_URL = "https://www.goethe.de/ins/pk/en/spr/prf/gzsd1.cfm"

# In-memory status cache
system_state = {
    "is_open": False,
    "status_text": "INITIALIZING",
    "last_checked": "N/A",
    "details": "System starting up..."
}

async def scrape_goethe():
    """Background task to poll the Goethe website safely."""
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
                    # Check for the closed phrase
                    no_dates_phrase = "UNFORTUNATELY, NO EXAMINATION DATES ARE CURRENTLY AVAILABLE"
                    
                    if no_dates_phrase in response.text.upper():
                        system_state["is_open"] = False
                        system_state["status_text"] = "NO DATES AVAILABLE"
                        system_state["details"] = "Monitoring portal for available slots."
                    else:
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
            
            # ---------------------------------------------------------
            # ANTI-BOT PROTECTION: Randomized Delay (4 to 7 minutes)
            # ---------------------------------------------------------
            wait_time = random.randint(240, 420)
            
            # This will print in your Render logs so you can monitor it
            print(f"[{now_str}] Scan complete. Next scan in {wait_time // 60}m {wait_time % 60}s.")
            
            await asyncio.sleep(wait_time)

@app.on_event("startup")
async def startup_event():
    # Start the continuous scraper loop in the background when Render boots up
    asyncio.create_task(scrape_goethe())

@app.get("/api/status")
async def get_status():
    """API endpoint polled by the Lovable dashboard every 10 seconds."""
    return system_state
