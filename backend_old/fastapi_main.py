from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr
from typing import List, Optional
import json
from pathlib import Path
from datetime import datetime
import subprocess
import sys

app = FastAPI(title="ViK Varna Outages API", version="1.0.0")

# CORS middleware to allow React frontend to connect
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, replace with specific origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Paths
STATE_FILE = Path("state.json")
OUTPUT_DIR = Path("vik_json_runs")
AI_OUTPUT_DIR = Path("ai_parse_output")

# Ensure directories exist
OUTPUT_DIR.mkdir(exist_ok=True)
AI_OUTPUT_DIR.mkdir(exist_ok=True)

# Pydantic models
class OutageMessage(BaseModel):
    id: int
    date: str
    message: str
    locations: Optional[List[str]] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    lat: Optional[float] = None
    lng: Optional[float] = None

class Address(BaseModel):
    street: str
    neighborhood: str

class UserProfile(BaseModel):
    firstName: str
    lastName: str
    email: EmailStr
    addresses: List[Address] = []

class LoginRequest(BaseModel):
    email: EmailStr
    password: str

class RegisterRequest(BaseModel):
    firstName: str
    lastName: str
    email: EmailStr
    password: str

class UserResponse(BaseModel):
    firstName: str
    lastName: str
    email: str
    addresses: List[Address]

# In-memory user storage (replace with database in production)
users_db = [
    {
        "email": "ivan.petrov@example.com",
        "password": "password123",
        "firstName": "Иван",
        "lastName": "Петров",
        "addresses": [
            {"street": "бул. Владислав Варненчик 25, Варна", "neighborhood": "Левски"},
            {"street": "ул. Цaревец 10, Варна", "neighborhood": "Възраждане"}
        ]
    }
]

# Helper functions
def get_latest_outages() -> List[dict]:
    """Get the most recent outages from JSON files"""
    json_files = sorted(OUTPUT_DIR.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True)
    
    if not json_files:
        return []
    
    # Read the most recent file
    with open(json_files[0], 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    # Enhance with AI-parsed data if available
    enhanced_data = []
    for item in data:
        ai_file = AI_OUTPUT_DIR / f"result_{item['id']}.json"
        if ai_file.exists():
            try:
                with open(ai_file, 'r', encoding='utf-8') as af:
                    ai_data = json.load(af)
                    # Merge AI data with original
                    if isinstance(ai_data, str):
                        ai_data = json.loads(ai_data)
                    item.update(ai_data)
            except (json.JSONDecodeError, Exception):
                pass
        enhanced_data.append(item)
    
    return enhanced_data

def get_spider_state() -> dict:
    """Get the current state of the spider"""
    try:
        if STATE_FILE.exists():
            with open(STATE_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
    except Exception:
        pass
    return {"last_id": 16000}

def save_spider_state(last_id: int):
    """Save the spider state"""
    with open(STATE_FILE, 'w', encoding='utf-8') as f:
        json.dump({"last_id": last_id}, f, indent=2)

# API Routes

@app.get("/")
async def root():
    """API root endpoint"""
    return {
        "message": "ViK Varna Outages API",
        "version": "1.0.0",
        "endpoints": {
            "outages": "/api/outages",
            "spider_status": "/api/spider/status",
            "trigger_scrape": "/api/spider/scrape",
            "auth": "/api/auth/*"
        }
    }

@app.get("/api/outages", response_model=List[OutageMessage])
async def get_outages():
    """Get all current outages"""
    try:
        outages = get_latest_outages()
        return outages
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error retrieving outages: {str(e)}")

@app.get("/api/outages/{outage_id}", response_model=OutageMessage)
async def get_outage(outage_id: int):
    """Get a specific outage by ID"""
    outages = get_latest_outages()
    outage = next((o for o in outages if o.get('id') == outage_id), None)
    
    if not outage:
        raise HTTPException(status_code=404, detail="Outage not found")
    
    return outage

@app.get("/api/spider/status")
async def get_spider_status():
    """Get the current status of the web scraper"""
    state = get_spider_state()
    json_files = list(OUTPUT_DIR.glob("*.json"))
    
    return {
        "last_scraped_id": state.get("last_id", 16000),
        "total_runs": len(json_files),
        "last_run": max([f.stat().st_mtime for f in json_files]) if json_files else None,
        "status": "ready"
    }

@app.post("/api/spider/scrape")
async def trigger_scrape(background_tasks: BackgroundTasks):
    """Trigger a manual scrape of the ViK website"""
    def run_spider():
        subprocess.run([sys.executable, "vik_spider.py"], check=False)
    
    background_tasks.add_task(run_spider)
    
    return {
        "message": "Scraping started in background",
        "status": "processing"
    }

@app.post("/api/spider/parse")
async def trigger_ai_parse(background_tasks: BackgroundTasks):
    """Trigger AI parsing of scraped messages"""
    def run_parser():
        subprocess.run([sys.executable, "ai_parse.py"], check=False)
    
    background_tasks.add_task(run_parser)
    
    return {
        "message": "AI parsing started in background",
        "status": "processing"
    }

# Authentication endpoints

@app.post("/api/auth/login", response_model=UserResponse)
async def login(request: LoginRequest):
    """User login"""
    user = next((u for u in users_db if u['email'].lower() == request.email.lower()), None)
    
    if not user:
        raise HTTPException(status_code=404, detail="Потребителят не е регистриран")
    
    if user['password'] != request.password:
        raise HTTPException(status_code=401, detail="Грешна парола")
    
    return {
        "firstName": user['firstName'],
        "lastName": user['lastName'],
        "email": user['email'],
        "addresses": user.get('addresses', [])
    }

@app.post("/api/auth/register", response_model=UserResponse)
async def register(request: RegisterRequest):
    """User registration"""
    # Check if user already exists
    if any(u['email'].lower() == request.email.lower() for u in users_db):
        raise HTTPException(status_code=400, detail="Потребител с този имейл вече съществува")
    
    # Create new user
    new_user = {
        "email": request.email,
        "password": request.password,
        "firstName": request.firstName,
        "lastName": request.lastName,
        "addresses": []
    }
    
    users_db.append(new_user)
    
    return {
        "firstName": new_user['firstName'],
        "lastName": new_user['lastName'],
        "email": new_user['email'],
        "addresses": []
    }

@app.get("/api/users/{email}", response_model=UserResponse)
async def get_user(email: str):
    """Get user profile"""
    user = next((u for u in users_db if u['email'].lower() == email.lower()), None)
    
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    
    return {
        "firstName": user['firstName'],
        "lastName": user['lastName'],
        "email": user['email'],
        "addresses": user.get('addresses', [])
    }

@app.put("/api/users/{email}/addresses")
async def update_user_addresses(email: str, addresses: List[Address]):
    """Update user addresses"""
    user = next((u for u in users_db if u['email'].lower() == email.lower()), None)
    
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    
    user['addresses'] = [addr.dict() for addr in addresses]
    
    return {"message": "Addresses updated successfully", "addresses": user['addresses']}

@app.delete("/api/users/{email}")
async def delete_user(email: str):
    """Delete user account"""
    global users_db
    user = next((u for u in users_db if u['email'].lower() == email.lower()), None)
    
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    
    users_db = [u for u in users_db if u['email'].lower() != email.lower()]
    
    return {"message": "User deleted successfully"}

# Health check
@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "timestamp": datetime.now().isoformat()
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000, reload=True)