import uuid
import json
from datetime import datetime
from pathlib import Path
import scrapy
from scrapy.crawler import CrawlerProcess
from scrapy.exceptions import CloseSpider

# State file (stores {"last_id": 14999} when spider finishes)
STATE_FILE = Path(__file__).parent / "state.json"
DEFAULT_START = 16000


class WaterSpider(scrapy.Spider):
    name = "ViK"
    handle_httpstatus_list = [404]

    custom_settings = {
        "DOWNLOAD_DELAY": 0.3,
        "LOG_LEVEL": "ERROR",
    }

    def start_requests(self):
        start_id = self._read_start_id()
        # Kick off chain: each parse schedules the next id
        yield scrapy.Request(
            url=self._make_url(start_id),
            callback=self.parse,
            dont_filter=True,
            meta={
                "current_id": start_id,
                "consecutive_miss": 0,
                "last_valid_id": None,
            },
        )

    def parse(self, response):
        current_id = response.meta["current_id"]
        consecutive_miss = response.meta.get("consecutive_miss", 0)
        last_valid_id = response.meta.get("last_valid_id", None)

        # treat 404 as a miss
        if response.status == 404:
            consecutive_miss += 1
        else:
            date = response.xpath('//div[@class="list-item-date"]/text()').get()
            message = response.xpath('//div[@class="view"]/p/text()').get()

            if not date or not message:
                consecutive_miss += 1
            else:
                # valid item found -> reset miss counter and update last_valid_id
                consecutive_miss = 0
                last_valid_id = current_id

                yield {
                    "id": current_id,
                    "date": date.replace('Ð³.', '').strip(),
                    "message": message.strip().rstrip(';')
                }

        # stop when we have 3 consecutive misses
        if consecutive_miss >= 3:
            # persist last valid id if we have one
            if last_valid_id is not None:
                self._write_state(last_valid_id)
            raise CloseSpider("stopped after 3 consecutive empty results")

        # otherwise continue to the next id
        next_id = current_id + 1
        yield scrapy.Request(
            url=self._make_url(next_id),
            callback=self.parse,
            dont_filter=True,
            meta={
                "current_id": next_id,
                "consecutive_miss": consecutive_miss,
                "last_valid_id": last_valid_id,
            },
        )

    def _make_url(self, msg_id: int) -> str:
        return f"https://vikvarna.com/bg/messages/breakdown/{msg_id}.html"

    def _read_start_id(self) -> int:
        """
        Read STATE_FILE. If 'last_id' exists, start from last_id + 1.
        Otherwise default to DEFAULT_START.
        """
        try:
            if STATE_FILE.exists():
                with STATE_FILE.open("r", encoding="utf8") as fh:
                    data = json.load(fh)
                    if isinstance(data, dict) and "last_id" in data:
                        return int(data["last_id"]) + 1
        except Exception:
            # if file is malformed, ignore and fallback to default
            pass
        return DEFAULT_START

    def _write_state(self, last_valid_id: int) -> None:
        """
        Atomically write the last_valid_id to STATE_FILE as {"last_id": <int>}.
        """
        tmp = STATE_FILE.with_suffix(".tmp")
        try:
            with tmp.open("w", encoding="utf8") as fh:
                json.dump({"last_id": int(last_valid_id)}, fh, indent=2)
            tmp.replace(STATE_FILE)
        except Exception as e:
            self.logger.error("Failed to write state file: %s", e)


if __name__ == "__main__":
    output_dir = Path(__file__).parent / "vik_json_runs"
    output_dir.mkdir(exist_ok=True)

    run_uuid = uuid.uuid1().hex
    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    output_file = output_dir / f"vik_messages_{timestamp}_{run_uuid}.json"

    process = CrawlerProcess(settings={
        "FEEDS": {
            str(output_file): {
                "format": "json",
                "encoding": "utf8",
                "indent": 2,
            }
        }
    })

    process.crawl(WaterSpider)
    process.start()
