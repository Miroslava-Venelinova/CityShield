import subprocess
import sys
import time

INTERVAL = 1 * 60  # 10 minutes

while True:
    print("[RUNNER] Checking for new IDs...")
    subprocess.run([sys.executable, "vik_spider.py"], check=False)
    print("[RUNNER] Sleeping...\n")
    time.sleep(INTERVAL)