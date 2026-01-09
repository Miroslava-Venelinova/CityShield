import json
import uuid
from datetime import datetime
from pathlib import Path

import scrapy
from scrapy.crawler import CrawlerProcess

STATE_FILE = Path(__file__).parent / "state.json"

def load_latest_id():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))["latest_id"]
    return 16000

START_ID = load_latest_id()
LOOKAHEAD = 4
MAX_KEEP = 10

OUTPUT_DIR = Path(__file__).parent / "vik_json_runs"
OUTPUT_DIR.mkdir(exist_ok=True)


class WaterSpider(scrapy.Spider):
    name = "ViK"
    handle_httpstatus_list = [404]

    custom_settings = {
        "DOWNLOAD_DELAY": 0.3,
        "LOG_LEVEL": "ERROR",
    }

    def __init__(self):
        self.current_id = START_ID
        self.valid_items = []

    def start_requests(self):
        yield self.make_request(self.current_id)

    def make_request(self, page_id):
        return scrapy.Request(
            url=f"https://vikvarna.com/bg/messages/breakdown/{page_id}.html",
            callback=self.parse,
            meta={"page_id": page_id},
            dont_filter=True,
        )

    def parse(self, response):
        page_id = response.meta["page_id"]

        date = response.xpath('//div[@class="list-item-date"]/text()').get()
        message = response.xpath('//div[@class="view"]/p/text()').get()

        if date and message:
            self.valid_items.append({
                "id": page_id,
                "date": date.replace("г.", "").strip(),
                "message": message.strip().rstrip(";"),
            })
            self.valid_items = self.valid_items[-MAX_KEEP:]

            yield self.make_request(page_id + 1)
            return

        # INVALID → look ahead
        for offset in range(1, LOOKAHEAD + 1):
            yield self.make_request(page_id + offset)

    def closed(self, reason):
        if not self.valid_items:
            return

        run_uuid = uuid.uuid1().hex
        timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")

        output_file = OUTPUT_DIR / f"vik_messages_{timestamp}_{run_uuid}.json"
        output_file.write_text(
            json.dumps(self.valid_items, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )


if __name__ == "__main__":
    process = CrawlerProcess()
    process.crawl(WaterSpider)
    process.start()